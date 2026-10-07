// Exercises BunPgClient beyond the HTTP contract: transactions, streams, helpers, interruption.
import { SqlClient } from "@effect/sql"
import { expect, test } from "bun:test"
import { Chunk, Config, Duration, Effect, Fiber, Stream } from "effect"
import * as BunPgClient from "./BunPgClient"

const Live = BunPgClient.layerConfig({ url: Config.redacted("DATABASE_URL"), maxConnections: Config.succeed(4) })
const run = <A, E>(eff: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(eff, Live) as Effect.Effect<A, E>)

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
    return (yield* sql<{ n: string }>`SELECT count(*) n FROM adapter_t WHERE name = 'tx-ok'`)[0]!.n
  }))
  expect(n).toBe("1")
})

test("transaction rolls back on failure, including nested savepoints", async () => {
  const counts = await run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const nested = sql.withTransaction(Effect.zipRight(sql`INSERT INTO adapter_t (name) VALUES ('inner')`, Effect.fail("boom")))
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO adapter_t (name) VALUES ('outer')`
      yield* Effect.ignore(nested) // savepoint rolled back, outer continues
    }))
    yield* Effect.ignore(sql.withTransaction(Effect.zipRight(sql`INSERT INTO adapter_t (name) VALUES ('doomed')`, Effect.fail("boom"))))
    return yield* sql<{ name: string; n: string }>`SELECT name, count(*) n FROM adapter_t WHERE name IN ('outer','inner','doomed') GROUP BY name`
  }))
  expect(counts).toEqual([{ name: "outer", n: "1" }])
})

test("stream reads through a cursor in 128-row pages", async () => {
  const total = await run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ g: number }>`SELECT g FROM generate_series(1, 1000) g WHERE g > ${0}`.stream.pipe(Stream.runCollect)
    return Chunk.reduce(rows, 0, (acc, r) => acc + r.g)
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
    const fiber = yield* Effect.fork(sql`SELECT pg_sleep(10)`)
    yield* Effect.sleep(Duration.millis(200))
    yield* Fiber.interrupt(fiber)
    yield* sql`SELECT 1` // pool still healthy afterwards
  }))
  expect(Date.now() - start).toBeLessThan(3000)
})

test("errors surface as SqlError", async () => {
  const tag = await run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql`SELECT * FROM no_such_table`.pipe(Effect.as("ok"), Effect.catchTag("SqlError", () => Effect.succeed("SqlError")))
  }))
  expect(tag).toBe("SqlError")
})

test("cleanup", () => run(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; yield* sql`DROP TABLE adapter_t` })))

test("parameters are inferred by Postgres exactly like pg", async () => {
  const r = await run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const overflow = yield* sql`SELECT 1 FROM todos WHERE id = ${99999999999}`.pipe(Effect.as("ok"), Effect.catchTag("SqlError", () => Effect.succeed("SqlError")))
    const textEqNumber = yield* sql<{ c: string }>`SELECT count(*)::text c FROM todos WHERE title = ${5}`
    const [types] = yield* sql<{ a: string; b: string; d: string }>`SELECT ${true}::text a, ${1.5}::float8::text b, ${new Date("2026-01-02T03:04:05Z")}::timestamptz = '2026-01-02T03:04:05Z' AS d`
    return { overflow, textEqNumber: textEqNumber[0]!.c, types }
  }))
  expect(r).toEqual({ overflow: "SqlError", textEqNumber: "0", types: { a: "true", b: "1.5", d: true } as any })
})
