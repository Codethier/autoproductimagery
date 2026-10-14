import {randomUUID} from 'node:crypto'
import {and, eq, isNull} from 'drizzle-orm'
import {createError} from 'h3'
import {users} from '../db/schema'
import {getDatabase} from './lib/db'
import {createBackgroundRemovalRepository, type BackgroundRemovalRecord} from './backgroundRemovalJobs'
import {useUserFS} from './useUserFS'
import {removeImageBackground, closeBackgroundRemovalEngine} from './backgroundRemovalEngine'
import {getBackgroundRemovalModel} from '../../schemas/background-removal-models'
import type {AssetActor} from './assetAccess'

type Dependencies = {
    repository: ReturnType<typeof createBackgroundRemovalRepository>
    actor(job: BackgroundRemovalRecord): Promise<AssetActor>
    storage(actor: AssetActor): Promise<Awaited<ReturnType<typeof useUserFS>>>
    infer: typeof removeImageBackground
    heartbeatMs?: number
}
export function createBackgroundRemovalRunner(deps: Dependencies) {
    const owner = randomUUID()
    let work: Promise<void> | undefined
    let revision = 0
    let closed = false
    let active: AbortController | undefined
    async function processJob(job: BackgroundRemovalRecord) {
        const controller = new AbortController()
        active = controller
        let staged: Awaited<ReturnType<Awaited<ReturnType<typeof useUserFS>>['prepareProcessedImage']>> | undefined
        let published = false
        let renewing = false
        const heartbeat = setInterval(() => {
            if (renewing) return
            renewing = true
            void deps.repository.heartbeat(job.id, owner).then(live => {
                if (!live) controller.abort()
            }).catch(() => controller.abort()).finally(() => {renewing = false})
        }, deps.heartbeatMs ?? 15_000)
        const deadline = setTimeout(() => controller.abort(), 11 * 60_000)
        try {
            const profile = getBackgroundRemovalModel(job.model)
            if (profile.version !== job.modelVersion) throw {code: 'MODEL_UNAVAILABLE'}
            const actor = await deps.actor(job)
            const storage = await deps.storage(actor)
            await deps.repository.assertPipelineSources(job)
            const source = await storage.assetByUrl(job.sourceUrl)
            if (source.id !== job.sourceAssetId || source.kind !== 'file') throw {code: 'SOURCE_UNAVAILABLE'}
            const image = await storage.getImageFile(job.sourceUrl)
            const result = await deps.infer({buffer: image.buffer, model: job.model, signal: controller.signal})
            if (controller.signal.aborted) throw {code: 'PROCESSING_INTERRUPTED'}
            // Disabled users and revoked shares cannot publish a cutout after a long inference.
            await deps.actor(job)
            await deps.repository.assertPipelineSources(job)
            await storage.assertReadableImages([job.sourceUrl])
            staged = await storage.prepareProcessedImage(result.buffer)
            if (controller.signal.aborted) throw {code: 'PROCESSING_INTERRUPTED'}
            published = await deps.repository.complete(job.id, owner, tx => staged!.register(tx, {id: job.sourceAssetId, url: job.sourceUrl}))
        } catch (error) {
            const failure = error as {code?: unknown; retryable?: unknown; statusCode?: unknown}
            const unavailable = typeof failure?.statusCode === 'number' && [401, 403, 404, 425].includes(failure.statusCode)
            const engineCodes: Record<string, string> = {TIMED_OUT: 'PROCESSING_TIMEOUT', CANCELLED: 'PROCESSING_INTERRUPTED',
                UNAVAILABLE: 'MODEL_UNAVAILABLE', BUSY: 'PROCESSING_INTERRUPTED', INVALID_IMAGE: 'PROCESSING_FAILED'}
            const safeFailure = unavailable ? {code: 'SOURCE_UNAVAILABLE'} : {
                code: typeof failure?.code === 'string' ? engineCodes[failure.code] ?? failure.code : 'PROCESSING_FAILED',
                retryable: failure?.retryable === true && failure?.code !== 'INVALID_IMAGE',
            }
            await deps.repository.fail(job.id, owner, safeFailure).catch(() => undefined)
        } finally {
            clearInterval(heartbeat)
            clearTimeout(deadline)
            active = undefined
            if (staged && !published) await staged.discard().catch(() => console.error('An unregistered cutout could not be removed.'))
        }
    }
    function kick(): Promise<void> {
        revision++
        if (closed) return Promise.resolve()
        if (work) return work
        work = (async () => {
            // No idle poller: incoming enqueue/status requests and startup wake the durable queue.
            while (!closed) {
                const seen = revision
                const job = await deps.repository.claim(owner)
                if (job) await processJob(job)
                else if (seen === revision) break
            }
        })().catch(() => console.error('Background removal queue is temporarily unavailable.')).finally(() => {work = undefined})
        return work
    }
    async function close() {
        closed = true
        active?.abort()
        await work
    }
    return {kick, close}
}

let runner: ReturnType<typeof createBackgroundRemovalRunner> | undefined
function getRunner() {
    if (!runner) {
        const db = getDatabase()
        runner = createBackgroundRemovalRunner({repository: createBackgroundRemovalRepository(db),
            actor: async job => {
                const [user] = await db.select({userId: users.id, organizationId: users.organizationId,
                    username: users.username, displayName: users.displayName, role: users.role}).from(users)
                    .where(and(eq(users.id, job.userId), eq(users.organizationId, job.organizationId), isNull(users.disabledAt))).limit(1)
                if (!user) throw createError({statusCode: 401, statusMessage: 'Unauthorized'})
                return user
            }, storage: actor => useUserFS(actor), infer: removeImageBackground})
    }
    return runner
}
export function kickBackgroundRemovalQueue() {return getRunner().kick()}
export async function closeBackgroundRemovalQueue() {
    const current = runner
    runner = undefined
    await current?.close()
    await closeBackgroundRemovalEngine()
}
