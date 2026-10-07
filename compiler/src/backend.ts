// Backend: IR → a Rust crate (axum + sqlx + tokio + effect_rt), for Effect 4 semantics.
import { CompileError, describeSchema, rty, showTy, snake } from "./frontend"
import type { Check, ClassDef, Fn, Handler, Program, Query, RTy, STy } from "./ir"

const rust = (t: RTy): string => {
  switch (t.k) {
    case "cls": return t.name
    case "option": return `Option<${rust(t.of)}>`
    case "vec": return `Vec<${rust(t.of)}>`
    case "unit": return "()"
    case "never": return "std::convert::Infallible"
    default: return t.k
  }
}

const indent = (lines: string[], n = 1) => lines.map((l) => "    ".repeat(n) + l)
const lit = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`)

// ───────────── Checks ─────────────

/** Rust boolean expression testing `v` (a value or reference) against the checks. */
function checksExpr(s: STy, v: string): string | null {
  const parts: string[] = []
  if (s.k === "string") {
    for (const c of s.checks) {
      if (c.k === "minLength") parts.push(`rt::utf16_len(&${v}) >= ${c.n}`)
      else if (c.k === "maxLength") parts.push(`rt::utf16_len(&${v}) <= ${c.n}`)
    }
  } else if (s.k === "number" || s.k === "numberFromString") {
    const f = s.int ? `(${v} as f64)` : v
    if (!s.int && s.finite) parts.push(`${v}.is_finite()`)
    for (const c of s.checks as Check[]) {
      const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[c.k as "gt" | "gte" | "lt" | "lte"]
      if (op) parts.push(`${f} ${op} ${lit(c.n)}`)
    }
  }
  return parts.length ? parts.join(" && ") : null
}

// ───────────── Decoders ─────────────

/** JSON value → field (payloads): expression of type Result<T, rt::Invalid>. */
function decodeJson(ty: STy, v: string): string {
  switch (ty.k) {
    case "string": {
      const c = checksExpr(ty, "s")
      return c ? `rt::json_string(${v}).and_then(|s| if ${c} { Ok(s) } else { Err(rt::Invalid) })` : `rt::json_string(${v})`
    }
    case "number": {
      const base = ty.int ? `rt::json_int(${v})` : `rt::json_number(${v}, ${ty.finite})`
      const c = checksExpr(ty, "n")
      return c ? `${base}.and_then(|n| if ${c} { Ok(n) } else { Err(rt::Invalid) })` : base
    }
    case "numberFromString": {
      const base = `rt::json_string(${v}).and_then(|s| ${numberFromStr(ty, "&s")})`
      return base
    }
    case "boolean": return `rt::json_bool(${v})`
    case "nullOr": return `match ${v} { Some(rt::Value::Null) => Ok(None), other => ${decodeJson(ty.of, "other")}.map(Some) }`
    case "ref": return `${ty.name}::decode(${v})`
  }
}

/** `Number(s)` + checks, for NumberFromString: Result<T, rt::Invalid>. */
function numberFromStr(ty: Extract<STy, { k: "numberFromString" }>, s: string): string {
  const parsed = `rt::js_number(${s})`
  const c = checksExpr({ ...ty, int: false }, "n")
  const int = ty.int ? `.and_then(rt::to_int)` : ""
  const finite = !ty.int && ty.finite ? " && n.is_finite()" : ""
  const cond = [c, finite ? "n.is_finite()" : null].filter(Boolean).join(" && ")
  return `Ok::<f64, rt::Invalid>(${parsed})${cond ? `.and_then(|n| if ${cond} { Ok(n) } else { Err(rt::Invalid) })` : ""}${int}`
}

/** Path parameter string → field (StringTree codec): Result<T, rt::Invalid>. */
function decodeParam(ty: STy, s: string): string {
  switch (ty.k) {
    case "string": {
      const c = checksExpr(ty, "v")
      return c ? `{ let v = ${s}.to_owned(); if ${c} { Ok(v) } else { Err(rt::Invalid) } }` : `Ok::<String, rt::Invalid>(${s}.to_owned())`
    }
    case "number": {
      const base = ty.finite ? `rt::param_finite(${s})` : `rt::param_number(${s})`
      const c = checksExpr({ ...ty, int: false }, "n")
      const tail = ty.int ? ".and_then(rt::to_int)" : ""
      return `${base}${c ? `.and_then(|n| if ${c} { Ok(n) } else { Err(rt::Invalid) })` : ""}${tail}`
    }
    case "numberFromString": return numberFromStr(ty, s)
    case "boolean": return `rt::param_bool(${s})`
    default: throw new Error(`unsupported path parameter type ${ty.k}`)
  }
}

function classDef(c: ClassDef, decodable: boolean): string[] {
  const fields = c.fields.map((f) => {
    const t = rty(f.ty)
    const ser = t.k === "f64" ? `#[serde(serialize_with = "rt::ser_number")] ` : t.k === "option" && t.of.k === "f64" ? `#[serde(serialize_with = "rt::ser_opt_number")] ` : ""
    const rename = snake(f.name) !== f.name ? `#[serde(rename = "${f.name}")] ` : ""
    return `${ser}${rename}pub ${snake(f.name)}: ${rust(t)},`
  })
  const out = ["#[derive(Debug, Clone, Serialize)]", `pub struct ${c.name} {`, ...indent(fields), "}"]
  if (decodable) {
    out.push(
      "",
      `impl ${c.name} {`,
      "    /// Decode from parsed JSON, like Schema.decodeUnknown on the JSON codec.",
      "    pub fn decode(v: Option<&rt::Value>) -> Result<Self, rt::Invalid> {",
      "        let m = rt::json_object(v)?;",
      "        Ok(Self {",
      ...indent(c.fields.map((f) => `${snake(f.name)}: ${decodeJson(f.ty, `m.get(${JSON.stringify(f.name)})`)}?,`), 3),
      "        })",
      "    }",
      "}",
    )
  }
  return out
}

function paramsDecoder(c: ClassDef, order: string[]): string[] {
  return [
    `impl ${c.name} {`,
    "    /// Decode path parameters (already URI-decoded by the router).",
    "    pub fn from_params(p: &[String]) -> Result<Self, rt::Invalid> {",
    "        Ok(Self {",
    ...indent(c.fields.map((f) => `${snake(f.name)}: ${decodeParam(f.ty, `p[${order.indexOf(f.name)}].as_str()`)}?,`), 3),
    "        })",
    "    }",
    "}",
  ]
}

// ───────────── Errors ─────────────

function appError(errors: ClassDef[]): string[] {
  const variants = errors.flatMap((e) => [
    ...(e.tag !== e.name ? [`#[serde(rename = "${e.tag}")]`] : []),
    `${e.name} { ${e.fields.map((f) => {
      const t = rty(f.ty)
      const ser = t.k === "f64" ? `#[serde(serialize_with = "rt::ser_number")] ` : ""
      return `${ser}${snake(f.name) !== f.name ? `#[serde(rename = "${f.name}")] ` : ""}${snake(f.name)}: ${rust(t)}`
    }).join(", ")} },`,
  ])
  return [
    "/// Every failure in the program: tagged errors (the `E` channel), the built-in SQL",
    "/// failures, and defects.",
    "#[derive(Debug, Serialize)]",
    `#[serde(tag = "_tag")]`,
    "pub enum AppError {",
    ...indent(variants),
    "    #[serde(skip)]",
    "    NoSuchElementError {},",
    "    #[serde(skip)]",
    "    SqlError(String),",
    "    #[serde(skip)]",
    "    SchemaError(String),",
    "    #[serde(skip)]",
    "    Defect(rt::Die),",
    "}",
    "",
    "impl AppError {",
    "    /// Effect.orDie / Effect.die: failures become defects.",
    "    pub fn into_defect(self) -> AppError {",
    "        match self {",
    "            AppError::Defect(d) => AppError::Defect(d),",
    `            other => AppError::Defect(rt::Die(format!("{other:?}"))),`,
    "        }",
    "    }",
    "}",
    "",
    "impl From<rt::SqlFailure> for AppError {",
    "    fn from(e: rt::SqlFailure) -> Self {",
    "        match e {",
    "            rt::SqlFailure::Sql(m) => AppError::SqlError(m),",
    "            rt::SqlFailure::Schema(m) => AppError::SchemaError(m),",
    "        }",
    "    }",
    "}",
  ]
}

// ───────────── Queries ─────────────

const TEXT_LIKE = ["text", "character varying", "character", "name", "citext"]

function bindStmt(q: Query, i: number, classes: Map<string, ClassDef>): string {
  const b = q.binds[i]!
  let ty: STy = q.request!
  for (const key of b.path) {
    if (ty.k !== "ref") throw new CompileError(b.node, `\`${b.node.getText()}\` has no fields`)
    const f = classes.get(ty.name)!.fields.find((f) => f.name === key)
    if (!f) throw new CompileError(b.node, `no field \`${key}\` on ${ty.name}`)
    ty = f.ty
  }
  const expr = ["req", ...b.path.map(snake)].join(".")
  const pg = q.db!.params[i] ?? "unknown"
  const t = rty(ty)
  const cast = JSON.stringify(TEXT_LIKE.includes(pg) ? "" : pg)
  const bind = (inner: RTy, e: string): string => {
    switch (inner.k) {
      case "i64": return `q.int(${e});`
      case "f64": return `q.number(${e});`
      case "bool": return `q.bool(${e});`
      case "String": return `q.string(&${e}, ${cast});`
      default: throw new CompileError(b.node, `\`${b.node.getText()}\` (${showTy(inner)}) can't be a SQL parameter`)
    }
  }
  if (t.k === "option") return `match &${expr} { Some(v) => { ${bind(t.of, inner(t.of))} } None => q.null(${JSON.stringify(pg)}), }`
  return bind(t, expr)
  function inner(x: RTy) {
    return x.k === "String" ? "*v" : "*v"
  }
}

/** Which Postgres column types each schema can decode (as the JS driver returns them). */
function columnExpr(q: Query, f: { name: string; ty: STy }, cls: string, i: number): string {
  const col = q.db!.columns.find((c) => c.name === f.name)
  const got = q.db!.columns.map((c) => c.name).join(", ")
  if (!col) throw new CompileError(q.node, `${cls}.${f.name} isn't returned by ${q.service}.${q.name} (columns: ${got})`)
  const idx = q.db!.columns.indexOf(col)
  const nullable = f.ty.k === "nullOr"
  const base = f.ty.k === "nullOr" ? f.ty.of : f.ty
  const accepts: Record<string, string[]> = {
    int: ["integer", "smallint"],
    number: ["integer", "smallint", "real", "double precision"],
    string: [...TEXT_LIKE, "uuid"],
    boolean: ["boolean"],
  }
  const kind = base.k === "number" ? (base.int ? "int" : "number") : base.k === "string" ? "string" : base.k === "boolean" ? "boolean" : null
  if (!kind || !accepts[kind]!.includes(col.type)) {
    const hint =
      col.type === "bigint" ? " (the driver returns bigint as a JS BigInt, so this fails at runtime in the Effect version too: cast in SQL, e.g. `count(*)::int`)"
      : col.type === "numeric" ? " (numeric comes back as a string: use Schema.String, or cast to float8)"
      : ""
    throw new CompileError(q.node, `${cls}.${f.name} is ${describeSchema(f.ty)} but column \`${col.name}\` is ${col.type}${hint}`)
  }
  void i
  const read = `rt::col_${kind}${nullable ? "_opt" : ""}(&row, ${idx}, ${JSON.stringify(f.name)})?`
  const c = checksExpr(base, nullable ? "x" : "v")
  if (!c) return read
  return nullable
    ? `{ let v = ${read}; if let Some(x) = &v { let x = *x; if !(${c}) { return Err(rt::SqlFailure::schema(${JSON.stringify(f.name)}).into()); } } v }`
    : `{ let v = ${read}; if !(${c}) { return Err(rt::SqlFailure::schema(${JSON.stringify(f.name)}).into()); } v }`
}

function queryFn(q: Query, classes: Map<string, ClassDef>): string[] {
  const nParams = q.db!.params.length
  if (nParams !== q.binds.length) throw new CompileError(q.node, `parameter count mismatch (${q.binds.length} interpolations, Postgres sees ${nParams})`)
  const req = q.request ? rty(q.request) : null
  const reqParam = req ? `, req: ${req.k === "cls" || req.k === "String" ? "&" : ""}${rust(req)}` : ""
  const name = `${snake(q.service)}_${snake(q.name)}`
  const build = [
    `let mut q = rt::Sql::new(&${JSON.stringify(q.parts)});`,
    ...q.binds.map((_, i) => bindStmt(q, i, classes)),
  ]
  if (q.mode === "void") {
    return [`/// ${q.service}.${q.name}: SqlSchema.void`, `async fn ${name}(ctx: &Ctx${reqParam}) -> Result<(), AppError> {`, ...indent(build), "    q.execute(&ctx.db).await?;", "    Ok(())", "}"]
  }
  const cls = (q.result as { name: string }).name
  const row = [`${cls} {`, ...indent(classes.get(cls)!.fields.map((f, i) => `${snake(f.name)}: ${columnExpr(q, f, cls, i)},`)), "}"]
  const decodeRow = [`fn decode_row(row: &rt::PgRow) -> Result<${cls}, AppError> {`, `    Ok(${row[0]}`, ...indent(row.slice(1, -1)), "    })", "}"]
  const body: Record<Exclude<Query["mode"], "void">, string[]> = {
    findOne: ["let Some(row) = q.fetch_optional(&ctx.db).await? else { return Err(AppError::NoSuchElementError {}) };", "decode_row(&row)"],
    findOneOption: ["let Some(row) = q.fetch_optional(&ctx.db).await? else { return Ok(None) };", "decode_row(&row).map(Some)"],
    findAll: ["q.fetch_all(&ctx.db).await?.iter().map(decode_row).collect()"],
    findNonEmpty: ["let rows = q.fetch_all(&ctx.db).await?;", "if rows.is_empty() { return Err(AppError::NoSuchElementError {}); }", "rows.iter().map(decode_row).collect()"],
  }
  const ret = q.mode === "findOneOption" ? `Option<${cls}>` : q.mode === "findAll" || q.mode === "findNonEmpty" ? `Vec<${cls}>` : cls
  return [
    `/// ${q.service}.${q.name}: SqlSchema.${q.mode}`,
    `async fn ${name}(ctx: &Ctx${reqParam}) -> Result<${ret}, AppError> {`,
    ...indent(decodeRow),
    ...indent(build),
    ...indent(body[q.mode]),
    "}",
  ]
}

// ───────────── Functions, handlers, routes ─────────────

const fnDef = (fn: Fn, doc: string) => [
  `/// ${doc}`,
  `async fn ${fn.rustName}(ctx: &Ctx${fn.params.map((p) => `, ${p.name}: ${p.byRef ? "&" : ""}${rust(p.ty)}`).join("")}) -> Result<${rust(fn.ret)}, AppError> {`,
  ...indent(fn.body),
  "}",
]

function routeArm(h: Handler, idx: number, paramOrder: string[]): string[] {
  const ep = h.endpoint
  const pre: string[] = []
  if (h.uses.params) {
    pre.push(`let Ok(params) = ${ep.name[0]!.toUpperCase() + ep.name.slice(1)}Params::from_params(&params) else { return rt::empty(400) };`)
  } else if (ep.params) {
    pre.push(`if ${ep.name[0]!.toUpperCase() + ep.name.slice(1)}Params::from_params(&params).is_err() { return rt::empty(400) }`)
  }
  if (ep.payload) {
    const cls = (ep.payload.ty as { name: string }).name
    pre.push(
      "let raw = match rt::read_json_body(&headers, &body) { Ok(v) => v, Err(resp) => return resp };",
      `let Ok(payload) = ${cls}::decode(raw.as_ref()) else { return rt::empty(400) };`,
    )
    if (!h.uses.payload) pre.push("let _ = payload;")
  }
  const args = h.fn.params.map((p) => `, ${p.name}`).join("")
  const ok = ep.success.ty ? `rt::json(${ep.success.status}, &v)` : `rt::empty(${ep.success.status})`
  const statusArms = ep.errors.map((e) => `Err(e @ AppError::${e.name} { .. }) => rt::json(${e.status}, &e),`)
  void paramOrder
  return [
    `// ${ep.method.toUpperCase()} ${ep.path} (${ep.group}.${ep.name})`,
    `${idx} => {`,
    ...indent(pre),
    `    match ${h.fn.rustName}(&ctx${args}).await {`,
    `        Ok(v) => ${ok},`,
    ...indent(statusArms, 2),
    "        Err(AppError::Defect(d)) => d.into_response(),",
    `        Err(other) => rt::Die(format!("{other:?}")).into_response(),`,
    "    }",
    "}",
  ]
}

// ───────────── Crate ─────────────

export function backend(p: Program, opts: { source: string; crate: string; runtimePath: string }) {
  const errorClasses = [...p.classes.values()].filter((c) => c.error)
  const payloadClasses = new Set<string>()
  const markDecodable = (t: STy) => {
    if (t.k === "nullOr") return markDecodable(t.of)
    if (t.k !== "ref" || payloadClasses.has(t.name)) return
    payloadClasses.add(t.name)
    for (const f of p.classes.get(t.name)!.fields) markDecodable(f.ty)
  }
  for (const ep of p.endpoints) if (ep.payload) markDecodable(ep.payload.ty)
  const paramClasses = new Map(p.handlers.filter((h) => h.endpoint.params).map((h) => [`${h.endpoint.name[0]!.toUpperCase()}${h.endpoint.name.slice(1)}Params`, h.endpoint]))
  for (const h of p.handlers) {
    const n = `${h.endpoint.name[0]!.toUpperCase()}${h.endpoint.name.slice(1)}Params`
    if (h.endpoint.params && !p.classes.has(n)) p.classes.set(n, { name: n, error: false, tag: n, fields: h.endpoint.params })
  }
  const structs = [...p.classes.values()].filter((c) => !c.error)
  const routes = p.handlers.map((h) => h.endpoint)
  const r = p.server.router

  const main = [
    `// @generated by effect2rust from ${opts.source}. Do not edit; change the Effect program instead.`,
    "#![allow(unused, clippy::needless_return, clippy::let_and_return)]",
    "",
    "use effect_rt as rt;",
    "use rt::IntoResponse;",
    "use serde::Serialize;",
    "",
    "#[global_allocator]",
    "static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;",
    "",
    "struct Ctx {",
    "    db: rt::PgPool,",
    "}",
    "",
    "// ───────────── Schemas ─────────────",
    "",
    ...structs.flatMap((c) => [
      ...classDef(c, payloadClasses.has(c.name)),
      ...(paramClasses.has(c.name) ? ["", ...paramsDecoder(c, paramOrder(paramClasses.get(c.name)!.path))] : []),
      "",
    ]),
    ...appError(errorClasses),
    "",
    "// ───────────── Queries (described by Postgres at compile time) ─────────────",
    "",
    ...p.queries.flatMap((q) => [...queryFn(q, p.classes), ""]),
    "// ───────────── Services ─────────────",
    "",
    ...p.methods.flatMap((m) => [...fnDef(m, "service method"), ""]),
    "// ───────────── Handlers ─────────────",
    "",
    ...p.handlers.flatMap((h) => [...fnDef(h.fn, `handler for ${h.endpoint.group}.${h.endpoint.name}`), ""]),
    "async fn dispatch(ctx: &Ctx, route: usize, params: Vec<String>, headers: rt::HeaderMap, body: rt::Bytes) -> rt::Response {",
    "    match route {",
    ...indent(p.handlers.flatMap((h, i) => routeArm(h, i, paramOrder(h.endpoint.path))), 2),
    "        _ => rt::empty(404),",
    "    }",
    "}",
    "",
    "// ───────────── Server ─────────────",
    "",
    "#[tokio::main]",
    "async fn main() {",
    `    let url = std::env::var("${p.server.dbUrlEnv}").unwrap_or_else(|_| {`,
    `        eprintln!("(Missing data at ${p.server.dbUrlEnv}: \\"Expected ${p.server.dbUrlEnv} to exist in the process context\\")");`,
    "        std::process::exit(1)",
    "    });",
    `    let db = rt::pool(&url, ${p.server.maxConnections});`,
    "    let router = rt::Router::new(",
    `        rt::RouterConfig { case_sensitive: ${r.caseSensitive}, ignore_trailing_slash: ${r.ignoreTrailingSlash}, ignore_duplicate_slashes: ${r.ignoreDuplicateSlashes}, max_param_length: ${r.maxParamLength} },`,
    `        &[${routes.map((ep) => `(${JSON.stringify(ep.method.toUpperCase())}, ${JSON.stringify(ep.path)})`).join(", ")}],`,
    "    );",
    `    rt::serve(${p.server.hostname === null ? "None" : `Some(${JSON.stringify(p.server.hostname)})`}, ${p.server.port}, router, Ctx { db }, |ctx, route, params, headers, body| async move {`,
    "        dispatch(&ctx, route, params, headers, body).await",
    "    })",
    "    .await;",
    "}",
  ].join("\n")

  const cargo = `# @generated by effect2rust
[package]
name = "${opts.crate}"
version = "0.1.0"
edition = "2021"

[dependencies]
effect_rt = { path = "${opts.runtimePath}" }
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net"] }
serde = { version = "1", features = ["derive"] }
mimalloc = "0.1"

[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true

# Fast rebuilds: dependencies optimized once, generated code compiled quickly.
[profile.dev.package."*"]
opt-level = 2
`
  return { "Cargo.toml": cargo, "src/main.rs": main + "\n" }
}

/** Parameter names in path order. */
const paramOrder = (path: string) => [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!)
