// `effect2rust check` should compile the example and pinpoint every unsupported construct
// in a multi-file program (once each, at its source, without cascades).
import { expect, test } from "bun:test"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const check = (entry: string) => {
  const env = { ...process.env }
  delete env.DATABASE_URL // frontend only; SQL checks are covered by the build in CI
  const r = Bun.spawnSync(["bun", "compiler/src/cli.ts", "check", entry], { cwd: root, env })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

test("the todos example compiles", () => {
  const { code, out } = check("examples/todos/api.ts")
  expect(out).toContain("2 endpoints")
  expect(out).toContain("everything compiles")
  expect(code).toBe(0)
}, 60_000)

test("multi-file program: every unsupported construct, at its source", () => {
  const { code, out } = check("compiler/test/fixtures/multifile/main.ts")
  expect(code).toBe(1)
  expect(out).toContain("domain.ts, compiler/test/fixtures/multifile/repo.ts, compiler/test/fixtures/multifile/main.ts")
  expect(out).toContain("skipped 1 helper declaration")
  expect(out).toContain("4 unsupported constructs")
  for (const [loc, msg] of [
    ["domain.ts:14:10", "unsupported schema `Schema.Trimmed`"],
    ["repo.ts:20:18", "unsupported schema `Schema.Array(Schema.Int)`"],
    ["repo.ts:29:46", "service members must be functions"],
    ["repo.ts:28:9", "unsupported Effect `Effect.all("],
  ]) expect(out).toContain(`multifile/${loc}: ${msg}`)
}, 60_000)
