import { Schema } from "effect"

export type TodoId = number // type-only: ignored

export const Todo = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  done: Schema.Boolean,
})

export class CreateTodo extends Schema.Class<CreateTodo>("CreateTodo")({
  title: Schema.String.pipe(Schema.trimmed()), // unsupported refinement
}) {}

export class TodoNotFound extends Schema.TaggedError<TodoNotFound>()("TodoNotFound", { id: Schema.Int }) {}

export const formatTitle = (t: string) => t.trim() // helper: skipped
