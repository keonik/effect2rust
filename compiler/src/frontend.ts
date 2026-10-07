// Frontend: Effect program (TypeScript AST) → IR.
//
// Supported subset (anything else is a compile error that points at the code):
//   Schema.Class / Schema.TaggedError / Schema.Struct with String, Int, Number,
//     Boolean, NumberFromString and the minLength / maxLength / int refinements
//   HttpApi / HttpApiGroup / HttpApiEndpoint (setPath, setPayload, addSuccess, addError)
//   Effect.Service whose effect is Effect.gen defining SqlSchema queries + methods
//   HttpApiBuilder.group handlers
//   Inside Effect.gen: const x = yield* …, if (Option.isNone(x)) return yield* new E(…),
//     return yield* …, return value, Effect.succeed / Effect.fail, .pipe(Effect.orDie)
import ts from "typescript"
import type { ClassDef, Endpoint, Field, Fn, Handler, Program, Query, Refine, RTy, STy } from "./ir"

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

// ───────────────────────── AST helpers ─────────────────────────

/** "Schema.Class" for an identifier / property-access chain, else null. */
function dotted(e: ts.Node): string | null {
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) {
    const left = dotted(e.expression)
    return left && `${left}.${e.name.text}`
  }
  return null
}

const calleeName = (e: ts.Node) => (ts.isCallExpression(e) ? dotted(e.expression) : null)

/** `A.b(x).c(y).d(z)` → head "A.b" with args, then calls [c, d]. */
function methodChain(e: ts.Expression) {
  const calls: { name: string; args: readonly ts.Expression[]; node: ts.CallExpression }[] = []
  let cur: ts.Expression = e
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const target = cur.expression.expression
    if (ts.isIdentifier(target)) {
      calls.reverse()
      return { head: `${target.text}.${cur.expression.name.text}`, headArgs: cur.arguments, calls }
    }
    calls.push({ name: cur.expression.name.text, args: cur.arguments, node: cur })
    cur = target
  }
  return fail(e, "expected a method chain such as HttpApiEndpoint.get(...).addSuccess(...)")
}

function stringLit(e: ts.Node | undefined, what: string): string {
  if (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) return e.text
  return fail(e, `${what} must be a string literal`)
}

function numberLit(e: ts.Node | undefined, what: string): number {
  if (e && ts.isNumericLiteral(e)) return Number(e.text)
  return fail(e, `${what} must be a numeric literal`)
}

function objectProps(e: ts.Node | undefined, what: string): Map<string, ts.Expression> {
  if (!e || !ts.isObjectLiteralExpression(e)) return fail(e, `${what} must be an object literal`)
  const out = new Map<string, ts.Expression>()
  for (const p of e.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) out.set(p.name.text, p.initializer)
    else if (ts.isShorthandPropertyAssignment(p)) out.set(p.name.text, p.name)
    else fail(p, `unsupported property in ${what}`)
  }
  return out
}

const statusOf = (opts: ts.Expression | undefined, dflt: number) =>
  opts ? numberLit(objectProps(opts, "options").get("status"), "status") : dflt

/** Unwrap `yield* x` → x. */
function yieldStar(e: ts.Expression | undefined): ts.Expression | null {
  return e && ts.isYieldExpression(e) && e.asteriskToken && e.expression ? e.expression : null
}

/** The statements of `Effect.gen(function* () { ... })`. */
function genBody(e: ts.Node): ts.NodeArray<ts.Statement> | null {
  if (calleeName(e) !== "Effect.gen") return null
  const fn = (e as ts.CallExpression).arguments[0]
  if (fn && ts.isFunctionExpression(fn) && fn.asteriskToken && fn.parameters.length === 0) return fn.body.statements
  return fail(e, "Effect.gen must take a parameterless generator function: Effect.gen(function* () { ... })")
}

// ───────────────────────── Types ─────────────────────────

export const rty = (s: STy): RTy => {
  switch (s.k) {
    case "string": return { k: "String" }
    case "int": return { k: "i64" }
    case "number": return { k: "f64" }
    case "boolean": return { k: "bool" }
    case "numberFromString": return s.int ? { k: "i64" } : { k: "f64" }
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
  | { k: "sql" }

type Scope = Map<string, Binding>

interface PendingMethod {
  service: string
  name: string
  fn: ts.ArrowFunction
  scope: Scope
  lowered?: Fn & { fails: boolean }
  lowering?: boolean
}

export interface FrontendResult {
  program: Program
  /** Unsupported constructs found (only populated in `collect` mode; otherwise the first one is thrown). */
  errors: CompileError[]
  /** Top-level statements in imported files that aren't part of the server (helpers, constants…). */
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
  const endpoints: Endpoint[] = []
  const queries: Query[] = []
  const methods = new Map<string, PendingMethod>() // key: Service.method
  const services = new Set<string>()
  const handlerGroups: { group: string; scope: Scope; handlers: { name: string; fn: ts.ArrowFunction; node: ts.Node }[] }[] = []
  const groups = new Map<string, Endpoint[]>()
  const server = { port: 3000, maxConnections: 10, dbUrlEnv: "DATABASE_URL" }

  // ── Schemas ──
  function parseSchema(e: ts.Expression): STy {
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "pipe") {
      return e.arguments.reduce(refine, parseSchema(e.expression.expression))
    }
    switch (dotted(e)) {
      case "Schema.String": return { k: "string", refine: [] }
      case "Schema.Int": return { k: "int" }
      case "Schema.Number": return { k: "number" }
      case "Schema.Boolean": return { k: "boolean" }
      case "Schema.NumberFromString": return { k: "numberFromString", int: false }
    }
    if (ts.isIdentifier(e) && classes.has(e.text)) return { k: "ref", name: e.text }
    return fail(e, `unsupported schema \`${e.getText()}\` (supported: String, Int, Number, Boolean, NumberFromString, Schema.Class references)`)
  }

  function refine(base: STy, r: ts.Expression): STy {
    const name = calleeName(r)
    const args = (r as ts.CallExpression).arguments ?? []
    if ((name === "Schema.minLength" || name === "Schema.maxLength") && base.k === "string") {
      const k = name === "Schema.minLength" ? "minLength" : "maxLength"
      return { k: "string", refine: [...base.refine, { k, n: numberLit(args[0], k) } as Refine] }
    }
    if (name === "Schema.int" && args.length === 0) {
      if (base.k === "numberFromString") return { k: "numberFromString", int: true }
      if (base.k === "number") return { k: "int" }
    }
    return fail(r, `unsupported refinement \`${r.getText()}\` for this schema`)
  }

  const parseFields = (obj: ts.Node | undefined, what: string): Field[] => {
    const fields: Field[] = []
    for (const [name, e] of objectProps(obj, what)) attempt(() => void fields.push({ name, ty: parseSchema(e) }))
    return fields
  }

  // ── Top-level declarations ──
  for (const file of files) {
    const isEntry = file === sf
    for (const stmt of file.statements) {
      // Types and re-exports carry no runtime behavior.
      if (
        ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) || ts.isEmptyStatement(stmt) ||
        (ts.isModuleDeclaration(stmt) && (stmt.flags & ts.NodeFlags.Namespace) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword))
      ) continue
      attempt(() => {
        if (ts.isClassDeclaration(stmt) && stmt.name) {
          if (!isEntry && !isServerClass(stmt)) return void skipped.push(stmt)
          return classDecl(stmt.name.text, stmt)
        }
        if (ts.isVariableStatement(stmt)) {
          for (const d of stmt.declarationList.declarations) {
            if (!d.initializer) continue
            if (calleeName(d.initializer) === "Schema.Struct" && ts.isIdentifier(d.name)) {
              // const Todo = Schema.Struct({...}) is used like a Schema.Class
              const name = d.name.text
              classes.set(name, { name, error: false, tag: name, fields: parseFields((d.initializer as ts.CallExpression).arguments[0], "struct fields") })
              continue
            }
            if (!isEntry && !isServerValue(d.initializer)) skipped.push(d)
            else topLevelValue(d.initializer)
          }
          return
        }
        if (ts.isExpressionStatement(stmt)) return topLevelValue(stmt.expression)
        if (!isEntry) return void skipped.push(stmt)
        fail(stmt, "unsupported top-level statement")
      })
    }
  }

  function classDecl(name: string, decl: ts.ClassDeclaration) {
    if (decl.members.length > 0) fail(decl.members[0], "class bodies must be empty (methods on schemas aren't supported yet)")
    const h = decl.heritageClauses?.[0]?.types[0]?.expression
    if (!h || !ts.isCallExpression(h)) return fail(decl, `unsupported class ${name}`)
    const inner = h.expression
    const innerName = calleeName(inner)
    if (innerName === "Schema.Class") {
      stringLit((inner as ts.CallExpression).arguments[0], "class identifier")
      const def: ClassDef = { name, error: false, tag: name, fields: [] }
      classes.set(name, def)
      def.fields = parseFields(h.arguments[0], "class fields")
    } else if (innerName === "Schema.TaggedError") {
      const def: ClassDef = { name, error: true, tag: stringLit(h.arguments[0], "error tag"), fields: [] }
      classes.set(name, def)
      def.fields = parseFields(h.arguments[1], "error fields")
    } else if (innerName === "Effect.Service") {
      serviceDecl(name, h)
    } else {
      const chain = methodChain(h)
      if (chain.head === "HttpApiGroup.make") {
        const group = stringLit(chain.headArgs[0], "group name")
        const eps: Endpoint[] = []
        groups.set(name, eps)
        for (const c of chain.calls) {
          attempt(() => {
            if (c.name !== "add") fail(c.node, `unsupported HttpApiGroup method .${c.name}`)
            eps.push(endpoint(group, c.args[0]!))
          })
        }
      } else if (chain.head === "HttpApi.make") {
        for (const c of chain.calls) {
          const g = c.name === "add" && ts.isIdentifier(c.args[0]!) ? groups.get(c.args[0].text) : undefined
          if (!g) fail(c.node, "HttpApi.make(...).add(...) expects a group class declared above")
          endpoints.push(...g!)
        }
      } else fail(h, `unsupported base class \`${chain.head}\``)
    }
  }

  function endpoint(group: string, e: ts.Expression): Endpoint {
    const chain = methodChain(e)
    const method = chain.head.replace("HttpApiEndpoint.", "")
    if (!["get", "post", "put", "patch", "delete"].includes(method) || !chain.head.startsWith("HttpApiEndpoint.")) {
      fail(e, "endpoints must start with HttpApiEndpoint.get/post/put/patch/delete")
    }
    const ep: Endpoint = {
      group,
      name: stringLit(chain.headArgs[0], "endpoint name"),
      method: method as Endpoint["method"],
      path: stringLit(chain.headArgs[1], "endpoint path"),
      pathFields: null,
      payload: null,
      success: { ty: null, status: 204 },
      errors: [],
    }
    for (const c of chain.calls) {
      switch (c.name) {
        case "setPath": {
          if (calleeName(c.args[0]!) !== "Schema.Struct") fail(c.args[0], "setPath expects Schema.Struct({...})")
          ep.pathFields = parseFields((c.args[0] as ts.CallExpression).arguments[0], "path fields")
          for (const f of ep.pathFields) {
            if (!ep.path.includes(`:${f.name}`)) fail(c.args[0], `path field \`${f.name}\` is not in ${ep.path}`)
            if (f.ty.k !== "string" && f.ty.k !== "numberFromString") fail(c.args[0], "path fields must decode from strings")
          }
          break
        }
        case "setPayload": {
          ep.payload = parseSchema(c.args[0]!)
          if (ep.payload.k !== "ref") fail(c.args[0], "payload must be a Schema.Class")
          break
        }
        case "addSuccess": {
          const ty = parseSchema(c.args[0]!)
          if (ty.k !== "ref") fail(c.args[0], "success schema must be a Schema.Class")
          ep.success = { ty, status: statusOf(c.args[1], 200) }
          break
        }
        case "addError": {
          const name = ts.isIdentifier(c.args[0]!) ? c.args[0].text : ""
          if (!classes.get(name)?.error) fail(c.args[0], "addError expects a Schema.TaggedError class")
          ep.errors.push({ name, status: statusOf(c.args[1], 500) })
          break
        }
        default: fail(c.node, `unsupported endpoint method .${c.name}`)
      }
    }
    return ep
  }

  function serviceDecl(name: string, h: ts.CallExpression) {
    stringLit(h.arguments[0], "service key")
    const body = genBody(objectProps(h.arguments[1], "service options").get("effect") ?? fail(h, "service needs `effect:`"))
    if (!body) return fail(h, "service `effect` must be Effect.gen(...)")
    services.add(name)
    const scope: Scope = new Map()
    for (const s of body) attempt(() => {
      if (ts.isVariableStatement(s)) {
        const d = s.declarationList.declarations[0]!
        const id = ts.isIdentifier(d.name) ? d.name.text : fail(d.name, "use a plain identifier")
        const y = yieldStar(d.initializer)
        if (y && dotted(y) === "SqlClient.SqlClient") scope.set(id, { k: "sql" })
        else if (d.initializer && calleeName(d.initializer)?.startsWith("SqlSchema.")) scope.set(id, { k: "query", q: query(name, id, d.initializer as ts.CallExpression, scope) })
        else fail(d, "in a service: bind `yield* SqlClient.SqlClient` or a SqlSchema query")
      } else if (ts.isReturnStatement(s) && s.expression) {
        for (const [m, fn] of objectProps(s.expression, "service methods")) {
          attempt(() => {
            if (!ts.isArrowFunction(fn)) fail(fn, "service methods must be arrow functions (wrap queries: `(id) => findOne(id)`)")
            methods.set(`${name}.${m}`, { service: name, name: m, fn: fn as ts.ArrowFunction, scope })
          })
        }
      } else fail(s, "unsupported statement in service definition")
    })
  }

  function query(service: string, name: string, call: ts.CallExpression, scope: Scope): Query {
    const mode = calleeName(call)!.replace("SqlSchema.", "") as Query["mode"]
    if (!["findOne", "single", "findAll", "void"].includes(mode)) fail(call, `unsupported SqlSchema.${mode}`)
    const opts = objectProps(call.arguments[0], "SqlSchema options")
    const request = parseSchema(opts.get("Request") ?? fail(call, "missing Request"))
    const result = mode === "void" ? null : parseSchema(opts.get("Result") ?? fail(call, "missing Result"))
    if (result && result.k !== "ref") fail(opts.get("Result"), "Result must be a Schema.Class")
    const exec = opts.get("execute")
    if (!exec || !ts.isArrowFunction(exec) || exec.parameters.length !== 1) return fail(exec ?? call, "execute must be (req) => sql`...`")
    const requestParam = exec.parameters[0]!.name.getText()
    const body = exec.body
    if (!ts.isTaggedTemplateExpression(body) || !ts.isIdentifier(body.tag) || scope.get(body.tag.text)?.k !== "sql") {
      return fail(body, "execute must return a single sql`...` template")
    }
    let sql = ""
    const binds: Query["binds"] = []
    const t = body.template
    if (ts.isNoSubstitutionTemplateLiteral(t)) sql = t.text
    else {
      sql = t.head.text
      t.templateSpans.forEach((span, i) => {
        const path: string[] = []
        let e: ts.Expression = span.expression
        while (ts.isPropertyAccessExpression(e)) {
          path.unshift(e.name.text)
          e = e.expression
        }
        if (!ts.isIdentifier(e) || e.text !== requestParam) {
          fail(span.expression, `interpolations must be \`${requestParam}\` or its fields (sql helpers like sql.in aren't supported yet)`)
        }
        binds.push({ path, node: span.expression })
        sql += `$${i + 1}${span.literal.text}`
      })
    }
    const q: Query = { service, name, mode, request, result, requestParam, sql, binds, node: call }
    queries.push(q)
    return q
  }

  function topLevelValue(e: ts.Expression) {
    if (calleeName(e) === "HttpApiBuilder.group") {
      const [, groupArg, fn] = (e as ts.CallExpression).arguments
      const group = stringLit(groupArg, "group name")
      const body = fn && ts.isArrowFunction(fn) ? genBody(fn.body) : null
      if (!body) return fail(e, "HttpApiBuilder.group(Api, name, (handlers) => Effect.gen(...))")
      const scope: Scope = new Map()
      const handlers: (typeof handlerGroups)[number]["handlers"] = []
      for (const s of body) {
        if (ts.isVariableStatement(s)) {
          const d = s.declarationList.declarations[0]!
          const y = yieldStar(d.initializer)
          if (y && ts.isIdentifier(y) && services.has(y.text) && ts.isIdentifier(d.name)) scope.set(d.name.text, { k: "service", name: y.text })
          else fail(d, "in a handler group: bind services with `const x = yield* Service`")
        } else if (ts.isReturnStatement(s) && s.expression) {
          const chain = methodChain(s.expression)
          const all = [{ name: chain.head.split(".")[1]!, args: chain.headArgs, node: s.expression }, ...chain.calls]
          for (const c of all) {
            if (c.name !== "handle") fail(c.node, `unsupported handlers method .${c.name}`)
            const fn = c.args[1]
            if (!fn || !ts.isArrowFunction(fn)) return fail(c.node, "handlers must be arrow functions")
            handlers.push({ name: stringLit(c.args[0], "endpoint name"), fn, node: c.node })
          }
        } else fail(s, "unsupported statement in handler group")
      }
      handlerGroups.push({ group, scope, handlers })
      return
    }
    // Wiring: read config from the layers we recognize; everything else is plumbing.
    const visit = (n: ts.Node): void => {
      const name = calleeName(n)
      if (name !== null && /^(Bun)?PgClient\.layer(Config)?$/.test(name)) {
        const opts = objectProps((n as ts.CallExpression).arguments[0], "PgClient options")
        const url = opts.get("url")
        if (url && ts.isCallExpression(url) && ["Config.redacted", "Config.string"].includes(calleeName(url)!)) {
          server.dbUrlEnv = stringLit(url.arguments[0], "config key")
        } else fail(url ?? n, "url must be Config.redacted(\"ENV_VAR\")")
        const max = opts.get("maxConnections")
        if (max) server.maxConnections = numberLit(max, "maxConnections")
      } else if (name === "BunHttpServer.layer" || name === "NodeHttpServer.layer") {
        const port = objectProps((n as ts.CallExpression).arguments[0], "server options").get("port")
        if (port) server.port = numberLit(port, "port")
      }
      ts.forEachChild(n, visit)
    }
    visit(e)
  }

  // ── Lowering function bodies ──

  const valueOwned = (v: Val) => (v.own === "owned" || isCopy(v.ty) ? v.code : `${v.code}.clone()`)
  const valueBorrowed = (v: Val) => (v.own === "ref" ? v.code : `&${v.code}`)
  const fieldsOf = (t: RTy, node: ts.Node) =>
    t.k === "cls" ? classes.get(t.name)!.fields : fail(node, `\`${node.getText()}\` has no fields (type ${showTy(t)})`)

  /** Convert a value to the expected type (only lossless widening is implicit). */
  function coerce(v: Val, want: RTy, node: ts.Node, ctx: string): string {
    if (sameTy(v.ty, want)) return valueOwned(v)
    if (v.ty.k === "i64" && want.k === "f64") return `(${v.code} as f64)`
    return fail(node, `${ctx}: expected ${showTy(want)}, got ${showTy(v.ty)}`)
  }

  function lowerValue(e: ts.Expression, scope: Scope): Val {
    if (ts.isParenthesizedExpression(e)) return lowerValue(e.expression, scope)
    if (ts.isIdentifier(e)) {
      const b = scope.get(e.text)
      if (b?.k === "val") return b.v
      return fail(e, `unknown value \`${e.text}\``)
    }
    if (ts.isPropertyAccessExpression(e)) {
      const base = lowerValue(e.expression, scope)
      if (e.name.text === "value" && base.narrowed) return base
      if (base.ty.k === "option") fail(e, "unwrap Options with an `if (Option.isNone(x)) return yield* ...` guard first")
      const f = fieldsOf(base.ty, e.expression).find((f) => f.name === e.name.text) ?? fail(e.name, `no field \`${e.name.text}\``)
      return { code: `${base.code}.${snake(f.name)}`, ty: rty(f.ty), own: "place" }
    }
    if (ts.isNumericLiteral(e)) {
      const n = Number(e.text)
      return Number.isInteger(n) ? { code: `${n}i64`, ty: { k: "i64" }, own: "owned" } : { code: `${n}f64`, ty: { k: "f64" }, own: "owned" }
    }
    if (ts.isStringLiteral(e)) return { code: `String::from(${JSON.stringify(e.text)})`, ty: { k: "String" }, own: "owned" }
    if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) {
      return { code: e.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false", ty: { k: "bool" }, own: "owned" }
    }
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const v = lowerValue(e.operand, scope)
      if (v.ty.k !== "bool") fail(e, "`!` needs a boolean")
      return { code: `!(${v.code})`, ty: v.ty, own: "owned" }
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
      const l = lowerValue(e.left, scope)
      const r = lowerValue(e.right, scope)
      if (!sameTy(l.ty, r.ty) || !["i64", "f64", "bool", "String"].includes(l.ty.k)) fail(e, `operands must be the same primitive type (${showTy(l.ty)} vs ${showTy(r.ty)})`)
      if (op[1] === "arith" && l.ty.k !== "i64" && l.ty.k !== "f64") fail(e, "arithmetic needs numbers")
      if (op[1] === "bool" && l.ty.k !== "bool") fail(e, "&& and || need booleans")
      const ty: RTy = op[1] === "arith" ? l.ty : { k: "bool" }
      return { code: `(${l.code} ${op[0]} ${r.code})`, ty, own: "owned" }
    }
    if (calleeName(e) === "Option.isNone" || calleeName(e) === "Option.isSome") {
      const v = lowerValue((e as ts.CallExpression).arguments[0]!, scope)
      if (v.ty.k !== "option") fail(e, "Option.isNone needs an Option")
      return { code: `${v.code}.${calleeName(e) === "Option.isNone" ? "is_none" : "is_some"}()`, ty: { k: "bool" }, own: "owned" }
    }
    return fail(e, `unsupported expression \`${e.getText()}\``)
  }

  /** An Effect expression → Rust expression of type Result<ty, AppError> (already awaited). */
  function lowerEffect(e: ts.Expression, scope: Scope): { code: string; ty: RTy; fails: boolean } {
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "pipe") {
      let cur = lowerEffect(e.expression.expression, scope)
      for (const a of e.arguments) {
        if (dotted(a) !== "Effect.orDie") fail(a, "only .pipe(Effect.orDie) is supported in Effect pipelines so far")
        if (cur.fails) cur = { ...cur, code: `${cur.code}.map_err(AppError::into_defect)`, fails: false }
      }
      return cur
    }
    if (ts.isNewExpression(e) || calleeName(e) === "Effect.fail") {
      const n = ts.isNewExpression(e) ? e : (e as ts.CallExpression).arguments[0]
      if (!n || !ts.isNewExpression(n) || !ts.isIdentifier(n.expression)) return fail(e, "Effect.fail expects `new SomeError({...})`")
      const cls = classes.get(n.expression.text)
      if (!cls?.error) return fail(n, `\`${n.expression.text}\` is not a Schema.TaggedError`)
      const props = objectProps(n.arguments?.[0], "error fields")
      const inits = cls.fields.map((f) => {
        const init = props.get(f.name) ?? fail(n, `missing field \`${f.name}\``)
        return `${snake(f.name)}: ${coerce(lowerValue(init, scope), rty(f.ty), init, `field ${f.name}`)}`
      })
      return { code: `Err(AppError::${cls.name} { ${inits.join(", ")} })`, ty: { k: "never" }, fails: true }
    }
    if (calleeName(e) === "Effect.succeed") {
      const v = lowerValue((e as ts.CallExpression).arguments[0]!, scope)
      return { code: `Ok(${valueOwned(v)})`, ty: v.ty, fails: false }
    }
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      const b = scope.get(e.expression.text)
      if (b?.k === "query") return callQuery(b.q, e, scope)
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)) {
      const b = scope.get(e.expression.expression.text)
      if (b?.k === "service") return callMethod(b.name, e.expression.name.text, e, scope)
    }
    return fail(e, `unsupported Effect \`${e.getText()}\` (supported: SqlSchema queries, service methods, new TaggedError, Effect.succeed/fail, .pipe(Effect.orDie))`)
  }

  function callQuery(q: Query, call: ts.CallExpression, scope: Scope) {
    const arg = call.arguments[0] ?? fail(call, "queries take one argument")
    const want = rty(q.request)
    const v = lowerValue(arg, scope)
    const code = isCopy(want) ? coerce(v, want, arg, "query argument") : sameTy(v.ty, want) ? valueBorrowed(v) : fail(arg, `query expects ${showTy(want)}, got ${showTy(v.ty)}`)
    const res = q.result ? rty(q.result) : ({ k: "unit" } as RTy)
    const ty: RTy = q.mode === "findOne" ? { k: "option", of: res } : q.mode === "findAll" ? { k: "vec", of: res } : res
    return { code: `${snake(q.service)}_${snake(q.name)}(ctx, ${code}).await`, ty, fails: false }
  }

  function callMethod(service: string, name: string, call: ts.CallExpression, scope: Scope) {
    const m = methods.get(`${service}.${name}`) ?? fail(call, `${service} has no method \`${name}\``)
    const args = call.arguments.map((a) => ({ v: lowerValue(a, scope), node: a }))
    const fn = lowerMethod(m, args, call)
    const code = fn.params.map((p, i) => (p.byRef ? valueBorrowed(args[i]!.v) : coerce(args[i]!.v, p.ty, args[i]!.node, `argument ${p.name}`)))
    return { code: `${fn.rustName}(ctx, ${code.join(", ")}).await`, ty: fn.ret, fails: fn.fails }
  }

  /** Lower a service method the first time it's called; parameter types come from call sites. */
  function lowerMethod(m: PendingMethod, args: { v: Val; node: ts.Node }[], call: ts.Node) {
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
      if (!ts.isIdentifier(p.name)) return fail(p, "use plain parameters")
      const annotated = p.type?.getText()
      const a = args[i]!.v
      let ty: RTy = a.ty
      if (annotated === "number" && a.ty.k !== "i64" && a.ty.k !== "f64") fail(args[i]!.node, "expected a number")
      if (annotated && annotated !== "number" && annotated !== showTy(a.ty) && !(annotated === "string" && a.ty.k === "String") && !(annotated === "boolean" && a.ty.k === "bool")) {
        fail(args[i]!.node, `parameter \`${p.name.text}: ${annotated}\` receives ${showTy(a.ty)}`)
      }
      const byRef = !isCopy(ty)
      scope.set(p.name.text, { k: "val", v: { code: snake(p.name.text), ty, own: byRef ? "ref" : "owned" } })
      return { name: snake(p.name.text), ty, byRef }
    })
    const { body, ret, fails } = lowerFnBody(m.fn, scope)
    m.lowered = { rustName: `${snake(m.service)}_${snake(m.name)}`, params, body, ret, fails }
    return m.lowered
  }

  function lowerFnBody(fn: ts.ArrowFunction, scope: Scope) {
    const stmts = genBody(fn.body)
    if (stmts) return lowerStmts(stmts, scope)
    if (ts.isBlock(fn.body)) return fail(fn.body, "write the body as an expression or Effect.gen(function* () { ... })")
    const eff = lowerEffect(fn.body, scope)
    return { body: [eff.code], ret: eff.ty, fails: eff.fails }
  }

  function lowerStmts(stmts: readonly ts.Statement[], scope: Scope): { body: string[]; ret: RTy; fails: boolean } {
    const out: string[] = []
    const rets: RTy[] = []
    let fails = false
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
            fails ||= eff.fails
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
          fails ||= eff.fails
          if (eff.ty.k !== "never") rets.push(eff.ty)
          out.push(`let Some(${v.code}) = ${v.code} else { return ${eff.code}; };`)
          scope.set(guard.text, { k: "val", v: { code: v.code, ty: (v.ty as { of: RTy }).of, own: "owned", narrowed: true } })
        } else {
          const cond = lowerValue(s.expression, scope)
          if (cond.ty.k !== "bool") fail(s.expression, "conditions must be booleans")
          const inner = lowerStmts(thenStmts, new Map(scope))
          const els = s.elseStatement ? lowerStmts(ts.isBlock(s.elseStatement) ? [...s.elseStatement.statements] : [s.elseStatement], new Map(scope)) : null
          fails ||= inner.fails || (els?.fails ?? false)
          for (const r of [inner, els]) if (r && r.ret.k !== "never" && r.ret.k !== "unit") rets.push(r.ret)
          out.push(`if ${cond.code} {`, ...inner.body.map((l) => `    ${l}`), els ? "} else {" : "}", ...(els ? [...els.body.map((l) => `    ${l}`), "}"] : []))
        }
      } else if (ts.isReturnStatement(s)) {
        const y = yieldStar(s.expression)
        if (y) {
          const eff = lowerEffect(y, scope)
          fails ||= eff.fails
          ret(eff.code, eff.ty, s)
        } else {
          const v = lowerValue(s.expression ?? fail(s, "return a value"), scope)
          ret(`Ok(${valueOwned(v)})`, v.ty, s)
        }
      } else if (ts.isExpressionStatement(s) && yieldStar(s.expression)) {
        const eff = lowerEffect(yieldStar(s.expression)!, scope)
        fails ||= eff.fails
        out.push(`${eff.code}?;`)
      } else fail(s, "unsupported statement in Effect.gen")
    }
    const retTy: RTy = rets[0] ?? (out.at(-1)?.startsWith("return") ? { k: "never" } : { k: "unit" })
    if (retTy.k === "unit" && !out.at(-1)?.startsWith("return")) out.push("Ok(())")
    return { body: out, ret: retTy, fails }
  }

  // ── Handlers ──
  const handlers: Handler[] = []
  for (const g of handlerGroups) {
    for (const h of g.handlers) attempt(() => {
      const ep = endpoints.find((x) => x.group === g.group && x.name === h.name) ?? fail(h.node, `no endpoint ${g.group}.${h.name} in the Api`)
      const scope: Scope = new Map(g.scope)
      const uses = { path: false, payload: false }
      const params: Fn["params"] = []
      const p0 = h.fn.parameters[0]
      if (p0) {
        if (!ts.isObjectBindingPattern(p0.name)) fail(p0, "destructure the request: ({ path, payload }) => ...")
        for (const el of (p0.name as ts.ObjectBindingPattern).elements) {
          const n = el.name.getText()
          if (n === "path" && ep.pathFields) {
            const cls = `${upperFirst(ep.name)}Path`
            classes.set(cls, { name: cls, error: false, tag: cls, fields: ep.pathFields })
            scope.set("path", { k: "val", v: { code: "path", ty: { k: "cls", name: cls }, own: "owned" } })
            params.push({ name: "path", ty: { k: "cls", name: cls }, byRef: false })
            uses.path = true
          } else if (n === "payload" && ep.payload) {
            const ty = rty(ep.payload)
            scope.set("payload", { k: "val", v: { code: "payload", ty, own: "owned" } })
            params.push({ name: "payload", ty, byRef: false })
            uses.payload = true
          } else fail(el, `\`${n}\` isn't available on ${ep.name} (supported: path, payload)`)
        }
      }
      const { body, ret } = lowerFnBody(h.fn, scope)
      const want = ep.success.ty ? rty(ep.success.ty) : ({ k: "unit" } as RTy)
      if (ret.k !== "never" && !sameTy(ret, want)) fail(h.fn, `handler returns ${showTy(ret)}, endpoint declares ${showTy(want)}`)
      handlers.push({ endpoint: ep, fn: { rustName: `handle_${snake(ep.name)}`, params, body, ret: want }, uses })
    })
  }
  if (opts.collect) {
    for (const m of methods.values()) {
      if (m.lowered || m.lowering) continue
      attempt(() => {
        const args = m.fn.parameters.map((p) => {
          const t = p.type?.getText()
          const ty: RTy | undefined =
            t === "number" ? { k: "i64" } : t === "string" ? { k: "String" } : t === "boolean" ? { k: "bool" } : t && classes.has(t) ? { k: "cls", name: t } : undefined
          if (!ty) fail(p, `can't infer the type of \`${p.name.getText()}\` (annotate it; no handler calls ${m.service}.${m.name})`)
          return { v: { code: p.name.getText(), ty: ty!, own: "owned" as const }, node: p as ts.Node }
        })
        lowerMethod(m, args, m.fn)
      })
    }
  }
  if (errors.length === 0) {
    for (const ep of endpoints) {
      attempt(() => {
        if (!handlers.some((h) => h.endpoint === ep)) fail(sf, `endpoint ${ep.group}.${ep.name} has no handler`)
      })
    }
  }
  if (endpoints.length === 0) attempt(() => fail(sf, "no HttpApi found: the entry file (or a file it imports) must declare `class Api extends HttpApi.make(...)`"))

  const lowered = [...methods.values()].flatMap((m) => (m.lowered ? [m.lowered] : []))
  return { program: { classes, endpoints, queries, methods: lowered, handlers, server }, errors, skipped }
}

/** Declarations in imported files that belong to the server (everything else there is skipped). */
function isServerClass(decl: ts.ClassDeclaration): boolean {
  const h = decl.heritageClauses?.[0]?.types[0]?.expression
  if (!h) return false
  const text = h.getText()
  return /^(Schema\.(Class|TaggedError)|Effect\.Service|HttpApiGroup\.make|HttpApi\.make)\b/.test(text)
}

function isServerValue(e: ts.Expression): boolean {
  return /^(HttpApiBuilder\.|HttpApiEndpoint\.)/.test(e.getText())
}

const upperFirst = (s: string) => s[0]!.toUpperCase() + s.slice(1)
