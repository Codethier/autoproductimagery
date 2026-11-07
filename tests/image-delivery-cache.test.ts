import assert from 'node:assert/strict'
import test from 'node:test'
import { createImageDeliveryCache, type ImageRepresentation } from '../server/utils/imageDeliveryCache.ts'

function image(size = 4): ImageRepresentation {
    return { buffer: Buffer.alloc(size, 42), mimeType: 'image/png', width: 2, height: 2 }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

test('image delivery reuses cached immutable bytes and expires without extending TTL on hits', async () => {
    let now = 0
    let loads = 0
    const cache = createImageDeliveryCache({ ttlMs: 100, now: () => now })
    const load = async () => { loads += 1; return image() }
    const first = await cache.get('source', load)
    now = 99
    assert.equal(await cache.get('source', load), first)
    assert.equal(loads, 1)
    now = 100
    assert.notEqual(await cache.get('source', load), first)
    assert.equal(loads, 2)
    assert.deepEqual(cache.stats(), { bytes: 4, entries: 1, active: 0, queued: 0, inflight: 0 })
})

test('image delivery evicts least recently used entries within entry and byte budgets', async () => {
    const cache = createImageDeliveryCache({ maxEntries: 2, maxBytes: 9 })
    const counts = new Map<string, number>()
    const get = (key: string, size = 4) => cache.get(key, async () => {
        counts.set(key, (counts.get(key) ?? 0) + 1)
        return image(size)
    })
    await get('a')
    await get('b')
    await get('a')
    await get('c')
    assert.deepEqual(cache.stats(), { bytes: 8, entries: 2, active: 0, queued: 0, inflight: 0 })
    await get('a')
    assert.equal(counts.get('a'), 1)
    await get('b')
    assert.equal(counts.get('b'), 2)
    // Byte pressure can require multiple evictions even below maxEntries.
    await get('large', 8)
    assert.equal(cache.stats().entries, 1)
    assert.equal(cache.stats().bytes, 8)
})

test('image delivery skips oversized buffers and owns the bytes counted in its budget', async () => {
    const cache = createImageDeliveryCache({ maxBytes: 4 })
    let loads = 0
    const oversized = async () => { loads += 1; return image(5) }
    await cache.get('large', oversized)
    await cache.get('large', oversized)
    assert.equal(loads, 2)
    assert.equal(cache.stats().bytes, 0)
    const allocation = Buffer.alloc(1024)
    const input = { ...image(), buffer: allocation.subarray(0, 4) }
    const cached = await cache.get('slice', async () => input)
    assert.notEqual(cached.buffer.buffer, allocation.buffer)
    assert.equal(cached.buffer.buffer.byteLength, 4)
    allocation.fill(99)
    assert.equal(cached.buffer[0], 0)
    assert.equal(cache.stats().bytes, 4)
})

test('image delivery coalesces concurrent callers before both active and queued loads', async () => {
    const cache = createImageDeliveryCache({ maxConcurrent: 1, maxQueued: 1 })
    const running = deferred<ImageRepresentation>()
    const waiting = deferred<ImageRepresentation>()
    let runningLoads = 0
    let waitingLoads = 0
    const a = cache.get('running', () => { runningLoads += 1; return running.promise })
    const a2 = cache.get('running', () => { throw new Error('Duplicate running load') })
    const b = cache.get('waiting', () => { waitingLoads += 1; return waiting.promise })
    const b2 = cache.get('waiting', () => { throw new Error('Duplicate queued load') })
    assert.equal(a, a2)
    assert.equal(b, b2)
    assert.deepEqual(cache.stats(), { bytes: 0, entries: 0, active: 1, queued: 1, inflight: 2 })
    assert.equal(waitingLoads, 0)
    running.resolve(image())
    await a
    assert.equal(waitingLoads, 1)
    waiting.resolve(image())
    assert.equal(await b, await b2)
    assert.equal(runningLoads, 1)
    assert.deepEqual(cache.stats(), { bytes: 8, entries: 2, active: 0, queued: 0, inflight: 0 })
})

test('image delivery reports redacted overload, releases failures and recovers', async () => {
    const cache = createImageDeliveryCache({ maxConcurrent: 1, maxQueued: 1 })
    const running = deferred<ImageRepresentation>()
    const failure = new Error('Underlying failure')
    const a = cache.get('secret-running-path', () => running.promise)
    const rejected = assert.rejects(a, error => error === failure)
    const b = cache.get('waiting', async () => image())
    await assert.rejects(cache.get('secret-overload-path', async () => image()), error => {
        const busy = error as { statusCode: number; statusMessage: string; data: { code: string; retryable: boolean } }
        assert.equal(busy.statusCode, 429)
        assert.equal(busy.data.code, 'IMAGE_DELIVERY_BUSY')
        assert.equal(busy.data.retryable, true)
        assert.equal(busy.statusMessage.includes('secret'), false)
        return true
    })
    running.reject(failure)
    await rejected
    await b
    await cache.get('secret-running-path', async () => image())
    assert.deepEqual(cache.stats(), { bytes: 8, entries: 2, active: 0, queued: 0, inflight: 0 })
})

test('image delivery recovers from synchronous loader failures and can disable queueing', async () => {
    const cache = createImageDeliveryCache({ maxConcurrent: 1, maxQueued: 0 })
    await assert.rejects(cache.get('a', () => { throw new Error('Failed before await') }), /Failed before await/)
    const pending = deferred<ImageRepresentation>()
    const a = cache.get('a', () => pending.promise)
    await assert.rejects(cache.get('b', async () => image()), { statusCode: 429 })
    pending.resolve(image())
    await a
    await cache.get('b', async () => image())
    assert.equal(cache.stats().active, 0)
})

test('image delivery clear prevents an old in-flight load repopulating cached bytes', async () => {
    const cache = createImageDeliveryCache()
    await cache.get('stored', async () => image())
    const pending = deferred<ImageRepresentation>()
    const running = cache.get('running', () => pending.promise)
    cache.clear()
    assert.equal(cache.stats().bytes, 0)
    pending.resolve(image())
    await running
    assert.deepEqual(cache.stats(), { bytes: 0, entries: 0, active: 0, queued: 0, inflight: 0 })
    await cache.get('running', async () => image())
    assert.equal(cache.stats().entries, 1)
})

test('image delivery can disable retaining entries without disabling concurrent coalescing', async () => {
    const cache = createImageDeliveryCache({ maxBytes: 0 })
    const pending = deferred<ImageRepresentation>()
    const a = cache.get('a', () => pending.promise)
    assert.equal(a, cache.get('a', async () => image()))
    pending.resolve(image())
    await a
    assert.deepEqual(cache.stats(), { bytes: 0, entries: 0, active: 0, queued: 0, inflight: 0 })
})
