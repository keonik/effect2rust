// Backend: IR → a Rust crate (axum + sqlx + tokio + effect_rt).
import { CompileError, rty, showTy, snake } from "./frontend"
import type { ClassDef, Endpoint, Fn, Handler, Program, Query, RTy, STy } from "./ir"

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

// ───────────── Schema decoders: STy → expression producing the value (uses `?` on rt::Issue) ─────────────

function decodeExpr(ty: STy, v: string, p: string): string {
  switch (ty.k) {
    case "string":
      return ty.refine.reduce(
        (acc, r) => `rt::refine_${r.k === "minLength" ? "min" : "max"}_length(${acc}, ${r.n}, ${p})?`,
        `rt::string(${v}, ${p})?`,
      )
    case "int": return `rt::int(${v}, ${p})?`
    case "number": return `rt::number(${v}, ${p})?`
    case "boolean": return `rt::boolean(${v}, ${p})?`
    case "numberFromString":
      return ty.int ? `rt::refine_int(rt::number_from_string(${v}, ${p})?, ${p})?` : `rt::number_from_string(${v}, ${p})?`
    case "ref": return `${ty.name}::decode(${v}, ${p})?`
  }
}

function classDef(c: ClassDef): string[] {
  const fields = c.fields.map((f) => {
    const t = rty(f.ty)
    const ser = t.k === "f64" ? `#[serde(serialize_with = "rt::ser_number")] ` : ""
    const rename = snake(f.name) !== f.name ? `#[serde(rename = "${f.name}")] ` : ""
    return `${ser}${rename}pub ${snake(f.name)}: ${rust(t)},`
  })
  const decodes = c.fields.map((f) =>
    `${snake(f.name)}: { let p = p.key("${f.name}"); ${decodeExpr(f.ty, `m.get("${f.name}")`, "p")} },`,
  )
  return [
    "#[derive(Debug, Clone, Serialize)]",
    `pub struct ${c.name} {`,
    ...indent(fields),
    "}",
    "",
    `impl ${c.name} {`,
    "    pub fn decode(v: Option<&rt::Value>, p: rt::Path) -> Result<Self, rt::Issue> {",
    `        let m = rt::object(v, p, "${c.name} (Encoded side)")?;`,
    `        Ok(Self {`,
    ...indent(decodes, 3),
    "        })",
    "    }",
    "}",
  ]
}

// ───────────── Errors ─────────────

function appError(errors: ClassDef[]): string[] {
  const variants = errors.flatMap((e) => [
    ...(e.tag !== e.name ? [`#[serde(rename = "${e.tag}")]`] : []),
    `${e.name} { ${e.fields.map((f) => `${snake(f.name) !== f.name ? `#[serde(rename = "${f.name}")] ` : ""}${snake(f.name)}: ${rust(rty(f.ty))}`).join(", ")} },`,
  ])
  return [
    "/// Every tagged error in the program (the `E` channel), plus defects.",
    "#[derive(Debug, Serialize)]",
    `#[serde(tag = "_tag")]`,
    "pub enum AppError {",
    ...indent(variants),
    "    #[serde(skip)]",
    "    Defect(rt::Die),",
    "}",
    "",
    "impl AppError {",
    "    /// Effect.orDie: typed failures become defects.",
    "    pub fn into_defect(self) -> AppError {",
    "        match self {",
    "            AppError::Defect(d) => AppError::Defect(d),",
    `            other => AppError::Defect(rt::Die(format!("{other:?}"))),`,
    "        }",
    "    }",
    "}",
    "",
    "impl From<rt::Die> for AppError {",
    "    fn from(d: rt::Die) -> Self { AppError::Defect(d) }",
    "}",
    "",
    "impl From<sqlx::Error> for AppError {",
    "    fn from(e: sqlx::Error) -> Self { AppError::Defect(rt::Die(e.to_string())) }",
    "}",
  ]
}

// ───────────── Queries ─────────────

const PG_TEXT = ["text", "character varying", "character", "name"]

function bindExpr(q: Query, i: number, classes: Map<string, ClassDef>): string {
  const b = q.binds[i]!
  let ty: STy = q.request
  for (const key of b.path) {
    if (ty.k !== "ref") throw new CompileError(b.node, `\`${b.node.getText()}\` has no fields`)
    const f = classes.get(ty.name)!.fields.find((f) => f.name === key)
    if (!f) throw new CompileError(b.node, `no field \`${key}\` on ${ty.name}`)
    ty = f.ty
  }
  const t = rty(ty)
  const expr = ["req", ...b.path.map(snake)].join(".")
  const pg = q.db!.params[i]!
  const bad = () => new CompileError(b.node, `\`${b.node.getText()}\` is ${showTy(t)}, but Postgres expects ${pg} for $${i + 1}`)
  switch (pg) {
    case "integer": if (t.k === "i64") return `rt::int4(${expr})?`; throw bad()
    case "smallint": if (t.k === "i64") return `rt::int2(${expr})?`; throw bad()
    case "bigint": if (t.k === "i64") return expr; throw bad()
    case "double precision": if (t.k === "f64") return expr; if (t.k === "i64") return `(${expr} as f64)`; throw bad()
    case "real": if (t.k === "f64") return `(${expr} as f32)`; throw bad()
    case "boolean": if (t.k === "bool") return expr; throw bad()
    default:
      if (PG_TEXT.includes(pg) && t.k === "String") return `${expr}.as_str()`
      throw bad()
  }
}

/** Check that each column can be decoded by the field's schema the way the JS driver would see it. */
function columnExpr(q: Query, f: { name: string; ty: STy }, cls: string): string {
  const col = q.db!.columns.find((c) => c.name === f.name)
  const got = q.db!.columns.map((c) => c.name).join(", ")
  if (!col) throw new CompileError(q.node, `${cls}.${f.name} isn't returned by ${q.service}.${q.name} (columns: ${got})`)
  const t = rty(f.ty)
  const ok =
    (f.ty.k === "int" && ["integer", "smallint"].includes(col.type)) ||
    (f.ty.k === "number" && ["integer", "smallint", "real", "double precision"].includes(col.type)) ||
    (f.ty.k === "string" && PG_TEXT.includes(col.type)) ||
    (f.ty.k === "boolean" && col.type === "boolean")
  if (!ok) {
    const hint = ["bigint", "numeric"].includes(col.type)
      ? ` (the JS driver returns ${col.type} as a string, so this would fail at runtime in the Effect version too; cast in SQL or use a string schema)`
      : ""
    throw new CompileError(q.node, `${cls}.${f.name} is ${showSchema(f.ty)} but column \`${col.name}\` is ${col.type}${hint}`)
  }
  let e = `<_ as rt::Col<${rust(t)}>>::col(r.${col.name}, "${f.name}")?`
  if (f.ty.k === "string") {
    for (const r of f.ty.refine) e = `rt::refine_${r.k === "minLength" ? "min" : "max"}_length(${e}, ${r.n}, rt::Path::ROOT).map_err(rt::Die::from)?`
  }
  return e
}

const showSchema = (s: STy) => (s.k === "ref" ? s.name : `Schema.${{ string: "String", int: "Int", number: "Number", boolean: "Boolean", numberFromString: "NumberFromString" }[s.k]}`)

function queryFn(q: Query, classes: Map<string, ClassDef>): string[] {
  if (q.db!.params.length !== q.binds.length) throw new CompileError(q.node, "parameter count mismatch")
  const req = rty(q.request)
  const reqTy = req.k === "cls" || req.k === "String" ? `&${rust(req)}` : rust(req)
  const binds = q.binds.map((_, i) => bindExpr(q, i, classes))
  const call = `sqlx::query!(${JSON.stringify(q.sql)}${binds.map((b) => `, ${b}`).join("")})`
  const name = `${snake(q.service)}_${snake(q.name)}`
  if (q.mode === "void") {
    return [`async fn ${name}(ctx: &Ctx, req: ${reqTy}) -> Result<(), AppError> {`, `    ${call}.execute(&ctx.db).await?;`, "    Ok(())", "}"]
  }
  const cls = (q.result as { name: string }).name
  const build = [`${cls} {`, ...indent(classes.get(cls)!.fields.map((f) => `${snake(f.name)}: ${columnExpr(q, f, cls)},`)), "}"]
  const out: Record<Exclude<Query["mode"], "void">, string[]> = {
    findOne: [`let Some(r) = ${call}.fetch_optional(&ctx.db).await? else { return Ok(None) };`, "Ok(Some(", ...indent(build), "))"],
    single: [`let r = ${call}.fetch_one(&ctx.db).await?;`, "Ok(", ...indent(build), ")"],
    findAll: [`let rows = ${call}.fetch_all(&ctx.db).await?;`, "rows.into_iter()", "    .map(|r| Ok(", ...indent(build, 2), "    ))", "    .collect()"],
  }
  const ret = q.mode === "findOne" ? `Option<${cls}>` : q.mode === "findAll" ? `Vec<${cls}>` : cls
  return [`/// ${q.service}.${q.name} — SqlSchema.${q.mode}`, `async fn ${name}(ctx: &Ctx, req: ${reqTy}) -> Result<${ret}, AppError> {`, ...indent(out[q.mode]), "}"]
}

// ───────────── Functions & handlers ─────────────

const fnDef = (fn: Fn, doc: string) => [
  `/// ${doc}`,
  `async fn ${fn.rustName}(ctx: &Ctx${fn.params.map((p) => `, ${p.name}: ${p.byRef ? "&" : ""}${rust(p.ty)}`).join("")}) -> Result<${rust(fn.ret)}, AppError> {`,
  ...indent(fn.body),
  "}",
]

function route(h: Handler): string[] {
  const ep = h.endpoint
  const extractors = ["State(ctx): State<Ctx>"]
  if (h.uses.path) extractors.push("Path(params): Path<Vec<(String, String)>>")
  if (h.uses.payload) extractors.push("headers: HeaderMap", "body: Bytes")
  const pre: string[] = []
  if (h.uses.path) {
    pre.push(
      "let params: rt::Map<String, rt::Value> = params.into_iter().map(|(k, v)| (k, rt::Value::String(v))).collect();",
      `let path = match ${upper(ep.name)}Path::decode(Some(&rt::Value::Object(params)), rt::Path::ROOT) {`,
      "    Ok(v) => v,",
      "    Err(issue) => return rt::DecodeError(issue).into_response(),",
      "};",
    )
  }
  if (h.uses.payload) {
    pre.push(
      "let raw = match rt::read_payload(&headers, &body) { Ok(v) => v, Err(resp) => return resp };",
      `let payload = match ${decodeExpr(ep.payload!, "Some(&raw)", "rt::Path::ROOT").replace(/\?$/, "")} {`,
      "    Ok(v) => v,",
      "    Err(issue) => return rt::DecodeError(issue).into_response(),",
      "};",
    )
  }
  const args = h.fn.params.map((p) => `, ${p.name}`).join("")
  const ok = ep.success.ty ? `(StatusCode::from_u16(${ep.success.status}).unwrap(), Json(v)).into_response()` : `StatusCode::from_u16(${ep.success.status}).unwrap().into_response()`
  const statusArms = ep.errors.map((e) => `AppError::${e.name} { .. } => StatusCode::from_u16(${e.status}).unwrap(),`)
  return [
    `/// ${ep.method.toUpperCase()} ${ep.path} (${ep.group}.${ep.name})`,
    `async fn route_${snake(ep.name)}(${extractors.join(", ")}) -> Response {`,
    ...indent(pre),
    `    match ${h.fn.rustName}(&ctx${args}).await {`,
    `        Ok(v) => ${ok},`,
    "        Err(AppError::Defect(d)) => d.into_response(),",
    "        Err(e) => {",
    "            let status = match &e {",
    ...indent(statusArms, 4),
    "                _ => StatusCode::INTERNAL_SERVER_ERROR,",
    "            };",
    "            (status, Json(e)).into_response()",
    "        }",
    "    }",
    "}",
  ]
}

const upper = (s: string) => s[0]!.toUpperCase() + s.slice(1)

// ───────────── Crate ─────────────

export function backend(p: Program, opts: { source: string; crate: string; runtimePath: string }) {
  const errors = [...p.classes.values()].filter((c) => c.error)
  const structs = [...p.classes.values()].filter((c) => !c.error)
  const byPath = new Map<string, Endpoint[]>()
  for (const ep of p.endpoints) byPath.set(ep.path, [...(byPath.get(ep.path) ?? []), ep])
  const routes = [...byPath].map(([path, eps]) =>
    `.route("${path.replace(/:(\w+)/g, "{$1}")}", ${eps.map((ep, i) => `${i ? "" : "routing::"}${ep.method}(route_${snake(ep.name)})`).join(".")})`,
  )

  const main = [
    `// @generated by effect2rust from ${opts.source}. Do not edit; change the Effect program instead.`,
    "#![allow(unused, clippy::needless_return)]",
    "",
    "use axum::{",
    "    body::Bytes,",
    "    extract::{Path, State},",
    "    http::{HeaderMap, StatusCode},",
    "    response::{IntoResponse, Response},",
    "    routing, Json, Router,",
    "};",
    "use effect_rt as rt;",
    "use serde::Serialize;",
    "use sqlx::postgres::{PgPool, PgPoolOptions};",
    "",
    "#[global_allocator]",
    "static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;",
    "",
    "#[derive(Clone)]",
    "struct Ctx {",
    "    db: PgPool,",
    "}",
    "",
    "// ───────────── Schemas ─────────────",
    "",
    ...structs.flatMap((c) => [...classDef(c), ""]),
    ...appError(errors),
    "",
    "// ───────────── Queries (checked against Postgres at compile time) ─────────────",
    "",
    ...p.queries.flatMap((q) => [...queryFn(q, p.classes), ""]),
    "// ───────────── Services ─────────────",
    "",
    ...p.methods.flatMap((m) => [...fnDef(m, "service method"), ""]),
    "// ───────────── Handlers ─────────────",
    "",
    ...p.handlers.flatMap((h) => [...fnDef(h.fn, `handler for ${h.endpoint.group}.${h.endpoint.name}`), "", ...route(h), ""]),
    "// ───────────── Server ─────────────",
    "",
    "#[tokio::main]",
    "async fn main() {",
    `    let url = std::env::var("${p.server.dbUrlEnv}").unwrap_or_else(|_| {`,
    `        eprintln!("(Missing data at ${p.server.dbUrlEnv}: \\"Expected ${p.server.dbUrlEnv} to exist in the process context\\")");`,
    "        std::process::exit(1)",
    "    });",
    "    let db = PgPoolOptions::new()",
    `        .max_connections(${p.server.maxConnections})`,
    "        .connect(&url)",
    "        .await",
    `        .unwrap_or_else(|e| { eprintln!("database connection failed: {e}"); std::process::exit(1) });`,
    "",
    "    let app = Router::new()",
    ...indent(routes, 2),
    "        .fallback(|| async { StatusCode::NOT_FOUND })",
    "        .method_not_allowed_fallback(|| async { StatusCode::NOT_FOUND })",
    "        .with_state(Ctx { db });",
    "",
    `    let listener = tokio::net::TcpListener::bind(("0.0.0.0", ${p.server.port})).await.expect("bind");`,
    "    axum::serve(listener, app).await.expect(\"server\");",
    "}",
  ].join("\n")

  const cargo = `# @generated by effect2rust
[package]
name = "${opts.crate}"
version = "0.1.0"
edition = "2021"

[dependencies]
effect_rt = { path = "${opts.runtimePath}" }
axum = { version = "0.8", default-features = false, features = ["http1", "tokio", "json"] }
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net"] }
serde = { version = "1", features = ["derive"] }
sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio", "postgres", "macros"] }
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
