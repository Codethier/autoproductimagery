import { useDB } from "~~/server/utils/useDB";

export default defineEventHandler(async (event) => {
  // Require auth (same as other endpoints)
  useAuth(event)

  const db = await useDB()

  // Optional pagination via query params
  const q = getQuery(event) as { take?: string; skip?: string }
  const take = q.take ? Number(q.take) : 50
  const skip = q.skip ? Number(q.skip) : 0

  const rows = await db.getSystemPrompts()

  return {
    ok: true,
    count: rows.length,
    items: rows,
  }
})
