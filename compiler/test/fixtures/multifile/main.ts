import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer, Schema } from "effect"
import * as BunPgClient from "effect2rust/BunPgClient"
import { CreateTodo, Todo, TodoNotFound } from "./domain"
import { TodoRepo } from "./repo"

class TodosGroup extends HttpApiGroup.make("todos")
  .add(HttpApiEndpoint.get("getTodo", "/todos/:id").setPath(Schema.Struct({ id: Schema.NumberFromString.pipe(Schema.int()) })).addSuccess(Todo).addError(TodoNotFound, { status: 404 }))
  .add(HttpApiEndpoint.post("createTodo", "/todos").setPayload(CreateTodo).addSuccess(CreateTodo, { status: 201 })) {}

class Api extends HttpApi.make("api").add(TodosGroup) {}

const TodosLive = HttpApiBuilder.group(Api, "todos", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* TodoRepo
    return handlers
      .handle("getTodo", ({ path }) => repo.findById(path.id))
      .handle("createTodo", ({ payload }) => repo.create(payload).pipe(Effect.orDie))
  }),
)

HttpApiBuilder.serve().pipe(
  Layer.provide(HttpApiBuilder.api(Api).pipe(Layer.provide(TodosLive))),
  Layer.provide(TodoRepo.Default),
  Layer.provide(BunPgClient.layerConfig({ url: Config.redacted("DATABASE_URL") })),
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
  Layer.launch,
  BunRuntime.runMain,
)
