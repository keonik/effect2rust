import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { CreateTodo, Todo, TodoNotFound } from "./domain"

export class TodoRepo extends Context.Service<TodoRepo, {
  findById(id: number): Effect.Effect<typeof Todo.Type, TodoNotFound>
  create(input: CreateTodo): Effect.Effect<typeof Todo.Type>
  findMany(ids: ReadonlyArray<number>): Effect.Effect<Array<typeof Todo.Type>, any>
}>()("fixture/TodoRepo") {
  static readonly layer = Layer.effect(
    TodoRepo,
    Effect.gen(function* () {
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
      const findById = Effect.fn("TodoRepo.findById")((id: number) =>
        findOne(id).pipe(Effect.catchTags({ NoSuchElementError: () => new TodoNotFound({ id }), SchemaError: Effect.die, SqlError: Effect.die })),
      )
      const create = (input: CreateTodo) =>
        Effect.all([findOne(1), findOne(2)]).pipe(Effect.as({ id: 1, title: input.title, done: false }), Effect.orDie) // unsupported effect
      return TodoRepo.of({ findById, create, findMany })
    }),
  )
}
