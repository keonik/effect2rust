// Intermediate representation shared by the frontend (TS → IR) and backend (IR → Rust).
import type ts from "typescript"

/** A Schema, as written in the Effect program. */
export type STy =
  | { k: "string"; refine: Refine[] }
  | { k: "int" }
  | { k: "number" }
  | { k: "boolean" }
  | { k: "numberFromString"; int: boolean }
  | { k: "ref"; name: string }

export type Refine = { k: "minLength"; n: number } | { k: "maxLength"; n: number }

/** A Rust type in generated code. */
export type RTy =
  | { k: "i64" }
  | { k: "f64" }
  | { k: "String" }
  | { k: "bool" }
  | { k: "unit" }
  | { k: "never" }
  | { k: "cls"; name: string }
  | { k: "option"; of: RTy }
  | { k: "vec"; of: RTy }

export interface Field {
  name: string
  ty: STy
}

/** `Schema.Class` or `Schema.TaggedError`. */
export interface ClassDef {
  name: string
  error: boolean
  tag: string
  fields: Field[]
}

export interface Endpoint {
  group: string
  name: string
  method: "get" | "post" | "put" | "patch" | "delete"
  path: string
  pathFields: Field[] | null
  payload: STy | null
  success: { ty: STy | null; status: number }
  errors: { name: string; status: number }[]
}

/** `SqlSchema.findOne | single | findAll | void` with a single `sql` template. */
export interface Query {
  service: string
  name: string
  mode: "findOne" | "single" | "findAll" | "void"
  request: STy
  result: STy | null
  requestParam: string
  sql: string
  /** Template interpolations: a path rooted at the request param, e.g. [] or ["title"]. */
  binds: { path: string[]; node: ts.Node }[]
  node: ts.Node
  /** Filled by introspection. */
  db?: { params: string[]; columns: { name: string; type: string }[] }
}

/** A lowered function: Rust statements plus its success type. */
export interface Fn {
  rustName: string
  params: { name: string; ty: RTy; byRef: boolean }[]
  body: string[]
  ret: RTy
}

export interface Handler {
  endpoint: Endpoint
  fn: Fn
  /** Names bound by the handler's destructured argument. */
  uses: { path: boolean; payload: boolean }
}

export interface Program {
  classes: Map<string, ClassDef>
  endpoints: Endpoint[]
  queries: Query[]
  methods: Fn[]
  handlers: Handler[]
  server: { port: number; maxConnections: number; dbUrlEnv: string }
}
