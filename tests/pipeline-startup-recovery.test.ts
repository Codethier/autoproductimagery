import assert from 'node:assert/strict'
import test from 'node:test'
import {recoverPipelineWorkerAtStartup} from '../server/utils/pipelineStartupRecovery.ts'

test('one startup wake recovers work saved by an older app after the new runner became dormant', async () => {
    const calls: string[] = []
    await recoverPipelineWorkerAtStartup({configured: () => true,
        pending: async () => {calls.push('saved-work'); return true},
        wake: async () => {calls.push('wake')}, unavailable: () => calls.push('error'),
    })
    assert.deepEqual(calls, ['saved-work', 'wake'])
})

test('idle or unconfigured startup does not repeatedly wake the database or runner', async () => {
    let queries = 0, wakes = 0
    const dependencies = {pending: async () => {queries++; return false}, wake: async () => {wakes++}, unavailable: () => undefined}
    await recoverPipelineWorkerAtStartup({...dependencies, configured: () => false})
    assert.equal(queries, 0)
    await recoverPipelineWorkerAtStartup({...dependencies, configured: () => true})
    assert.equal(queries, 1)
    assert.equal(wakes, 0)
    await Promise.resolve()
    assert.equal(queries, 1, 'there is no idle polling loop')
})

test('a startup readiness failure is redacted and cannot execute or replay provider work', async () => {
    let failures = 0, wakes = 0
    await recoverPipelineWorkerAtStartup({configured: () => true,
        pending: async () => {throw new Error('private connection diagnostic')},
        wake: async () => {wakes++}, unavailable: () => {failures++},
    })
    assert.equal(failures, 1)
    assert.equal(wakes, 0)
})
