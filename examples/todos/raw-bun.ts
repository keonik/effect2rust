// Same GET /todos/:id contract, no Effect: Bun.serve + Bun's native Postgres client (Bun.sql).
import { SQL } from "bun"
const sql = new SQL({ url: process.env.DATABASE_URL!, max: 10 })
Bun.serve({
  port: 3000,
  reusePort: true,
  routes: {
    "/todos/:id": async (req) => {
      const id = Number(req.params.id)
      if (!Number.isSafeInteger(id)) return new Response(null, { status: 400 })
      const [todo] = await sql`SELECT id, title, done FROM todos WHERE id = ${id}`
      return todo ? Response.json(todo) : Response.json({ _tag: "TodoNotFound", id }, { status: 404 })
    },
  },
  fetch: () => new Response(null, { status: 404 }),
})
