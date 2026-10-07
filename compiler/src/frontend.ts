// Frontend: Effect 4 program (TypeScript AST) → IR.
//
// Supported subset (anything else is a compile error that points at the code):
//   Schemas    Schema.Class, Schema.TaggedError (+ { httpApiStatus }), Schema.Struct (named or inline),
//              String, NonEmptyString, Number, Finite, Int, Boolean, NumberFromString, FiniteFromString,
//              NullOr; .check(...) / .pipe(Schema.check(...)) with isMinLength, isMaxLength, isNonEmpty,
//              isInt, isFinite, isGreaterThan(OrEqualTo), isLessThan(OrEqualTo); brands are ignored
//   API        HttpApi.make / HttpApiGroup.make(...).add(...).prefix(...) /
//              HttpApiEndpoint.<method>(name, path, { params, payload, success, error })
//              with HttpApiSchema.status(n), NoContent, Created
//   Services   Context.Service<S, I>()("id") with `static layer = Layer.effect(S, Effect.gen(...))`
//              (or the `make` option): yield* SqlClient / other services, SqlSchema queries,
//              methods as arrows, Effect.fn(...)(...), Effect.fnUntraced(...)
//   Effects    queries, service calls, new TaggedError (yieldable), Effect.succeed / fail / die / void,
//              .pipe(Effect.orDie | Effect.catchTag(s) | Effect.mapError), Effect.orDie(x)
//   Statements const x = yield* ..., if/else, return [yield*] ..., Option.isNone guards,
//              comparisons, arithmetic
//   Handlers   HttpApiBuilder.group(Api, "g", Effect.fn(function* (handlers) { ... handleAll / handle }))
//   Wiring     HttpRouter.serve(..., { disableLogger, routerConfig }), BunHttpServer.layer({ port, hostname }),
//              PgClient / BunPgClient .layerConfig({ url: Config.Redacted("ENV"), maxConnections })
import ts from "typescript"
import type { Check, ClassDef, Endpoint, Field, Fn, Handler, Program, Query, QueryMode, RTy, STy } from "./ir"

export class CompileError extends Error {
  constructor(readonly node: ts.Node | undefined, message: string) {
    super(message)
  }
}

const fail = (node: ts.Node | undefined, message: string): never => {
  throw new CompileError(node, message)
}

export const snake = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase()
const upperFirst = (s: string) => s[0]!.toUpperCase() + s.slice(1)

// ───────────────────────── AST helpers ─────────────────────────

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) ? unwrap(e.expression) : e

/** "Schema.Class" for an identifier / property-access chain, else null. */
function dotted(e: ts.Node): string | null {
  if (ts.isParenthesizedExpression(e)) return dotted(e.expression)
  if (ts.isIdentifier(e)) return e.text
  if (e.kind === ts.SyntaxKind.ThisKeyword) return "this"
  if (ts.isPropertyAccessExpression(e)) {
    const left = dotted(e.expression)
    return left && `${left}.${e.name.text}`
  }
  return null
}

/** Name of the called function, ignoring type arguments: `Schema.TaggedError<X>()` → "Schema.TaggedError". */
const calleeName = (e: ts.Node): string | null => (ts.isCallExpression(e) ? dotted(e.expression) : null)

/** `a.b(x).c(y)` → [{ target: a.b(x), name: "c", args: [y] }, ...] from outermost. Returns base expression and calls (in order). */
function methodChain(e: ts.Expression): { base: ts.Expression; calls: { name: string; args: readonly ts.Expression[]; node: ts.CallExpression }[] } {
  const calls: { name: string; args: readonly ts.Expression[]; node: ts.CallExpression }[] = []
  let cur = unwrap(e)
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) && !dotted(cur.expression)) {
    calls.unshift({ name: cur.expression.name.text, args: cur.arguments, node: cur })
    cur = unwrap(cur.expression.expression)
  }
  return { base: cur, calls }
}

function stringLit(e: ts.Node | undefined, what: string): string {
  if (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) return e.text
  return fail(e, `${what} must be a string literal`)
}

function numberLit(e: ts.Node | undefined, what: string): number {
  if (e && ts.isNumericLiteral(e)) return Number(e.text)
  if (e && ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text)
  return fail(e, `${what} must be a numeric literal`)
}

function boolLit(e: ts.Node | undefined, what: string): boolean {
  if (e?.kind === ts.SyntaxKind.TrueKeyword) return true
  if (e?.kind === ts.SyntaxKind.FalseKeyword) return false
  return fail(e, `${what} must be true or false`)
}

function objectProps(e: ts.Node | undefined, what: string): Map<string, ts.Expression> {
  if (!e || !ts.isObjectLiteralExpression(e)) return fail(e, `${what} must be an object literal`)
  const out = new Map<string, ts.Expression>()
  for (const p of e.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) out.set(p.name.text, p.initializer)
    else if (ts.isShorthandPropertyAssignment(p)) out.set(p.name.text, p.name)
    else if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) fail(p, `write \`${p.name.text}: (...) => ...\` instead of a method in ${what}`)
    else fail(p, `unsupported property in ${what}`)
  }
  return out
}

/** Unwrap `yield* x` → x. */
function yieldStar(e: ts.Expression | undefined): ts.Expression | null {
  if (!e) return null
  const u = unwrap(e)
  return ts.isYieldExpression(u) && u.asteriskToken && u.expression ? u.expression : null
}

/** A generator or arrow used as a function body. */
type FnLike = ts.ArrowFunction | ts.FunctionExpression

/** `Effect.gen(function* () { ... })` → its statements. */
function genBody(e: ts.Node): ts.NodeArray<ts.Statement> | null {
  if (calleeName(e) !== "Effect.gen") return null
  const fn = (e as ts.CallExpression).arguments.at(-1)
  if (fn && ts.isFunctionExpression(fn) && fn.asteriskToken && fn.parameters.length === 0) return fn.body.statements
  return fail(e, "Effect.gen must take a parameterless generator function: Effect.gen(function* () { ... })")
}

/**
 * A function definition in any of the supported spellings:
 *   (x) => ..., function* (x) { ... }, Effect.fn("name")(f, ...pipes), Effect.fn(f, ...pipes),
 *   Effect.fnUntraced(f, ...pipes)
 */
function asFunction(e: ts.Expression): { fn: FnLike; pipes: readonly ts.Expression[] } | null {
  const u = unwrap(e)
  if (ts.isArrowFunction(u)) return { fn: u, pipes: [] }
  if (ts.isFunctionExpression(u)) return { fn: u, pipes: [] }
  if (!ts.isCallExpression(u)) return null
  // Effect.fn("name")(f, ...pipes)
  if (ts.isCallExpression(u.expression) && calleeName(u.expression) === "Effect.fn") {
    const [f, ...pipes] = u.arguments
    const inner = f && unwrap(f)
    if (inner && (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner))) return { fn: inner, pipes }
    return fail(u, "Effect.fn(name)(...) expects a function")
  }
  const name = calleeName(u)
  if (name === "Effect.fn" || name === "Effect.fnUntraced") {
    const [f, ...pipes] = u.arguments
    const inner = f && unwrap(f)
    if (inner && (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner))) return { fn: inner, pipes }
    return fail(u, `${name}(...) expects a function`)
  }
  return null
}

// ───────────────────────── Types ─────────────────────────

export const rty = (s: STy): RTy => {
  switch (s.k) {
    case "string": return { k: "String" }
    case "number":
    case "numberFromString": return s.int ? { k: "i64" } : { k: "f64" }
    case "boolean": return { k: "bool" }
    case "nullOr": return { k: "option", of: rty(s.of) }
    case "ref": return { k: "cls", name: s.name }
  }
}

export const showTy = (t: RTy): string => {
  switch (t.k) {
    case "cls": return t.name
    case "option": return `Option<${showTy(t.of)}>`
    case "vec": return `Vec<${showTy(t.of)}>`
    case "unit": return "()"
    case "never": return "!"
    default: return t.k
  }
}

const sameTy = (a: RTy, b: RTy): boolean => showTy(a) === showTy(b)
const isCopy = (t: RTy) => t.k === "i64" || t.k === "f64" || t.k === "bool" || t.k === "unit"

export const describeSchema = (s: STy): string => {
  switch (s.k) {
    case "string": return "Schema.String"
    case "number": return s.int ? "Schema.Int" : s.finite ? "Schema.Finite" : "Schema.Number"
    case "numberFromString": return "Schema.NumberFromString"
    case "boolean": return "Schema.Boolean"
    case "nullOr": return `Schema.NullOr(${describeSchema(s.of)})`
    case "ref": return s.name
  }
}

// ───────────────────────── Frontend ─────────────────────────

/** A value in generated Rust code. `ref`: the code is a reference; `place`: a field path (not owned). */
interface Val {
  code: string
  ty: RTy
  own: "owned" | "ref" | "place"
  narrowed?: boolean
}

type Binding =
  | { k: "val"; v: Val }
  | { k: "service"; name: string }
  | { k: "query"; q: Query }
  | { k: "method"; key: string }
  | { k: "sql" }

type Scope = Map<string, Binding>

interface PendingMethod {
  service: string
  name: string
  fn: FnLike
  pipes: readonly ts.Expression[]
  scope: Scope
  node: ts.Node
  lowered?: Fn
  lowering?: boolean
}

/** A lowered Effect expression: Rust code evaluating to Result<ty, AppError> (already awaited). */
interface Eff {
  code: string
  ty: RTy
  errors: Set<string>
}

export interface FrontendResult {
  program: Program
  /** Unsupported constructs found (only populated in `collect` mode; otherwise the first one is thrown). */
  errors: CompileError[]
  /** Top-level declarations in imported files that aren't part of the server (helpers, constants…). */
  skipped: ts.Node[]
}

/**
 * Compile an Effect program spread over several files.
 * `files` are ordered dependencies-first; the last one is the entry point.
 * In `collect` mode every unsupported construct is recorded instead of stopping at the first.
 */
export function frontend(files: readonly ts.SourceFile[], opts: { collect?: boolean } = {}): FrontendResult {
  const sf = files[files.length - 1]!
  const errors: CompileError[] = []
  const skipped: ts.Node[] = []
  const attempt = (f: () => void) => {
    try {
      f()
    } catch (e) {
      if (opts.collect && e instanceof CompileError) errors.push(e)
      else throw e
    }
  }

  const classes = new Map<string, ClassDef>()
  const aliases = new Map<string, STy>()
  const endpointConsts = new Map<string, ts.Expression>()
  const groups = new Map<string, Endpoint[]>()
  const apis: Endpoint[][] = []
  const queries: Query[] = []
  const methods = new Map<string, PendingMethod>() // key: Service.method
  const services = new Set<string>()
  const handlerGroups: { group: string; node: ts.Node; build: ts.Expression }[] = []
  const server: Program["server"] = {
    port: 3000,
    hostname: null,
    maxConnections: 10,
    dbUrlEnv: "DATABASE_URL",
    logRequests: true,
    router: { caseSensitive: false, ignoreTrailingSlash: true, ignoreDuplicateSlashes: true, maxParamLength: 100 },
  }
  let sawDb = false

  // ── Schemas ──
  function parseSchema(e: ts.Expression, ctx: string): STy {
    e = unwrap(e)
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && !dotted(e.expression)) {
      // X.check(...), X.pipe(...), X.annotate(...)
      const method = e.expression.name.text
      const base = parseSchema(e.expression.expression, ctx)
      if (method === "check") return e.arguments.reduce((s, c) => applyCheck(s, c), base)
      if (method === "pipe") return e.arguments.reduce((s, a) => pipeSchema(s, a), base)
      if (method === "annotate" || method === "annotateKey") return base
      return fail(e, `unsupported schema method .${method}()`)
    }
    if (ts.isCallExpression(e)) {
      const name = calleeName(e)
      // dotted callee that ends in .check/.pipe (e.g. Schema.String.check(...))
      if (name?.endsWith(".check") || name?.endsWith(".pipe") || name?.endsWith(".annotate")) {
        const target = (e.expression as ts.PropertyAccessExpression).expression
        const base = parseSchema(target, ctx)
        if (name.endsWith(".check")) return e.arguments.reduce((s, c) => applyCheck(s, c), base)
        if (name.endsWith(".pipe")) return e.arguments.reduce((s, a) => pipeSchema(s, a), base)
        return base
      }
      if (name === "Schema.NullOr") return { k: "nullOr", of: parseSchema(e.arguments[0]!, ctx) }
      if (name === "Schema.Struct") return { k: "ref", name: synthesizeStruct(e, ctx) }
      return fail(e, `unsupported schema \`${short(e)}\``)
    }
    switch (dotted(e)) {
      case "Schema.String": return { k: "string", checks: [] }
      case "Schema.NonEmptyString": return { k: "string", checks: [{ k: "minLength", n: 1 }] }
      case "Schema.Number": return { k: "number", int: false, finite: false, checks: [] }
      case "Schema.Finite": return { k: "number", int: false, finite: true, checks: [] }
      case "Schema.Int": return { k: "number", int: true, finite: true, checks: [] }
      case "Schema.Boolean": return { k: "boolean" }
      case "Schema.NumberFromString": return { k: "numberFromString", int: false, finite: false, checks: [] }
      case "Schema.FiniteFromString": return { k: "numberFromString", int: false, finite: true, checks: [] }
    }
    if (ts.isIdentifier(e)) {
      if (classes.has(e.text)) return { k: "ref", name: e.text }
      const alias = aliases.get(e.text)
      if (alias) return alias
    }
    return fail(e, `unsupported schema \`${short(e)}\` (supported: String, NonEmptyString, Number, Finite, Int, Boolean, NumberFromString, NullOr, Struct, Class references)`)
  }

  function pipeSchema(s: STy, a: ts.Expression): STy {
    const name = calleeName(a)
    if (name === "Schema.check") return (a as ts.CallExpression).arguments.reduce((acc, c) => applyCheck(acc, c), s)
    if (name === "Schema.brand") return s // brands are type-level only
    return fail(a, `unsupported schema pipe \`${short(a)}\``)
  }

  function applyCheck(s: STy, c: ts.Expression): STy {
    const name = calleeName(c)
    const args = (c as ts.CallExpression).arguments ?? []
    const isNum = s.k === "number" || s.k === "numberFromString"
    if (s.k === "string") {
      if (name === "Schema.isMinLength") return { ...s, checks: [...s.checks, { k: "minLength", n: numberLit(args[0], "length") }] }
      if (name === "Schema.isMaxLength") return { ...s, checks: [...s.checks, { k: "maxLength", n: numberLit(args[0], "length") }] }
      if (name === "Schema.isNonEmpty") return { ...s, checks: [...s.checks, { k: "minLength", n: 1 }] }
    }
    if (isNum) {
      if (name === "Schema.isInt") return { ...s, int: true, finite: true }
      if (name === "Schema.isFinite") return { ...s, finite: true }
      const bound: Record<string, Check["k"]> = {
        "Schema.isGreaterThan": "gt",
        "Schema.isGreaterThanOrEqualTo": "gte",
        "Schema.isLessThan": "lt",
        "Schema.isLessThanOrEqualTo": "lte",
      }
      const k = name ? bound[name] : undefined
      if (k) return { ...s, checks: [...s.checks, { k, n: numberLit(args[0], "bound") } as Check] }
    }
    return fail(c, `unsupported check \`${short(c)}\` for ${describeSchema(s)}`)
  }

  const parseFields = (obj: ts.Node | undefined, what: string, ctx: string): Field[] => {
    const fields: Field[] = []
    for (const [name, e] of objectProps(obj, what)) attempt(() => void fields.push({ name, ty: parseSchema(e, `${ctx}${upperFirst(name)}`) }))
    return fields
  }

  /** Inline `Schema.Struct({...})` → a synthesized class. */
  function synthesizeStruct(call: ts.CallExpression, ctx: string): string {
    let name = ctx || "Struct"
    for (let i = 2; classes.has(name); i++) name = `${ctx}${i}`
    const def: ClassDef = { name, error: false, tag: name, fields: [] }
    classes.set(name, def)
    def.fields = parseFields(call.arguments[0], "struct fields", name)
    return name
  }

  /** Fields given as `{ a: Schema.X }`, `Schema.Struct({...})` or a struct/class reference. */
  function parseFieldSet(e: ts.Expression, ctx: string): Field[] {
    const u = unwrap(e)
    if (ts.isObjectLiteralExpression(u)) return parseFields(u, "fields", ctx)
    const ty = parseSchema(u, ctx)
    if (ty.k !== "ref") return fail(e, "expected an object of fields, Schema.Struct(...) or a Schema.Class")
    return classes.get(ty.name)!.fields
  }

  // ── Top-level declarations ──
  for (const file of files) {
    const isEntry = file === sf
    for (const stmt of file.statements) {
      if (
        ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) || ts.isEmptyStatement(stmt) || ts.isModuleDeclaration(stmt) ||
        ts.isFunctionDeclaration(stmt) || ts.isEnumDeclaration(stmt)
      ) {
        if (ts.isFunctionDeclaration(stmt) || ts.isEnumDeclaration(stmt)) skipped.push(stmt)
        continue
      }
      attempt(() => {
        if (ts.isClassDeclaration(stmt) && stmt.name) return classDecl(stmt.name.text, stmt, isEntry)
        if (ts.isVariableStatement(stmt)) {
          for (const d of stmt.declarationList.declarations) {
            if (d.initializer && ts.isIdentifier(d.name)) attempt(() => constDecl(d.name.getText(), d.initializer!, d, isEntry))
          }
          return
        }
        if (ts.isExpressionStatement(stmt)) return scanWiring(stmt.expression)
        if (!isEntry) return void skipped.push(stmt)
        fail(stmt, "unsupported top-level statement")
      })
    }
  }

  function classDecl(name: string, decl: ts.ClassDeclaration, isEntry: boolean) {
    const h = decl.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression
    if (!h || !ts.isCallExpression(h)) return void skipped.push(decl)
    // Schema.Class<X>("Id")({...}) / Schema.TaggedError<X>()("Tag", {...}, { httpApiStatus })
    const innerName = ts.isCallExpression(h.expression) ? calleeName(h.expression) : null
    if (innerName === "Schema.Class" || innerName === "Schema.TaggedError" || innerName === "Schema.TaggedClass") {
      const statics = decl.members.filter((m) => !(ts.isPropertyDeclaration(m) && m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)))
      if (statics.length > 0) fail(statics[0], "methods and instance members on schema classes aren't supported yet")
      if (innerName === "Schema.Class") {
        const def: ClassDef = { name, error: false, tag: name, fields: [] }
        classes.set(name, def)
        def.fields = parseFields(h.arguments[0], "class fields", name)
      } else if (innerName === "Schema.TaggedError") {
        const def: ClassDef = { name, error: true, tag: stringLit(h.arguments[0], "error tag"), fields: [] }
        classes.set(name, def)
        def.fields = parseFields(h.arguments[1], "error fields", name)
        const annotations = h.arguments[2]
        if (annotations) {
          const status = objectProps(annotations, "error annotations").get("httpApiStatus")
          if (status) def.status = numberLit(status, "httpApiStatus")
        }
      } else fail(h, "Schema.TaggedClass isn't supported yet")
      return
    }
    // Context.Service<S, I>()("id", { make })
    if (innerName === "Context.Service") return serviceDecl(name, decl, h)
    const root = rootCall(h)
    if (root === "HttpApiGroup.make") return void groups.set(name, groupDecl(h))
    if (root === "HttpApi.make") return void apis.push(apiDecl(h))
    if (isEntry) fail(h, `unsupported base class \`${short(h)}\``)
    skipped.push(decl)
  }

  function constDecl(name: string, init: ts.Expression, decl: ts.Node, isEntry: boolean) {
    const root = rootCall(init)
    const cn = calleeName(unwrap(init))
    if (cn === "Schema.Struct") {
      const def: ClassDef = { name, error: false, tag: name, fields: [] }
      classes.set(name, def)
      def.fields = parseFields((unwrap(init) as ts.CallExpression).arguments[0], "struct fields", name)
      return
    }
    if (root?.startsWith("HttpApiEndpoint.")) return void endpointConsts.set(name, init)
    if (root === "HttpApiGroup.make") return void groups.set(name, groupDecl(init))
    if (root === "HttpApi.make") return void apis.push(apiDecl(init))
    if ((root ?? dotted(init) ?? "").startsWith("Schema.")) {
      try {
        aliases.set(name, parseSchema(init, name))
        return
      } catch (e) {
        if (isEntry) throw e
      }
    }
    if (containsServerCode(init)) return scanWiring(init)
    skipped.push(decl)
  }

  /** The innermost call of a method chain: HttpApiGroup.make("x").add(...).prefix(...) → "HttpApiGroup.make". */
  function rootCall(e: ts.Expression): string | null {
    const { base } = methodChain(e)
    return calleeName(base) ?? (ts.isCallExpression(base) ? calleeName(base) : null)
  }

  function containsServerCode(e: ts.Node): boolean {
    let found = false
    const visit = (n: ts.Node) => {
      const c = calleeName(n)
      if (c && /^(HttpApiBuilder|HttpRouter|BunHttpServer|PgClient|BunPgClient|Layer)\./.test(c)) found = true
      if (!found) ts.forEachChild(n, visit)
    }
    visit(e)
    return found
  }

  // ── API ──
  function groupDecl(e: ts.Expression): Endpoint[] {
    const { base, calls } = methodChain(e)
    const group = stringLit((base as ts.CallExpression).arguments[0], "group name")
    const eps: Endpoint[] = []
    let prefix = ""
    for (const c of calls) {
      attempt(() => {
        if (c.name === "add") for (const a of c.args) attempt(() => void eps.push(endpoint(group, a)))
        else if (c.name === "prefix") prefix = joinPath(stringLit(c.args[0], "prefix"), prefix)
        else if (c.name === "annotate" || c.name === "annotateMerge") {}
        else fail(c.node, `unsupported HttpApiGroup method .${c.name}()${c.name === "middleware" ? " (middleware isn't supported yet)" : ""}`)
      })
    }
    return eps.map((ep) => ({ ...ep, path: joinPath(prefix, ep.path) }))
  }

  function apiDecl(e: ts.Expression): Endpoint[] {
    const { calls } = methodChain(e)
    const out: Endpoint[] = []
    let prefix = ""
    for (const c of calls) {
      attempt(() => {
        if (c.name === "add") {
          for (const a of c.args) {
            const g = ts.isIdentifier(a) ? groups.get(a.text) : undefined
            if (!g) fail(a, "HttpApi.make(...).add(...) expects an HttpApiGroup declared before it")
            out.push(...g!)
          }
        } else if (c.name === "prefix") prefix = joinPath(stringLit(c.args[0], "prefix"), prefix)
        else if (c.name === "annotate" || c.name === "annotateMerge") {}
        else fail(c.node, `unsupported HttpApi method .${c.name}()`)
      })
    }
    return out.map((ep) => ({ ...ep, path: joinPath(prefix, ep.path) }))
  }


  function endpoint(group: string, e: ts.Expression): Endpoint {
    if (ts.isIdentifier(e)) {
      const c = endpointConsts.get(e.text)
      if (!c) return fail(e, `\`${e.text}\` is not an HttpApiEndpoint declared above`)
      return endpoint(group, c)
    }
    const { base, calls } = methodChain(e)
    const head = calleeName(base) ?? ""
    const method = head.replace("HttpApiEndpoint.", "") as Endpoint["method"]
    if (!head.startsWith("HttpApiEndpoint.") || !["get", "post", "put", "patch", "delete"].includes(method)) {
      fail(e, "endpoints must be HttpApiEndpoint.get/post/put/patch/delete(name, path, { ... })")
    }
    const args = (base as ts.CallExpression).arguments
    const name = stringLit(args[0], "endpoint name")
    let path = stringLit(args[1], "endpoint path")
    if (/[*()]|:[^/]*:|\?/.test(path)) fail(args[1], "wildcard, regex and optional path parameters aren't supported yet")
    const ep: Endpoint = { group, name, method, path, params: null, payload: null, success: { ty: null, status: 204 }, errors: [], node: e }
    const options = args[2] ? objectProps(args[2], "endpoint options") : new Map<string, ts.Expression>()
    for (const [key, value] of options) {
      switch (key) {
        case "params": {
          ep.params = parseFieldSet(value, `${upperFirst(name)}Params`)
          for (const f of ep.params) {
            if (!path.includes(`:${f.name}`)) fail(value, `path parameter \`${f.name}\` is not in ${path}`)
            if (f.ty.k === "ref" || f.ty.k === "nullOr") fail(value, `path parameter \`${f.name}\` must be a string, number or boolean schema`)
          }
          break
        }
        case "payload": {
          if (method === "get" || method === "delete") fail(value, "payloads on GET/DELETE come from the query string, which isn't supported yet")
          const u = unwrap(value)
          const ty = ts.isObjectLiteralExpression(u)
            ? ({ k: "ref", name: synthesizeFromFields(u, `${upperFirst(name)}Payload`) } as STy)
            : parseSchema(u, `${upperFirst(name)}Payload`)
          if (ty.k !== "ref") fail(value, "payload must be a struct (object of fields, Schema.Struct or Schema.Class)")
          ep.payload = { ty }
          break
        }
        case "success": {
          const { schema, status } = withStatus(value)
          if (schema === null) ep.success = { ty: null, status: status ?? 204 }
          else ep.success = { ty: parseSchema(schema, `${upperFirst(name)}Success`), status: status ?? 200 }
          if (ep.success.ty && ep.success.ty.k !== "ref") fail(value, "success must be a struct or class schema (other shapes aren't supported yet)")
          break
        }
        case "error": {
          const u = unwrap(value)
          const list = ts.isArrayLiteralExpression(u) ? [...u.elements] : [u]
          for (const item of list) {
            const { schema, status } = withStatus(item)
            const cls = schema && ts.isIdentifier(schema) ? classes.get(schema.text) : undefined
            if (!cls?.error) fail(item, "errors must be Schema.TaggedError classes")
            ep.errors.push({ name: cls!.name, status: status ?? cls!.status ?? 500 })
          }
          break
        }
        case "query":
        case "headers":
          fail(value, `\`${key}\` isn't supported yet`)
          break
        default:
          fail(value, `unsupported endpoint option \`${key}\``)
      }
    }
    for (const m of path.matchAll(/:(\w+)/g)) {
      if (!ep.params?.some((f) => f.name === m[1])) {
        // Undeclared path parameters are strings in HttpApi.
        ep.params = [...(ep.params ?? []), { name: m[1]!, ty: { k: "string", checks: [] } }]
      }
    }
    for (const c of calls) {
      if (c.name === "prefix") path = ep.path = joinPath(stringLit(c.args[0], "prefix"), path)
      else if (c.name !== "annotate" && c.name !== "annotateMerge") fail(c.node, `unsupported endpoint method .${c.name}()`)
    }
    return ep
  }

  function synthesizeFromFields(obj: ts.ObjectLiteralExpression, ctx: string): string {
    let name = ctx
    for (let i = 2; classes.has(name); i++) name = `${ctx}${i}`
    const def: ClassDef = { name, error: false, tag: name, fields: [] }
    classes.set(name, def)
    def.fields = parseFields(obj, "payload fields", name)
    return name
  }

  /** `X.pipe(HttpApiSchema.status(n))`, `HttpApiSchema.NoContent`, `HttpApiSchema.Created`, `HttpApiSchema.Empty(n)`. */
  function withStatus(e: ts.Expression): { schema: ts.Expression | null; status: number | null } {
    const u = unwrap(e)
    const d = dotted(u)
    if (d === "HttpApiSchema.NoContent") return { schema: null, status: 204 }
    if (d === "HttpApiSchema.Created") return { schema: null, status: 201 }
    if (calleeName(u) === "HttpApiSchema.Empty") return { schema: null, status: numberLit((u as ts.CallExpression).arguments[0], "status") }
    if (ts.isCallExpression(u) && ts.isPropertyAccessExpression(u.expression) && u.expression.name.text === "pipe") {
      let status: number | null = null
      for (const a of u.arguments) {
        if (calleeName(a) === "HttpApiSchema.status") status = numberLit((a as ts.CallExpression).arguments[0], "status")
        else fail(a, `unsupported \`${short(a)}\` here (supported: HttpApiSchema.status(n))`)
      }
      return { schema: u.expression.expression, status }
    }
    return { schema: u, status: null }
  }

  // ── Services ──
  function serviceDecl(name: string, decl: ts.ClassDeclaration, h: ts.CallExpression) {
    stringLit(h.arguments[0], "service key")
    services.add(name)
    const optionsArg = h.arguments[1]
    const makeOpt = optionsArg ? objectProps(optionsArg, "service options").get("make") : undefined
    let body: ts.NodeArray<ts.Statement> | null = null
    for (const m of decl.members) {
      if (!ts.isPropertyDeclaration(m) || !m.initializer) continue
      // static readonly layer = Layer.effect(S, Effect.gen(...)).pipe(...)
      const { base } = methodChain(m.initializer)
      if (calleeName(base) !== "Layer.effect") continue
      const [tag, eff] = (base as ts.CallExpression).arguments
      if (!tag || !eff || !["this", name].includes(dotted(tag) ?? "")) continue
      const target = ["this.make", `${name}.make`].includes(dotted(eff) ?? "") ? makeOpt : eff
      if (!target) fail(eff, "this.make refers to a `make` option the service doesn't have")
      body = genBody(target!) ?? fail(target, "the service layer must be built with Effect.gen(function* () { ... })")
      if (body) break
    }
    if (!body && makeOpt) body = genBody(makeOpt) ?? fail(makeOpt, "`make` must be Effect.gen(function* () { ... })")
    if (!body) return void skipped.push(decl) // a service without an implementation here (e.g. provided elsewhere)
    const scope: Scope = new Map()
    for (const s of body) {
      attempt(() => {
        if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations) {
            const id = ts.isIdentifier(d.name) ? d.name.text : fail(d.name, "destructuring isn't supported here")
            const init = d.initializer ?? fail(d, "missing initializer")
            const y = yieldStar(init)
            if (y && dotted(y) === "SqlClient.SqlClient") scope.set(id, { k: "sql" })
            else if (y && ts.isIdentifier(y)) scope.set(id, { k: "service", name: y.text })
            else if (calleeName(unwrap(init))?.startsWith("SqlSchema.")) scope.set(id, { k: "query", q: query(name, id, unwrap(init) as ts.CallExpression, scope) })
            else {
              const f = asFunction(init)
              if (!f) fail(init, "in a service: bind `yield* SqlClient.SqlClient`, another service, a SqlSchema query, or a function (arrow / Effect.fn)")
              const key = `${name}.${id}`
              methods.set(key, { service: name, name: id, fn: f!.fn, pipes: f!.pipes, scope, node: d })
              scope.set(id, { k: "method", key })
            }
          }
        } else if (ts.isReturnStatement(s) && s.expression) {
          const ret = unwrap(s.expression)
          const obj = calleeName(ret) === `${name}.of` ? (ret as ts.CallExpression).arguments[0] : ret
          for (const [m, e] of objectProps(obj, "service methods")) {
            attempt(() => {
              const b = ts.isIdentifier(e) ? scope.get(e.text) : undefined
              const key = `${name}.${m}`
              if (b?.k === "method") {
                const target = methods.get(b.key)!
                if (b.key !== key) methods.set(key, { ...target, name: m })
                return
              }
              if (b?.k === "query") fail(e, `wrap queries in a function to expose them: \`${m}: (req) => ${e.getText()}(req)\``)
              const f = asFunction(e)
              if (!f) fail(e, "service members must be functions (arrow / Effect.fn); plain Effect values aren't supported yet")
              methods.set(key, { service: name, name: m, fn: f!.fn, pipes: f!.pipes, scope, node: e })
            })
          }
        } else fail(s, "unsupported statement in a service implementation")
      })
    }
  }

  function query(service: string, name: string, call: ts.CallExpression, scope: Scope): Query {
    const mode = calleeName(call)!.replace("SqlSchema.", "") as QueryMode
    if (!["findOne", "findOneOption", "findAll", "findNonEmpty", "void"].includes(mode)) fail(call, `unsupported SqlSchema.${mode}`)
    const options = objectProps(call.arguments[0], "SqlSchema options")
    const reqExpr = options.get("Request") ?? fail(call, "missing Request")
    const request = dotted(reqExpr) === "Schema.Void" ? null : parseSchema(reqExpr, `${upperFirst(name)}Request`)
    const result = mode === "void" ? null : parseSchema(options.get("Result") ?? fail(call, "missing Result"), `${upperFirst(name)}Row`)
    if (result && result.k !== "ref") fail(options.get("Result"), "Result must be a struct or class schema")
    const exec = options.get("execute")
    const fn = exec && unwrap(exec)
    if (!fn || !ts.isArrowFunction(fn) || fn.parameters.length > 1) return fail(exec ?? call, "execute must be (req) => sql`...`")
    const requestParam = fn.parameters[0]?.name.getText() ?? "_"
    const body = unwrap(fn.body as ts.Expression)
    if (!ts.isTaggedTemplateExpression(body) || !ts.isIdentifier(body.tag) || scope.get(body.tag.text)?.k !== "sql") {
      return fail(body, "execute must return a single sql`...` template (blocks and sql helpers like sql.in / sql.insert aren't supported yet)")
    }
    const parts: string[] = []
    const binds: Query["binds"] = []
    const t = body.template
    if (ts.isNoSubstitutionTemplateLiteral(t)) parts.push(t.text)
    else {
      parts.push(t.head.text)
      for (const span of t.templateSpans) {
        const path: string[] = []
        let e: ts.Expression = unwrap(span.expression)
        while (ts.isPropertyAccessExpression(e)) {
          path.unshift(e.name.text)
          e = unwrap(e.expression)
        }
        if (!ts.isIdentifier(e) || e.text !== requestParam) {
          fail(span.expression, `interpolations must be \`${requestParam}\` or its fields (sql helpers like sql.in aren't supported yet)`)
        }
        binds.push({ path, node: span.expression })
        parts.push(span.literal.text)
      }
    }
    const q: Query = { service, name, mode, request, result, requestParam, parts, binds, node: call }
    queries.push(q)
    return q
  }

  // ── Wiring (any expression: layers, serve options, handler groups) ──
  function scanWiring(e: ts.Node) {
    const visit = (n: ts.Node): void => {
      const name = calleeName(n)
      const call = n as ts.CallExpression
      if (name === "HttpApiBuilder.group") {
        const [, groupArg, build] = call.arguments
        handlerGroups.push({ group: stringLit(groupArg, "group name"), node: call, build: build ?? fail(call, "missing handlers") })
        return
      }
      if (name && /^(Bun)?PgClient\.layer(Config)?$/.test(name)) {
        sawDb = true
        const options = objectProps(call.arguments[0], "client options")
        const url = options.get("url")
        if (url && ts.isCallExpression(url) && /^Config\.(Redacted|redacted|String|string)$/.test(calleeName(url) ?? "")) {
          server.dbUrlEnv = stringLit(url.arguments[0], "config key")
        } else fail(url ?? call, "url must be Config.Redacted(\"ENV_VAR\")")
        const max = options.get("maxConnections")
        if (max) server.maxConnections = calleeName(max) === "Config.succeed" ? numberLit((max as ts.CallExpression).arguments[0], "maxConnections") : numberLit(max, "maxConnections")
        return
      }
      if (name === "BunHttpServer.layer" || name === "NodeHttpServer.layer") {
        const arg = name === "NodeHttpServer.layer" ? call.arguments[1] : call.arguments[0]
        const options = objectProps(arg, "server options")
        const port = options.get("port")
        if (port) server.port = numberLit(port, "port")
        const host = options.get("hostname") ?? options.get("host")
        if (host) server.hostname = stringLit(host, "hostname")
        return
      }
      if (name === "HttpRouter.serve" && call.arguments[1]) {
        const options = objectProps(call.arguments[1], "serve options")
        for (const [k, v] of options) {
          if (k === "disableLogger") server.logRequests = !boolLit(v, k)
          else if (k === "disableListenLog") {}
          else if (k === "routerConfig") {
            for (const [rk, rv] of objectProps(v, "routerConfig")) {
              if (rk === "maxParamLength") server.router.maxParamLength = numberLit(rv, rk)
              else if (rk === "caseSensitive" || rk === "ignoreTrailingSlash" || rk === "ignoreDuplicateSlashes") server.router[rk] = boolLit(rv, rk)
              else fail(rv, `unsupported routerConfig option \`${rk}\``)
            }
          } else fail(v, `unsupported HttpRouter.serve option \`${k}\``)
        }
      }
      if (dotted(n) === "HttpRouter.disableLogger") server.logRequests = false
      if (name === "HttpApiBuilder.layer" && call.arguments[1]) {
        for (const [k, v] of objectProps(call.arguments[1], "HttpApiBuilder.layer options")) fail(v, `HttpApiBuilder.layer option \`${k}\` isn't supported yet`)
      }
      ts.forEachChild(n, visit)
    }
    visit(e)
  }

  // ── Lowering expressions ──
  const valueOwned = (v: Val) => (v.own === "owned" || isCopy(v.ty) ? v.code : `${v.code}.clone()`)
  const valueBorrowed = (v: Val) => (v.own === "ref" ? v.code : `&${v.code}`)

  /** Convert a value to the expected type (only lossless widening is implicit). */
  function coerce(v: Val, want: RTy, node: ts.Node, ctx: string): string {
    if (sameTy(v.ty, want)) return valueOwned(v)
    if (v.ty.k === "i64" && want.k === "f64") return `(${v.code} as f64)`
    if (want.k === "option" && sameTy(v.ty, want.of)) return `Some(${valueOwned(v)})`
    return fail(node, `${ctx}: expected ${showTy(want)}, got ${showTy(v.ty)}`)
  }

  function lowerValue(e: ts.Expression, scope: Scope): Val {
    e = unwrap(e)
    if (ts.isIdentifier(e)) {
      if (e.text === "undefined") return fail(e, "undefined isn't supported; use Schema.NullOr and null")
      const b = scope.get(e.text)
      if (b?.k === "val") return b.v
      return fail(e, `unknown value \`${e.text}\``)
    }
    if (e.kind === ts.SyntaxKind.NullKeyword) return { code: "None", ty: { k: "option", of: { k: "never" } }, own: "owned" }
    if (ts.isPropertyAccessExpression(e)) {
      const base = lowerValue(e.expression, scope)
      if (e.name.text === "value" && base.narrowed) return base
      if (base.ty.k === "option") fail(e, "unwrap Options with an `if (Option.isNone(x)) return yield* ...` guard first")
      if (e.name.text === "length" && base.ty.k === "String") return { code: `(${base.code}.encode_utf16().count() as i64)`, ty: { k: "i64" }, own: "owned" }
      if (base.ty.k !== "cls") return fail(e.expression, `\`${short(e.expression)}\` has no fields (type ${showTy(base.ty)})`)
      const f = classes.get(base.ty.name)!.fields.find((f) => f.name === e.name.text) ?? fail(e.name, `no field \`${e.name.text}\` on ${base.ty.name}`)
      return { code: `${base.code}.${snake(f.name)}`, ty: rty(f.ty), own: "place" }
    }
    if (ts.isNumericLiteral(e)) {
      const n = Number(e.text)
      return Number.isSafeInteger(n) ? { code: `${n}i64`, ty: { k: "i64" }, own: "owned" } : { code: `${n}f64`, ty: { k: "f64" }, own: "owned" }
    }
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { code: `String::from(${JSON.stringify(e.text)})`, ty: { k: "String" }, own: "owned" }
    if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) {
      return { code: e.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false", ty: { k: "bool" }, own: "owned" }
    }
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const v = lowerValue(e.operand, scope)
      if (v.ty.k !== "bool") fail(e, "`!` needs a boolean")
      return { code: `!(${v.code})`, ty: v.ty, own: "owned" }
    }
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
      const v = lowerValue(e.operand, scope)
      if (v.ty.k !== "i64" && v.ty.k !== "f64") fail(e, "`-` needs a number")
      return { code: `(-${v.code})`, ty: v.ty, own: "owned" }
    }
    if (ts.isBinaryExpression(e)) {
      const ops: Record<number, [string, "cmp" | "bool" | "arith"]> = {
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: ["==", "cmp"],
        [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ["!=", "cmp"],
        [ts.SyntaxKind.LessThanToken]: ["<", "cmp"],
        [ts.SyntaxKind.LessThanEqualsToken]: ["<=", "cmp"],
        [ts.SyntaxKind.GreaterThanToken]: [">", "cmp"],
        [ts.SyntaxKind.GreaterThanEqualsToken]: [">=", "cmp"],
        [ts.SyntaxKind.AmpersandAmpersandToken]: ["&&", "bool"],
        [ts.SyntaxKind.BarBarToken]: ["||", "bool"],
        [ts.SyntaxKind.PlusToken]: ["+", "arith"],
        [ts.SyntaxKind.MinusToken]: ["-", "arith"],
        [ts.SyntaxKind.AsteriskToken]: ["*", "arith"],
      }
      const op = ops[e.operatorToken.kind] ?? fail(e.operatorToken, `unsupported operator ${e.operatorToken.getText()}`)
      let l = lowerValue(e.left, scope)
      let r = lowerValue(e.right, scope)
      // JS numbers are one type: widen i64 to f64 when mixed.
      if (l.ty.k === "i64" && r.ty.k === "f64") l = { ...l, code: `(${l.code} as f64)`, ty: { k: "f64" } }
      if (r.ty.k === "i64" && l.ty.k === "f64") r = { ...r, code: `(${r.code} as f64)`, ty: { k: "f64" } }
      if (!sameTy(l.ty, r.ty) || !["i64", "f64", "bool", "String"].includes(l.ty.k)) fail(e, `operands must be the same primitive type (${showTy(l.ty)} vs ${showTy(r.ty)})`)
      if (op[1] === "arith" && l.ty.k !== "i64" && l.ty.k !== "f64") fail(e, "arithmetic needs numbers (string concatenation isn't supported yet)")
      if (op[1] === "bool" && l.ty.k !== "bool") fail(e, "&& and || need booleans")
      const ty: RTy = op[1] === "arith" ? l.ty : { k: "bool" }
      return { code: `(${l.code} ${op[0]} ${r.code})`, ty, own: "owned" }
    }
    if (calleeName(e) === "Option.isNone" || calleeName(e) === "Option.isSome") {
      const v = lowerValue((e as ts.CallExpression).arguments[0]!, scope)
      if (v.ty.k !== "option") fail(e, "Option.isNone needs an Option")
      return { code: `${v.code}.${calleeName(e) === "Option.isNone" ? "is_none" : "is_some"}()`, ty: { k: "bool" }, own: "owned" }
    }
    return fail(e, `unsupported expression \`${short(e)}\``)
  }

  /** `new E({...})` → Rust error constructor. */
  function newError(n: ts.NewExpression, scope: Scope): { code: string; tag: string } {
    if (!ts.isIdentifier(n.expression)) return fail(n, "expected `new SomeError({...})`")
    const cls = classes.get(n.expression.text)
    if (!cls?.error) return fail(n, `\`${n.expression.text}\` is not a Schema.TaggedError`)
    const props = n.arguments?.[0] ? objectProps(n.arguments[0], "error fields") : new Map<string, ts.Expression>()
    const inits = cls.fields.map((f) => {
      const init = props.get(f.name) ?? (f.ty.k === "nullOr" ? undefined : fail(n, `missing field \`${f.name}\``))
      const v = init ? coerce(lowerValue(init, scope), rty(f.ty), init, `field ${f.name}`) : "None"
      return `${snake(f.name)}: ${v}`
    })
    return { code: `AppError::${cls.name} { ${inits.join(", ")} }`, tag: cls.name }
  }

  /** An Effect expression → Rust expression of type Result<ty, AppError> (already awaited). */
  function lowerEffect(e: ts.Expression, scope: Scope): Eff {
    e = unwrap(e)
    // x.pipe(f, g, ...)
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "pipe" && !dotted(e.expression.expression)?.startsWith("Schema")) {
      return e.arguments.reduce((acc, a) => applyPipe(acc, a, scope), lowerEffect(e.expression.expression, scope))
    }
    if (ts.isNewExpression(e)) {
      const err = newError(e, scope)
      return { code: `Err(${err.code})`, ty: { k: "never" }, errors: new Set([err.tag]) }
    }
    const name = calleeName(e)
    const args = ts.isCallExpression(e) ? e.arguments : []
    if (name === "Effect.fail") {
      const n = args[0] && unwrap(args[0])
      if (!n || !ts.isNewExpression(n)) return fail(e, "Effect.fail expects `new SomeError({...})`")
      return lowerEffect(n, scope)
    }
    if (name === "Effect.succeed") {
      const v = lowerValue(args[0]!, scope)
      return { code: `Ok(${valueOwned(v)})`, ty: v.ty, errors: new Set() }
    }
    if (dotted(e) === "Effect.void") return { code: "Ok(())", ty: { k: "unit" }, errors: new Set() }
    if (name === "Effect.die" || dotted(e) === "Effect.die") return { code: `Err(AppError::Defect(rt::Die(String::from("Effect.die"))))`, ty: { k: "never" }, errors: new Set() }
    if (name === "Effect.orDie") return applyPipe(lowerEffect(args[0]!, scope), (e as ts.CallExpression).expression, scope, true)
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      const b = scope.get(e.expression.text)
      if (b?.k === "query") return callQuery(b.q, e, scope)
      if (b?.k === "method") return callMethod(methods.get(b.key)!, e, scope)
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)) {
      const b = scope.get(e.expression.expression.text)
      if (b?.k === "service") {
        const m = methods.get(`${b.name}.${e.expression.name.text}`) ?? fail(e, `${b.name} has no method \`${e.expression.name.text}\` (or its implementation isn't in the compiled files)`)
        return callMethod(m, e, scope)
      }
    }
    return fail(e, `unsupported Effect \`${short(e)}\` (supported: SqlSchema queries, service methods, new TaggedError, Effect.succeed/fail/die/void, .pipe(Effect.orDie | catchTag | catchTags | mapError))`)
  }

  /** One `.pipe(...)` step. */
  function applyPipe(acc: Eff, a: ts.Expression, scope: Scope, isOrDie = false): Eff {
    const d = dotted(a)
    if (isOrDie || d === "Effect.orDie") {
      return { ...acc, code: acc.errors.size ? `${acc.code}.map_err(AppError::into_defect)` : acc.code, errors: new Set() }
    }
    const name = calleeName(a)
    const args = (a as ts.CallExpression).arguments ?? []
    if (name === "Effect.catchTags") {
      const handlers = [...objectProps(args[0], "catchTags handlers")]
      return catchTags(acc, handlers.map(([tag, h]) => ({ tags: [tag], h })), scope, a)
    }
    if (name === "Effect.catchTag") {
      const t = unwrap(args[0]!)
      const tags = ts.isArrayLiteralExpression(t) ? t.elements.map((x) => stringLit(x, "tag")) : [stringLit(t, "tag")]
      return catchTags(acc, [{ tags, h: args[1]! }], scope, a)
    }
    if (name === "Effect.mapError") {
      return catchTags(acc, [{ tags: [...acc.errors], h: args[0]! }], scope, a)
    }
    return fail(a, `unsupported pipe step \`${short(a)}\` (supported: Effect.orDie, Effect.catchTag, Effect.catchTags, Effect.mapError)`)
  }

  function catchTags(acc: Eff, cases: { tags: string[]; h: ts.Expression }[], scope: Scope, node: ts.Node): Eff {
    const errors = new Set(acc.errors)
    const arms: string[] = []
    let ty = acc.ty
    for (const { tags, h } of cases) {
      for (const t of tags) {
        if (!acc.errors.has(t)) fail(h, `this effect can't fail with \`${t}\` (it can fail with: ${[...acc.errors].join(", ") || "nothing"})`)
        errors.delete(t)
      }
      const res = lowerHandler(h, scope)
      for (const x of res.errors) errors.add(x)
      if (res.ty.k !== "never") {
        if (ty.k === "never") ty = res.ty
        else if (!sameTy(ty, res.ty)) fail(h, `the handler returns ${showTy(res.ty)}, but the effect succeeds with ${showTy(ty)}`)
      }
      const pats = tags.map((t) => (t === "SqlError" || t === "SchemaError" ? `AppError::${t}(_)` : `AppError::${t} { .. }`))
      arms.push(`Err(__e @ (${pats.join(" | ")})) => ${res.code},`)
    }
    void node
    return { code: `match ${acc.code} {\n${arms.join("\n")}\nother => other,\n}`, ty, errors }
  }

  /** A catchTag / mapError handler: `Effect.die`, `() => new E()`, `(e) => Effect.fail(...)`, `() => Effect.succeed(v)`. */
  function lowerHandler(h: ts.Expression, scope: Scope): Eff {
    const u = unwrap(h)
    if (dotted(u) === "Effect.die" || dotted(u) === "Effect.fail") {
      // Effect.fail re-raises the same error: keep it (only valid when the tag stays declared; rare)
      return dotted(u) === "Effect.die"
        ? { code: `Err(__e.into_defect())`, ty: { k: "never" }, errors: new Set() }
        : fail(u, "re-failing with `Effect.fail` isn't supported yet")
    }
    if (ts.isArrowFunction(u)) {
      if (u.parameters.length > 1) fail(u, "handlers take at most the error")
      const p = u.parameters[0]
      const inner: Scope = new Map(scope)
      if (p && ts.isIdentifier(p.name)) inner.delete(p.name.text) // the error value itself isn't usable yet
      const body = ts.isBlock(u.body) ? fail(u.body, "write handlers as expressions") : u.body
      return lowerEffect(body, inner)
    }
    return fail(h, "unsupported handler (supported: Effect.die, () => new SomeError({...}), () => Effect.succeed(...))")
  }

  function callQuery(q: Query, call: ts.CallExpression, scope: Scope): Eff {
    const res = q.result ? rty(q.result) : ({ k: "unit" } as RTy)
    const ty: RTy = q.mode === "findOneOption" ? { k: "option", of: res } : q.mode === "findAll" || q.mode === "findNonEmpty" ? { k: "vec", of: res } : res
    const errors = new Set(["SqlError", "SchemaError", ...(q.mode === "findOne" || q.mode === "findNonEmpty" ? ["NoSuchElementError"] : [])])
    const fn = `${snake(q.service)}_${snake(q.name)}`
    if (!q.request) {
      if (call.arguments.length > 0) fail(call, "this query takes no argument (Request: Schema.Void)")
      return { code: `${fn}(ctx).await`, ty, errors }
    }
    const arg = call.arguments[0] ?? fail(call, "queries take one argument")
    const want = rty(q.request)
    const v = lowerValue(arg, scope)
    const code = isCopy(want) ? coerce(v, want, arg, "query argument") : sameTy(v.ty, want) ? valueBorrowed(v) : fail(arg, `query expects ${showTy(want)}, got ${showTy(v.ty)}`)
    return { code: `${fn}(ctx, ${code}).await`, ty, errors }
  }

  function callMethod(m: PendingMethod, call: ts.CallExpression, scope: Scope): Eff {
    const args = call.arguments.map((a) => ({ v: lowerValue(a, scope), node: a as ts.Node }))
    const fn = lowerMethod(m, args, call)
    const code = fn.params.map((p, i) => (p.byRef ? valueBorrowed(args[i]!.v) : coerce(args[i]!.v, p.ty, args[i]!.node, `argument ${p.name}`)))
    return { code: `${fn.rustName}(ctx${code.map((c) => `, ${c}`).join("")}).await`, ty: fn.ret, errors: new Set(fn.errors) }
  }

  /** Lower a service method the first time it's called; parameter types come from call sites. */
  function lowerMethod(m: PendingMethod, args: { v: Val; node: ts.Node }[], call: ts.Node): Fn {
    if (m.lowered) {
      m.lowered.params.forEach((p, i) => {
        const a = args[i]!.v
        if (!sameTy(a.ty, p.ty) && !(a.ty.k === "i64" && p.ty.k === "f64")) fail(args[i]!.node, `${m.service}.${m.name} was already compiled with ${p.name}: ${showTy(p.ty)}`)
      })
      return m.lowered
    }
    if (m.lowering) return fail(call, "recursive service methods aren't supported")
    m.lowering = true
    if (m.fn.parameters.length !== args.length) fail(call, `expected ${m.fn.parameters.length} arguments`)
    const scope: Scope = new Map(m.scope)
    const params = m.fn.parameters.map((p, i) => {
      if (!ts.isIdentifier(p.name)) return fail(p, "destructured parameters aren't supported yet")
      const annotated = p.type?.getText()
      const a = args[i]!.v
      let ty: RTy = a.ty
      if (annotated === "number" && a.ty.k !== "i64" && a.ty.k !== "f64") fail(args[i]!.node, "expected a number")
      if (annotated === "string" && a.ty.k !== "String") fail(args[i]!.node, "expected a string")
      if (annotated === "boolean" && a.ty.k !== "bool") fail(args[i]!.node, "expected a boolean")
      if (ty.k === "never") ty = { k: "option", of: { k: "String" } }
      const byRef = !isCopy(ty)
      scope.set(p.name.text, { k: "val", v: { code: snake(p.name.text), ty, own: byRef ? "ref" : "owned" } })
      return { name: snake(p.name.text), ty, byRef }
    })
    let { body, ret, errors } = lowerFnBody(m.fn, scope)
    if (m.pipes.length) {
      // Effect.fn(f, ...pipes): run the body as a block, then apply the pipeline.
      const inner: Eff = { code: `(async { ${body.join("\n")} }).await`, ty: ret, errors }
      const piped = m.pipes.reduce((acc, a) => applyPipe(acc, a, scope), inner)
      body = [piped.code]
      ret = piped.ty
      errors = piped.errors
    }
    m.lowered = { rustName: `${snake(m.service)}_${snake(m.name)}`, params, body, ret, errors }
    return m.lowered
  }

  function lowerFnBody(fn: FnLike, scope: Scope): { body: string[]; ret: RTy; errors: Set<string> } {
    if (ts.isFunctionExpression(fn) || (ts.isArrowFunction(fn) && fn.asteriskToken)) {
      if (!fn.asteriskToken) fail(fn, "use a generator (function*) or an arrow function returning an Effect")
      return lowerStmts((fn.body as ts.Block).statements, scope)
    }
    const stmts = genBody(fn.body)
    if (stmts) return lowerStmts(stmts, scope)
    if (ts.isBlock(fn.body)) return fail(fn.body, "write the body as an expression, Effect.gen(function* () { ... }) or Effect.fn(function* () { ... })")
    const eff = lowerEffect(fn.body, scope)
    return { body: [eff.code], ret: eff.ty, errors: eff.errors }
  }

  function lowerStmts(stmts: readonly ts.Statement[], scope: Scope): { body: string[]; ret: RTy; errors: Set<string> } {
    const out: string[] = []
    const rets: RTy[] = []
    const errors = new Set<string>()
    const addErrors = (e: Set<string>) => e.forEach((x) => errors.add(x))
    const ret = (code: string, ty: RTy, node: ts.Node) => {
      if (ty.k !== "never") {
        if (rets[0] && !sameTy(rets[0], ty)) fail(node, `returns ${showTy(ty)} here but ${showTy(rets[0])} elsewhere`)
        rets.push(ty)
      }
      out.push(`return ${code};`)
    }
    for (const s of stmts) {
      if (ts.isVariableStatement(s)) {
        if (!(s.declarationList.flags & ts.NodeFlags.Const)) fail(s, "use const")
        for (const d of s.declarationList.declarations) {
          const id = ts.isIdentifier(d.name) ? d.name.text : fail(d.name, "destructuring isn't supported yet")
          const y = yieldStar(d.initializer)
          if (y) {
            const eff = lowerEffect(y, scope)
            addErrors(eff.errors)
            if (eff.ty.k === "never") fail(d, "this always fails; use `return yield*`")
            out.push(`let ${snake(id)} = ${eff.code}?;`)
            scope.set(id, { k: "val", v: { code: snake(id), ty: eff.ty, own: "owned" } })
          } else {
            const v = lowerValue(d.initializer ?? fail(d, "missing initializer"), scope)
            out.push(`let ${snake(id)} = ${valueOwned(v)};`)
            scope.set(id, { k: "val", v: { code: snake(id), ty: v.ty, own: "owned" } })
          }
        }
      } else if (ts.isIfStatement(s)) {
        const thenStmts = ts.isBlock(s.thenStatement) ? [...s.thenStatement.statements] : [s.thenStatement]
        const guard = calleeName(s.expression) === "Option.isNone" ? (s.expression as ts.CallExpression).arguments[0] : undefined
        if (guard && ts.isIdentifier(guard) && !s.elseStatement && thenStmts.length === 1 && ts.isReturnStatement(thenStmts[0]!)) {
          // if (Option.isNone(x)) return yield* fail  →  let Some(x) = x else { return fail };
          const v = lowerValue(guard, scope)
          if (v.ty.k !== "option") fail(guard, "Option.isNone needs an Option")
          const y = yieldStar((thenStmts[0] as ts.ReturnStatement).expression)
          const eff = y ? lowerEffect(y, scope) : fail(thenStmts[0], "the None branch must `return yield* ...`")
          addErrors(eff.errors)
          if (eff.ty.k !== "never") rets.push(eff.ty)
          out.push(`let Some(${v.code}) = ${v.code} else { return ${eff.code}; };`)
          scope.set(guard.text, { k: "val", v: { code: v.code, ty: (v.ty as { of: RTy }).of, own: "owned", narrowed: true } })
        } else {
          const cond = lowerValue(s.expression, scope)
          if (cond.ty.k !== "bool") fail(s.expression, "conditions must be booleans")
          const inner = lowerStmts(thenStmts, new Map(scope))
          const els = s.elseStatement ? lowerStmts(ts.isBlock(s.elseStatement) ? [...s.elseStatement.statements] : [s.elseStatement], new Map(scope)) : null
          addErrors(inner.errors)
          if (els) addErrors(els.errors)
          for (const r of [inner, els]) if (r && r.ret.k !== "never" && r.ret.k !== "unit") rets.push(r.ret)
          const block = (b: string[]) => b.filter((l) => l !== "Ok(())").map((l) => `    ${l}`)
          out.push(`if ${cond.code} {`, ...block(inner.body), els ? "} else {" : "}", ...(els ? [...block(els.body), "}"] : []))
        }
      } else if (ts.isReturnStatement(s)) {
        const y = yieldStar(s.expression)
        if (y) {
          const eff = lowerEffect(y, scope)
          addErrors(eff.errors)
          ret(eff.code, eff.ty, s)
        } else if (s.expression && (ts.isNewExpression(unwrap(s.expression)) || calleeName(unwrap(s.expression))?.startsWith("Effect."))) {
          fail(s, "use `return yield* ...` to run an Effect")
        } else {
          const v = lowerValue(s.expression ?? fail(s, "return a value"), scope)
          ret(`Ok(${valueOwned(v)})`, v.ty, s)
        }
      } else if (ts.isExpressionStatement(s) && yieldStar(s.expression)) {
        const eff = lowerEffect(yieldStar(s.expression)!, scope)
        addErrors(eff.errors)
        out.push(eff.ty.k === "never" ? `return ${eff.code};` : `${eff.code}?;`)
      } else fail(s, "unsupported statement in a generator body")
    }
    const retTy: RTy = rets[0] ?? (out.at(-1)?.startsWith("return") ? { k: "never" } : { k: "unit" })
    if (retTy.k === "unit" && !out.at(-1)?.startsWith("return")) out.push("Ok(())")
    return { body: out, ret: retTy, errors }
  }

  // ── Handlers ──
  const endpoints = apis.length ? apis.flat() : []
  if (apis.length > 1) attempt(() => fail(sf, "more than one HttpApi found; compile one API per server"))
  const handlers: Handler[] = []
  for (const g of handlerGroups) {
    attempt(() => {
      const { stmts, handlersParam } = handlerBuild(g.build)
      const scope: Scope = new Map()
      let ret: ts.Expression | undefined
      for (const s of stmts) {
        if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations) {
            const y = yieldStar(d.initializer)
            if (y && ts.isIdentifier(y) && services.has(y.text) && ts.isIdentifier(d.name)) scope.set(d.name.text, { k: "service", name: y.text })
            else fail(d, "in a handler group: bind services with `const x = yield* Service`")
          }
        } else if (ts.isReturnStatement(s) && s.expression) ret = s.expression
        else fail(s, "unsupported statement in a handler group")
      }
      if (!ret) return fail(g.build, "the handler group must return handlers.handleAll({...}) or handlers.handle(...)")
      const entries: { name: string; fn: ts.Expression; node: ts.Node }[] = []
      const { base, calls } = methodChain(ret)
      const all = [...(ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) ? [{ name: base.expression.name.text, args: base.arguments, node: base }] : []), ...calls]
      if (dotted((ts.isCallExpression(base) ? (base.expression as ts.PropertyAccessExpression).expression : base)) !== handlersParam) {
        fail(ret, `return ${handlersParam}.handleAll({...}) or ${handlersParam}.handle(...)`)
      }
      for (const c of all) {
        if (c.name === "handleAll") for (const [n, f] of objectProps(c.args[0], "handlers")) entries.push({ name: n, fn: f, node: f })
        else if (c.name === "handle") entries.push({ name: stringLit(c.args[0], "endpoint name"), fn: c.args[1]!, node: c.node })
        else fail(c.node, `unsupported handlers method .${c.name}()`)
      }
      for (const h of entries) attempt(() => handlers.push(lowerHandlerEntry(g.group, h, scope)))
    })
  }

  function handlerBuild(build: ts.Expression): { stmts: readonly ts.Statement[]; handlersParam: string } {
    const f = asFunction(build) ?? fail(build, "expected Effect.fn(function* (handlers) { ... }) or (handlers) => ...")
    const p = f.fn.parameters[0]
    const handlersParam = p && ts.isIdentifier(p.name) ? p.name.text : fail(f.fn, "the handler builder takes the `handlers` argument")
    if (f.fn.asteriskToken) return { stmts: (f.fn.body as ts.Block).statements, handlersParam }
    const gen = genBody(f.fn.body)
    if (gen) return { stmts: gen, handlersParam }
    if (!ts.isBlock(f.fn.body)) {
      const ret = ts.factory.createReturnStatement(f.fn.body as ts.Expression)
      ts.setTextRange(ret, f.fn.body)
      ;(ret as { parent?: ts.Node }).parent = f.fn
      return { stmts: [ret], handlersParam }
    }
    return fail(f.fn.body, "unsupported handler builder body")
  }

  function lowerHandlerEntry(group: string, h: { name: string; fn: ts.Expression; node: ts.Node }, groupScope: Scope): Handler {
    const ep = endpoints.find((x) => x.group === group && x.name === h.name) ?? fail(h.node, `no endpoint ${group}.${h.name} in the Api`)
    const f = asFunction(h.fn) ?? fail(h.fn, "handlers must be functions: ({ params, payload }) => ... or Effect.fn(function* ({ params }) { ... })")
    if (f.pipes.length) fail(h.fn, "Effect.fn pipelines on handlers aren't supported yet")
    const scope: Scope = new Map(groupScope)
    const uses = { params: false, payload: false }
    const params: Fn["params"] = []
    const p0 = f.fn.parameters[0]
    if (p0) {
      if (!ts.isObjectBindingPattern(p0.name)) fail(p0, "destructure the request: ({ params, payload }) => ...")
      for (const el of (p0.name as ts.ObjectBindingPattern).elements) {
        const n = (el.propertyName ?? el.name).getText()
        const local = el.name.getText()
        if (n === "params" && ep.params) {
          const cls = `${upperFirst(ep.name)}Params`
          if (!classes.has(cls)) classes.set(cls, { name: cls, error: false, tag: cls, fields: ep.params })
          scope.set(local, { k: "val", v: { code: "params", ty: { k: "cls", name: cls }, own: "owned" } })
          params.push({ name: "params", ty: { k: "cls", name: cls }, byRef: false })
          uses.params = true
        } else if (n === "payload" && ep.payload) {
          const ty = rty(ep.payload.ty)
          scope.set(local, { k: "val", v: { code: "payload", ty, own: "owned" } })
          params.push({ name: "payload", ty, byRef: false })
          uses.payload = true
        } else fail(el, `\`${n}\` isn't available on ${ep.name} (supported: params, payload)`)
      }
    }
    const { body, ret, errors } = lowerFnBody(f.fn, scope)
    const want = ep.success.ty ? rty(ep.success.ty) : ({ k: "unit" } as RTy)
    if (ret.k !== "never" && !sameTy(ret, want)) fail(h.fn, `handler returns ${showTy(ret)}, endpoint declares ${showTy(want)}`)
    for (const e of errors) {
      if (!ep.errors.some((x) => x.name === e)) fail(h.fn, `the handler can fail with \`${e}\`, which ${ep.name} doesn't declare (handle it, or add it to \`error\`)`)
    }
    return { endpoint: ep, fn: { rustName: `handle_${snake(group)}_${snake(ep.name)}`, params, body, ret: want, errors }, uses }
  }

  if (errors.length === 0) {
    for (const ep of endpoints) {
      attempt(() => {
        if (!handlers.some((h) => h.endpoint === ep)) fail(ep.node, `endpoint ${ep.group}.${ep.name} has no handler`)
      })
    }
  }
  if (endpoints.length === 0) attempt(() => fail(sf, "no HttpApi found: the entry file (or a file it imports) must declare `class Api extends HttpApi.make(...)`"))
  if (!sawDb && queries.length) attempt(() => fail(sf, "queries need a Postgres layer: PgClient.layerConfig(...) or BunPgClient.layerConfig(...)"))

  const lowered = [...new Set([...methods.values()].map((m) => m.lowered).filter((m): m is Fn => !!m))]
  return { program: { classes, endpoints, queries, methods: lowered, handlers, server }, errors, skipped }
}

function joinPath(a: string, b: string): string {
  return a.replace(/\/$/, "") + (b.startsWith("/") || b === "" ? b : `/${b}`) || "/"
}

const short = (n: ts.Node) => {
  const t = n.getText().replace(/\s+/g, " ")
  return t.length > 70 ? `${t.slice(0, 67)}...` : t
}
