# effect2rust

Write the server once in [Effect 4](https://effect.website). Get a native Rust binary
that behaves identically, plus a faster Postgres client if you stay on Bun.

```
your Effect app ──tsc──▶ lower Effect.gen / Effect.fn to Rust ──▶ Postgres describes every query ──▶ axum + sqlx crate ──cargo──▶ ~2 MB binary
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
| `SqlSchema.*` | runtime `sqlx` queries; parameter types chosen per value, like the JS driver |
| `HttpRouter` (find-my-way) | `effect_rt::Router`, a port with the same normalization rules |
| `Context.Service` + `Layer` | plain functions over a `Ctx` |

Some things the compiler catches that `tsc` can't: `Schema.Int` reading a `bigint` column (the
driver returns a BigInt, so the Effect version fails at runtime), a column missing from a
query's result, and SQL Postgres rejects.

## Results (todos example, 2 vCPU VM: load generator, server and Postgres share the cores)

| | GET req/s · p99 | POST req/s · p99 | memory | startup |
|---|---|---|---|---|
| Effect 4 + `@effect/sql-pg` | 10,520 · 97.8 ms | 6,377 · 37.0 ms | 53→115 MB | 69 ms |
| Effect 4 + BunPgClient | 11,830 · 9.8 ms | 8,057 · 14.9 ms | 54→99 MB | 70 ms |
| **Rust (effect2rust)** | **17,991 · 5.4 ms** | **8,291 · 10.1 ms** | **10→16 MB** | **9 ms** |

Bun rows are `bun build --compile --minify --bytecode --format=esm` executables with request
logging off (`HttpRouter.serve(app, { disableLogger: true })`). Effect 4's default per-request
logging costs about 35% of throughput; the compiled server doesn't log requests.

Contract: 81/81 identical across all three. Build: ~75 s clean release build, ~21 s after a
change, 1.9 MB binary, `target/` ~300 MB.

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
| `examples/todos/` | The example (`api.ts` on `@effect/sql-pg`, `api-bunpg.ts` on BunPgClient), schema, contract cases |
