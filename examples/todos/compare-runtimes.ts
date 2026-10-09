#!/usr/bin/env bun
// Runtime comparison for the todos example: the same Effect 4 program on Node, Deno and Bun
// (interpreted and compiled), the effect2rust binary, and hand-written Rust and C++ servers
// (the performance ceiling, without Effect's exact HTTP contract).
//
//   DATABASE_URL=postgres://... bun examples/todos/compare-runtimes.ts [--no-build] [--duration 15s] [--only a,b]
//
// For each target: build it (timed), check the 81-case contract against the reference
// (Effect on Bun), then load-test it with contract/bench.sh. Targets whose toolchain is
// missing are skipped. Deno compile honors DENORT_BIN for offline builds.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const here = import.meta.dir
const root = resolve(here, "../..")
const out = join(here, ".targets")
const args = process.argv.slice(2)
const flag = (n: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}
const build = !args.includes("--no-build")
const skipBench = args.includes("--skip-bench")
const duration = flag("--duration") ?? "15s"
const only = flag("--only")?.split(",")
if (!process.env.DATABASE_URL) throw new Error("set DATABASE_URL")
mkdirSync(out, { recursive: true })

const has = (cmd: string) => Bun.spawnSync(["bash", "-c", `command -v ${cmd}`]).exitCode === 0
const sh = (cmd: string, cwd = here) => {
  const r = Bun.spawnSync(["bash", "-c", cmd], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`${cmd}\n${r.stderr.toString().slice(-2000)}${r.stdout.toString().slice(-1000)}`)
  return r.stdout.toString()
}
const size = (p: string) => {
  const b = existsSync(p) ? statSync(p).size : 0
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`
}

interface Target {
  name: string
  kind: string
  cmd: string
  needs: string[]
  build?: () => string | null // returns the artifact path (for size)
  note?: string
}

const targets: Target[] = [
  { name: "node", kind: "Effect 4, interpreted", cmd: "node api-node.ts", needs: ["node"] },
  { name: "deno", kind: "Effect 4, interpreted", cmd: "deno run -A api-node.ts", needs: ["deno"] },
  { name: "bun", kind: "Effect 4, interpreted", cmd: "bun api.ts", needs: ["bun"] },
  {
    name: "node SEA",
    kind: "Effect 4, compiled",
    cmd: `${out}/node-sea`,
    needs: ["node", "npx"],
    build: () => {
      sh(`npx --yes esbuild@0.25 api-node.ts --bundle --platform=node --target=node22 --format=cjs --minify --define:import.meta.env=undefined --outfile=${out}/sea.cjs --log-level=error`)
      writeFileSync(`${out}/sea-config.json`, JSON.stringify({ main: `${out}/sea.cjs`, output: `${out}/sea-prep.blob`, disableExperimentalSEAWarning: true }))
      sh(`node --experimental-sea-config ${out}/sea-config.json && cp "$(command -v node)" ${out}/node-sea && npx --yes postject ${out}/node-sea NODE_SEA_BLOB ${out}/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`)
      return `${out}/node-sea`
    },
  },
  {
    name: "deno compile",
    kind: "Effect 4, compiled",
    cmd: `${out}/deno-bin`,
    needs: ["deno"],
    build: () => (sh(`deno compile -A --quiet --output ${out}/deno-bin api-node.ts`), `${out}/deno-bin`),
  },
  {
    name: "bun compile",
    kind: "Effect 4, compiled",
    cmd: `${out}/bun-bin`,
    needs: ["bun"],
    build: () => (sh(`bun build --compile --minify --bytecode --format=esm --no-compile-autoload-dotenv --no-compile-autoload-bunfig api.ts --outfile ${out}/bun-bin`), `${out}/bun-bin`),
  },
  {
    name: "rust (effect2rust)",
    kind: "compiled from the Effect program",
    cmd: "rust/target/release/api_server",
    needs: ["cargo", "psql"],
    build: () => (sh(`bun ${root}/compiler/src/cli.ts build api.ts --out rust --release`), join(here, "rust/target/release/api_server")),
  },
  {
    name: "rust (hand-written)",
    kind: "axum + tokio-postgres, written by hand",
    cmd: "rust-handwritten/target/release/todos_rust_handwritten",
    needs: ["cargo"],
    build: () => (sh("cargo build --release --quiet", join(here, "rust-handwritten")), join(here, "rust-handwritten/target/release/todos_rust_handwritten")),
  },
  {
    name: "c++ (hand-written)",
    kind: "Drogon, written by hand",
    cmd: "cpp/build/todos_cpp",
    needs: ["cmake", "g++"],
    build: () => (sh("cmake -S cpp -B cpp/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-O3 > /dev/null && cmake --build cpp/build -j"), join(here, "cpp/build/todos_cpp")),
    note: "needs Drogon (apt: libdrogon-dev libpq-dev libjsoncpp-dev uuid-dev)",
  },
]

const rows: Record<string, string>[] = []
const active: Target[] = []
for (const t of targets) {
  if (only && !only.includes(t.name)) continue
  const missing = t.needs.filter((n) => !has(n))
  if (missing.length) {
    console.log(`- skipping ${t.name}: missing ${missing.join(", ")}`)
    continue
  }
  const row: Record<string, string> = { target: t.name, kind: t.kind, build: "-", size: "-" }
  if (t.build && build) {
    process.stdout.write(`- building ${t.name}... `)
    const s = performance.now()
    try {
      const artifact = t.build()
      row.build = `${((performance.now() - s) / 1000).toFixed(1)} s`
      row.size = artifact ? size(artifact) : "-"
      console.log(row.build)
    } catch (e) {
      console.log(`failed, skipping${t.note ? ` (${t.note})` : ""}\n  ${String(e).split("\n").slice(0, 4).join("\n  ")}`)
      continue
    }
  } else if (t.build) {
    const artifact = t.cmd.startsWith("/") ? t.cmd : join(here, t.cmd)
    if (!existsSync(artifact)) {
      console.log(`- skipping ${t.name}: not built (run without --no-build)`)
      continue
    }
    row.size = size(artifact)
  }
  rows.push(row)
  active.push(t)
}

// Contract: every target against the reference (Effect on Bun).
console.log("\n- contract (81 cases vs Effect on Bun)")
const reference = targets.find((t) => t.name === "bun")!
const specs = [reference, ...active.filter((t) => t !== reference)].map((t, i) => `'${i === 0 ? "reference" : t.name.replace(/[^\w-]/g, "_")}=${t.cmd}'`)
const diff = Bun.spawnSync(["bash", "-c", `${root}/contract/diff.sh --cases contract-cases.json --reset 'TRUNCATE todos RESTART IDENTITY' --cwd ${here} ${specs.join(" ")}`], {
  cwd: here,
  env: process.env,
}).stdout.toString()
// Classify mismatches: a "cascade" differs from the reference only in `id` values (an earlier
// difference changed how many rows were inserted); everything else is a root difference.
const outDir = `${process.env.TMPDIR ?? "/tmp"}/effect2rust-contract`
const stripIds = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stripIds) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "id").map(([k, x]) => [k, stripIds(x)])) : v
const label = (req: string) => (req.length > 60 ? `${req.slice(0, 57)}...` : req)
const mismatches: string[] = []
const refRec: { req: string; status: number; body: unknown }[] = existsSync(`${outDir}/reference.json`) ? await Bun.file(`${outDir}/reference.json`).json() : []
active.forEach((t, i) => {
  if (t === reference) return void (rows[i]!.contract = "reference")
  const file = `${outDir}/${t.name.replace(/[^\w-]/g, "_")}.json`
  if (!existsSync(file) || !refRec.length) return void (rows[i]!.contract = "didn't run")
  const rec: typeof refRec = require(file)
  const roots: string[] = []
  let same = 0, cascade = 0
  const created = new Set(refRec.filter((r) => r.status === 201).map((r) => JSON.stringify(stripIds(r.body))))
  refRec.forEach((r, j) => {
    const c = rec[j]!
    if (r.status === c.status && Bun.deepEquals(r.body, c.body)) same++
    else if (r.status === c.status && Bun.deepEquals(stripIds(r.body), stripIds(c.body)) && /^(GET \/todos\/\d+|POST)/.test(r.req)) cascade++
    else if (r.status === 200 && c.status === 200 && /^GET \/todos\/\d+$/.test(r.req) && created.has(JSON.stringify(stripIds(c.body)))) cascade++ // a different row after an id shift
    else roots.push(`${label(r.req)} → ${c.status === r.status ? `${c.status}, body differs` : c.status} (reference ${r.status}${c.status === r.status ? ` ${JSON.stringify(r.body).slice(0, 40)}` : ""})`)
  })
  rows[i]!.contract = `${same}/${refRec.length}${roots.length ? ` (${roots.length} root diff${roots.length === 1 ? "" : "s"})` : cascade ? "" : ""}`
  if (roots.length) mismatches.push(`${t.name}: ${roots.length} root difference(s), ${cascade} id-shift cascade(s)\n    ${roots.slice(0, 8).join("\n    ")}${roots.length > 8 ? `\n    (+${roots.length - 8} more)` : ""}`)
})
void diff

// Benchmark each target with identical load.
console.log(`- benchmark (${duration} per endpoint, 50 connections)`)
const seed = "TRUNCATE todos RESTART IDENTITY; INSERT INTO todos (title) SELECT 'todo ' || g FROM generate_series(1, 1000) g"
if (!skipBench) active.forEach((t, i) => {
  const line = Bun.spawnSync(
    ["bash", "-c", `${root}/contract/bench.sh --duration ${duration} --get /todos/500 --post /todos --body '{"title":"bench"}' --seed "${seed}" --cwd ${here} '${t.name}=${t.cmd}'`],
    { cwd: here, env: process.env },
  ).stdout.toString()
  const m = line.match(/GET\s+([\d,]+) req\/s\s+p99\s+([\d.]+)ms \| POST\s+([\d,]+) req\/s\s+p99\s+([\d.]+)ms \| mem\s+(\d+)→\s*(\d+) MB \| start\s+(\d+) ms/)
  Object.assign(rows[i]!, m ? { get: m[1], getP99: m[2], post: m[3], postP99: m[4], mem: `${m[5]}→${m[6]} MB`, start: `${m[7]} ms` } : { get: "failed" })
  console.log(`  ${t.name}: ${m ? `${m[1]} GET/s, ${m[3]} POST/s` : "failed"}`)
})

const table = [
  "| Target | Kind | Contract | GET req/s · p99 | POST req/s · p99 | Memory | Startup | Build | Size |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.target} | ${r.kind} | ${r.contract} | ${r.get} · ${r.getP99} ms | ${r.post} · ${r.postP99} ms | ${r.mem} | ${r.start} | ${r.build} | ${r.size} |`),
].join("\n")
console.log(`\n${table}\n`)
if (mismatches.length) console.log(`Contract differences vs the reference:\n${mismatches.map((m) => `- ${m}`).join("\n")}\n`)
writeFileSync(join(out, "results.md"), `${table}\n`)
