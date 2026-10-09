# effect2rust

Write the server once in [Effect 4](https://effect.website). Get a native Rust binary
that behaves identically, plus a faster Postgres client if you stay on Bun.

```
your Effect app ──tsc──▶ lower Effect.gen / Effect.fn to Rust ──▶ Postgres describes every query ──▶ axum + tokio-postgres crate ──cargo──▶ ~2 MB binary
```

This is not an OpenAPI translator. It compiles the program itself: generator bodies, `yield*`,
typed errors and `catchTags`, services, Schema decoding, and SQL whose parameters are typed
exactly the way `@effect/sql-pg` types them. It also reproduces Effect's HTTP behavior, including
the find-my-way router's normalization rules, content-type handling and status codes.

Two things in this repo:

| | What it is | Status |
|---|---|---|
| **`effect2rust` CLI** | Effect 4 → Rust compiler + differential contract tester | Prototype: a small, growing subset of Effect |
| **`effect2rust/BunPgClient`** | Drop-in `effect/sql` client on Bun's native Postgres driver | Usable: faster than `@effect/sql-pg` with ~10× lower p99, same results |

## Use it in your Effect repos

Requirements: **Effect 4** (`effect` ≥ 4.0), Bun (tested on 1.4.2), and for `build`: a Rust
toolchain (`rustup`), `psql`, and a Postgres with your schema.

```sh
bun add -d github:keonik/effect2rust        # private repo: uses your git credentials
# or: bun add -d git+ssh://git@github.com:keonik/effect2rust.git

# 1. What compiles today, and every construct that doesn't (across the files your entry imports)
bunx effect2rust check src/main.ts
DATABASE_URL=postgres://… bunx effect2rust check src/main.ts      # also checks SQL against your schema

# 2. Build the native server (Postgres is only needed to describe queries; cargo runs offline)
DATABASE_URL=postgres://… bunx effect2rust build src/main.ts --out rust --release
./rust/target/release/main_server

# 3. Prove it behaves identically: same requests against both, compare every status and body
node_modules/effect2rust/contract/diff.sh --cases contract-cases.json \
  --reset 'TRUNCATE todos RESTART IDENTITY' \
  "effect=bun src/main.ts" "rust=./rust/target/release/main_server"
```

Start with `check` on an existing repo. It lists each unsupported construct once, at its source
(`repo.ts:28:9: unsupported Effect Effect.all(...)`), so you can see how far a codebase is from
compiling and what the compiler should support next.

Contract cases are plain JSON (see `examples/todos/contract-cases.json`, 81 cases):

```json
[{ "method": "GET", "path": "/todos/1" },
 { "method": "POST", "path": "/todos", "body": "{\"title\":\"x\"}", "contentType": "application/json" }]
```

Put the edge cases there: bad input, wrong types, odd URLs, content types, Unicode. That's
where implementations drift.

### BunPgClient (staying on Bun)

```diff
- import { PgClient } from "@effect/sql-pg"
+ import * as BunPgClient from "effect2rust/BunPgClient"

- Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") }))
+ Layer.provide(BunPgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") }))
```

It reuses `@effect/sql-pg`'s SQL compiler (keep it installed) and matches its driver where it
matters: parameters typed by value (int4 / int8 / float8 / bool, strings untyped), int8 as BigInt,
numeric as string, and `SqlError` reasons classified from SQLSTATE (`UniqueViolation`, …). The
test suite runs the same probes through both clients and requires identical results.
Transactions with savepoints, cursor streams and server-side cancellation on interrupt are tested.

Known differences: `date` columns are `Date` objects (PgClient: `"YYYY-MM-DD"`), `time` is a string
(PgClient: BigInt microseconds), `bytea` is a `Buffer` (a `Uint8Array` subclass), `interval` is
Postgres text, and parameterless multi-statement strings run (PgClient rejects them).
Not ported: `listen` / `notify`, the `json` helper.

## What compiles today

| | Supported |
|---|---|
| Schemas | `Schema.Class`, `Schema.TaggedError` (with `{ httpApiStatus }`), `Schema.Struct` (named or inline), `String`, `NonEmptyString`, `Number`, `Finite`, `Int`, `Boolean`, `NumberFromString`, `NullOr`; `.check(...)` with `isMinLength`, `isMaxLength`, `isNonEmpty`, `isInt`, `isFinite`, `isGreaterThan(OrEqualTo)`, `isLessThan(OrEqualTo)`; brands |
| API | `HttpApi.make`, `HttpApiGroup.make(...).add(...).prefix(...)`, `HttpApiEndpoint.get/post/put/patch/delete(name, path, { params, payload, success, error })`, `HttpApiSchema.status(n)` / `NoContent` / `Created` |
| Services | `Context.Service<S, I>()("id")` with `static layer = Layer.effect(S, Effect.gen(...))` (or `make`), depending on `SqlClient` and other services |
| Data | `SqlSchema.findOne` / `findOneOption` / `findAll` / `findNonEmpty` / `void` over one `sql` template |
| Logic | `Effect.fn` / `Effect.fnUntraced` / arrows, `const x = yield* …`, `if/else`, `return yield* new E(…)`, `Option.isNone` guards, comparisons, arithmetic, `Effect.succeed/fail/die/void`, `.pipe(Effect.orDie \| catchTag \| catchTags \| mapError)` |
| Server | `HttpRouter.serve(..., { disableLogger, routerConfig })`, `BunHttpServer.layer({ port, hostname })`, `PgClient` / `BunPgClient` `.layerConfig({ url, maxConnections })` |
| Program | Entry file plus the local files it imports; helpers in imported files are skipped |

Anything else is a compile error that points at the line; nothing is guessed. Next up, roughly in
order: arrays and `map`/`filter`, loops, string methods, `query` params, `Effect.all` and
`forEach` (→ tokio), `sql.withTransaction`, `sql.in` / `sql.insert`, `Schema.Array` / `optional` /
`Literal` / `Union`, middleware, `Model.Class`, then `Schedule` and `Stream`.

How it maps:

| Effect 4 | Rust |
|---|---|
| `Effect.gen` / `Effect.fn` + `yield*` | `async fn` + `.await?` |
| `Effect.catchTags({ NoSuchElementError: () => new E(...), SqlError: Effect.die })` | `match` on `AppError` variants |
| `Schema.TaggedError` + `httpApiStatus` | `enum AppError` with `#[serde(tag = "_tag")]`, status per endpoint |
| `Schema.Class` + checks | struct + decoders for the JSON and StringTree codecs |
| `SqlSchema.*` | pipelined `tokio-postgres` queries; parameter types chosen per value, like the JS driver |
| `HttpRouter` (find-my-way) | `effect_rt::Router`, a port with the same normalization rules |
| `Context.Service` + `Layer` | plain functions over a `Ctx` |

Some things the compiler catches that `tsc` can't: `Schema.Int` reading a `bigint` column (the
driver returns a BigInt, so the Effect version fails at runtime), a column missing from a
query's result, and SQL Postgres rejects.

## Runtime comparison

`bun run compare` builds and runs the same Effect 4 program on every JS runtime, interpreted and
compiled, next to the effect2rust binary and hand-written Rust and C++ servers (the performance
ceiling). Every target first runs the 81-case contract against the reference (Effect on Bun),
then gets the same load. One run on a 2 vCPU VM where the load generator, server and Postgres
share the cores, so compare rows, not absolute numbers:

| Target | Contract | GET req/s · p99 | POST req/s · p99 | Memory | Startup | Build | Size |
|---|---|---|---|---|---|---|---|
| Node 22 | 69/81 (1 root diff) | 5,045 · 190 ms | 3,610 · 79 ms | 170→343 MB | 1,072 ms | | |
| Deno 2.9 | 69/81 (1 root diff) | 4,430 · 120 ms | 3,469 · 89 ms | 131→398 MB | 595 ms | | |
| Bun 1.4 | reference | 6,639 · 150 ms | 3,999 · 67 ms | 82→171 MB | 479 ms | | |
| Node SEA | 69/81 (1 root diff) | 5,311 · 191 ms | 3,813 · 75 ms | 85→147 MB | 229 ms | 8.3 s | 118 MB |
| `deno compile` | 69/81 (1 root diff) | 4,806 · 120 ms | 4,023 · 80 ms | 152→413 MB | 429 ms | 4.8 s | 186 MB |
| `bun build --compile` | 81/81 | 6,855 · 151 ms | 4,416 · 63 ms | 54→112 MB | 90 ms | 0.7 s | 82 MB |
| **Rust (effect2rust)** | **81/81** | **23,249 · 4.9 ms** | **9,902 · 12.4 ms** | **9→16 MB** | **32 ms** | 24 s | 1.6 MB |
| Rust, hand-written (axum + tokio-postgres) | 31/81 (44 root diffs) | 23,748 · 5.0 ms | 9,681 · 13.6 ms | 10→14 MB | 77 ms | 57 s* | 1.5 MB |
| C++, hand-written (Drogon) | 35/81 (39 root diffs) | 28,829 · 4.2 ms | 9,264 · 11.6 ms | 14 MB | 51 ms | 10 s* | 324 KB† |

<sub>Effect targets use `@effect/sql-pg` and request logging off; Node and Deno run the same program on
`node:http` (`api-node.ts`), Bun on `Bun.serve` (`api.ts`). JS runtimes are single-threaded;
Rust and C++ use both cores. Builds marked * are clean builds (the table's 0.2 s were cached).
† dynamically linked to Drogon. "Root diffs" exclude cascades, where an earlier difference
shifted auto-increment ids for later requests.</sub>

What this shows:

- **The same Effect program isn't identical across JS runtimes.** On Node and Deno, a JSON body
  starting with a UTF-8 byte-order mark is a 400; on Bun it's accepted (Bun's `request.text()`
  strips the BOM). The compiled binary follows its reference exactly.
- **C/C++ isn't meaningfully faster than Rust here.** Hand-written Rust and C++ are within ~10% of
  each other (C++ ahead on reads, Rust on writes). What mattered was the database driver:
  effect2rust doubled its throughput by switching from sqlx to pipelined tokio-postgres, the same
  technique Drogon uses. effect2rust now runs at ~98% of hand-written Rust and ~80% of C++ on reads,
  and leads on writes.
- **Hand-written code pays for its speed in the contract.** The C++ server answers
  `GET /todos/1.5` and `GET /todos/1e400` with **todo #1** (its integer conversion stops at the
  first non-digit) and returns 500s for `/todos/abc`; both hand-written servers differ from the
  Effect API on 40+ of 81 requests. effect2rust matches all 81 while staying in the same
  performance tier.

`bun run compare -- --no-build --skip-bench` re-runs just the contract. Deno compile downloads
`denort` unless `DENORT_BIN` points at a local copy; the C++ target needs Drogon
(`apt install libdrogon-dev libpq-dev libjsoncpp-dev uuid-dev`).

## Develop

```sh
bun install
psql "$DATABASE_URL" -f examples/todos/schema.sql
bun run typecheck && bun test                # compiler + BunPgClient tests (needs DATABASE_URL)
(cd runtime && cargo test)
bun run example:check
bun run example:build                        # → examples/todos/rust/target/release/api_server
bun run example:diff                         # PgClient vs BunPgClient vs Rust, 81 cases
contract/bench.sh --get /todos/500 --post /todos --body '{"title":"x"}' \
  --seed "TRUNCATE todos RESTART IDENTITY; INSERT INTO todos (title) SELECT 'todo ' || g FROM generate_series(1, 1000) g" \
  --cwd examples/todos "effect=bun api.ts" "rust=rust/target/release/api_server"   # needs `cargo install oha`
```

| Path | |
|---|---|
| `compiler/src/` | `cli.ts`, `frontend.ts` (TS AST → IR, lowering generators and error channels), `introspect.ts` (Postgres describes queries), `backend.ts` (IR → Rust) |
| `runtime/` | `effect_rt`: router, body handling, Schema codecs, value-typed SQL, JS number semantics |
| `bun-pg-client/` | `BunPgClient` and its tests |
| `contract/` | `diff.sh` (differential contract test), `bench.sh`, `contract.ts` |
| `examples/todos/` | The example (`api.ts` on `@effect/sql-pg`, `api-bunpg.ts` on BunPgClient, `api-node.ts` on `node:http`), schema, contract cases, `compare-runtimes.ts`, hand-written `cpp/` and `rust-handwritten/` baselines |
