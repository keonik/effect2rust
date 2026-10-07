#!/usr/bin/env bun
// effect2rust — compile an Effect HttpApi + SqlSchema program into a native Rust server.
//
//   effect2rust check <entry.ts> [--database-url <url>]
//       Report what compiles and every construct that doesn't yet, across the entry file
//       and the local files it imports. With a database URL, SQL is checked too.
//
//   effect2rust build <entry.ts> --out <dir> [--release] [--database-url <url>]
//       Type-check → lower → describe queries in Postgres → emit a Rust crate
//       (→ cargo build --release with --release).
//
// DATABASE_URL is read from the environment when --database-url isn't given.
import { mkdirSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import ts from "typescript"
import { backend } from "./backend"
import { CompileError, frontend } from "./frontend"
import { introspect } from "./introspect"

const USAGE = `usage:
  effect2rust check <entry.ts> [--database-url <url>]
  effect2rust build <entry.ts> --out <dir> [--release] [--database-url <url>]`

const argv = process.argv.slice(2)
const take = (name: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv.splice(i, 2)[1] : undefined
}
const has = (name: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? Boolean(argv.splice(i, 1)) : false
}
let command = argv[0]?.endsWith(".ts") ? "build" : argv.shift() // `effect2rust app.ts` = build
const release = has("--release") || has("--build")
const outArg = take("--out")
const databaseUrl = take("--database-url") ?? process.env.DATABASE_URL
const entryArg = argv[0]
if (!entryArg || (command !== "check" && command !== "build")) {
  console.error(USAGE)
  process.exit(2)
}
const entry = resolve(entryArg)
const rel = (f: string) => relative(process.cwd(), f) || f

const step = (label: string) => {
  const t = performance.now()
  return () => console.log(`  ✓ ${label} (${((performance.now() - t) / 1000).toFixed(2)}s)`)
}

const where = (e: CompileError) => {
  const node = e.node
  if (!node) return { loc: rel(entry), src: "" }
  const sf = node.getSourceFile()
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  return { loc: `${rel(sf.fileName)}:${line + 1}:${character + 1}`, src: (sf.text.split("\n")[line] ?? "").trim() }
}
const printError = (e: CompileError) => {
  const { loc, src } = where(e)
  console.error(`  ${loc}: ${e.message}${src ? `\n      > ${src}` : ""}`)
}

// ── 1. Type-check (TS types are the contract: a program that doesn't type-check never compiles)
let done = step("type-check")
const configPath = ts.findConfigFile(dirname(entry), ts.sys.fileExists)
const config = configPath
  ? ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, dirname(configPath))
  : { options: { strict: true, noEmit: true, module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler } as ts.CompilerOptions }
const program = ts.createProgram([entry], { ...config.options, noEmit: true })
const diags = ts.getPreEmitDiagnostics(program)
if (diags.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diags, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }))
  process.exit(1)
}
done()

// ── 2. Collect the entry file and the local files it imports (relative imports), dependencies first
function collectFiles(): ts.SourceFile[] {
  const out: ts.SourceFile[] = []
  const seen = new Set<string>()
  const visit = (sf: ts.SourceFile) => {
    if (seen.has(sf.fileName)) return
    seen.add(sf.fileName)
    for (const stmt of sf.statements) {
      const spec = (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null
      if (!spec?.startsWith(".")) continue
      if (ts.isImportDeclaration(stmt) && stmt.importClause?.isTypeOnly) continue
      const resolved = ts.resolveModuleName(spec, sf.fileName, program.getCompilerOptions(), ts.sys).resolvedModule
      const dep = resolved && !resolved.isExternalLibraryImport ? program.getSourceFile(resolved.resolvedFileName) : undefined
      if (dep && !dep.isDeclarationFile) visit(dep)
    }
    out.push(sf)
  }
  visit(program.getSourceFile(entry)!)
  return out
}
const files = collectFiles()

if (command === "check") {
  // ── check: report everything, don't stop at the first problem
  const { program: ir, errors, skipped } = frontend(files, { collect: true })
  const sqlErrors: CompileError[] = []
  if (databaseUrl) {
    for (const q of ir.queries) {
      try {
        introspect([q], databaseUrl)
        backend({ ...ir, queries: [q] }, { source: "check", crate: "check", runtimePath: "." }) // runs the column/parameter type checks
      } catch (e) {
        if (e instanceof CompileError) sqlErrors.push(e)
        else throw e
      }
    }
  }
  const all = [...errors, ...sqlErrors]
  const count = (n: number, w: string) => `${n} ${n === 1 ? w : w.endsWith("y") ? w.slice(0, -1) + "ies" : w + "s"}`
  const structs = [...ir.classes.values()].filter((c) => !c.error && !c.name.endsWith("Params")).length
  const errs = [...ir.classes.values()].filter((c) => c.error).length
  console.log(`\n  files: ${files.map((f) => rel(f.fileName)).join(", ")}`)
  console.log(`  found: ${count(structs, "schema")}, ${count(errs, "error type")}, ${count(ir.endpoints.length, "endpoint")}, ${count(ir.queries.length, "query")}, ${count(ir.handlers.length, "compiled handler")}`)
  if (!databaseUrl && ir.queries.length) console.log("  note: SQL not checked (pass --database-url or set DATABASE_URL)")
  if (skipped.length) console.log(`  skipped ${count(skipped.length, "helper declaration")} in imported files (fine unless the server uses them)`)
  if (all.length === 0) {
    console.log(`\n  ✓ everything compiles. Next: effect2rust build ${rel(entry)} --out <dir> --release\n`)
    process.exit(0)
  }
  console.error(`\n  ✗ ${count(all.length, "unsupported construct")} (later ones may be caused by earlier ones):\n`)
  all.forEach(printError)
  console.error("")
  process.exit(1)
}

// ── build
if (!databaseUrl || !outArg) {
  console.error(`build needs ${!outArg ? "--out <dir>" : "a database (--database-url or DATABASE_URL) to check queries against"}\n\n${USAGE}`)
  process.exit(2)
}
const out = resolve(outArg)
try {
  done = step(`lower Effect program (${files.length} file${files.length === 1 ? "" : "s"})`)
  const { program: ir } = frontend(files)
  done()

  done = step(`describe ${ir.queries.length} queries in Postgres`)
  introspect(ir.queries, databaseUrl)
  done()

  done = step("emit Rust")
  const crate = basename(entry).replace(/\.ts$/, "").replace(/\W/g, "_") + "_server"
  const emitted = backend(ir, { source: rel(entry), crate, runtimePath: relative(out, resolve(import.meta.dir, "../../runtime")) })
  for (const [path, content] of Object.entries(emitted)) {
    mkdirSync(dirname(join(out, path)), { recursive: true })
    writeFileSync(join(out, path), content)
  }
  Bun.spawnSync(["rustfmt", "--edition", "2021", join(out, "src/main.rs")])
  done()
  console.log(`\n  ${ir.endpoints.length} endpoints · ${ir.queries.length} queries · ${ir.methods.length} service methods → ${rel(out)}`)

  if (release) {
    done = step("cargo build --release")
    const r = Bun.spawnSync(["cargo", "build", "--release", "--quiet"], {
      cwd: out,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdout: "inherit",
      stderr: "inherit",
    })
    if (r.exitCode !== 0) process.exit(r.exitCode ?? 1)
    done()
    const bin = join(process.env.CARGO_TARGET_DIR ? resolve(out, process.env.CARGO_TARGET_DIR) : join(out, "target"), "release", crate)
    console.log(`\n  binary: ${rel(bin)} (${(statSync(bin).size / 1024 / 1024).toFixed(1)} MB)`)
  }
} catch (e) {
  if (!(e instanceof CompileError)) throw e
  console.error("")
  printError(e)
  console.error(`\n  run \`effect2rust check ${rel(entry)}\` to list every unsupported construct\n`)
  process.exit(1)
}
