# effect2rust

Write the server once in [Effect](https://effect.website). Get a native Rust binary that
behaves identically, plus a faster Postgres client if you stay on Bun.

```
your Effect app ──tsc──▶ lower Effect.gen to Rust ──▶ Postgres describes every query ──▶ axum + sqlx crate ──cargo──▶ ~2 MB binary
```

This is not an OpenAPI translator. It compiles the program itself: `Effect.gen` bodies,
`yield*`, `Option` guards, typed errors, services, Schema validation (down to the exact
error messages), and SQL checked against your real database at compile time.

Two things in this repo:

| | What it is | Status |
|---|---|---|
| **`effect2rust` CLI** | Effect → Rust compiler + differential contract tester | Prototype: a small, growing subset of Effect |
| **`effect2rust/BunPgClient`** | Drop-in `@effect/sql` client on Bun's native Postgres driver | Usable: ~30% faster than `@effect/sql-pg`, identical behavior |

## Use it in your Effect repos

Requirements: Bun (tested on 1.4.2), **Effect 3.x** (Effect 4 moved the HTTP modules; not supported yet),
and for `build`: a Rust toolchain (`rustup`), `psql`, and a Postgres with your schema.

```sh
bun add -d github:keonik/effect2rust        # private repo: uses your git credentials
# or: bun add -d git+ssh://git@github.com:keonik/effect2rust.git

# 1. What compiles today, and every construct that doesn't (across the files your entry imports)
bunx effect2rust check src/main.ts
DATABASE_URL=postgres://… bunx effect2rust check src/main.ts      # also checks SQL against your schema

# 2. Build the native server
DATABASE_URL=postgres://… bunx effect2rust build src/main.ts --out rust --release
./rust/target/release/main_server

# 3. Prove it behaves identically: same requests against both, compare every status and body
node_modules/effect2rust/contract/diff.sh --cases contract-cases.json \
  --reset 'TRUNCATE todos RESTART IDENTITY' \
  "effect=bun src/main.ts" "rust=./rust/target/release/main_server"
```

`check` is the place to start on an existing repo. It lists each unsupported construct
once, at its source (`repo.ts:26:9: unsupported Effect Effect.all(...)`), so you can see
how far your codebase is from compiling and what to add to the compiler next.

Contract cases are plain JSON (see `examples/todos/contract-cases.json`):

```json
[{ "method": "GET", "path": "/todos/1" },
 { "method": "POST", "path": "/todos", "body": "{\"title\":\"x\"}", "contentType": "application/json" }]
```

Put the edge cases there: bad input, wrong types, missing fields, huge ids, Unicode.
That's where implementations drift. The suite here caught three real divergences while
building this (a stale binary, and two driver parameter-typing differences).

### BunPgClient (staying on Bun)

```diff
- import { PgClient } from "@effect/sql-pg"
+ import * as BunPgClient from "effect2rust/BunPgClient"

- const PgLive = PgClient.layerConfig({ url: Config.redacted("DATABASE_URL") })
+ const PgLive = BunPgClient.layerConfig({ url: Config.redacted("DATABASE_URL") })
```

Same SQL compiler as `@effect/sql-pg` (keep it installed), same row values, and
parameters serialized with `pg`'s own `prepareValue`, so Postgres infers parameter types
exactly as before. Without that, `WHERE int4_col = 99999999999` silently becomes a 404
instead of a 500. Tested: transactions and nested savepoints, cursor streams,
`sql.insert`/`sql.in`, server-side cancellation on fiber interrupt, error mapping.
Not ported: `listen`/`notify`, the `json` helper, custom `types`.

## What compiles today

| | Supported |
|---|---|
| Schemas | `Schema.Class`, `Schema.TaggedError`, `const X = Schema.Struct({...})` with `String`, `Int`, `Number`, `Boolean`, `NumberFromString`; `minLength`, `maxLength`, `int` |
| API | `HttpApi` / `HttpApiGroup` / `HttpApiEndpoint` with `setPath`, `setPayload`, `addSuccess`, `addError` (status codes) |
| Data | `Effect.Service` with `SqlSchema.findOne/single/findAll/void` over one `sql` template |
| Logic | `const x = yield* …`, `if (Option.isNone(x)) return yield* new E(…)`, `if/else`, `return`, comparisons, arithmetic, `Effect.succeed/fail`, `.pipe(Effect.orDie)`, service-to-service calls |
| Program | Entry file plus the local files it imports; helpers in imported files are skipped |

Anything else is a compile error that points at the line; nothing is guessed. Roughly
in order, next up: arrays and `map`/`filter`, loops, string methods, `Effect.all` and
`forEach` (→ tokio), `sql.withTransaction` (→ sqlx transactions), `sql.in`/`sql.insert`,
`Schema.Array`/`optional`/`Literal`/`Union`, then `Schedule`, `Stream`, and Effect 4.

How it maps:

| Effect | Rust |
|---|---|
| `Effect.gen` + `yield*` | `async fn` + `.await?` |
| `Option.isNone` guard returning a failure | `let Some(x) = x else { return Err(...) };` |
| `Schema.TaggedError` (the `E` channel) | `enum AppError` with `#[serde(tag = "_tag")]` |
| `.pipe(Effect.orDie)` | `.map_err(AppError::into_defect)` → empty 500 |
| `Schema.Class` + refinements | struct + decoder with Effect's exact `ParseIssue`s |
| `SqlSchema.*` | `sqlx::query!`, checked against the live schema at build time |
| `Effect.Service`, `Layer` | plain functions over a `Ctx` |

The compiler also catches bugs `tsc` can't, like `Schema.Int` reading a `bigint`
column (JS drivers return bigint as a string, so the Effect version would fail at runtime).

## Results (todos example, 2 vCPU VM: load generator, server and Postgres share the cores)

| | GET req/s · p99 | POST req/s · p99 | memory | startup |
|---|---|---|---|---|
| Effect + `@effect/sql-pg` (`bun build --compile --bytecode`) | 4,089 · 28.5 ms | 3,126 · 32.2 ms | 61→116 MB | 88 ms |
| Effect + BunPgClient | 5,253 · 18.8 ms | 4,127 · 26.7 ms | 60→110 MB | 90 ms |
| Effect + BunPgClient, 2 processes (`reusePort`) | 6,480 · 23.6 ms | 4,028 · 38.3 ms | 126→220 MB | 113 ms |
| **Rust (effect2rust)** | **20,195 · 4.8 ms** | **8,015 · 11.6 ms** | **10→16 MB** | **26 ms** |
| *Plain Bun.serve + Bun.sql, no Effect (GET only)* | *20,974 · 5.9 ms* | | *81 MB* | |

Contract: 33/33 identical across all three implementations. A CPU profile puts ~55% of the
Bun version's time in Effect's fiber runtime, versus ~1% in app code; tracing isn't the cost.
Bun itself is as fast as Rust here. Effect's per-request runtime (~140 µs CPU/request) is
the gap, which is what compiling removes while keeping Effect as the source of truth.

Build cost: ~90 s clean release build, ~20 s after a change, 1.9 MB binary, `target/` ~1.8 GB.

## Develop

```sh
bun install
psql "$DATABASE_URL" -f examples/todos/schema.sql
bun run typecheck && bun test                # compiler + BunPgClient tests (needs DATABASE_URL)
bun run example:check
bun run example:build                        # → examples/todos/rust/target/release/api_server
bun run example:diff                         # pg vs BunPgClient vs Rust, 33 cases
contract/bench.sh --get /todos/500 --post /todos --body '{"title":"x"}' \
  --seed "TRUNCATE todos RESTART IDENTITY; INSERT INTO todos (title) SELECT 'todo ' || g FROM generate_series(1, 1000) g" \
  --cwd examples/todos "effect=bun api.ts" "rust=rust/target/release/api_server"   # needs `cargo install oha`
```

| Path | |
|---|---|
| `compiler/src/` | `cli.ts`, `frontend.ts` (TS AST → IR, lowering `Effect.gen`), `introspect.ts` (Postgres describes queries), `backend.ts` (IR → Rust) |
| `runtime/` | `effect_rt`: the Rust crate mirroring Effect semantics (Schema decoding and messages, JS `Number()` parsing/formatting, HttpApi bodies, defects) |
| `bun-pg-client/` | `BunPgClient` and its tests |
| `contract/` | `diff.sh` (differential contract test), `bench.sh`, `contract.ts` |
| `examples/todos/` | The example app (`api.ts` on BunPgClient, `api-pg.ts` on `@effect/sql-pg`), schema, contract cases |
