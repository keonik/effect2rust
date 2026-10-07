/**
 * BunPgClient — an `@effect/sql` SqlClient backed by Bun's native Postgres
 * driver (`Bun.sql`) instead of the `pg` npm package.
 *
 * Drop-in for `PgClient` from `@effect/sql-pg`: same SQL compiler (placeholders,
 * identifier escaping, `sql.insert`, `sql.in`, …), same row values (Bun.sql parses
 * int8/numeric as strings, timestamps as Dates, json as objects, exactly like `pg`),
 * same SqlError semantics. Swap the layer, keep the program.
 *
 *   - PgClient.layerConfig({ url: Config.redacted("DATABASE_URL") })
 *   + BunPgClient.layerConfig({ url: Config.redacted("DATABASE_URL") })
 *
 * Not ported from PgClient: `listen` / `notify`, the `json` helper, custom `types`.
 */
import * as Reactivity from "@effect/experimental/Reactivity"
import { makeCompiler } from "@effect/sql-pg/PgClient"
import * as Client from "@effect/sql/SqlClient"
import type { Connection } from "@effect/sql/SqlConnection"
import { SqlError } from "@effect/sql/SqlError"
import * as Statement from "@effect/sql/Statement"
import { SQL, type ReservedSQL } from "bun"
import * as Chunk from "effect/Chunk"
import * as Config from "effect/Config"
import type * as ConfigError from "effect/ConfigError"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
// @ts-expect-error: untyped internal module of `pg` (already installed via @effect/sql-pg)
import { prepareValue } from "pg/lib/utils.js"

export interface BunPgClientConfig {
  readonly url: Redacted.Redacted
  readonly maxConnections?: number | undefined
  readonly idleTimeout?: Duration.DurationInput | undefined
  readonly connectTimeout?: Duration.DurationInput | undefined
  readonly connectionTTL?: Duration.DurationInput | undefined
  readonly spanAttributes?: Record<string, unknown> | undefined
  readonly transformResultNames?: ((str: string) => string) | undefined
  readonly transformQueryNames?: ((str: string) => string) | undefined
  readonly transformJson?: boolean | undefined
}

export interface BunPgClient extends Client.SqlClient {
  readonly config: BunPgClientConfig
  /** The underlying Bun.sql pool, for anything the SqlClient interface doesn't cover. */
  readonly bun: SQL
}

export const BunPgClient = Context.GenericTag<BunPgClient>("BunPgClient")

type Db = SQL | ReservedSQL
type Rows = ReadonlyArray<any>
type Transform = (<A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined

const seconds = (d: Duration.DurationInput | undefined) => (d === undefined ? undefined : Duration.toSeconds(d))

/**
 * Serialize parameters exactly like `pg` does (numbers, booleans, Dates, arrays and
 * objects become untyped text), so Postgres infers parameter types the same way.
 * Bun.sql would otherwise send numbers as int4/int8/float8, which changes results:
 * `WHERE int4_col = 99999999999` is an out-of-range error under pg but no match under
 * Bun, and `WHERE text_col = 5` works under pg but errors under Bun.
 */
const toPgParams = (params: ReadonlyArray<unknown>): Array<unknown> => {
  const out = new Array(params.length)
  for (let i = 0; i < params.length; i++) {
    const v = params[i]
    out[i] = typeof v === "string" ? v : prepareValue(v)
  }
  return out
}

/** Run one statement. Interrupting the fiber cancels the query on the server. */
const run = (db: Db, sql: string, params: ReadonlyArray<unknown>, mode: "rows" | "values" = "rows") =>
  Effect.async<Rows, SqlError>((resume) => {
    // Without parameters, Bun.sql uses the simple protocol, which (like pg) allows several statements.
    let query = params.length > 0 ? db.unsafe(sql, toPgParams(params)) : db.unsafe(sql)
    if (mode === "values") query = query.values()
    query.then(
      (rows: Rows) => resume(Effect.succeed(rows)),
      (cause: unknown) => resume(Effect.fail(new SqlError({ cause, message: "Failed to execute statement" }))),
    )
    return Effect.sync(() => {
      query.cancel()
    })
  })

let cursorId = 0

export const make = (config: BunPgClientConfig): Effect.Effect<BunPgClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function* () {
    const db = new SQL({
      url: Redacted.value(config.url),
      max: config.maxConnections ?? 10,
      idleTimeout: seconds(config.idleTimeout),
      connectionTimeout: seconds(config.connectTimeout),
      maxLifetime: seconds(config.connectionTTL),
    })

    // Fail fast at startup, close the pool on shutdown (same contract as PgClient).
    yield* Effect.acquireRelease(run(db, "SELECT 1", []), () =>
      Effect.promise(() => db.close()).pipe(Effect.interruptible, Effect.timeoutOption(1000)),
    ).pipe(
      Effect.timeoutFail({
        duration: config.connectTimeout ?? Duration.seconds(5),
        onTimeout: () => new SqlError({ cause: new Error("Connection timed out"), message: "BunPgClient: Connection timed out" }),
      }),
    )

    /** A dedicated connection, released when the scope closes (transactions, cursors). */
    const reserveRaw: Effect.Effect<ReservedSQL, SqlError, Scope.Scope> = Effect.acquireRelease(
      Effect.tryPromise({
        try: (signal) => db.reserve({ signal }),
        catch: (cause) => new SqlError({ cause, message: "Failed to acquire connection for transaction" }),
      }),
      (conn) => Effect.sync(() => conn.release()),
    )

    class ConnectionImpl implements Connection {
      constructor(readonly db: Db, readonly reserved: boolean) {}

      execute(sql: string, params: ReadonlyArray<unknown>, transformRows: Transform) {
        const rows = run(this.db, sql, params)
        return transformRows ? Effect.map(rows, transformRows) : rows
      }
      executeRaw(sql: string, params: ReadonlyArray<unknown>) {
        return run(this.db, sql, params)
      }
      executeWithoutTransform(sql: string, params: ReadonlyArray<unknown>) {
        return run(this.db, sql, params)
      }
      executeValues(sql: string, params: ReadonlyArray<unknown>) {
        return run(this.db, sql, params, "values") as Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>
      }
      executeUnprepared(sql: string, params: ReadonlyArray<unknown>, transformRows: Transform) {
        return this.execute(sql, params, transformRows)
      }
      /** Server-side cursor, 128 rows per round trip; opens its own transaction unless already in one. */
      executeStream(sql: string, params: ReadonlyArray<unknown>, transformRows: Transform) {
        const self = this
        return Effect.gen(function* () {
          const conn: Db = self.reserved ? self.db : yield* reserveRaw
          const name = `effect_cursor_${++cursorId}`
          if (!self.reserved) yield* run(conn, "BEGIN", [])
          yield* Effect.addFinalizer(() =>
            run(conn, `CLOSE ${name}${self.reserved ? "" : "; COMMIT"}`, []).pipe(Effect.ignore),
          )
          yield* run(conn, `DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`, params)
          const pull = run(conn, `FETCH 128 FROM ${name}`, []).pipe(
            Effect.mapError(Option.some),
            Effect.flatMap((rows) =>
              rows.length > 0
                ? Effect.succeed(Chunk.unsafeFromArray(transformRows ? transformRows(rows) : rows))
                : Effect.fail(Option.none()),
            ),
          )
          return Stream.repeatEffectChunkOption(pull)
        }).pipe(Stream.unwrapScoped)
      }
    }

    const client = yield* Client.make({
      acquirer: Effect.succeed(new ConnectionImpl(db, false)),
      transactionAcquirer: Effect.map(reserveRaw, (conn) => new ConnectionImpl(conn, true)),
      compiler: makeCompiler(config.transformQueryNames, config.transformJson),
      spanAttributes: [...Object.entries(config.spanAttributes ?? {}), ["db.system.name", "postgresql"]],
      transformRows: config.transformResultNames
        ? Statement.defaultTransforms(config.transformResultNames, config.transformJson).array
        : undefined,
    })
    return Object.assign(client, { config, bun: db })
  })

export const layerConfig = (
  config: Config.Config.Wrap<BunPgClientConfig>,
): Layer.Layer<BunPgClient | Client.SqlClient, ConfigError.ConfigError | SqlError> =>
  Layer.scopedContext(
    Config.unwrap(config).pipe(
      Effect.flatMap(make),
      Effect.map((client) => Context.make(BunPgClient, client).pipe(Context.add(Client.SqlClient, client))),
    ),
  ).pipe(Layer.provide(Reactivity.layer))

export const layer = (config: BunPgClientConfig): Layer.Layer<BunPgClient | Client.SqlClient, SqlError> =>
  Layer.scopedContext(
    Effect.map(make(config), (client) => Context.make(BunPgClient, client).pipe(Context.add(Client.SqlClient, client))),
  ).pipe(Layer.provide(Reactivity.layer))
