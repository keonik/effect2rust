// Intermediate representation shared by the frontend (Effect 4 TS → IR) and backend (IR → Rust).
import type ts from "typescript"

/** A value check from `.check(...)` / `Schema.check(...)`. */
export type Check =
  | { k: "minLength" | "maxLength"; n: number }
  | { k: "gt" | "gte" | "lt" | "lte"; n: number }

/** A Schema, as written in the Effect program. */
export type STy =
  | { k: "string"; checks: Check[] }
  /** Schema.Number / Finite / Int (int implies finite). JSON numbers. */
  | { k: "number"; int: boolean; finite: boolean; checks: Check[] }
  /** Schema.NumberFromString: a string decoded with JS `Number(s)`, then checked. */
  | { k: "numberFromString"; int: boolean; finite: boolean; checks: Check[] }
  | { k: "boolean" }
  | { k: "nullOr"; of: STy }
  | { k: "ref"; name: string }

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

/** `Schema.Class`, `Schema.Struct` (named) or `Schema.TaggedError`. */
export interface ClassDef {
  name: string
  error: boolean
  tag: string
  fields: Field[]
  /** For errors: the `httpApiStatus` annotation. */
  status?: number
}

export interface Endpoint {
  group: string
  name: string
  method: "get" | "post" | "put" | "patch" | "delete"
  /** Full path including group/api prefixes, e.g. /todos/:id */
  path: string
  params: Field[] | null
  /** A struct/class reference (inline payload structs are synthesized as classes). */
  payload: { ty: STy } | null
  /** null type = no content. */
  success: { ty: STy | null; status: number }
  errors: { name: string; status: number }[]
  node: ts.Node
}

export type QueryMode = "findOne" | "findOneOption" | "findAll" | "findNonEmpty" | "void"

/** `SqlSchema.*` with a single `sql` template. */
export interface Query {
  service: string
  name: string
  mode: QueryMode
  request: STy | null // null = Schema.Void
  result: STy | null
  requestParam: string
  /** SQL text split around parameters: parts.length === binds.length + 1 */
  parts: string[]
  /** Template interpolations: a path rooted at the request param, e.g. [] or ["title"]. */
  binds: { path: string[]; node: ts.Node }[]
  node: ts.Node
  /** Filled by introspection. */
  db?: { params: string[]; columns: { name: string; type: string }[] }
}

/** A lowered function: Rust statements plus its success type and possible failures. */
export interface Fn {
  rustName: string
  params: { name: string; ty: RTy; byRef: boolean }[]
  body: string[]
  ret: RTy
  /** Error tags this function can fail with (user errors + NoSuchElementError | SqlError | SchemaError). */
  errors: Set<string>
}

export interface Handler {
  endpoint: Endpoint
  fn: Fn
  uses: { params: boolean; payload: boolean }
}

export interface RouterConfig {
  caseSensitive: boolean
  ignoreTrailingSlash: boolean
  ignoreDuplicateSlashes: boolean
  maxParamLength: number
}

export interface Program {
  classes: Map<string, ClassDef>
  endpoints: Endpoint[]
  queries: Query[]
  methods: Fn[]
  handlers: Handler[]
  server: {
    port: number
    hostname: string | null
    maxConnections: number
    dbUrlEnv: string
    logRequests: boolean
    router: RouterConfig
  }
}

/** Errors every SQL query can raise (findOne / findNonEmpty add NoSuchElementError). */
export const BUILTIN_ERRORS = ["NoSuchElementError", "SqlError", "SchemaError"] as const
