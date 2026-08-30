import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GenerationLimiter,
  GenerationQueueFullError,
  getGenerationRuntimeSettings,
  unresolvedGenerationIndexes,
} from '../server/utils/generationLimiter.ts'

test('generation limiter bounds its waiting queue and exposes a retryable 429 error', async () => {
  const limiter = new GenerationLimiter(1, 1)
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
  const order: string[] = []

  const first = limiter.run(async () => {
    order.push('first-start')
    await firstGate
    order.push('first-end')
  })
  const second = limiter.run(async () => {
    order.push('second')
  })

  await assert.rejects(
    limiter.run(async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof GenerationQueueFullError)
      assert.equal(error.statusCode, 429)
      assert.equal(error.retryable, true)
      assert.equal(error.code, 'IMAGE_GENERATION_QUEUE_FULL')
      return true
    },
  )
  assert.deepEqual(limiter.snapshot(), {
    active: 1,
    queued: 1,
    concurrency: 1,
    maxQueue: 1,
  })

  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first-start', 'first-end', 'second'])
  assert.equal(limiter.snapshot().active, 0)
  assert.equal(limiter.snapshot().queued, 0)
})

test('generation durability settings are bounded and derive a safe heartbeat', () => {
  const minimum = getGenerationRuntimeSettings({
    imageGenerationConcurrency: 0,
    imageGenerationMaxQueue: -10,
    imageGenerationStaleTtlMs: 1,
  })
  assert.equal(minimum.concurrency, 1)
  assert.equal(minimum.maxQueue, 0)
  assert.equal(minimum.staleTtlMs, 60_000)
  assert.equal(minimum.heartbeatMs, 20_000)

  const configured = getGenerationRuntimeSettings({
    imageGenerationConcurrency: 6,
    imageGenerationMaxQueue: 80,
    imageGenerationStaleTtlMs: 600_000,
  })
  assert.deepEqual(configured, {
    concurrency: 6,
    maxQueue: 80,
    staleTtlMs: 600_000,
    heartbeatMs: 30_000,
  })
})

test('outer failure repair excludes already-terminal output siblings', () => {
  assert.deepEqual(
    unresolvedGenerationIndexes(5, new Set([0, 2, 4])),
    [1, 3],
  )
})
