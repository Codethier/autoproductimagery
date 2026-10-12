import type {Pool, PoolClient} from "pg"

export const DEFAULT_GENERATED_IMAGE_RETENTION_DAYS = 180
export const GENERATED_IMAGE_RETENTION_LOCK = [716_205, 1] as const
const DAY_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 100
const MAX_RUN_ROWS = 10_000
const MAX_RUN_DURATION_MS = 5 * 60 * 1000
const MAX_CONSECUTIVE_FAILURES = 10
const MANAGED_IMAGE_PATTERN = "^/images/output/img-[0-9]+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.(png|jpg|gif|webp|bmp|tiff|heic)$"
const MANAGED_IMAGE_URL = new RegExp(MANAGED_IMAGE_PATTERN)

// A typo must never shorten retention accidentally. Zero is the explicit opt out.
export function parseRetentionDays(value: string | undefined): number {
    if (value === undefined) return DEFAULT_GENERATED_IMAGE_RETENTION_DAYS
    if (!/^(0|[1-9]\d*)$/.test(value)) {
        throw new Error("GENERATED_IMAGE_RETENTION_DAYS must be a whole number of days, or 0 to disable cleanup.")
    }
    const days = Number(value)
    if (!Number.isSafeInteger(days) || days > 36_500) {
        throw new Error("GENERATED_IMAGE_RETENTION_DAYS must be between 0 and 36500.")
    }
    return days
}

// Generated keys are immutable UUID objects. Never use a bucket listing or a
// directory deletion: only exact, recognized output objects recorded in SQL.
export function isRetentionManagedImageUrl(value: string): boolean {
    return MANAGED_IMAGE_URL.test(value)
}

export type GeneratedImageRetentionResult = {
    status: "completed" | "disabled" | "already_running" | "bounded"
    retentionDays: number
    cutoff: string | null
    dryRun: boolean
    scanned: number
    wouldDelete: number
    deleted: number
    skippedInvalid: number
    skippedShared: number
    failed: number
}

type RetentionCandidate = {id: number; outputImage: string; createdAt: string}
type RetentionStorage = {removeGeneratedImage(url: string): Promise<void>}
type RetentionOptions = {
    pool: Pick<Pool, "connect">
    storage: RetentionStorage
    retentionDays: number
    dryRun?: boolean
    now?: Date
    maxRows?: number
    maxDurationMs?: number
}

function boundedSetting(value: number, maximum: number, name: string) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid generated image cleanup ${name}.`)
    return value
}

export async function runGeneratedImageRetention(options: RetentionOptions): Promise<GeneratedImageRetentionResult> {
    const retentionDays = parseRetentionDays(String(options.retentionDays))
    const maxRows = boundedSetting(options.maxRows ?? MAX_RUN_ROWS, MAX_RUN_ROWS, "row limit")
    const maxDurationMs = boundedSetting(options.maxDurationMs ?? MAX_RUN_DURATION_MS, MAX_RUN_DURATION_MS, "time limit")
    const now = options.now ?? new Date()
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid generated image cleanup clock.")
    const result: GeneratedImageRetentionResult = {
        status: retentionDays === 0 ? "disabled" : "completed",
        retentionDays,
        cutoff: retentionDays === 0 ? null : new Date(now.getTime() - retentionDays * DAY_MS).toISOString(),
        dryRun: options.dryRun ?? false,
        scanned: 0, wouldDelete: 0, deleted: 0, skippedInvalid: 0, skippedShared: 0, failed: 0,
    }
    if (retentionDays === 0) return result

    let client: PoolClient
    try { client = await options.pool.connect() }
    catch { throw new Error("Generated image cleanup could not connect to PostgreSQL.") }
    let locked = false
    let discardConnection = false
    const connectionError = () => { discardConnection = true }
    client.on("error", connectionError)
    const startedAt = performance.now()
    let lastCreatedAt = "-infinity"
    let lastId = 0
    let consecutiveFailures = 0
    try {
        const lock = await client.query<{locked: boolean}>(
            "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked", [...GENERATED_IMAGE_RETENTION_LOCK],
        )
        locked = lock.rows[0]?.locked === true
        if (!locked) { result.status = "already_running"; return result }

        while (result.scanned < maxRows && performance.now() - startedAt < maxDurationMs) {
            const candidates = await client.query<RetentionCandidate>(`
                SELECT candidate.id, candidate."outputImage", candidate."createdAt"::text AS "createdAt"
                FROM "systemPrompt" candidate
                WHERE candidate."outputImageDeletedAt" IS NULL AND candidate."outputImage" <> ''
                    AND (candidate.status = 'succeeded' OR candidate.status IS NULL)
                    AND candidate."createdAt" < $1::timestamptz
                    AND (candidate."createdAt", candidate.id) > ($2::timestamptz, $3::integer)
                    AND candidate."outputImage" ~ $5
                    AND NOT EXISTS (
                        SELECT 1 FROM "systemPrompt" retained
                        WHERE retained."outputImage" = candidate."outputImage" AND retained.id <> candidate.id
                            AND retained."outputImageDeletedAt" IS NULL
                            AND (retained."createdAt" >= $1::timestamptz OR (retained.status IS NOT NULL AND retained.status <> 'succeeded'))
                    )
                ORDER BY candidate."createdAt", candidate.id
                LIMIT $4::integer
            `, [result.cutoff, lastCreatedAt, lastId, Math.min(PAGE_SIZE, maxRows - result.scanned), MANAGED_IMAGE_PATTERN])
            if (!candidates.rows.length) return result

            for (const row of candidates.rows) {
                if (performance.now() - startedAt >= maxDurationMs) { result.status = "bounded"; return result }
                // Keep the original PostgreSQL timestamp text, including its
                // microseconds, so keyset pagination does not repeat a row.
                lastCreatedAt = row.createdAt
                lastId = row.id
                result.scanned += 1
                if (!isRetentionManagedImageUrl(row.outputImage)) { result.skippedInvalid += 1; continue }
                try {
                    // A historical import can contain duplicate output URLs.
                    // Preserve the object while another undeleted generation
                    // with that URL is newer or not a completed generation.
                    const shared = await client.query<{retained: boolean}>(`
                        SELECT EXISTS (
                            SELECT 1 FROM "systemPrompt"
                            WHERE "outputImage" = $1 AND id <> $2::integer AND "outputImageDeletedAt" IS NULL
                                AND ("createdAt" >= $3::timestamptz OR (status IS NOT NULL AND status <> 'succeeded'))
                        ) AS retained
                    `, [row.outputImage, row.id, result.cutoff])
                    if (shared.rows[0]?.retained) { result.skippedShared += 1; continue }
                    if (result.dryRun) { result.wouldDelete += 1; continue }
                    // No database transaction spans the S3 call. Missing objects
                    // delete successfully, making a crash after DELETE safe to retry.
                    await options.storage.removeGeneratedImage(row.outputImage)
                    const marked = await client.query(`
                        UPDATE "systemPrompt" SET "outputImageDeletedAt" = $1::timestamptz
                        WHERE id = $2::integer AND "outputImage" = $3 AND "outputImageDeletedAt" IS NULL
                            AND (status = 'succeeded' OR status IS NULL) AND "createdAt" < $4::timestamptz
                    `, [now.toISOString(), row.id, row.outputImage, result.cutoff])
                    if (marked.rowCount !== 1) throw new Error("Cleanup row changed before it could be marked.")
                    result.deleted += 1
                    consecutiveFailures = 0
                } catch {
                    result.failed += 1
                    consecutiveFailures += 1
                    if (discardConnection || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        result.status = "bounded"
                        return result
                    }
                }
            }
        }
        result.status = "bounded"
        return result
    } catch {
        throw new Error("Generated image cleanup database operation failed.")
    } finally {
        // A session lock requires the same checked-out client for the whole run.
        // Destroy a client whose unlock fails instead of returning a held lock
        // to the warm pool. Process termination also releases session locks.
        if (locked && !discardConnection) {
            try {
                const unlocked = await client.query<{unlocked: boolean}>(
                    "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked", [...GENERATED_IMAGE_RETENTION_LOCK],
                )
                if (!unlocked.rows[0]?.unlocked) discardConnection = true
            } catch { discardConnection = true }
        }
        client.removeListener("error", connectionError)
        client.release(discardConnection)
    }
}
