import { useDB } from "~~/server/utils/useDB";

export default defineEventHandler(async (event) => {
  // Require auth (same as other endpoints)
  useAuth(event)

  const db = await useDB()
  const fs = await useFS()

  // Optional pagination via query params
  const q = getQuery(event) as { take?: string; skip?: string }
  const take = q.take ? Number(q.take) : 50
  const skip = q.skip ? Number(q.skip) : 0

  const rows = await db.getSystemPrompts()
  const visibleRows = []

  for (const row of rows) {
    if (await isStaleFileNotFoundRow(row, fs)) continue
    visibleRows.push(row)
  }

  return {
    ok: true,
    count: visibleRows.length,
    items: visibleRows,
  }
})

async function isStaleFileNotFoundRow(row: any, fs: Awaited<ReturnType<typeof useFS>>) {
  if (row?.errors !== 'File not found') return false
  if (row?.outputImage) return false

  const inputImages = Array.isArray(row?.serverImages) ? row.serverImages : []
  const modelImages = Array.isArray(row?.modelImages) ? row.modelImages : []
  const referencedImages = [...inputImages, ...modelImages].filter((item) => typeof item === 'string' && item.length > 0)
  if (referencedImages.length === 0) return false

  try {
    const exists = await Promise.all(referencedImages.map((image) => fs.fileExists(image)))
    return exists.every(Boolean)
  } catch {
    return false
  }
}
