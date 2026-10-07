// BunPgClient against PgClient semantics: transactions, streams, helpers, parameter typing,
// row values, error reasons, interruption.
import { PgClient } from "@effect/sql-pg"
import { expect, test } from "bun:test"
import { Config, Duration, Effect, Fiber, Layer, Stream } from "effect"
import { SqlClient } from "effect/sql"
import * as BunPgClient from "./BunPgClient"

const url = Config.Redacted("DATABASE_URL")
const Bun = BunPgClient.layerConfig({ url, maxConnections: Config.succeed(4) })
const Pg = PgClient.layerConfig({ url })
const run = <A, E>(eff: Effect.Effect<A, E, SqlClient.SqlClient>, layer: Layer.Layer<SqlClient.SqlClient, any> = Bun) =>
  Effect.runPromise(Effect.provide(eff, layer) as Effect.Effect<A, E>)

test("setup", () =>
  run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP TABLE IF EXISTS adapter_t`
    yield* sql`CREATE TABLE adapter_t (id serial PRIMARY KEY, name text NOT NULL)`
  })))

test("sql.insert + sql.in + identifiers", async () => {
  const rows = await run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO ${sql("adapter_t")} ${sql.insert([{ name: "a" }, { name: "b" }, { name: "c" }])}`
    return yield* sql<{ name: string }>`SELECT name FROM adapter_t WHERE name IN ${sql.in(["a", "c"])} ORDER BY name`
  }))
  expect(rows.map((r) => r.name)).toEqual(["a", "c"])
})

test("transaction commits", async () => {
  const n = await run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(sql`INSERT INTO adapter_t (name) VALUES ('tx-ok')`)
    return (yield* sql<{ n: string }>`SELECT count(*)::text n FROM adapter_t WHERE name = 'tx-ok'`)[0]!.n
  }))
  expect(n).toBe("1")
})

test("transaction rolls back on failure, including nested savepoints", async () => {
  const rows = await run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const nested = sql.withTransaction(Effect.andThen(sql`INSERT INTO adapter_t (name) VALUES ('inner')`, Effect.fail("boom")))
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO adapter_t (name) VALUES ('outer')`
      yield* Effect.ignore(nested) // savepoint rolled back, outer continues
    }))
    yield* Effect.ignore(sql.withTransaction(Effect.andThen(sql`INSERT INTO adapter_t (name) VALUES ('doomed')`, Effect.fail("boom"))))
    return yield* sql<{ name: string; n: string }>`SELECT name, count(*)::text n FROM adapter_t WHERE name IN ('outer','inner','doomed') GROUP BY name`
  }))
  expect(rows).toEqual([{ name: "outer", n: "1" }])
})

test("stream reads through a cursor in 128-row pages", async () => {
  const total = await run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ g: number }>`SELECT g FROM generate_series(1, 1000) g WHERE g > ${0}`.stream.pipe(Stream.runCollect)
    return rows.reduce((acc, r) => acc + r.g, 0)
  }))
  expect(total).toBe(500500)
})

test("stream inside a transaction reuses its connection", async () => {
  const n = await run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(sql`SELECT g FROM generate_series(1, 300) g`.stream.pipe(Stream.runCount))
  }))
  expect(n).toBe(300)
})

test("interrupting a query cancels it on the server", async () => {
  const start = Date.now()
  await run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const fiber = yield* Effect.forkChild(sql`SELECT pg_sleep(10)`)
    yield* Effect.sleep(Duration.millis(200))
    yield* Fiber.interrupt(fiber)
    yield* sql`SELECT 1` // pool still healthy afterwards
  }))
  expect(Date.now() - start).toBeLessThan(3000)
})

// The same probes through both clients must give the same answers.
const probes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const attempt = <A>(eff: Effect.Effect<A, any>) =>
    eff.pipe(Effect.map((v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x))), Effect.catch((e: any) => Effect.succeed(`SqlError:${e?.reason?._tag}`)))
  return {
    int4Overflow: yield* attempt(sql`SELECT count(*)::text c FROM adapter_t WHERE id = ${99999999999}`),
    textEqNumber: yield* attempt(sql`SELECT count(*)::text c FROM adapter_t WHERE name = ${5}`),
    untypedString: yield* attempt(sql`SELECT pg_typeof(${"5"})::text t`),
    numberTypes: yield* attempt(sql`SELECT pg_typeof(${5})::text a, pg_typeof(${99999999999})::text b, pg_typeof(${1.5})::text c, pg_typeof(${true})::text d`),
    values: yield* attempt(sql`SELECT 1::int2 a, 2::int4 b, 3::int8 c, 1.5::numeric d, 1.5::float8 e, true f, 'x'::text g, '2026-01-02T03:04:05Z'::timestamptz h, '{"k":1}'::jsonb j, '{1,2}'::int4[] l, null::text m, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid o`),
    uniqueViolation: yield* attempt(sql`INSERT INTO adapter_t (id, name) VALUES (1, 'dup')`),
    syntax: yield* attempt(sql`SELEC 1`),
    divByZero: yield* attempt(sql`SELECT 1/0`),
  }
})

test("parameter typing, row values and error reasons match PgClient", async () => {
  const [bun, pg] = await Promise.all([run(probes), run(probes, Pg)])
  expect(bun).toEqual(pg)
  expect(bun.int4Overflow).toBe('[{"c":"0"}]')
  expect(bun.uniqueViolation).toBe("SqlError:UniqueViolation")
})

test("documented difference: parameterless multi-statement strings run (PgClient rejects them)", async () => {
  const q = Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("SELECT 1 a; SELECT 2 b"))
  expect(await run(q)).toEqual([[{ a: 1 }], [{ b: 2 }]] as any)
  expect(await run(Effect.flip(q), Pg).then((e: any) => e.reason._tag)).toBe("SqlSyntaxError")
})

test("cleanup", () => run(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; yield* sql`DROP TABLE adapter_t` })))
