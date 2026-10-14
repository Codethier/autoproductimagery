import assert from 'node:assert/strict'
import test from 'node:test'
import {migrateAfterDatabaseWarmup} from '../scripts/lib/databaseMigration.ts'

test('explicit migration waits for database readiness then invokes migration once', async () => {
    const calls: string[] = []
    let release!: () => void
    const ready = new Promise<void>(resolve => {release = resolve})
    const pending = migrateAfterDatabaseWarmup({
        warmDatabase: async () => {calls.push('warmup'); await ready; calls.push('ready')},
        migrateOnce: async () => {calls.push('migration')},
    })
    await Promise.resolve()
    assert.deepEqual(calls, ['warmup'])
    release(); await pending
    assert.deepEqual(calls, ['warmup', 'ready', 'migration'])
})

test('failed database warmup does not execute any migration SQL', async () => {
    let migrations = 0
    await assert.rejects(migrateAfterDatabaseWarmup({
        warmDatabase: async () => {throw new Error('cold database unavailable')},
        migrateOnce: async () => {migrations++},
    }))
    assert.equal(migrations, 0)
})

test('a failed or interrupted actual migration is never automatically retried', async () => {
    let warmups = 0, migrations = 0
    await assert.rejects(migrateAfterDatabaseWarmup({
        warmDatabase: async () => {warmups++},
        migrateOnce: async () => {migrations++; throw new Error('uncertain migration state')},
    }))
    assert.equal(warmups, 1)
    assert.equal(migrations, 1)
})

test('expiry during warmup prevents a late migration from starting', async () => {
    const controller = new AbortController()
    let migrations = 0
    await assert.rejects(migrateAfterDatabaseWarmup({signal: controller.signal,
        warmDatabase: async () => {controller.abort()},
        migrateOnce: async () => {migrations++},
    }))
    assert.equal(migrations, 0)
})
