// Effect + @effect/sql-pg + HttpApi (Bun runtime)
// deps: effect @effect/platform @effect/platform-bun @effect/sql @effect/sql-pg (its SQL compiler only)
// Postgres via Bun's native driver (effect2rust/BunPgClient); api-pg.ts is the same program on the `pg` package
//
// schema.sql (shared by both servers):
//   CREATE TABLE todos (id serial PRIMARY KEY, title text NOT NULL, done boolean NOT NULL DEFAULT false);
//   (serial/int4 on purpose: bigint comes back as a string from most JS drivers)

import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { SqlClient, SqlSchema } from "@effect/sql"
import { Config, Effect, Layer, Option, Schema } from "effect"
import * as BunPgClient from "effect2rust/BunPgClient"

// ── Domain: schemas are runtime-validated, so types hold inside the program ──
// Rust: #[derive(Serialize, FromRow)] struct Todo
export class Todo extends Schema.Class<Todo>("Todo")({
  id: Schema.Int,
  title: Schema.String,
  done: Schema.Boolean,
}) {}

// Rust: #[derive(Deserialize)] struct CreateTodo + explicit validation
export class CreateTodo extends Schema.Class<CreateTodo>("CreateTodo")({
  title: Schema.String.pipe(Schema.minLength(1)),
}) {}

// Rust: ApiError::TodoNotFound { id }  (serialized as { "_tag": "TodoNotFound", "id": n })
export class TodoNotFound extends Schema.TaggedError<TodoNotFound>()(
  "TodoNotFound",
  { id: Schema.Int },
) {}

// ── API contract: pure data, so it can be read and code-generated from ──
// Rust: Router::new().route(...)
export class TodosGroup extends HttpApiGroup.make("todos")
  .add(
    HttpApiEndpoint.get("getTodo", "/todos/:id")
      .setPath(Schema.Struct({ id: Schema.NumberFromString.pipe(Schema.int()) }))
      .addSuccess(Todo)
      .addError(TodoNotFound, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.post("createTodo", "/todos")
      .setPayload(CreateTodo)
      .addSuccess(Todo, { status: 201 }),
  ) {}

export class Api extends HttpApi.make("api").add(TodosGroup) {}
// Type-safe client (the Hono RPC equivalent):
//   const client = yield* HttpApiClient.make(Api, { baseUrl: "http://localhost:3000" })

// ── Repository: a service with explicit dependencies ──
// Rust: plain functions taking &PgPool; sqlx query_as! checks SQL at compile time
export class TodoRepo extends Effect.Service<TodoRepo>()("TodoRepo", {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const findOne = SqlSchema.findOne({
      Request: Schema.Int,
      Result: Todo,
      execute: (id) => sql`SELECT id, title, done FROM todos WHERE id = ${id}`,
    })

    const insert = SqlSchema.single({
      Request: CreateTodo,
      Result: Todo,
      execute: (t) =>
        sql`INSERT INTO todos (title, done) VALUES (${t.title}, false) RETURNING id, title, done`,
    })

    return {
      // Rust: fetch_optional(..).await?.ok_or(ApiError::TodoNotFound { id })?
      findById: (id: number) =>
        Effect.gen(function* () {
          const todo = yield* findOne(id).pipe(Effect.orDie) // SqlError -> 500, like From<sqlx::Error>
          if (Option.isNone(todo)) return yield* new TodoNotFound({ id })
          return todo.value
        }),
      // Rust: fetch_one(..).await?
      create: (input: CreateTodo) => insert(input).pipe(Effect.orDie),
    }
  }),
}) {}

// ── Handlers ──
// Rust: async fn get_todo / create_todo
const TodosLive = HttpApiBuilder.group(Api, "todos", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* TodoRepo
    return handlers
      .handle("getTodo", ({ path }) => repo.findById(path.id))
      .handle("createTodo", ({ payload }) => repo.create(payload))
  }),
)

// ── Wiring: Layers = dependency injection ──
// Rust: PgPool::connect + .with_state(db)
const ApiLive = HttpApiBuilder.api(Api).pipe(Layer.provide(TodosLive))
const PgLive = BunPgClient.layerConfig({ url: Config.redacted("DATABASE_URL") })

HttpApiBuilder.serve().pipe(
  Layer.provide(ApiLive),
  Layer.provide(TodoRepo.Default),
  Layer.provide(PgLive),
  Layer.provide(BunHttpServer.layer({ port: 3000, reusePort: true })),
  Layer.launch,
  BunRuntime.runMain,
)
