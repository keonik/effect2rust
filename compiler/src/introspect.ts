// Ask Postgres to describe every query at compile time (no rows are touched):
// parameter types via PREPARE + pg_prepared_statements, result columns via \gdesc.
import { CompileError } from "./frontend"
import type { Query } from "./ir"

export function introspect(queries: Query[], databaseUrl: string) {
  for (const [i, q] of queries.entries()) {
    const name = `e2r_${i}`
    const script = [
      `PREPARE ${name} AS ${q.sql};`,
      `SELECT array_to_string(parameter_types::text[], '|') FROM pg_prepared_statements WHERE name = '${name}';`,
      ...(q.mode === "void" ? [] : [`${q.sql} \\gdesc`]),
    ].join("\n")
    const r = Bun.spawnSync(["psql", databaseUrl, "-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1"], {
      stdin: new TextEncoder().encode(script),
    })
    if (r.exitCode !== 0) {
      const msg = r.stderr.toString().replace(/^psql:<stdin>:\d+: /gm, "").trim()
      throw new CompileError(q.node, `Postgres rejected ${q.service}.${q.name}: ${msg}`)
    }
    const [paramLine = "", ...cols] = r.stdout.toString().trim().split("\n")
    q.db = {
      params: paramLine ? paramLine.split("|").map(normalize) : [],
      columns: cols.filter(Boolean).map((l) => {
        const [colName = "", type = ""] = l.split("\t")
        return { name: colName, type: normalize(type) }
      }),
    }
  }
}

const normalize = (t: string) => t.replace(/\(.*\)$/, "").trim()
