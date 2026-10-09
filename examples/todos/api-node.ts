// Same program as api.ts on node:http (NodeHttpServer), for Node, Deno and their compiled forms.
// reusePort lets several processes share port 3000 (Linux, Node ≥ 23.1); one process is unaffected.
// deps: effect @effect/platform-bun @effect/sql-pg   (schema: ./schema.sql)
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { createServer } from "node:http"
import { PgClient } from "@effect/sql-pg"
import { Config, Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { SqlClient, SqlSchema } from "effect/sql"

// ── Domain ──
export class Todo extends Schema.Class<Todo>("Todo")({
  id: Schema.Int,
  title: Schema.String,
  done: Schema.Boolean,
}) {}

export class CreateTodo extends Schema.Class<CreateTodo>("CreateTodo")({
  title: Schema.String.check(Schema.isMinLength(1)),
}) {}

export class TodoNotFound extends Schema.TaggedError<TodoNotFound>()("TodoNotFound", { id: Schema.Int }, { httpApiStatus: 404 }) {}

// ── API contract ──
export class TodosGroup extends HttpApiGroup.make("todos").add(
  HttpApiEndpoint.get("getTodo", "/todos/:id", {
    params: { id: Schema.Int },
    success: Todo,
    error: TodoNotFound,
  }),
  HttpApiEndpoint.post("createTodo", "/todos", {
    payload: CreateTodo,
    success: Todo.pipe(HttpApiSchema.status(201)),
  }),
) {}

export class Api extends HttpApi.make("api").add(TodosGroup) {}

// ── Repository ──
export class TodoRepo extends Context.Service<TodoRepo, {
  findById(id: number): Effect.Effect<Todo, TodoNotFound>
  create(input: CreateTodo): Effect.Effect<Todo>
}>()("app/TodoRepo") {
  static readonly layer = Layer.effect(
    TodoRepo,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const findOne = SqlSchema.findOne({
        Request: Schema.Int,
        Result: Todo,
        execute: (id) => sql`SELECT id, title, done FROM todos WHERE id = ${id}`,
      })

      const insert = SqlSchema.findOne({
        Request: CreateTodo,
        Result: Todo,
        execute: (t) => sql`INSERT INTO todos (title, done) VALUES (${t.title}, false) RETURNING id, title, done`,
      })

      const findById = Effect.fn("TodoRepo.findById")((id: number) =>
        findOne(id).pipe(
          Effect.catchTags({
            NoSuchElementError: () => new TodoNotFound({ id }),
            SchemaError: Effect.die,
            SqlError: Effect.die,
          }),
        ),
      )

      const create = Effect.fn("TodoRepo.create")((input: CreateTodo) => insert(input).pipe(Effect.orDie))

      return TodoRepo.of({ findById, create })
    }),
  )
}

// ── Handlers ──
const TodosLive = HttpApiBuilder.group(
  Api,
  "todos",
  Effect.fn(function* (handlers) {
    const repo = yield* TodoRepo
    return handlers.handleAll({
      getTodo: ({ params }) => repo.findById(params.id),
      createTodo: ({ payload }) => repo.create(payload),
    })
  }),
)

// ── Wiring ──
const ApiLive = HttpApiBuilder.layer(Api).pipe(Layer.provide(TodosLive))

// disableLogger: per-request logs cost ~35% throughput; the compiled server doesn't log them either.
const AppLive = HttpRouter.serve(ApiLive, { disableLogger: true }).pipe(
  Layer.provide(TodoRepo.layer),
  Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000, host: "0.0.0.0", reusePort: true })),
)

Layer.launch(AppLive).pipe(NodeRuntime.runMain)
