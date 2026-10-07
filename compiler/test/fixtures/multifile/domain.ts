import { Schema } from "effect"

export type TodoId = number // type-only: ignored

export const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))

export const Todo = Schema.Struct({
  id: Schema.Int,
  title: Title,
  done: Schema.Boolean,
})

export class CreateTodo extends Schema.Class<CreateTodo>("CreateTodo")({
  title: Schema.Trimmed, // unsupported schema
}) {}

export class TodoNotFound extends Schema.TaggedError<TodoNotFound>()("TodoNotFound", { id: Schema.Int }, { httpApiStatus: 404 }) {}

export const formatTitle = (t: string) => t.trim() // helper: skipped
