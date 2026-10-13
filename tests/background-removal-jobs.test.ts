import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {Pool} from 'pg'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {count, eq, sql} from 'drizzle-orm'
import {assets, backgroundRemovalJobs, organizations, systemPrompt, users, accountGenerationCharges} from '../server/db/schema.ts'
import {createAssetRepository, type AssetActor} from '../server/utils/assetAccess.ts'
import {createBackgroundRemovalRepository, safeBackgroundRemovalError, backgroundRemovalRequestError} from '../server/utils/backgroundRemovalJobs.ts'
import {getDatabasePoolConfig} from '../server/utils/lib/db.ts'
import {CreateBackgroundRemovalSchema, BackgroundRemovalListQuerySchema} from '../schemas/background-removal.ts'

const integration = {skip: !process.env.TEST_DATABASE_URL, timeout: 60_000}
const status = (code: number) => (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === code)
const actor = (organizationId: string, username: string, role: 'owner' | 'user' = 'user'): AssetActor => ({organizationId, userId: randomUUID(), username, displayName: username, role})
type Database = ReturnType<typeof drizzle>
async function fixture(work: (f: {db: Database; alice: AssetActor; bob: AssetActor; owner: AssetActor; outsider: AssetActor; queries: string[]}) => Promise<void>) {
    const connectionString = process.env.TEST_DATABASE_URL!
    const schema = `imagery_removal_${randomUUID().replaceAll('-', '')}`
    const administrator = new Pool({connectionString, max: 1})
    const pool = new Pool({...getDatabasePoolConfig({DATABASE_URL: connectionString}), options: `-c search_path=${schema} -c timezone=UTC`})
    try {
        await administrator.query(`CREATE SCHEMA "${schema}"`)
        const queries: string[] = []
        const db = drizzle({client: pool, logger: {logQuery(query) {queries.push(query)}}})
        await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle/postgres', import.meta.url)), migrationsSchema: schema})
        const org = randomUUID(), other = randomUUID()
        await db.insert(organizations).values([{id: org, name: 'Studio'}, {id: other, name: 'Other studio'}])
        const alice = actor(org, 'alice'), bob = actor(org, 'bob'), owner = actor(org, 'owner', 'owner'), outsider = actor(other, 'outsider', 'owner')
        await db.insert(users).values([alice, bob, owner, outsider].map(a => ({id: a.userId, organizationId: a.organizationId,
            username: a.username, normalizedUsername: a.username, displayName: a.displayName, passwordHash: 'unused-local-test-hash', role: a.role})))
        await work({db, alice, bob, owner, outsider, queries})
    } finally {
        await pool.end()
        await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await administrator.end()
    }
}
async function sourceImage(db: Database, actor: AssetActor, category: 'uploaded' | 'generated' | 'processed' = 'uploaded') {
    return createAssetRepository(actor, db).register({ownerUserId: actor.userId, parentId: null, name: 'product.png', kind: 'file', category,
        url: `/images/organizations/${actor.organizationId}/users/${actor.userId}/objects/${randomUUID()}/product.png`,
        byteSize: 1200, mimeType: 'image/png', width: 40, height: 30})
}
const enqueue = (repository: ReturnType<typeof createBackgroundRemovalRepository>, actor: AssetActor, source: typeof assets.$inferSelect,
    overrides: Partial<Parameters<typeof repository.enqueue>[1]> = {}) => repository.enqueue(actor, {
        sourceAssetId: source.id, sourceUrl: source.url, model: 'birefnet-lite', modelVersion: 'pinned-test-checkpoint-v1', idempotencyKey: randomUUID(), ...overrides,
    })

test('background removal accepts exact two models and bounded strict JSON/list schemas', () => {
    const request = {sourceUrl: '/images/product.png', model: 'birefnet-lite', idempotencyKey: randomUUID()}
    assert.equal(CreateBackgroundRemovalSchema.safeParse(request).success, true)
    assert.equal(CreateBackgroundRemovalSchema.safeParse({...request, model: 'birefnet'}).success, true)
    for (const model of ['birefnet-portrait', 'provider/birefnet', 'bria', '', null]) assert.equal(CreateBackgroundRemovalSchema.safeParse({...request, model}).success, false)
    assert.equal(CreateBackgroundRemovalSchema.safeParse({...request, idempotencyKey: 'not-a-uuid'}).success, false)
    assert.equal(CreateBackgroundRemovalSchema.safeParse({...request, modelVersion: 'caller-selected'}).success, false)
    assert.deepEqual(BackgroundRemovalListQuerySchema.parse({}), {limit: 20, offset: 0})
    for (const value of [{limit: 51}, {limit: 0}, {offset: 10001}, {offset: -1}, {unknown: 1}]) assert.equal(BackgroundRemovalListQuerySchema.safeParse(value).success, false)
})

test('background-removal errors are allowlisted and never echo model/native/driver details', () => {
    const error = safeBackgroundRemovalError({code: 'PROCESSING_TIMEOUT', retryable: true})
    assert.equal(error.code, 'PROCESSING_TIMEOUT')
    assert.equal(error.retryable, true)
    assert.deepEqual(safeBackgroundRemovalError({code: 'https://secret.test/?password=secret', retryable: 'yes'}), {
        code: 'PROCESSING_FAILED', message: 'Background removal could not process this image.', retryable: false,
    })
    assert.throws(() => backgroundRemovalRequestError(new Error('C:\\private\\secret-model.onnx?token=secret')), status(503))
    const hidden = (() => {try {backgroundRemovalRequestError(new Error('token=secret'))} catch (e) {return String(e)}})()
    assert.ok(!hidden?.includes('token=secret'))
})

test('jobs are private to the initiating user, owners cannot read private history, and idempotency is scoped', integration, async () => fixture(async f => {
    const repository = createBackgroundRemovalRepository(f.db), source = await sourceImage(f.db, f.alice)
    const idempotencyKey = randomUUID()
    const duplicates = await Promise.all([enqueue(repository, f.alice, source, {idempotencyKey}), enqueue(repository, f.alice, source, {idempotencyKey})])
    assert.equal(duplicates[0]!.id, duplicates[1]!.id)
    assert.equal(duplicates[0]!.status, 'queued')
    assert.equal(duplicates[0]!.providerPriceUsd, '0')
    assert.equal(duplicates[0]!.priceSource, 'local-processing')
    assert.ok(!('leaseOwner' in duplicates[0]!))
    await assert.rejects(enqueue(repository, f.alice, source, {idempotencyKey, model: 'birefnet'}), status(409))
    for (const stranger of [f.bob, f.owner, f.outsider]) {
        assert.deepEqual(await repository.list(stranger), [])
        await assert.rejects(repository.get(stranger, duplicates[0]!.id), status(404))
        await assert.rejects(enqueue(repository, stranger, source), status(404))
    }
    await assert.rejects(repository.get(f.alice, 'not-an-id'), status(404))
    assert.equal((await repository.list(f.alice)).length, 1)
    const [charges] = await f.db.select({value: count()}).from(accountGenerationCharges)
    assert.equal(Number(charges?.value), 0, 'local processing must not forge a paid Gateway ledger entry')
}))

test('read-only same-org shares may be processed into recipient jobs; revoked/unpriced/deleted sources fail closed', integration, async () => fixture(async f => {
    const repository = createBackgroundRemovalRepository(f.db), source = await sourceImage(f.db, f.alice)
    const sourceRepo = createAssetRepository(f.alice, f.db)
    await sourceRepo.share(source.id, f.bob.userId, 'view')
    const sharedJob = await enqueue(repository, f.bob, source)
    assert.equal((await repository.get(f.bob, sharedJob.id)).id, sharedJob.id)
    await assert.rejects(repository.get(f.alice, sharedJob.id), status(404))
    await sourceRepo.revoke(source.id, f.bob.userId)
    await assert.rejects(enqueue(repository, f.bob, source), status(404))
    await assert.rejects(enqueue(repository, f.alice, source, {sourceAssetId: randomUUID()}), status(404))
    await assert.rejects(enqueue(repository, f.alice, source, {sourceUrl: 'https://example.test/image.png'}), status(400))
    const generated = await sourceImage(f.db, f.alice, 'generated')
    const [generation] = await f.db.insert(systemPrompt).values({organizationId: f.alice.organizationId, userId: f.alice.userId,
        TextPrompt: 'Local visibility fixture', outputImage: generated.url, status: 'succeeded', priceUsd: '0.02', priceSource: 'estimate', billingState: 'awaiting'}).returning()
    await assert.rejects(enqueue(repository, f.alice, generated), status(425))
    await f.db.update(systemPrompt).set({priceUsd: '0', priceSource: 'gateway', billingState: 'confirmed', usageJson: {gatewayBilling: {isByok: false}}}).where(eq(systemPrompt.id, generation!.id))
    assert.equal((await enqueue(repository, f.alice, generated)).status, 'queued')
    await f.db.update(assets).set({deletedAt: sql`CURRENT_TIMESTAMP`}).where(eq(assets.id, source.id))
    await assert.rejects(enqueue(repository, f.alice, source), status(404))
}))

test('PostgreSQL admission enforces per-user and global queue limits under concurrent submissions', integration, async () => fixture(async f => {
    const repository = createBackgroundRemovalRepository(f.db), source = await sourceImage(f.db, f.alice)
    const submitted = await Promise.allSettled(Array.from({length: 7}, () => enqueue(repository, f.alice, source)))
    assert.equal(submitted.filter(r => r.status === 'fulfilled').length, 5)
    for (const rejected of submitted.filter(r => r.status === 'rejected')) assert.ok(status(429)(rejected.reason))
    for (const existing of [f.bob, f.owner, f.outsider]) {
        const ownSource = await sourceImage(f.db, existing)
        for (let index = 0; index < 5; index++) await enqueue(repository, existing, ownSource)
    }
    const fifth = actor(f.alice.organizationId, 'fifth')
    await f.db.insert(users).values({id: fifth.userId, organizationId: fifth.organizationId, username: fifth.username, normalizedUsername: fifth.username,
        displayName: fifth.displayName, passwordHash: 'unused-local-test-hash', role: 'user'})
    const fifthSource = await sourceImage(f.db, fifth)
    await assert.rejects(enqueue(repository, fifth, fifthSource), status(429))
    const [total] = await f.db.select({value: count()}).from(backgroundRemovalJobs)
    assert.equal(Number(total?.value), 20)
}))

test('claims serialize globally, heartbeat protects live work, and only expired owners can be replaced', integration, async () => fixture(async f => {
    const repository = createBackgroundRemovalRepository(f.db), source = await sourceImage(f.db, f.alice)
    const first = await enqueue(repository, f.alice, source), second = await enqueue(repository, f.alice, source)
    const owners = [randomUUID(), randomUUID(), randomUUID()]
    const claims = await Promise.all(owners.map(owner => repository.claim(owner)))
    const claimed = claims.find(Boolean)!
    assert.equal(claims.filter(Boolean).length, 1)
    const owner = owners[claims.indexOf(claimed)]!
    assert.equal(claimed.attempts, 1)
    assert.equal(await repository.heartbeat(claimed.id, randomUUID()), false)
    assert.equal(await repository.heartbeat(claimed.id, owner), true)
    assert.equal(await repository.claim(randomUUID()), null, 'another process startup must not invalidate a live lease')
    let ran = false
    assert.equal(await repository.complete(claimed.id, randomUUID(), async () => {ran = true; return {outputAssetId: randomUUID(), outputUrl: '/images/test.png'}}), false)
    assert.equal(ran, false)
    await f.db.update(backgroundRemovalJobs).set({leaseExpiresAt: sql`CURRENT_TIMESTAMP - interval '1 second'`}).where(eq(backgroundRemovalJobs.id, claimed.id))
    assert.equal(await repository.heartbeat(claimed.id, owner), false, 'late heartbeat cannot resurrect an expired lease')
    const replacementOwner = randomUUID(), replacement = await repository.claim(replacementOwner)
    assert.equal(replacement?.id, claimed.id)
    assert.equal(replacement?.attempts, 2)
    assert.equal(await repository.fail(claimed.id, owner, {retryable: false}), false)
    await f.db.update(backgroundRemovalJobs).set({leaseExpiresAt: sql`CURRENT_TIMESTAMP - interval '1 second'`}).where(eq(backgroundRemovalJobs.id, claimed.id))
    const next = await repository.claim(randomUUID())
    assert.equal(next?.id, claimed.id === first.id ? second.id : first.id)
    const expired = await repository.get(f.alice, claimed.id)
    assert.equal(expired.status, 'failed')
    assert.equal(expired.error?.code, 'PROCESSING_INTERRUPTED')
}))

test('completion registers and succeeds atomically, preserves successes, and retryable failures stop after two attempts', integration, async () => fixture(async f => {
    const repository = createBackgroundRemovalRepository(f.db), source = await sourceImage(f.db, f.alice)
    const created = await enqueue(repository, f.alice, source), owner = randomUUID()
    assert.equal((await repository.claim(owner))?.id, created.id)
    const invalidId = randomUUID()
    await assert.rejects(repository.complete(created.id, owner, async tx => {
        await tx.insert(assets).values({id: invalidId, organizationId: f.bob.organizationId, ownerUserId: f.bob.userId,
            createdByUserId: f.bob.userId, name: 'bad.png', kind: 'file', category: 'processed', url: '/images/bad.png'})
        return {outputAssetId: invalidId, outputUrl: '/images/bad.png'}
    }))
    assert.equal((await f.db.select().from(assets).where(eq(assets.id, invalidId))).length, 0, 'asset insertion rolls back when ownership validation fails')
    const outputId = randomUUID(), outputUrl = `/images/organizations/${f.alice.organizationId}/users/${f.alice.userId}/processed/${randomUUID()}.png`
    assert.equal(await repository.complete(created.id, owner, async tx => {
        await tx.insert(assets).values({id: outputId, organizationId: f.alice.organizationId, ownerUserId: f.alice.userId,
            createdByUserId: f.alice.userId, name: 'cutout.png', kind: 'file', category: 'processed', url: outputUrl,
            byteSize: 400, mimeType: 'image/png', width: 40, height: 30})
        return {outputAssetId: outputId, outputUrl}
    }), true)
    assert.equal(await repository.fail(created.id, owner, {retryable: true}), false)
    assert.equal(await repository.heartbeat(created.id, owner), false)
    const done = await repository.get(f.alice, created.id)
    assert.equal(done.status, 'succeeded')
    assert.equal(done.outputUrl, outputUrl)
    assert.ok(done.completedAt)
    const second = await enqueue(repository, f.alice, source), secondOwner = randomUUID()
    await repository.claim(secondOwner)
    assert.equal(await repository.fail(second.id, secondOwner, {code: 'MODEL_UNAVAILABLE', retryable: true}), true)
    assert.equal((await repository.get(f.alice, second.id)).status, 'queued')
    const finalOwner = randomUUID()
    assert.equal((await repository.claim(finalOwner))?.attempts, 2)
    assert.equal(await repository.fail(second.id, finalOwner, {code: 'PROCESSING_TIMEOUT', retryable: true}), true)
    const failed = await repository.get(f.alice, second.id)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error?.retryable, false)
    assert.equal(await repository.claim(randomUUID()), null)
}))

test('disabled or changed accounts cannot enqueue and list pagination stays private', integration, async () => fixture(async f => {
    const repository = createBackgroundRemovalRepository(f.db), source = await sourceImage(f.db, f.alice)
    for (let index = 0; index < 3; index++) await enqueue(repository, f.alice, source)
    const page = await repository.list(f.alice, {limit: 2})
    assert.equal(page.length, 2)
    const next = await repository.list(f.alice, {limit: 2, offset: 2})
    assert.equal(next.length, 1)
    assert.ok(page.every(row => row.id !== next[0]!.id))
    await assert.rejects(repository.enqueue({...f.alice, authVersion: 99}, {sourceAssetId: source.id, sourceUrl: source.url,
        model: 'birefnet', modelVersion: 'test-v1', idempotencyKey: randomUUID()}), status(401))
    await f.db.update(users).set({disabledAt: sql`CURRENT_TIMESTAMP`}).where(eq(users.id, f.alice.userId))
    await assert.rejects(enqueue(repository, f.alice, source), status(401))
}))

test('job projections batch live output checks and hide deleted or mismatched private output identities', integration, async () => fixture(async f => {
    const repository = createBackgroundRemovalRepository(f.db), source = await sourceImage(f.db, f.alice), idempotencyKey = randomUUID()
    const job = await enqueue(repository, f.alice, source, {idempotencyKey}), owner = randomUUID()
    await repository.claim(owner)
    const outputId = randomUUID(), outputUrl = `/images/organizations/${f.alice.organizationId}/users/${f.alice.userId}/output/img-1780000000000-${randomUUID()}.png`
    await repository.complete(job.id, owner, async tx => {
        await tx.insert(assets).values({id: outputId, organizationId: f.alice.organizationId, ownerUserId: f.alice.userId,
            createdByUserId: f.alice.userId, name: 'cutout.png', kind: 'file', category: 'processed', url: outputUrl,
            byteSize: 400, mimeType: 'image/png', width: 40, height: 30})
        return {outputAssetId: outputId, outputUrl}
    })
    const live = await repository.get(f.alice, job.id)
    assert.equal(live.outputUrl, outputUrl)
    assert.equal(live.outputExpired, undefined)
    await f.db.update(assets).set({deletedAt: sql`CURRENT_TIMESTAMP`}).where(eq(assets.id, outputId))
    const deleted = await repository.get(f.alice, job.id)
    assert.equal(deleted.status, 'succeeded', 'stored processing history remains intact')
    assert.equal(deleted.outputExpired, true)
    assert.equal(deleted.outputAssetId, null)
    assert.equal(deleted.outputUrl, null)
    f.queries.length = 0
    assert.equal((await repository.list(f.alice))[0]!.outputExpired, true)
    assert.equal(f.queries.length, 2, 'one owner history query and one batched live-output query per page')
    assert.equal((await enqueue(repository, f.alice, source, {idempotencyKey})).outputUrl, null, 'terminal idempotent replies use the same safe projection')
    const [persisted] = await f.db.select().from(backgroundRemovalJobs).where(eq(backgroundRemovalJobs.id, job.id))
    assert.equal(persisted!.outputUrl, outputUrl, 'projection never mutates original job metadata')
    const foreign = await sourceImage(f.db, f.bob, 'processed')
    await f.db.update(backgroundRemovalJobs).set({outputAssetId: foreign.id, outputUrl: foreign.url}).where(eq(backgroundRemovalJobs.id, job.id))
    const mismatch = await repository.get(f.alice, job.id)
    assert.equal(mismatch.outputExpired, true)
    assert.equal(mismatch.outputUrl, null, 'an inconsistent row cannot reveal another owner output URL')
    await assert.rejects(repository.get(f.bob, job.id), status(404))
}))
