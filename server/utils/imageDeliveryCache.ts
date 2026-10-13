import { createError } from 'h3'

export type ImageRepresentation = {
    buffer: Buffer
    mimeType: string
    width: number
    height: number
}

export type ImageDeliveryCacheOptions = {
    maxBytes?: number
    maxEntries?: number
    ttlMs?: number
    maxConcurrent?: number
    maxQueued?: number
    now?: () => number
}

type CachedRepresentation = {
    image: ImageRepresentation
    expiresAt: number
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
    return value !== undefined && Number.isFinite(value)
        ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
        : fallback
}

/**
 * An instance is scoped to one storage backend. Keys identify immutable image
 * representations, never authorization: callers must check current access
 * before every lookup. Cached buffers must be treated as immutable by callers.
 * No timers or disk files are required for a serverless worker.
 */
export function createImageDeliveryCache(options: ImageDeliveryCacheOptions = {}) {
    const maxBytes = boundedInteger(options.maxBytes, 64 * 1024 * 1024, 0, 512 * 1024 * 1024)
    const maxEntries = boundedInteger(options.maxEntries, 128, 0, 2048)
    const ttlMs = boundedInteger(options.ttlMs, 5 * 60_000, 0, 24 * 60 * 60_000)
    const maxConcurrent = boundedInteger(options.maxConcurrent, 2, 1, 8)
    const maxQueued = boundedInteger(options.maxQueued, 64, 0, 256)
    const now = options.now ?? Date.now
    const cached = new Map<string, CachedRepresentation>()
    const inflight = new Map<string, Promise<ImageRepresentation>>()
    const queue: Array<() => void> = []
    let bytes = 0
    let active = 0
    let epoch = 0

    function remove(key: string) {
        const entry = cached.get(key)
        if (!entry) return
        bytes -= entry.image.buffer.byteLength
        cached.delete(key)
    }

    function expire() {
        const currentTime = now()
        for (const [key, entry] of cached) {
            if (entry.expiresAt <= currentTime) remove(key)
        }
    }

    function remember(key: string, image: ImageRepresentation): ImageRepresentation {
        const size = image.buffer.byteLength
        if (maxEntries === 0 || ttlMs === 0 || size > maxBytes || size === 0) return image
        expire()
        while (cached.size >= maxEntries || bytes + size > maxBytes) {
            const oldest = cached.keys().next().value
            if (oldest === undefined) break
            remove(oldest)
        }
        // A small Buffer slice can otherwise retain a much larger allocation
        // than its byteLength. Own exactly the bytes counted in the budget.
        const buffer = Buffer.allocUnsafeSlow(size)
        image.buffer.copy(buffer)
        const stored = { ...image, buffer }
        cached.set(key, { image: stored, expiresAt: now() + ttlMs })
        bytes += size
        return stored
    }

    function get(key: string, loader: () => Promise<ImageRepresentation>): Promise<ImageRepresentation> {
        expire()
        const entry = cached.get(key)
        if (entry) {
            // Move a successful hit to the most recently used end, without
            // extending its absolute expiry.
            cached.delete(key)
            cached.set(key, entry)
            return Promise.resolve(entry.image)
        }
        const pending = inflight.get(key)
        if (pending) return pending
        if (active >= maxConcurrent && queue.length >= maxQueued) {
            return Promise.reject(createError({
                statusCode: 429,
                statusMessage: 'Image loading is busy. Please try again shortly.',
                data: { code: 'IMAGE_DELIVERY_BUSY', retryable: true },
            }))
        }

        const loadEpoch = epoch
        let resolve!: (image: ImageRepresentation) => void
        let reject!: (error: unknown) => void
        const result = new Promise<ImageRepresentation>((done, fail) => {
            resolve = done
            reject = fail
        })
        inflight.set(key, result)
        const run = () => {
            active += 1
            void (async () => {
                try {
                    const image = await loader()
                    resolve(loadEpoch === epoch ? remember(key, image) : image)
                } catch (error) {
                    // Failures never become cache entries and all callers of
                    // this flight receive the same error.
                    reject(error)
                } finally {
                    inflight.delete(key)
                    active -= 1
                    queue.shift()?.()
                }
            })()
        }
        if (active < maxConcurrent) run()
        else queue.push(run)
        return result
    }

    return {
        get,
        clear() {
            cached.clear()
            bytes = 0
            epoch += 1
        },
        stats() {
            expire()
            return { bytes, entries: cached.size, active, queued: queue.length, inflight: inflight.size }
        },
    }
}
