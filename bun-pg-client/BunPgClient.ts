/**
 * BunPgClient — an `effect/sql` SqlClient backed by Bun's native Postgres driver
 * (`Bun.sql`), for Effect 4.
 *
 * Drop-in for `PgClient` from `@effect/sql-pg`: same SQL compiler (placeholders,
 * identifier escaping, `sql.insert`, `sql.in`, …), same parameter typing (numbers
 * are sent as int4 / int8 / float8 by value, strings untyped, so Postgres infers
 * them exactly as with PgClient's own driver), same row values for the common
 * types (int8 as BigInt, numeric as string, timestamptz as Date, json as objects),
 * and SqlError reasons classified from SQLSTATE the same way.
 *
 *   - PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })
 *   + BunPgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })
 *
 * Known differences from PgClient's driver: `date` columns are Date objects (PgClient:
 * "YYYY-MM-DD" strings), `time` is a string (PgClient: BigInt microseconds), `bytea` is
 * a Buffer (a Uint8Array subclass), and `interval` is Postgres text output. Parameterless
 * multi-statement strings (`sql.unsafe("A; B")`) run via Bun's simple protocol, where
 * PgClient rejects them.
 * Not ported: `listen` / `notify`, the `json` helper.
 */
import { makeCompiler } from "@effect/sql-pg/PgClient"
import { SQL, type ReservedSQL } from "bun"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as Client from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import {
  AuthenticationError,
  AuthorizationError,
  ConnectionError,
  ConstraintError,
  DeadlockError,
  LockTimeoutError,
  SerializationError,
  SqlError,
  type SqlErrorReason,
  SqlSyntaxError,
  StatementTimeoutError,
  UniqueViolation,
  UnknownError,
} from "effect/sql/SqlError"
import * as Statement from "effect/sql/Statement"

export interface BunPgClientConfig {
  readonly url: Redacted.Redacted
  readonly maxConnections?: number | undefined
  readonly idleTimeout?: Duration.Input | undefined
  readonly connectTimeout?: Duration.Input | undefined
  readonly connectionTTL?: Duration.Input | undefined
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

export const BunPgClient = Context.Service<BunPgClient>("effect2rust/BunPgClient")

type Db = SQL | ReservedSQL
type Rows = ReadonlyArray<any> & { readonly command?: string }
type Transform = (<A extends object>(rows: ReadonlyArray<A>) => ReadonlyArray<A>) | undefined

const seconds = (d: Duration.Input | undefined) => (d === undefined ? undefined : Duration.toSeconds(Duration.fromInputUnsafe(d)))

// ── Errors: SQLSTATE → SqlError reason (same classification as @effect/sql-pg) ──

const classify = (cause: unknown, message: string, operation: string): SqlErrorReason => {
  const e = cause as { errno?: unknown; constraint?: unknown } | undefined
  const code = typeof e?.errno === "string" ? e.errno : undefined
  const props = { cause, message, operation }
  if (code !== undefined) {
    if (code.startsWith("08")) return new ConnectionError(props)
    if (code.startsWith("28")) return new AuthenticationError(props)
    if (code === "42501") return new AuthorizationError(props)
    if (code.startsWith("42")) return new SqlSyntaxError(props)
    if (code === "23505") {
      const c = typeof e?.constraint === "string" && e.constraint.trim() ? e.constraint.trim() : "unknown"
      return new UniqueViolation({ ...props, constraint: c })
    }
    if (code.startsWith("23")) return new ConstraintError(props)
    if (code === "40P01") return new DeadlockError(props)
    if (code === "40001") return new SerializationError(props)
    if (code === "55P03") return new LockTimeoutError(props)
    if (code === "57014") return new StatementTimeoutError(props)
  } else if ((cause as { code?: unknown })?.code === "ERR_POSTGRES_CONNECTION_CLOSED" || (cause as { code?: unknown })?.code === "ERR_POSTGRES_CONNECTION_REFUSED") {
    return new ConnectionError(props)
  }
  return new UnknownError(props)
}

const sqlError = (cause: unknown, message: string, operation = "query") => new SqlError({ reason: classify(cause, message, operation) })

/** Run one statement. Interrupting the fiber cancels the query on the server. */
const run = (db: Db, sql: string, params: ReadonlyArray<unknown>, mode: "rows" | "values" = "rows", prepare = true) =>
  Effect.callback<Rows, SqlError>((resume) => {
    // Without parameters, or when asked, use the simple protocol (allows several statements).
    let query = params.length > 0 ? db.unsafe(sql, params as Array<unknown>) : db.unsafe(sql)
    if (!prepare && params.length === 0) query = query.simple()
    if (mode === "values") query = query.values()
    query.then(
      (rows: Rows) => resume(Effect.succeed(rows)),
      (cause: unknown) => resume(Effect.fail(sqlError(cause, "BunPgClient: Query failed"))),
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
      bigint: true, // int8 as BigInt, like PgClient's driver
      idleTimeout: seconds(config.idleTimeout),
      connectionTimeout: seconds(config.connectTimeout),
      maxLifetime: seconds(config.connectionTTL),
    })

    // Fail fast at startup, close the pool on shutdown.
    yield* Effect.acquireRelease(run(db, "SELECT 1", []), () =>
      Effect.promise(() => db.close()).pipe(Effect.interruptible, Effect.timeoutOption(1000)),
    ).pipe(
      Effect.timeoutOrElse({
        duration: config.connectTimeout ?? Duration.seconds(5),
        orElse: () => Effect.fail(sqlError(new Error("Connection timed out"), "BunPgClient: Connection timed out", "connect")),
      }),
    )

    /** A dedicated connection, released when the scope closes (transactions, cursors). */
    const reserveRaw: Effect.Effect<ReservedSQL, SqlError, Scope.Scope> = Effect.acquireRelease(
      Effect.tryPromise({
        try: (signal) => db.reserve({ signal }),
        catch: (cause) => sqlError(cause, "BunPgClient: Failed to acquire connection for transaction", "connect"),
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
      executeValues(sql: string, params: ReadonlyArray<unknown>) {
        return run(this.db, sql, params, "values") as Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>
      }
      executeValuesUnprepared(sql: string, params: ReadonlyArray<unknown>) {
        return run(this.db, sql, params, "values", false) as Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>
      }
      executeUnprepared(sql: string, params: ReadonlyArray<unknown>, transformRows: Transform) {
        const rows = run(this.db, sql, params, "rows", false)
        return transformRows ? Effect.map(rows, transformRows) : rows
      }
      /** Server-side cursor, 128 rows per round trip; opens its own transaction unless already in one. */
      executeStream(sql: string, params: ReadonlyArray<unknown>, transformRows: Transform) {
        const self = this
        return Stream.unwrap(
          Effect.gen(function* () {
            const conn: Db = self.reserved ? self.db : yield* reserveRaw
            const name = `effect_cursor_${++cursorId}`
            if (!self.reserved) yield* run(conn, "BEGIN", [])
            yield* Effect.addFinalizer(() => run(conn, `CLOSE ${name}${self.reserved ? "" : "; COMMIT"}`, []).pipe(Effect.ignore))
            yield* run(conn, `DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`, params)
            return Stream.paginate(undefined, () =>
              Effect.map(run(conn, `FETCH 128 FROM ${name}`, []), (rows) => {
                const page = transformRows ? transformRows(rows) : rows
                return [page, rows.length < 128 ? Option.none() : Option.some(undefined)] as const
              }),
            )
          }),
        )
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
      prepareTransactionControls: true,
      releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
      // Postgres answers COMMIT on an aborted transaction with ROLLBACK; surface that as a failure.
      commit: (conn: Connection) =>
        Effect.flatMap(conn.executeRaw("COMMIT", []) as Effect.Effect<Rows, SqlError>, (result) =>
          result.command === "ROLLBACK"
            ? Effect.fail(sqlError(new Error("COMMIT rolled back an aborted transaction"), "BunPgClient: COMMIT rolled back an aborted transaction", "commit"))
            : Effect.void,
        ),
    })
    return Object.assign(client, { config, bun: db })
  })

export const layerFrom = <E, R>(acquire: Effect.Effect<BunPgClient, E, R>): Layer.Layer<BunPgClient | Client.SqlClient, E, Exclude<R, Scope.Scope | Reactivity.Reactivity>> =>
  Layer.effectContext(
    Effect.map(acquire, (client) => Context.make(BunPgClient, client).pipe(Context.add(Client.SqlClient, client))),
  ).pipe(Layer.provide(Reactivity.layer)) as any

export const layerConfig = (config: Config.Wrap<BunPgClientConfig>): Layer.Layer<BunPgClient | Client.SqlClient, Config.ConfigError | SqlError> =>
  layerFrom(Effect.flatMap(Config.unwrap(config), make))

export const layer = (config: BunPgClientConfig): Layer.Layer<BunPgClient | Client.SqlClient, SqlError> => layerFrom(make(config))
