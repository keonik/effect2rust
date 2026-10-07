#!/usr/bin/env bun
// Differential contract testing: replay a list of HTTP requests against a server,
// record status + parsed body, then compare recordings from different servers.
//
//   bun contract/contract.ts record <baseUrl> <out.json> --cases <cases.json>
//   bun contract/contract.ts compare <reference.json> <candidate.json>
//
// cases.json: [{ "method": "GET", "path": "/todos/1" },
//              { "method": "POST", "path": "/todos", "body": "{\"title\":\"x\"}", "contentType": "application/json" }]
//
// The top-level `message` of HttpApiDecodeError (Effect's pretty-printed tree) is ignored;
// the structured `issues` carry the contract and are compared exactly.

export {}

interface Case {
  method: string
  path: string
  body?: string
  contentType?: string
  headers?: Record<string, string>
}

const [mode, ...rest] = process.argv.slice(2)
const flag = (name: string) => {
  const i = rest.indexOf(name)
  return i >= 0 ? rest.splice(i, 2)[1] : undefined
}

if (mode === "record") {
  const casesFile = flag("--cases")
  const [base, out] = rest
  if (!casesFile || !base || !out) throw new Error("usage: record <baseUrl> <out.json> --cases <cases.json>")
  const cases: Case[] = await Bun.file(casesFile).json()
  const results = []
  for (const c of cases) {
    const headers = { ...(c.contentType ? { "content-type": c.contentType } : {}), ...c.headers }
    const res = await fetch(base + c.path, { method: c.method, body: c.body ?? null, headers })
    const text = await res.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : ""
    } catch {}
    if (body && typeof body === "object" && (body as { _tag?: string })._tag === "HttpApiDecodeError") delete (body as { message?: string }).message
    results.push({ req: `${c.method} ${c.path} ${c.body ?? ""}`.trim(), status: res.status, body })
  }
  await Bun.write(out, JSON.stringify(results, null, 2))
} else if (mode === "compare") {
  const [a, b] = await Promise.all(rest.map((f) => Bun.file(f).json()))
  let failures = 0
  a.forEach((x: { req: string; status: number; body: unknown }, i: number) => {
    const y = b[i]
    if (x.status !== y.status || !Bun.deepEquals(x.body, y.body)) {
      failures++
      console.log(`✗ ${x.req}\n    reference: ${x.status} ${JSON.stringify(x.body)}\n    candidate: ${y.status} ${JSON.stringify(y.body)}`)
    }
  })
  console.log(`${a.length - failures}/${a.length} identical`)
  process.exit(failures ? 1 : 0)
} else {
  console.error("usage: contract.ts record <baseUrl> <out.json> --cases <cases.json> | compare <a.json> <b.json>")
  process.exit(2)
}
