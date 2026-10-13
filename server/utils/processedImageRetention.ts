import type {Pool, PoolClient} from 'pg'
import {isRetentionManagedImageUrl, parseRetentionDays} from './generatedImageRetention'

export const PROCESSED_IMAGE_RETENTION_LOCK = [716_205, 2] as const
const DAY_MS = 86_400_000
const MAX_ROWS = 10_000
const MAX_DURATION_MS = 5 * 60_000
const PAGE_SIZE = 100
const MAX_CONSECUTIVE_FAILURES = 10
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const SCOPED_OUTPUT = new RegExp(`^/images/organizations/(${UUID})/users/(${UUID})/output/`)
type Candidate = {jobId: string; kind: 'background' | 'pipeline'; assetId: string; outputUrl: string; organizationId: string; userId: string; completedAt: string}
export type ProcessedImageRetentionResult = {
    status: 'completed' | 'disabled' | 'already_running' | 'bounded' | 'schema_missing'
    retentionDays: number
    cutoff: string | null
    dryRun: boolean
    scanned: number
    wouldDelete: number
    deleted: number
    skippedInvalid: number
    failed: number
}
type Options = {
    pool: Pick<Pool, 'connect'>
    storage: {removeGeneratedImage(url: string): Promise<void>}
    retentionDays: number
    dryRun?: boolean
    now?: Date
    maxRows?: number
    maxDurationMs?: number
}
function bounded(value: number, maximum: number) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid processed image cleanup limit.')
    return value
}
export function isManagedProcessedOutput(url: string, organizationId: string, userId: string) {
    const scoped = SCOPED_OUTPUT.exec(url)
    return Boolean(scoped && scoped[1] === organizationId && scoped[2] === userId && isRetentionManagedImageUrl(url))
}

/** Daily maintenance only. Never called from app requests or an idle queue loop. */
export async function runProcessedImageRetention(options: Options): Promise<ProcessedImageRetentionResult> {
    const retentionDays = parseRetentionDays(String(options.retentionDays))
    const maxRows = bounded(options.maxRows ?? MAX_ROWS, MAX_ROWS)
    const maxDurationMs = bounded(options.maxDurationMs ?? MAX_DURATION_MS, MAX_DURATION_MS)
    const now = options.now ?? new Date()
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid processed image cleanup clock.')
    const result: ProcessedImageRetentionResult = {status: retentionDays === 0 ? 'disabled' : 'completed', retentionDays,
        cutoff: retentionDays === 0 ? null : new Date(now.getTime() - retentionDays * DAY_MS).toISOString(),
        dryRun: options.dryRun ?? false, scanned: 0, wouldDelete: 0, deleted: 0, skippedInvalid: 0, failed: 0}
    if (retentionDays === 0) return result
    let client: PoolClient
    try {client = await options.pool.connect()} catch {throw new Error('Processed image cleanup could not connect to PostgreSQL.')}
    let locked = false, discard = false, failures = 0
    const connectionError = () => {discard = true}
    client.on('error', connectionError)
    const started = performance.now()
    let lastCompletedAt = '-infinity', lastId = '00000000-0000-0000-0000-000000000000', lastKind = ''
    try {
        const acquired = await client.query<{locked: boolean}>('SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked', [...PROCESSED_IMAGE_RETENTION_LOCK])
        locked = acquired.rows[0]?.locked === true
        if (!locked) {result.status = 'already_running'; return result}
        // Git deploys can start this cron worker before the app's additive
        // migration finishes. That race must safely skip the new job table.
        const schema = await client.query<{available: boolean; pipelinesAvailable: boolean}>(`SELECT
            to_regclass('background_removal_job') IS NOT NULL AND to_regclass('asset') IS NOT NULL AS available,
            to_regclass('pipeline_step_output') IS NOT NULL AND to_regclass('pipeline_run_step') IS NOT NULL AS "pipelinesAvailable"`)
        if (schema.rows[0]?.available !== true) {result.status = 'schema_missing'; return result}
        const hasPipelines = schema.rows[0]?.pipelinesAvailable === true
        // Pipeline local references are also managed outputs, even when a
        // later paid step fails. Only a registered association can authorize
        // deletion; unrelated processed/uploaded assets are never scanned.
        const outputs = `SELECT id, 'background'::text AS kind, output_asset_id, output_url, organization_id, user_id,
            completed_at, status FROM background_removal_job
            ${hasPipelines ? `UNION ALL SELECT output.id, 'pipeline'::text AS kind, output.output_asset_id, output.output_url,
                output.organization_id, output.user_id, output.created_at AS completed_at, 'succeeded'::text AS status
                FROM pipeline_step_output output JOIN pipeline_run_step step ON step.id = output.step_id
                    AND step.organization_id = output.organization_id AND step.user_id = output.user_id
                WHERE output.deleted_at IS NULL` : ''}`
        while (result.scanned < maxRows && performance.now() - started < maxDurationMs) {
            const candidates = await client.query<Candidate>(`
                WITH processing_outputs AS NOT MATERIALIZED (${outputs})
                SELECT job.id::text AS "jobId", job.kind, image.id::text AS "assetId", job.output_url AS "outputUrl",
                    job.organization_id::text AS "organizationId", job.user_id::text AS "userId", job.completed_at::text AS "completedAt"
                FROM processing_outputs job JOIN asset image ON image.id = job.output_asset_id AND image.url = job.output_url
                    AND image.organization_id = job.organization_id AND image.owner_user_id = job.user_id
                    AND image.kind = 'file' AND image.category = 'processed' AND image.deleted_at IS NULL
                WHERE job.status = 'succeeded' AND job.completed_at < $1::timestamptz AND image.created_at < $1::timestamptz
                    AND (job.completed_at, job.id, job.kind) > ($2::timestamptz, $3::uuid, $5::text)
                    AND NOT EXISTS (SELECT 1 FROM processing_outputs retained
                        WHERE (retained.id <> job.id OR retained.kind <> job.kind) AND (retained.output_asset_id = image.id OR retained.output_url = image.url)
                        AND (retained.status <> 'succeeded' OR retained.completed_at >= $1::timestamptz))
                ORDER BY job.completed_at, job.id, job.kind LIMIT $4::integer
            `, [result.cutoff, lastCompletedAt, lastId, Math.min(PAGE_SIZE, maxRows - result.scanned), lastKind])
            if (!candidates.rows.length) return result
            for (const candidate of candidates.rows) {
                if (performance.now() - started >= maxDurationMs) {result.status = 'bounded'; return result}
                lastCompletedAt = candidate.completedAt; lastId = candidate.jobId; lastKind = candidate.kind; result.scanned += 1
                if (!isManagedProcessedOutput(candidate.outputUrl, candidate.organizationId, candidate.userId)) {result.skippedInvalid += 1; continue}
                try {
                    const current = await client.query<{eligible: boolean}>(`
                        WITH processing_outputs AS NOT MATERIALIZED (${outputs})
                        SELECT EXISTS (SELECT 1 FROM processing_outputs job JOIN asset image
                            ON image.id = job.output_asset_id AND image.url = job.output_url
                            WHERE job.id = $1::uuid AND job.kind = $7::text AND image.id = $2::uuid AND job.output_url = $3
                                AND job.organization_id = $4::uuid AND job.user_id = $5::uuid
                                AND image.organization_id = job.organization_id AND image.owner_user_id = job.user_id
                                AND image.kind = 'file' AND image.category = 'processed' AND image.deleted_at IS NULL
                                AND job.status = 'succeeded' AND job.completed_at < $6::timestamptz AND image.created_at < $6::timestamptz
                                AND NOT EXISTS (SELECT 1 FROM processing_outputs retained
                                    WHERE (retained.id <> job.id OR retained.kind <> job.kind) AND (retained.output_asset_id = image.id OR retained.output_url = image.url)
                                        AND (retained.status <> 'succeeded' OR retained.completed_at >= $6::timestamptz))) AS eligible
                    `, [candidate.jobId, candidate.assetId, candidate.outputUrl, candidate.organizationId, candidate.userId, result.cutoff, candidate.kind])
                    if (!current.rows[0]?.eligible) continue
                    if (result.dryRun) {result.wouldDelete += 1; continue}
                    // S3 first, then tombstone. No DB transaction spans network
                    // I/O. A crash after deletion leaves the row eligible and an
                    // idempotent missing-object delete completes it next run.
                    await options.storage.removeGeneratedImage(candidate.outputUrl)
                    const markAsset = `
                        UPDATE asset image SET deleted_at = COALESCE(image.deleted_at, $1::timestamptz), updated_at = $1::timestamptz
                        WHERE image.id = $2::uuid AND image.url = $3 AND image.organization_id = $4::uuid AND image.owner_user_id = $5::uuid
                            AND image.kind = 'file' AND image.category = 'processed' AND image.created_at < $6::timestamptz
                            AND EXISTS (SELECT 1 FROM processing_outputs job WHERE job.id = $7::uuid AND job.kind = $8::text
                                AND job.output_asset_id = image.id AND job.output_url = image.url
                                AND job.organization_id = image.organization_id AND job.user_id = image.owner_user_id
                                AND job.status = 'succeeded' AND job.completed_at < $6::timestamptz)
                        RETURNING image.id`
                    const mark = hasPipelines && candidate.kind === 'pipeline'
                        ? `WITH processing_outputs AS NOT MATERIALIZED (${outputs}), expired AS (${markAsset}), expired_links AS (
                            UPDATE pipeline_step_output output SET deleted_at = $1::timestamptz
                            WHERE output.id = $7::uuid AND output.output_asset_id IN (SELECT id FROM expired)
                                AND output.organization_id = $4::uuid AND output.user_id = $5::uuid AND output.output_url = $3
                            RETURNING output.id
                        ) SELECT count(*)::integer AS changed FROM expired`
                        : `WITH processing_outputs AS NOT MATERIALIZED (${outputs}), expired AS (${markAsset}) SELECT count(*)::integer AS changed FROM expired`
                    const marked = await client.query<{changed: number}>(mark,
                        [now.toISOString(), candidate.assetId, candidate.outputUrl, candidate.organizationId, candidate.userId, result.cutoff, candidate.jobId, candidate.kind])
                    if (marked.rows[0]?.changed !== 1) throw new Error('Processed image cleanup registration changed.')
                    result.deleted += 1; failures = 0
                } catch {
                    result.failed += 1; failures += 1
                    if (discard || failures >= MAX_CONSECUTIVE_FAILURES) {result.status = 'bounded'; return result}
                }
            }
        }
        result.status = 'bounded'; return result
    } catch {throw new Error('Processed image cleanup database operation failed.')}
    finally {
        if (locked && !discard) {
            try {
                const unlocked = await client.query<{unlocked: boolean}>('SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked', [...PROCESSED_IMAGE_RETENTION_LOCK])
                if (!unlocked.rows[0]?.unlocked) discard = true
            } catch {discard = true}
        }
        client.removeListener('error', connectionError)
        client.release(discard)
    }
}
