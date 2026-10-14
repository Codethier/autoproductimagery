import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import {
    DurableGenerationStore,
    GenerationLeaseLostError,
    GenerationQueueFullError,
    GenerationRequestTimeoutError,
    reserveGenerationBatch,
    getGenerationRuntimeSettings,
    type GenerationRuntimeSettings,
} from '../server/utils/generationLimiter.ts'
import {
    DurableLoginThrottle,
    LOGIN_ACCOUNT_ATTEMPT_LIMIT,
} from '../server/utils/loginThrottle.ts'

const url = process.env.PG_TEST_DATABASE_URL
const settings: GenerationRuntimeSettings = { concurrency: 1, maxQueue: 1, staleTtlMs: 60_000, heartbeatMs: 10 }

async function fixture() {
    const schema = `serverless_test_${randomUUID().replaceAll('-', '')}`
    const bootstrap = new Pool({ connectionString: url, max: 1 })
    await bootstrap.query(`CREATE SCHEMA "${schema}"`)
    const first = new Pool({ connectionString: url, max: 3, options: `-c search_path=${schema}` })
    const second = new Pool({ connectionString: url, max: 3, options: `-c search_path=${schema}` })
    const migrations = new URL('../drizzle/postgres/', import.meta.url)
    const directories = (await readdir(migrations)).filter(name => /^\d{14}_/.test(name)).sort()
    for (const directory of directories) {
        await first.query(await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8'))
    }
    return {
        first, second,
        async close() {
            await Promise.all([first.end(), second.end()])
            await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`)
            await bootstrap.end()
        },
    }
}

test('default distributed capacity admits a 50-picture batch while enforcing concurrency and rejecting excess work', { skip: !url }, async () => {
    const {first, second, close} = await fixture()
    try {
        const runtime = getGenerationRuntimeSettings()
        const firstStore = new DurableGenerationStore(first), secondStore = new DurableGenerationStore(second)
        const owner = randomUUID(), otherOwner = randomUUID()
        const ids = await firstStore.reserve(owner, 50, runtime)
        assert.equal(ids.length, 50)
        const claimed = await Promise.all(ids.slice(0, 4).map((id, index) => (index % 2 ? secondStore : firstStore).claim(owner, id, runtime)))
        assert.equal(claimed.filter(Boolean).length, 3)
        await assert.rejects(secondStore.reserve(otherOwner, 4, runtime), GenerationQueueFullError)
        assert.equal(Number((await first.query('SELECT COUNT(*) AS count FROM runtime_lease')).rows[0].count), 50)
        await firstStore.release(owner)
        const smaller = {...runtime, maxQueue: 8}
        await assert.rejects(secondStore.reserve(otherOwner, 50, smaller), GenerationQueueFullError)
        assert.equal(Number((await first.query('SELECT COUNT(*) AS count FROM runtime_lease')).rows[0].count), 0)
    } finally { await close() }
})

test('independent workers share atomic generation admission, running capacity, and stale ownership', { skip: !url }, async () => {
    const { first, second, close } = await fixture()
    try {
        const stores = [new DurableGenerationStore(first), new DurableGenerationStore(second)]
        const owners = Array.from({ length: 3 }, () => randomUUID())
        const attempts = await Promise.allSettled(owners.map((owner, index) => stores[index % 2]!.reserve(owner, 1, settings)))
        const accepted = attempts.flatMap((attempt, index) => attempt.status === 'fulfilled' ? [{ id: attempt.value[0]!, owner: owners[index]! }] : [])
        assert.equal(accepted.length, 2)
        const rejection = attempts.find(attempt => attempt.status === 'rejected') as PromiseRejectedResult
        assert.ok(rejection.reason instanceof GenerationQueueFullError)
        assert.equal(await stores[0]!.claim(accepted[0]!.owner, accepted[0]!.id, settings), true)
        assert.equal(await stores[1]!.claim(accepted[1]!.owner, accepted[1]!.id, settings), false)
        await assert.rejects(stores[1]!.claim(randomUUID(), accepted[0]!.id, settings), GenerationLeaseLostError)
        await first.query("UPDATE runtime_lease SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1", [accepted[0]!.id])
        assert.deepEqual(await stores[0]!.renew(accepted[0]!.owner, settings.staleTtlMs), [])
        await assert.rejects(stores[0]!.claim(accepted[0]!.owner, accepted[0]!.id, settings), GenerationLeaseLostError)
        assert.equal(await stores[1]!.claim(accepted[1]!.owner, accepted[1]!.id, settings), true)
        assert.equal((await stores[0]!.reserve(randomUUID(), 1, settings)).length, 1)
        const rows = await first.query('SELECT COUNT(*) AS count FROM runtime_lease')
        assert.equal(Number(rows.rows[0].count), 2)
    } finally {
        await close()
    }
})

test('request-scoped reservations serialize paid work across instances and release every slot', { skip: !url }, async () => {
    const { first, second, close } = await fixture()
    const batches: Awaited<ReturnType<typeof reserveGenerationBatch>>[] = []
    try {
        batches.push(await reserveGenerationBatch(randomUUID(), 1, settings, 10_000, first))
        batches.push(await reserveGenerationBatch(randomUUID(), 1, settings, 10_000, second))
        let active = 0
        let maximumActive = 0
        const work = async () => {
            active += 1
            maximumActive = Math.max(maximumActive, active)
            await delay(30)
            active -= 1
            return 'saved'
        }
        assert.deepEqual(await Promise.all(batches.map(batch => batch.run(0, work))), ['saved', 'saved'])
        assert.equal(maximumActive, 1)
        const rows = await first.query('SELECT COUNT(*) AS count FROM runtime_lease')
        assert.equal(Number(rows.rows[0].count), 0)
    } finally {
        await Promise.all(batches.map(batch => batch.close()))
        await close()
    }
})

test('a request deadline cancels running work and queued work never reaches a paid call', { skip: !url }, async () => {
    const { first, close } = await fixture()
    const batch = await reserveGenerationBatch(randomUUID(), 2, settings, 30, first)
    try {
        let paidCalls = 0
        const results = await Promise.allSettled([0, 1].map(index => batch.run(index, async signal => {
            paidCalls += 1
            await new Promise<void>((_resolve, reject) => {
                if (signal.aborted) reject(signal.reason)
                else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            })
        })))
        assert.equal(paidCalls, 1)
        for (const result of results) {
            assert.equal(result.status, 'rejected')
            assert.ok((result as PromiseRejectedResult).reason instanceof GenerationRequestTimeoutError)
        }
    } finally {
        await batch.close()
        await close()
    }
})

test('expired leases abort active work instead of resurrecting ownership', { skip: !url }, async () => {
    const { first, close } = await fixture()
    const batch = await reserveGenerationBatch(randomUUID(), 1, settings, 10_000, first)
    try {
        const work = batch.run(0, async signal => {
            await first.query("UPDATE runtime_lease SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'")
            await new Promise<void>((_resolve, reject) => {
                if (signal.aborted) reject(signal.reason)
                else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            })
        })
        await assert.rejects(work, GenerationLeaseLostError)
    } finally {
        await batch.close()
        await close()
    }
})

test('simultaneous request preflight and generation share one process memory gate', { skip: !url }, async () => {
    const { first, second, close } = await fixture()
    const batches: Awaited<ReturnType<typeof reserveGenerationBatch>>[] = []
    let releaseRunning!: () => void
    try {
        batches.push(await reserveGenerationBatch(randomUUID(), 1, settings, 10_000, first))
        batches.push(await reserveGenerationBatch(randomUUID(), 1, settings, 10_000, second))
        let signalStarted!: () => void
        const started = new Promise<void>(resolve => { signalStarted = resolve })
        let activeImageWork = 0
        let maximumImageWork = 0
        const enter = () => {
            activeImageWork += 1
            maximumImageWork = Math.max(maximumImageWork, activeImageWork)
        }
        const running = batches[0]!.run(0, async () => {
            enter()
            signalStarted()
            await new Promise<void>(resolve => { releaseRunning = resolve })
            activeImageWork -= 1
        })
        await started
        let maskReads = 0
        const preflight = batches[1]!.withMemorySlot(async () => {
            enter()
            maskReads += 1
            await delay(10)
            activeImageWork -= 1
        })
        await delay(20)
        assert.equal(maskReads, 0, 'a queued request cannot read/decode masks while provider work occupies process memory')
        releaseRunning()
        await Promise.all([running, preflight])
        await batches[1]!.run(0, async () => {
            enter()
            activeImageWork -= 1
        })
        assert.equal(maskReads, 1)
        assert.equal(maximumImageWork, 1)
    } finally {
        releaseRunning?.()
        await Promise.all(batches.map(batch => batch.close()))
        await close()
    }
})

test('a queued preflight deadline cancels before any mask/source read and stays cancelled after capacity frees', { skip: !url }, async () => {
    const { first, second, close } = await fixture()
    const batches: Awaited<ReturnType<typeof reserveGenerationBatch>>[] = []
    let releaseRunning!: () => void
    try {
        batches.push(await reserveGenerationBatch(randomUUID(), 1, settings, 10_000, first))
        let signalStarted!: () => void
        const started = new Promise<void>(resolve => { signalStarted = resolve })
        const running = batches[0]!.run(0, async () => {
            signalStarted()
            await new Promise<void>(resolve => { releaseRunning = resolve })
        })
        await started
        batches.push(await reserveGenerationBatch(randomUUID(), 1, settings, 30, second))
        let imageReads = 0
        await assert.rejects(batches[1]!.withMemorySlot(async () => { imageReads += 1 }), GenerationRequestTimeoutError)
        assert.equal(imageReads, 0)
        releaseRunning()
        await running
        await assert.rejects(batches[1]!.withMemorySlot(async () => { imageReads += 1 }), GenerationRequestTimeoutError)
        assert.equal(imageReads, 0)
    } finally {
        releaseRunning?.()
        await Promise.all(batches.map(batch => batch.close()))
        await close()
    }
})

test('login attempts stay bounded across independent workers, expiry, and successful resets', { skip: !url }, async () => {
    const { first, second, close } = await fixture()
    try {
        const throttles = [new DurableLoginThrottle(first), new DurableLoginThrottle(second)]
        const decisions = await Promise.all(Array.from({ length: 20 }, (_, index) =>
            throttles[index % 2]!.consume(`test-ip-${index}`, index % 2 ? 'Example Account' : 'example account'),
        ))
        assert.equal(decisions.filter(decision => decision.allowed).length, LOGIN_ACCOUNT_ATTEMPT_LIMIT)
        assert.ok(decisions.filter(decision => !decision.allowed).every(decision => decision.retryAfterSeconds > 0))
        const rows = await first.query('SELECT key FROM login_attempt')
        assert.ok(rows.rows.every(row => !row.key.includes('test-ip') && !row.key.includes('example')))
        await throttles[1]!.clearSuccessfulAccount('Example Account')
        assert.equal((await throttles[0]!.consume('test-next-ip', 'example account')).allowed, true)
        await first.query("UPDATE login_attempt SET reset_at = CURRENT_TIMESTAMP - INTERVAL '1 second'")
        assert.equal((await throttles[1]!.consume('test-next-ip', 'example account')).allowed, true)
    } finally {
        await close()
    }
})
