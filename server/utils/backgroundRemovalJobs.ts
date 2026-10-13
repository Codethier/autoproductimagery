import {randomUUID} from 'node:crypto'
import {and, asc, count, desc, eq, gt, inArray, isNull, lte, sql} from 'drizzle-orm'
import {createError} from 'h3'
import {assets, backgroundRemovalJobs, users} from '../db/schema'
import {getDatabase} from './lib/db'
import {canonicalAssetUrl, createAssetRepository, validAssetId, type AssetActor} from './assetAccess'
import type {BackgroundRemovalError, BackgroundRemovalJob, BackgroundRemovalModel} from '../../schemas/background-removal'

type Database = ReturnType<typeof getDatabase>
export type BackgroundRemovalTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export type BackgroundRemovalRecord = typeof backgroundRemovalJobs.$inferSelect
export const MAX_BACKGROUND_REMOVAL_QUEUED = 20
export const MAX_BACKGROUND_REMOVAL_USER_OUTSTANDING = 5
export const MAX_BACKGROUND_REMOVAL_ATTEMPTS = 2
export const BACKGROUND_REMOVAL_LEASE_MS = 90_000

const safeMessages: Record<BackgroundRemovalError['code'], string> = {
    PROCESSING_INTERRUPTED: 'Background removal was interrupted and could not finish.',
    SOURCE_UNAVAILABLE: 'The source image is no longer available to this account.',
    PROCESSING_TIMEOUT: 'Background removal exceeded its processing time limit.',
    PROCESSING_FAILED: 'Background removal could not process this image.',
    MODEL_UNAVAILABLE: 'The background removal model is temporarily unavailable.',
    INSUFFICIENT_MEMORY: 'This server does not have enough available RAM for the selected background removal model. Try Lite or increase the server memory.',
}
// Persist only known messages. Native/driver errors may contain paths, object
// keys, model bytes or credentials and must never be returned in job history.
export function safeBackgroundRemovalError(error: {code?: unknown; retryable?: unknown}): BackgroundRemovalError {
    const code = typeof error.code === 'string' && Object.hasOwn(safeMessages, error.code)
        ? error.code as BackgroundRemovalError['code'] : 'PROCESSING_FAILED'
    return {code, message: safeMessages[code], retryable: error.retryable === true}
}
export function publicBackgroundRemovalJob(row: BackgroundRemovalRecord, outputAvailable = true): BackgroundRemovalJob {
    const date = (value: string | null) => value === null ? null : new Date(value).toISOString()
    return {id: row.id, sourceUrl: row.sourceUrl, model: row.model, modelVersion: row.modelVersion,
        status: row.status, attempts: row.attempts,
        outputAssetId: outputAvailable ? row.outputAssetId : null, outputUrl: outputAvailable ? row.outputUrl : null,
        ...(!outputAvailable && row.status === 'succeeded' ? {outputExpired: true} : {}),
        providerPriceUsd: '0', priceSource: 'local-processing', error: row.errorJson ? safeBackgroundRemovalError(row.errorJson) : null,
        createdAt: date(row.createdAt)!, updatedAt: date(row.updatedAt)!, startedAt: date(row.startedAt), completedAt: date(row.completedAt)}
}
function ownerCondition(actor: Pick<AssetActor, 'organizationId' | 'userId'>) {
    return and(eq(backgroundRemovalJobs.organizationId, actor.organizationId), eq(backgroundRemovalJobs.userId, actor.userId))
}
function liveClaim(id: string, owner: string) {
    return and(eq(backgroundRemovalJobs.id, validAssetId(id)), eq(backgroundRemovalJobs.status, 'running'),
        eq(backgroundRemovalJobs.leaseOwner, validAssetId(owner)), gt(backgroundRemovalJobs.leaseExpiresAt, sql`CURRENT_TIMESTAMP`))
}
function queueOverloaded(message: string): never {throw createError({statusCode: 429, statusMessage: message})}

export function createBackgroundRemovalRepository(db: Database = getDatabase(), options: {leaseMs?: number} = {}) {
    const leaseMs = Math.max(5_000, Math.min(10 * 60_000, options.leaseMs ?? BACKGROUND_REMOVAL_LEASE_MS))
    const leaseExpiry = () => sql`CURRENT_TIMESTAMP + (${leaseMs} * interval '1 millisecond')`
    const lockQueue = (tx: BackgroundRemovalTransaction) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('autoproductimagery:background-removal-queue:v1', 0))`)
    async function projectJobs(rows: BackgroundRemovalRecord[], executor: Pick<Database, 'select'> = db): Promise<BackgroundRemovalJob[]> {
        const outputs = rows.filter(row => row.status === 'succeeded' && row.outputAssetId && row.outputUrl)
        if (!outputs.length) return rows.map(row => publicBackgroundRemovalJob(row))
        // Every input page is already scoped to one authenticated owner. Fetch
        // all live output identities together; do not leak old private URLs or
        // turn history pagination into N+1 asset queries.
        const first = outputs[0]!
        const registered = await executor.select({id: assets.id, url: assets.url}).from(assets)
            .where(and(inArray(assets.id, [...new Set(outputs.map(row => row.outputAssetId!))]),
                eq(assets.organizationId, first.organizationId), eq(assets.ownerUserId, first.userId),
                eq(assets.kind, 'file'), eq(assets.category, 'processed'), isNull(assets.deletedAt)))
        const identities = new Map(registered.map(row => [row.id, row.url]))
        return rows.map(row => publicBackgroundRemovalJob(row, row.status !== 'succeeded' ||
            (row.organizationId === first.organizationId && row.userId === first.userId &&
                Boolean(row.outputAssetId && row.outputUrl && identities.get(row.outputAssetId) === row.outputUrl))))
    }
    async function activeActor(tx: BackgroundRemovalTransaction, actor: Pick<AssetActor, 'organizationId' | 'userId'> & {authVersion?: number}) {
        const [user] = await tx.select({id: users.id, authVersion: users.authVersion}).from(users)
            .where(and(eq(users.id, actor.userId), eq(users.organizationId, actor.organizationId), isNull(users.disabledAt))).limit(1)
        if (!user || (actor.authVersion !== undefined && actor.authVersion !== user.authVersion)) throw createError({statusCode: 401, statusMessage: 'Unauthorized'})
    }
    async function enqueue(actor: AssetActor & {authVersion?: number}, input: {
        sourceAssetId: string; sourceUrl: string; model: BackgroundRemovalModel; modelVersion: string; idempotencyKey: string
    }): Promise<BackgroundRemovalJob> {
        validAssetId(input.idempotencyKey)
        if (!['birefnet-lite', 'birefnet'].includes(input.model) || !input.modelVersion || input.modelVersion.length > 200) {
            throw createError({statusCode: 400, statusMessage: 'Invalid background removal model'})
        }
        const url = canonicalAssetUrl(input.sourceUrl)
        // This rechecks inherited sharing and final-price visibility before any
        // durable work is admitted. The runner repeats it before reading bytes.
        const {row: source} = await createAssetRepository(actor, db).requireAsset(url)
        if (source.kind !== 'file' || source.id !== input.sourceAssetId) throw createError({statusCode: 404, statusMessage: 'Image not found'})
        return db.transaction(async tx => {
            await lockQueue(tx)
            await activeActor(tx, actor)
            const [sourceStillPresent] = await tx.select({id: assets.id}).from(assets).where(and(eq(assets.id, source.id),
                eq(assets.organizationId, actor.organizationId), eq(assets.url, url), isNull(assets.deletedAt))).limit(1)
            if (!sourceStillPresent) throw createError({statusCode: 404, statusMessage: 'Image not found'})
            const [existing] = await tx.select().from(backgroundRemovalJobs)
                .where(and(ownerCondition(actor), eq(backgroundRemovalJobs.idempotencyKey, input.idempotencyKey))).limit(1)
            if (existing) {
                if (existing.sourceAssetId !== source.id || existing.sourceUrl !== url || existing.model !== input.model || existing.modelVersion !== input.modelVersion) {
                    throw createError({statusCode: 409, statusMessage: 'This background removal request key was already used'})
                }
                return (await projectJobs([existing], tx))[0]!
            }
            const [personal] = await tx.select({value: count()}).from(backgroundRemovalJobs)
                .where(and(ownerCondition(actor), inArray(backgroundRemovalJobs.status, ['queued', 'running'])))
            if (Number(personal?.value ?? 0) >= MAX_BACKGROUND_REMOVAL_USER_OUTSTANDING) queueOverloaded('Too many background removals are pending for this account')
            const [queued] = await tx.select({value: count()}).from(backgroundRemovalJobs).where(eq(backgroundRemovalJobs.status, 'queued'))
            if (Number(queued?.value ?? 0) >= MAX_BACKGROUND_REMOVAL_QUEUED) queueOverloaded('Background removal is busy; try again later')
            const [created] = await tx.insert(backgroundRemovalJobs).values({id: randomUUID(), organizationId: actor.organizationId,
                userId: actor.userId, sourceAssetId: source.id, sourceUrl: url, model: input.model, modelVersion: input.modelVersion,
                idempotencyKey: input.idempotencyKey}).returning()
            if (!created) throw new Error('Background removal job was not created')
            return publicBackgroundRemovalJob(created)
        })
    }
    async function recoverExpired(tx: BackgroundRemovalTransaction) {
        // Only expired leases are recoverable. A process restart or different
        // worker's clock never invalidates another instance's live work.
        const expired = and(eq(backgroundRemovalJobs.status, 'running'), lte(backgroundRemovalJobs.leaseExpiresAt, sql`CURRENT_TIMESTAMP`))
        const reset = {leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, updatedAt: sql`CURRENT_TIMESTAMP`}
        await tx.update(backgroundRemovalJobs).set({...reset, status: 'failed', completedAt: sql`CURRENT_TIMESTAMP`,
            errorJson: safeBackgroundRemovalError({code: 'PROCESSING_INTERRUPTED', retryable: false})})
            .where(and(expired, sql`${backgroundRemovalJobs.attempts} >= ${MAX_BACKGROUND_REMOVAL_ATTEMPTS}`))
        await tx.update(backgroundRemovalJobs).set({...reset, status: 'queued',
            errorJson: safeBackgroundRemovalError({code: 'PROCESSING_INTERRUPTED', retryable: true})})
            .where(and(expired, sql`${backgroundRemovalJobs.attempts} < ${MAX_BACKGROUND_REMOVAL_ATTEMPTS}`))
    }
    async function claim(owner: string): Promise<BackgroundRemovalRecord | null> {
        validAssetId(owner)
        return db.transaction(async tx => {
            await lockQueue(tx)
            await recoverExpired(tx)
            const [active] = await tx.select({id: backgroundRemovalJobs.id}).from(backgroundRemovalJobs)
                .where(and(eq(backgroundRemovalJobs.status, 'running'), gt(backgroundRemovalJobs.leaseExpiresAt, sql`CURRENT_TIMESTAMP`))).limit(1)
            if (active) return null // One CPU inference across all app instances.
            const [pending] = await tx.select().from(backgroundRemovalJobs).where(and(eq(backgroundRemovalJobs.status, 'queued'),
                sql`${backgroundRemovalJobs.attempts} < ${MAX_BACKGROUND_REMOVAL_ATTEMPTS}`))
                .orderBy(asc(backgroundRemovalJobs.createdAt), asc(backgroundRemovalJobs.id)).limit(1).for('update', {skipLocked: true})
            if (!pending) return null
            const [row] = await tx.update(backgroundRemovalJobs).set({status: 'running', leaseOwner: owner,
                leaseExpiresAt: leaseExpiry(), heartbeatAt: sql`CURRENT_TIMESTAMP`, startedAt: sql`CURRENT_TIMESTAMP`,
                attempts: sql`${backgroundRemovalJobs.attempts} + 1`, updatedAt: sql`CURRENT_TIMESTAMP`, errorJson: null})
                .where(and(eq(backgroundRemovalJobs.id, pending.id), eq(backgroundRemovalJobs.status, 'queued'))).returning()
            return row ?? null
        })
    }
    async function heartbeat(id: string, owner: string): Promise<boolean> {
        const rows = await db.update(backgroundRemovalJobs).set({leaseExpiresAt: leaseExpiry(), heartbeatAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP`})
            .where(liveClaim(id, owner)).returning({id: backgroundRemovalJobs.id})
        return rows.length === 1
    }
    /** S3 write must finish first; register the exact object and success in one transaction. */
    async function complete(id: string, owner: string, register: (tx: BackgroundRemovalTransaction, job: BackgroundRemovalRecord) => Promise<{outputAssetId: string; outputUrl: string}>): Promise<boolean> {
        return db.transaction(async tx => {
            const [job] = await tx.select().from(backgroundRemovalJobs).where(liveClaim(id, owner)).limit(1).for('update')
            if (!job) return false
            await activeActor(tx, {userId: job.userId, organizationId: job.organizationId})
            const output = await register(tx, job)
            const [asset] = await tx.select({id: assets.id}).from(assets).where(and(eq(assets.id, validAssetId(output.outputAssetId)),
                eq(assets.url, canonicalAssetUrl(output.outputUrl)), eq(assets.organizationId, job.organizationId), eq(assets.ownerUserId, job.userId),
                eq(assets.category, 'processed'), eq(assets.kind, 'file'), isNull(assets.deletedAt))).limit(1)
            if (!asset) throw new Error('Processed image registration was invalid')
            const rows = await tx.update(backgroundRemovalJobs).set({status: 'succeeded', outputAssetId: output.outputAssetId,
                outputUrl: output.outputUrl, errorJson: null, leaseOwner: null, leaseExpiresAt: null,
                completedAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP`})
                .where(and(eq(backgroundRemovalJobs.id, id), eq(backgroundRemovalJobs.status, 'running'), eq(backgroundRemovalJobs.leaseOwner, owner))).returning({id: backgroundRemovalJobs.id})
            return rows.length === 1
        })
    }
    async function fail(id: string, owner: string, error: {code?: unknown; retryable?: unknown}): Promise<boolean> {
        return db.transaction(async tx => {
            const [job] = await tx.select().from(backgroundRemovalJobs).where(liveClaim(id, owner)).limit(1).for('update')
            if (!job) return false
            const safeError = safeBackgroundRemovalError(error)
            const retry = safeError.retryable && job.attempts < MAX_BACKGROUND_REMOVAL_ATTEMPTS
            const rows = await tx.update(backgroundRemovalJobs).set({status: retry ? 'queued' : 'failed',
                errorJson: {...safeError, retryable: retry}, leaseOwner: null, leaseExpiresAt: null,
                completedAt: retry ? null : sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP`})
                .where(and(eq(backgroundRemovalJobs.id, id), eq(backgroundRemovalJobs.status, 'running'), eq(backgroundRemovalJobs.leaseOwner, owner))).returning({id: backgroundRemovalJobs.id})
            return rows.length === 1
        })
    }
    async function get(actor: AssetActor, id: string): Promise<BackgroundRemovalJob> {
        const [row] = await db.select().from(backgroundRemovalJobs).where(and(eq(backgroundRemovalJobs.id, validAssetId(id)), ownerCondition(actor))).limit(1)
        if (!row) throw createError({statusCode: 404, statusMessage: 'Background removal not found'})
        return (await projectJobs([row]))[0]!
    }
    async function list(actor: AssetActor, pagination: {limit?: number; offset?: number} = {}): Promise<BackgroundRemovalJob[]> {
        const limit = Math.max(1, Math.min(50, Math.floor(pagination.limit ?? 20)))
        const offset = Math.max(0, Math.min(10_000, Math.floor(pagination.offset ?? 0)))
        const rows = await db.select().from(backgroundRemovalJobs).where(ownerCondition(actor))
            .orderBy(desc(backgroundRemovalJobs.createdAt), desc(backgroundRemovalJobs.id)).limit(limit).offset(offset)
        return projectJobs(rows)
    }
    return {enqueue, claim, heartbeat, complete, fail, get, list}
}

export function backgroundRemovalRequestError(error: unknown): never {
    const statusCode = (error as {statusCode?: unknown})?.statusCode
    if (typeof statusCode === 'number' && [400, 401, 403, 404, 409, 413, 415, 425, 429, 503].includes(statusCode)) throw error
    throw createError({statusCode: 503, statusMessage: 'Background removal is temporarily unavailable'})
}
