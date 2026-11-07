import test from 'node:test'
import assert from 'node:assert/strict'
import {createPipelineWorkerScheduler} from '../server/utils/pipelineWorkerScheduler.ts'

function gate<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>(done => {resolve = done})
    return {promise, resolve}
}
const timers = () => {
    const scheduled = new Map<number, {callback: () => void; ms: number}>()
    let id = 0
    return {scheduled, schedule(callback: () => void, ms: number) {scheduled.set(++id, {callback, ms}); return id},
        cancel(timer: unknown) {scheduled.delete(timer as number)}}
}

test('serverless runner fully releases idle notifications and does not poll until an explicit wake', async () => {
    const clock = timers()
    let drains = 0, connections = 0, releases = 0
    const scheduler = createPipelineWorkerScheduler({serverless: true, ...clock,
        drain: async () => {drains++}, pending: async () => false, connect: async () => {connections++},
        disconnect: async () => {releases++}, error: () => assert.fail('No error')})
    await scheduler.wake()
    assert.equal(drains, 1); assert.equal(connections, 1); assert.equal(releases, 1)
    assert.equal(scheduler.dormant, true); assert.equal(clock.scheduled.size, 0)
    await scheduler.wake()
    assert.equal(drains, 2); assert.equal(connections, 2); assert.equal(releases, 2)
    await scheduler.close(); await scheduler.wake()
    assert.equal(drains, 2); assert.equal(clock.scheduled.size, 0)
})

test('future-scheduled pricing or live lease work keeps active polling until all durable work finishes', async () => {
    const clock = timers()
    let pending = true, drains = 0, releases = 0
    const scheduler = createPipelineWorkerScheduler({serverless: true, ...clock,
        drain: async () => {drains++}, pending: async () => pending, connect: async () => {},
        disconnect: async () => {releases++}, error: () => assert.fail('No error')})
    await scheduler.wake()
    assert.equal(scheduler.dormant, false); assert.equal(releases, 0)
    assert.equal(clock.scheduled.size, 1); assert.equal([...clock.scheduled.values()][0]!.ms, 5000)
    pending = false
    await scheduler.wake()
    assert.equal(clock.scheduled.size, 0); assert.equal(drains, 2); assert.equal(releases, 1)
    await scheduler.close()
})

test('a wake while LISTEN is being released starts another drain and cannot strand a newly committed job', async () => {
    const clock = timers(), entered = gate(), releasing = gate()
    let drains = 0, releases = 0
    const scheduler = createPipelineWorkerScheduler({serverless: true, ...clock,
        drain: async () => {drains++}, pending: async () => false, connect: async () => {},
        disconnect: async () => {if (++releases === 1) {entered.resolve(); await releasing.promise}},
        error: () => assert.fail('No error')})
    const first = scheduler.wake()
    await entered.promise
    const second = scheduler.wake()
    releasing.resolve()
    await Promise.all([first, second])
    assert.equal(drains, 2); assert.equal(releases, 2); assert.equal(clock.scheduled.size, 0)
    await scheduler.close()
})

test('a wake during the settling promise window is handled by a fresh drain', async () => {
    const clock = timers()
    let drains = 0, releases = 0
    let scheduler!: ReturnType<typeof createPipelineWorkerScheduler>
    scheduler = createPipelineWorkerScheduler({serverless: true, ...clock,
        drain: async () => {drains++}, pending: async () => false, connect: async () => {},
        disconnect: async () => {if (++releases === 1) queueMicrotask(() => queueMicrotask(() => {void scheduler.wake()}))},
        error: () => assert.fail('No error')})
    await scheduler.wake()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(drains, 2); assert.equal(releases, 2); assert.equal(clock.scheduled.size, 0)
    await scheduler.close()
})

test('cold database and idle release failures retain bounded active recovery; newer wakes are not swallowed', async () => {
    const clock = timers(), entered = gate(), release = gate()
    let drains = 0, releases = 0, errors = 0
    const scheduler = createPipelineWorkerScheduler({serverless: true, ...clock,
        drain: async () => {drains++}, pending: async () => false, connect: async () => {},
        disconnect: async () => {if (++releases === 1) {entered.resolve(); await release.promise; throw Error('private socket error')}},
        error: () => errors++})
    const first = scheduler.wake()
    await entered.promise
    const second = scheduler.wake()
    release.resolve()
    await Promise.all([first, second])
    assert.equal(drains, 2); assert.equal(errors, 1); assert.equal(clock.scheduled.size, 0)
    await scheduler.close()
    const cold = createPipelineWorkerScheduler({serverless: true, ...clock,
        drain: async () => {throw Error('private database error')}, pending: async () => false, connect: async () => {},
        disconnect: async () => {}, error: () => errors++})
    await cold.wake()
    assert.equal(clock.scheduled.size, 1); assert.equal([...clock.scheduled.values()][0]!.ms, 5000)
    await cold.close(); assert.equal(clock.scheduled.size, 0)
})

test('non-Railway deployments without wake configuration retain their durable idle fallback', async () => {
    const clock = timers()
    let releases = 0
    const scheduler = createPipelineWorkerScheduler({serverless: false, ...clock,
        drain: async () => {}, pending: async () => false, connect: async () => {},
        disconnect: async () => {releases++}, error: () => assert.fail('No error')})
    await scheduler.wake()
    assert.equal(releases, 0); assert.equal(scheduler.dormant, false)
    assert.equal([...clock.scheduled.values()][0]!.ms, 60_000)
    await scheduler.close(); assert.equal(clock.scheduled.size, 0)
})
