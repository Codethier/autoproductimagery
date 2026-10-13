import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {Pool} from 'pg'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {eq, sql} from 'drizzle-orm'
import {assets, assetShares, backgroundRemovalJobs, organizations, users} from '../server/db/schema.ts'
import {getDatabasePoolConfig} from '../server/utils/lib/db.ts'
import {isManagedProcessedOutput, PROCESSED_IMAGE_RETENTION_LOCK, runProcessedImageRetention} from '../server/utils/processedImageRetention.ts'

const NOW = new Date('2026-10-13T12:00:00.000Z')
const age = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString()
const integration = {skip: !process.env.TEST_DATABASE_URL, timeout: 60_000}
type Database = ReturnType<typeof drizzle>
type Actor = {organizationId: string; userId: string}
const output = (actor: Actor) => `/images/organizations/${actor.organizationId}/users/${actor.userId}/output/img-1780000000000-${randomUUID()}.png`
async function fixture(work: (f: {db: Database; pool: Pool; alice: Actor; bob: Actor; outsider: Actor; sourceId: string; sourceUrl: string}) => Promise<void>, migrated = true) {
    const connectionString = process.env.TEST_DATABASE_URL!
    const schema = `imagery_processed_retention_${randomUUID().replaceAll('-', '')}`
    const administrator = new Pool({connectionString, max: 1})
    const pool = new Pool({...getDatabasePoolConfig({DATABASE_URL: connectionString}), options: `-c search_path=${schema} -c timezone=UTC`})
    try {
        await administrator.query(`CREATE SCHEMA "${schema}"`)
        const db = drizzle({client: pool})
        if (migrated) await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle/postgres', import.meta.url)), migrationsSchema: schema})
        const org = randomUUID(), other = randomUUID()
        const alice = {organizationId: org, userId: randomUUID()}, bob = {organizationId: org, userId: randomUUID()}, outsider = {organizationId: other, userId: randomUUID()}
        const sourceId = randomUUID(), sourceUrl = `/images/organizations/${org}/users/${alice.userId}/objects/${randomUUID()}/product.png`
        if (migrated) {
            await db.insert(organizations).values([{id: org, name: 'Studio'}, {id: other, name: 'Other studio'}])
            await db.insert(users).values([alice, bob, outsider].map((actor, i) => ({id: actor.userId, organizationId: actor.organizationId,
                username: `user${i}`, normalizedUsername: `user${i}`, displayName: `User ${i}`, passwordHash: 'unused-local-test-hash', role: 'user' as const})))
            await db.insert(assets).values({id: sourceId, organizationId: org, ownerUserId: alice.userId, createdByUserId: alice.userId,
                name: 'product.png', kind: 'file', category: 'uploaded', url: sourceUrl, createdAt: age(300)})
        }
        await work({db, pool, alice, bob, outsider, sourceId, sourceUrl})
    } finally {
        await pool.end()
        await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await administrator.end()
    }
}
async function cutout(f: {db: Database; alice: Actor; sourceId: string; sourceUrl: string}, overrides: {
    name?: string; assetAge?: number; completedAge?: number; category?: 'uploaded' | 'generated' | 'processed'; url?: string;
    actor?: Actor; jobActor?: Actor; deleted?: boolean
} = {}) {
    const actor = overrides.actor ?? f.alice, jobActor = overrides.jobActor ?? actor
    const [asset] = await f.db.insert(assets).values({id: randomUUID(), organizationId: actor.organizationId,
        ownerUserId: actor.userId, createdByUserId: actor.userId, name: overrides.name ?? 'cutout.png', kind: 'file',
        category: overrides.category ?? 'processed', url: overrides.url ?? output(actor), byteSize: 200, mimeType: 'image/png', width: 40, height: 30,
        createdAt: age(overrides.assetAge ?? 181), ...(overrides.deleted ? {deletedAt: age(1)} : {})}).returning()
    const [job] = await f.db.insert(backgroundRemovalJobs).values({id: randomUUID(), organizationId: jobActor.organizationId, userId: jobActor.userId,
        sourceAssetId: f.sourceId, sourceUrl: f.sourceUrl, model: 'birefnet-lite', modelVersion: 'local-test-pinned-v1', status: 'succeeded',
        idempotencyKey: randomUUID(), attempts: 1, outputAssetId: asset!.id, outputUrl: asset!.url, createdAt: age(200),
        startedAt: age(overrides.completedAge ?? 181), completedAt: age(overrides.completedAge ?? 181)}).returning()
    return {asset: asset!, job: job!}
}

test('processed retention accepts only the job owner canonical immutable output namespace', () => {
    const actor = {organizationId: randomUUID(), userId: randomUUID()}, path = output(actor)
    assert.equal(isManagedProcessedOutput(path, actor.organizationId, actor.userId), true)
    for (const value of [path + '?x=1', path + '/', path.replace('/output/', '/objects/'), path.replace('img-', '%69mg-'), '/images/output/img-1780000000000-' + randomUUID() + '.png']) {
        assert.equal(isManagedProcessedOutput(value, actor.organizationId, actor.userId), false)
    }
    assert.equal(isManagedProcessedOutput(path, randomUUID(), actor.userId), false)
    assert.equal(isManagedProcessedOutput(path, actor.organizationId, randomUUID()), false)
})

test('disabled processed retention does not connect or touch S3 and invalid settings fail closed', async () => {
    const pool = {connect: async () => {throw new Error('Must not connect')}}
    const storage = {removeGeneratedImage: async () => {throw new Error('Must not delete')}}
    const result = await runProcessedImageRetention({pool, storage, retentionDays: 0})
    assert.equal(result.status, 'disabled')
    assert.equal(result.cutoff, null)
    assert.equal(result.deleted, 0)
    for (const retentionDays of [-1, 0.5, NaN, 36501]) await assert.rejects(runProcessedImageRetention({pool, storage, retentionDays}))
    await assert.rejects(runProcessedImageRetention({pool, storage, retentionDays: 180, now: new Date(NaN)}))
    await assert.rejects(runProcessedImageRetention({pool, storage, retentionDays: 180, maxRows: 0}))
})

test('processed retention safely skips a pre-migration schema without touching S3', integration, async () => fixture(async f => {
    let deleted = false
    const result = await runProcessedImageRetention({pool: f.pool, storage: {removeGeneratedImage: async () => {deleted = true}}, retentionDays: 180, now: NOW})
    assert.equal(result.status, 'schema_missing')
    assert.equal(deleted, false)
}, false))

test('daily cleanup expires only old completed processed outputs and preserves job/source metadata', integration, async () => fixture(async f => {
    const old = await cutout(f)
    const boundary = await cutout(f, {assetAge: 180, completedAge: 180})
    const recent = await cutout(f, {assetAge: 1, completedAge: 1})
    const freshCompletion = await cutout(f, {assetAge: 200, completedAge: 1})
    const freshAsset = await cutout(f, {assetAge: 1, completedAge: 200})
    const uploaded = await cutout(f, {category: 'uploaded'})
    const generated = await cutout(f, {category: 'generated'})
    const mismatchedOwner = await cutout(f, {jobActor: f.bob})
    const mismatchedOrg = await cutout(f, {jobActor: f.outsider})
    const invalid = await cutout(f, {url: '/images/output/img-1780000000000-' + randomUUID() + '.png'})
    const wrongNamespace = await cutout(f, {url: output(f.bob)})
    const deleted = await cutout(f, {deleted: true})
    await f.db.insert(assetShares).values({id: randomUUID(), assetId: old.asset.id, organizationId: f.alice.organizationId,
        sharedByUserId: f.alice.userId, recipientUserId: f.bob.userId, permission: 'view'})
    const removed: string[] = [], storage = {removeGeneratedImage: async (url: string) => {removed.push(url)}}
    const dry = await runProcessedImageRetention({pool: f.pool, storage, retentionDays: 180, now: NOW, dryRun: true})
    assert.equal(dry.wouldDelete, 1)
    assert.equal(dry.skippedInvalid, 2)
    assert.deepEqual(removed, [])
    const result = await runProcessedImageRetention({pool: f.pool, storage, retentionDays: 180, now: NOW})
    assert.equal(result.deleted, 1)
    assert.equal(result.failed, 0)
    assert.deepEqual(removed, [old.asset.url])
    const [preserved] = await f.db.select().from(backgroundRemovalJobs).where(eq(backgroundRemovalJobs.id, old.job.id))
    assert.deepEqual(preserved, old.job, 'retention never erases or changes processing history')
    const [expired] = await f.db.select().from(assets).where(eq(assets.id, old.asset.id))
    assert.equal(new Date(expired!.deletedAt!).toISOString(), NOW.toISOString())
    for (const retained of [boundary, recent, freshCompletion, freshAsset, uploaded, generated, mismatchedOwner, mismatchedOrg, invalid, wrongNamespace]) {
        const [row] = await f.db.select().from(assets).where(eq(assets.id, retained.asset.id))
        assert.equal(row!.deletedAt, null)
    }
    assert.equal((await f.db.select().from(assets).where(eq(assets.id, f.sourceId)))[0]!.deletedAt, null)
    assert.ok((await f.db.select().from(assets).where(eq(assets.id, deleted.asset.id)))[0]!.deletedAt)
    assert.equal((await runProcessedImageRetention({pool: f.pool, storage, retentionDays: 180, now: NOW})).deleted, 0)
    assert.ok(!JSON.stringify(result).includes(old.asset.url))
}))

test('S3 failures and a crash after deletion remain retryable; missing objects tombstone safely', integration, async () => fixture(async f => {
    const missing = await cutout(f, {name: 'missing.png'}), rejectS3 = await cutout(f, {name: 'reject-s3.png'}), rejectMarker = await cutout(f, {name: 'reject-marker.png'})
    await f.pool.query(`CREATE FUNCTION reject_processed_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'reject-marker.png' AND NEW.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'synthetic confidential driver detail'; END IF; RETURN NEW; END $$`)
    await f.pool.query('CREATE TRIGGER reject_processed_marker BEFORE UPDATE ON asset FOR EACH ROW EXECUTE FUNCTION reject_processed_marker()')
    const objects = new Set([rejectS3.asset.url, rejectMarker.asset.url]), attempts: string[] = []
    let failS3 = true
    const storage = {removeGeneratedImage: async (url: string) => {
        attempts.push(url)
        if (url === rejectS3.asset.url && failS3) throw new Error('secret access key must never be logged')
        objects.delete(url)
    }}
    const first = await runProcessedImageRetention({pool: f.pool, storage, retentionDays: 180, now: NOW})
    assert.equal(first.deleted, 1)
    assert.equal(first.failed, 2)
    assert.equal(objects.has(rejectMarker.asset.url), false)
    assert.equal((await f.db.select().from(assets).where(eq(assets.id, rejectMarker.asset.id)))[0]!.deletedAt, null)
    assert.ok((await f.db.select().from(assets).where(eq(assets.id, missing.asset.id)))[0]!.deletedAt)
    failS3 = false
    await f.pool.query('DROP TRIGGER reject_processed_marker ON asset')
    const second = await runProcessedImageRetention({pool: f.pool, storage, retentionDays: 180, now: NOW})
    assert.equal(second.deleted, 2)
    assert.equal(second.failed, 0)
    assert.equal(attempts.filter(url => url === rejectMarker.asset.url).length, 2)
    assert.equal(objects.size, 0)
    assert.equal((await runProcessedImageRetention({pool: f.pool, storage, retentionDays: 180, now: NOW})).deleted, 0)
}))

test('recent duplicate history protects an object and row bounds preserve unfinished work for later runs', integration, async () => fixture(async f => {
    const protectedOutput = await cutout(f)
    await f.db.insert(backgroundRemovalJobs).values({...protectedOutput.job, id: randomUUID(), idempotencyKey: randomUUID(), completedAt: age(1)})
    const removed: string[] = [], storage = {removeGeneratedImage: async (url: string) => {removed.push(url)}}
    assert.equal((await runProcessedImageRetention({pool: f.pool, storage, retentionDays: 180, now: NOW})).deleted, 0)
    for (let index = 0; index < 3; index++) await cutout(f)
    const bounded = await runProcessedImageRetention({pool: f.pool, storage, retentionDays: 180, now: NOW, maxRows: 1})
    assert.equal(bounded.status, 'bounded')
    assert.equal(bounded.deleted, 1)
    assert.equal((await runProcessedImageRetention({pool: f.pool, storage, retentionDays: 180, now: NOW})).deleted, 2)
    assert.equal(removed.includes(protectedOutput.asset.url), false)
}))

test('another cleanup session holds the exact advisory lock and skips all deletion', integration, async () => fixture(async f => {
    await cutout(f)
    const held = await f.pool.connect()
    try {
        await held.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [...PROCESSED_IMAGE_RETENTION_LOCK])
        const result = await runProcessedImageRetention({pool: f.pool, storage: {removeGeneratedImage: async () => {throw new Error('Must not delete')}}, retentionDays: 180, now: NOW})
        assert.equal(result.status, 'already_running')
        assert.equal(result.scanned, 0)
    } finally {
        await held.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [...PROCESSED_IMAGE_RETENTION_LOCK])
        held.release()
    }
}))
