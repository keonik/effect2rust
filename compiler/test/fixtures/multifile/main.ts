import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import * as BunPgClient from "effect2rust/BunPgClient"
import { CreateTodo, Todo, TodoNotFound } from "./domain"
import { TodoRepo } from "./repo"

class TodosGroup extends HttpApiGroup.make("todos").add(
  HttpApiEndpoint.get("getTodo", "/todos/:id", { params: { id: Schema.Int }, success: Todo, error: TodoNotFound }),
  HttpApiEndpoint.post("createTodo", "/todos", { payload: CreateTodo, success: Todo.pipe(HttpApiSchema.status(201)) }),
) {}

class Api extends HttpApi.make("api").add(TodosGroup) {}

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

const AppLive = HttpRouter.serve(HttpApiBuilder.layer(Api).pipe(Layer.provide(TodosLive)), { disableLogger: true }).pipe(
  Layer.provide(TodoRepo.layer),
  Layer.provide(BunPgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })),
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
)

Layer.launch(AppLive).pipe(BunRuntime.runMain)
