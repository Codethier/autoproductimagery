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

    async run<T>(work: () => Promise<T>): Promise<T> {
        await this.acquire()
        try {
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

    private acquire(): Promise<void> {
        if (this.active < this.concurrency) {
            this.active += 1
            return Promise.resolve()
        }
        if (this.queue.length >= this.maxQueue) {
            return Promise.reject(new GenerationQueueFullError(this.maxQueue))
        }
        return new Promise(resolve => {
            this.queue.push(() => {
                this.active += 1
                resolve()
            })
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
