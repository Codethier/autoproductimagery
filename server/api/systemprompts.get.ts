import { useDB } from "~~/server/utils/useDB";
import { getGenerationRuntimeSettings } from "~~/server/utils/generationLimiter";
import { randomUUID } from "node:crypto";

export default defineEventHandler(async (event) => {
  // Require auth (same as other endpoints)
  useAuth(event)

  const db = await useDB()
  const runtime = getGenerationRuntimeSettings(
    useRuntimeConfig() as unknown as Record<string, unknown>,
  )
  try {
    await db.reconcileStalePendingGenerations(runtime.staleTtlMs)
  } catch (error) {
    const diagnosticId = randomUUID()
    console.error(`[systemprompts:${diagnosticId}] Stale generation reconciliation failed`, error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Generation history is temporarily unavailable.',
      data: { diagnosticId },
    })
  }
  // Optional pagination via query params
  const q = getQuery(event) as { take?: string; skip?: string }
  const take = q.take ? Number(q.take) : 50
  const skip = q.skip ? Number(q.skip) : 0

  const safeTake = Number.isFinite(take) ? Math.max(1, Math.min(200, Math.floor(take))) : 50
  const safeSkip = Number.isFinite(skip) ? Math.max(0, Math.floor(skip)) : 0
  let rows: Awaited<ReturnType<typeof db.getSystemPrompts>>
  let count: number
  try {
    [rows, count] = await Promise.all([
      db.getSystemPrompts(safeTake, safeSkip),
      db.countSystemPrompts(),
    ])
  } catch (error) {
    const diagnosticId = randomUUID()
    console.error(`[systemprompts:${diagnosticId}] Generation history query failed`, error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Generation history is temporarily unavailable.',
      data: { diagnosticId },
    })
  }
  const normalizedRows = rows.map(row => ({
    ...row,
    outputImage: row.outputImage || null,
    status: row.status ?? (row.errors ? 'failed' : 'succeeded'),
  }))

  return {
    ok: true,
    count,
    items: normalizedRows,
  }
})
