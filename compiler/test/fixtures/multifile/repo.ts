import { SqlClient, SqlSchema } from "@effect/sql"
import { Effect, Option, Schema } from "effect"
import { CreateTodo, Todo, TodoNotFound } from "./domain"

export class TodoRepo extends Effect.Service<TodoRepo>()("TodoRepo", {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const findOne = SqlSchema.findOne({
      Request: Schema.Int,
      Result: Todo,
      execute: (id) => sql`SELECT id, title, done FROM todos WHERE id = ${id}`,
    })
    const findMany = SqlSchema.findAll({
      Request: Schema.Array(Schema.Int), // unsupported schema
      Result: Todo,
      execute: (ids) => sql`SELECT id, title, done FROM todos WHERE id IN ${sql.in(ids)}`,
    })
    return {
      findById: (id: number) =>
        Effect.gen(function* () {
          const todo = yield* findOne(id).pipe(Effect.orDie)
          if (Option.isNone(todo)) return yield* new TodoNotFound({ id })
          return todo.value
        }),
      create: (input: CreateTodo) =>
        Effect.all([findOne(1), findOne(2)]).pipe(Effect.as(input)), // unsupported effect
      findMany,
    }
  }),
}) {}
