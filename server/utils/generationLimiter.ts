import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { coordinationTransaction, getCoordinationPool, type CoordinationPool } from './databaseCoordination'

type QueueEntry = () => void

const DEFAULT_CONCURRENCY = 3
const DEFAULT_MAX_QUEUE = 25
const MIN_STALE_TTL_MS = 60_000
const DEFAULT_STALE_TTL_MS = 15 * 60_000
const MAX_STALE_TTL_MS = 24 * 60 * 60_000

export class GenerationQueueFullError extends Error {
    readonly statusCode = 429
    readonly statusMessage = 'Image generation queue is full. Please try again later.'
    readonly code = 'IMAGE_GENERATION_QUEUE_FULL'
    readonly retryable = true
    readonly maxQueue: number

    constructor(maxQueue: number) {
        super(`Image generation queue is full (maximum ${maxQueue} waiting jobs).`)
        this.name = 'GenerationQueueFullError'
        this.maxQueue = maxQueue
    }
}

export class GenerationLimiter {
    private active = 0
    private readonly queue: QueueEntry[] = []
    private readonly concurrency: number
    private readonly maxQueue: number

    constructor(concurrency: number, maxQueue: number) {
        this.concurrency = concurrency
        this.maxQueue = maxQueue
    }

    async run<T>(work: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
        await this.acquire(abortSignal)
        try {
            abortSignal?.throwIfAborted()
            return await work()
        } finally {
            this.release()
        }
    }

    snapshot() {
        return {
            active: this.active,
            queued: this.queue.length,
            concurrency: this.concurrency,
            maxQueue: this.maxQueue,
        }
    }

    private acquire(abortSignal?: AbortSignal): Promise<void> {
        if (abortSignal?.aborted) return Promise.reject(abortSignal.reason)
        if (this.active < this.concurrency) {
            this.active += 1
            return Promise.resolve()
        }
        if (this.queue.length >= this.maxQueue) {
            return Promise.reject(new GenerationQueueFullError(this.maxQueue))
        }
        return new Promise((resolve, reject) => {
            const queued = () => {
                abortSignal?.removeEventListener('abort', cancel)
                this.active += 1
                resolve()
            }
            const cancel = () => {
                const index = this.queue.indexOf(queued)
                if (index >= 0) this.queue.splice(index, 1)
                reject(abortSignal?.reason)
            }
            this.queue.push(queued)
            abortSignal?.addEventListener('abort', cancel, { once: true })
        })
    }

    private release() {
        this.active = Math.max(0, this.active - 1)
        const next = this.queue.shift()
        if (next) next()
    }
}

export type GenerationRuntimeSettings = {
    concurrency: number
    maxQueue: number
    staleTtlMs: number
    heartbeatMs: number
}

export function unresolvedGenerationIndexes(total: number, terminalIndexes: ReadonlySet<number>) {
    return Array.from({length: Math.max(0, Math.floor(total))}, (_, index) => index)
        .filter(index => !terminalIndexes.has(index))
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
    const parsed = Number(value)
    return Number.isFinite(parsed)
        ? Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
        : fallback
}

export function getGenerationRuntimeSettings(runtimeConfig: Record<string, unknown> = {}): GenerationRuntimeSettings {
    const concurrency = boundedInteger(
        runtimeConfig.imageGenerationConcurrency
            ?? process.env.NUXT_IMAGE_GENERATION_CONCURRENCY
            ?? process.env.IMAGE_GENERATION_CONCURRENCY,
        DEFAULT_CONCURRENCY,
        1,
        8,
    )
    const maxQueue = boundedInteger(
        runtimeConfig.imageGenerationMaxQueue
            ?? process.env.NUXT_IMAGE_GENERATION_MAX_QUEUE
            ?? process.env.IMAGE_GENERATION_MAX_QUEUE,
        DEFAULT_MAX_QUEUE,
        0,
        500,
    )
    const staleTtlMs = boundedInteger(
        runtimeConfig.imageGenerationStaleTtlMs
            ?? process.env.NUXT_IMAGE_GENERATION_STALE_TTL_MS
            ?? process.env.IMAGE_GENERATION_STALE_TTL_MS,
        DEFAULT_STALE_TTL_MS,
        MIN_STALE_TTL_MS,
        MAX_STALE_TTL_MS,
    )
    // Keep the lease fresh several times inside the stale window. Capping this
    // also protects long default-TTL jobs without creating excessive writes.
    const heartbeatMs = Math.max(10_000, Math.min(30_000, Math.floor(staleTtlMs / 3)))
    return {concurrency, maxQueue, staleTtlMs, heartbeatMs}
}

type LimiterState = {
    limiter: GenerationLimiter
    concurrency: number
    maxQueue: number
}

const globalState = globalThis as typeof globalThis & {
    __imageGenerationLimiterState?: LimiterState
}

export function getGenerationLimiter(concurrencyValue: unknown, maxQueueValue?: unknown) {
    const concurrency = boundedInteger(concurrencyValue, DEFAULT_CONCURRENCY, 1, 8)
    const maxQueue = boundedInteger(maxQueueValue, DEFAULT_MAX_QUEUE, 0, 500)
    if (!globalState.__imageGenerationLimiterState) {
        globalState.__imageGenerationLimiterState = {
            limiter: new GenerationLimiter(concurrency, maxQueue),
            concurrency,
            maxQueue,
        }
    } else if (
        globalState.__imageGenerationLimiterState.concurrency !== concurrency
        || globalState.__imageGenerationLimiterState.maxQueue !== maxQueue
    ) {
        console.warn(
            `[image-generation] Limiter is already fixed at concurrency=${globalState.__imageGenerationLimiterState.concurrency}, `
            + `maxQueue=${globalState.__imageGenerationLimiterState.maxQueue}; ignoring runtime change to `
            + `concurrency=${concurrency}, maxQueue=${maxQueue}.`,
        )
    }
    return globalState.__imageGenerationLimiterState.limiter
}

export class GenerationLeaseLostError extends Error {
    readonly statusCode = 503
    readonly code = 'IMAGE_GENERATION_LEASE_LOST'
    readonly retryable = true
    constructor() {
        super('Generation ownership expired or could not be renewed. Please retry.')
        this.name = 'GenerationLeaseLostError'
    }
}

export class GenerationRequestTimeoutError extends Error {
    readonly statusCode = 504
    readonly code = 'IMAGE_GENERATION_REQUEST_TIMEOUT'
    readonly retryable = true
    constructor() {
        super('Generation exceeded the request time limit. Please retry unfinished images.')
        this.name = 'GenerationRequestTimeoutError'
    }
}

export function getGenerationRequestTimeoutMs(runtimeConfig: Record<string, unknown> = {}) {
    return boundedInteger(
        runtimeConfig.imageGenerationRequestTimeoutMs
            ?? process.env.NUXT_IMAGE_GENERATION_REQUEST_TIMEOUT_MS
            ?? process.env.IMAGE_GENERATION_REQUEST_TIMEOUT_MS,
        270_000,
        15_000,
        900_000,
    )
}

/** PostgreSQL coordinates paid work across cold starts and independent workers. */
export class DurableGenerationStore {
    private readonly pool: CoordinationPool
    private readonly scope: string
    constructor(pool: CoordinationPool, scope = 'image-generation') {
        this.pool = pool
        this.scope = scope
    }

    async reserve(owner: string, total: number, settings: GenerationRuntimeSettings): Promise<string[]> {
        if (!Number.isInteger(total) || total < 1) throw new TypeError('A generation batch must contain jobs')
        return coordinationTransaction(this.pool, `autoproductimagery:${this.scope}:admission:v1`, async connection => {
            await connection.query('DELETE FROM runtime_lease WHERE scope = $1 AND expires_at <= CURRENT_TIMESTAMP', [this.scope])
            const count = await connection.query('SELECT COUNT(*) AS count FROM runtime_lease WHERE scope = $1', [this.scope])
            if (Number(count.rows[0]?.count) + total > settings.concurrency + settings.maxQueue) {
                throw new GenerationQueueFullError(settings.maxQueue)
            }
            const ids = Array.from({ length: total }, () => randomUUID())
            await connection.query(
                `INSERT INTO runtime_lease (id, scope, owner, state, expires_at, created_at, updated_at)
                 SELECT id, $2, $3::uuid, 'queued', CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond'),
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM unnest($1::uuid[]) AS id`,
                [ids, this.scope, owner, settings.staleTtlMs],
            )
            return ids
        })
    }

    async claim(owner: string, id: string, settings: GenerationRuntimeSettings): Promise<boolean> {
        return coordinationTransaction(this.pool, `autoproductimagery:${this.scope}:admission:v1`, async connection => {
            await connection.query('DELETE FROM runtime_lease WHERE scope = $1 AND expires_at <= CURRENT_TIMESTAMP', [this.scope])
            const owned = await connection.query(
                'SELECT state FROM runtime_lease WHERE scope = $1 AND owner = $2::uuid AND id = $3::uuid',
                [this.scope, owner, id],
            )
            if (!owned.rows.length) throw new GenerationLeaseLostError()
            // Re-entering a running reservation must never trigger a second call.
            if (owned.rows[0]?.state !== 'queued') throw new GenerationLeaseLostError()
            const active = await connection.query(
                "SELECT COUNT(*) AS count FROM runtime_lease WHERE scope = $1 AND state = 'running'",
                [this.scope],
            )
            if (Number(active.rows[0]?.count) >= settings.concurrency) return false
            await connection.query(
                "UPDATE runtime_lease SET state = 'running', updated_at = CURRENT_TIMESTAMP, expires_at = CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond') WHERE scope = $1 AND owner = $2::uuid AND id = $3::uuid",
                [this.scope, owner, id, settings.staleTtlMs],
            )
            return true
        })
    }

    async renew(owner: string, staleTtlMs: number): Promise<string[]> {
        const result = await this.pool.query(
            `UPDATE runtime_lease SET updated_at = CURRENT_TIMESTAMP,
                expires_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond')
             WHERE scope = $1 AND owner = $2::uuid AND expires_at > CURRENT_TIMESTAMP RETURNING id`,
            [this.scope, owner, staleTtlMs],
        )
        return result.rows.map(row => String(row.id))
    }

    async release(owner: string, id?: string) {
        await this.pool.query(
            `DELETE FROM runtime_lease WHERE scope = $1 AND owner = $2::uuid${id ? ' AND id = $3::uuid' : ''}`,
            id ? [this.scope, owner, id] : [this.scope, owner],
        )
    }
}

/**
 * All queued work and lease maintenance stays inside the awaited HTTP request.
 * Nothing relies on a timer continuing after a serverless response is sent.
 */
export async function reserveGenerationBatch(
    owner: string,
    total: number,
    settings: GenerationRuntimeSettings,
    requestTimeoutMs: number,
    pool?: CoordinationPool,
) {
    const store = new DurableGenerationStore(pool ?? await getCoordinationPool())
    // A frozen worker cannot free its running slot while the bounded provider
    // call may still be alive. Admission leases outlive the entire request.
    const leaseSettings = { ...settings, staleTtlMs: Math.max(settings.staleTtlMs, requestTimeoutMs + 60_000) }
    const ids = await store.reserve(owner, total, leaseSettings)
    const remaining = new Set(ids)
    // One gate covers every batch sharing this warm worker, including mask
    // preflight. PostgreSQL admission bounds reservations, while this gate
    // bounds decoded image/reference buffers even before a running lease.
    const memoryGate = getGenerationLimiter(settings.concurrency, settings.maxQueue)
    const workAbort = new AbortController()
    const heartbeatStop = new AbortController()
    const deadline = setTimeout(() => workAbort.abort(new GenerationRequestTimeoutError()), requestTimeoutMs)
    deadline.unref?.()
    const heartbeat = (async () => {
        try {
            while (!heartbeatStop.signal.aborted) {
                await delay(settings.heartbeatMs, undefined, { signal: heartbeatStop.signal })
                const renewed = new Set(await store.renew(owner, leaseSettings.staleTtlMs))
                if ([...remaining].some(id => !renewed.has(id))) {
                    workAbort.abort(new GenerationLeaseLostError())
                    break
                }
            }
        } catch {
            if (!heartbeatStop.signal.aborted) workAbort.abort(new GenerationLeaseLostError())
        }
    })()

    return {
        signal: workAbort.signal,
        async withMemorySlot<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
            return memoryGate.run(() => work(workAbort.signal), workAbort.signal)
        },
        async run<T>(index: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
            const id = ids[index]
            if (!id) throw new RangeError('Unknown generation reservation')
            try {
                return await memoryGate.run(async () => {
                    workAbort.signal.throwIfAborted()
                    while (!await store.claim(owner, id, leaseSettings)) {
                        await delay(500 + Math.floor(Math.random() * 500), undefined, { signal: workAbort.signal })
                        workAbort.signal.throwIfAborted()
                    }
                    workAbort.signal.throwIfAborted()
                    return await work(workAbort.signal)
                }, workAbort.signal)
            } finally {
                // This also releases reservations cancelled while waiting for
                // process memory, before they acquire a global running lease.
                remaining.delete(id)
                await store.release(owner, id)
            }
        },
        async close() {
            clearTimeout(deadline)
            heartbeatStop.abort()
            await heartbeat
            await store.release(owner)
        },
    }
}
