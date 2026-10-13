import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {Pool} from 'pg'
import sharp from 'sharp'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {eq, sql} from 'drizzle-orm'
import {createError} from 'h3'
import {DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand} from '@aws-sdk/client-s3'
import {organizations, users, assets, assetShares, backgroundRemovalJobs} from '../server/db/schema.ts'
import {type AssetActor} from '../server/utils/assetAccess.ts'
import {createBackgroundRemovalRepository} from '../server/utils/backgroundRemovalJobs.ts'
import {createBackgroundRemovalRunner} from '../server/utils/backgroundRemovalRunner.ts'
import {useUserFS} from '../server/utils/useUserFS.ts'
import {createS3ImageStorage, type ImageStorageCommand} from '../server/utils/useFS.ts'
import {getBackgroundRemovalModel} from '../schemas/background-removal-models.ts'

const integration = {skip: !process.env.TEST_DATABASE_URL, timeout: 60_000}
const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>(done => {resolve = done})
    return {promise, resolve}
}
async function fixture(work: (f: {db: ReturnType<typeof drizzle>; pool: Pool; application: string; a: AssetActor; b: AssetActor;
    raw: ReturnType<typeof createS3ImageStorage>; objects: Map<string, Buffer>; bytes: Buffer}) => Promise<void>) {
    const schema = `cutout_publication_${randomUUID().replaceAll('-', '')}`
    const application = 'publication-' + randomUUID()
    const admin = new Pool({connectionString: process.env.TEST_DATABASE_URL!, max: 1})
    const pool = new Pool({connectionString: process.env.TEST_DATABASE_URL!, max: 4,
        options: `-c search_path=${schema} -c timezone=UTC -c application_name=${application}`})
    try {
        await admin.query(`CREATE SCHEMA "${schema}"`)
        const db = drizzle({client: pool})
        await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle/postgres', import.meta.url)), migrationsSchema: schema})
        const org = randomUUID()
        const a: AssetActor = {organizationId: org, userId: randomUUID(), username: 'a', displayName: 'A', role: 'owner'}
        const b: AssetActor = {...a, userId: randomUUID(), username: 'b', displayName: 'B', role: 'user'}
        await db.insert(organizations).values({id: org, name: 'Local publication test'})
        await db.insert(users).values([a, b].map(actor => ({id: actor.userId, organizationId: org,
            username: actor.username, normalizedUsername: actor.username, displayName: actor.displayName, role: actor.role, passwordHash: 'unused-test'})))
        const objects = new Map<string, Buffer>()
        const raw = createS3ImageStorage({bucket: 'local-test', prefix: 'images', client: {async send(command: ImageStorageCommand) {
            const missing = () => Object.assign(new Error('private diagnostic'), {name: 'NoSuchKey', $metadata: {httpStatusCode: 404}})
            if (command instanceof PutObjectCommand) {
                if (objects.has(command.input.Key!)) throw Object.assign(new Error('private conflict'), {name: 'PreconditionFailed', $metadata: {httpStatusCode: 412}})
                objects.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array)); return {}
            }
            if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
                const bytes = objects.get(command.input.Key!)
                if (!bytes) throw missing()
                return command instanceof HeadObjectCommand ? {ContentLength: bytes.length} : {Body: Readable.from([bytes]), ContentLength: bytes.length}
            }
            if (command instanceof DeleteObjectCommand) {objects.delete(command.input.Key!); return {}}
            return {Contents: [], CommonPrefixes: [], IsTruncated: false}
        }}})
        const bytes = await sharp({create: {width: 8, height: 6, channels: 4, background: {r: 50, g: 120, b: 60, alpha: 0.5}}}).png().toBuffer()
        await work({db, pool, application, a, b, raw, objects, bytes})
    } finally {
        await pool.end()
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await admin.end()
    }
}
const upload = (data: Buffer) => ({name: 'files' as const, filename: 'product.png', type: 'image/png', data})
const modelVersion = getBackgroundRemovalModel('birefnet-lite').version
async function enqueue(repo: ReturnType<typeof createBackgroundRemovalRepository>, actor: AssetActor, source: {id?: string; url: string}, version = modelVersion) {
    return repo.enqueue(actor, {sourceAssetId: source.id!, sourceUrl: source.url, model: 'birefnet-lite', modelVersion: version, idempotencyKey: randomUUID()})
}
async function waitForLock(pool: Pool, application: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const result = await pool.query<{blocked: boolean}>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid() AND wait_event_type = 'Lock') AS blocked", [application])
        if (result.rows[0]?.blocked) return
        await new Promise(done => setTimeout(done, 10))
    }
    throw new Error('Expected source mutation to wait for publication locks')
}

test('pipeline processed registration keeps decoded formats, private ownership and source-grant checks', integration, async () => fixture(async f => {
    const aFS = await useUserFS(f.a, f.raw, f.db), bFS = await useUserFS(f.b, f.raw, f.db)
    const source = await aFS.saveUpload('/', upload(f.bytes))
    await aFS.share(source.id!, f.b.userId, 'view')
    const jpeg = await sharp(f.bytes).flatten({background: '#ffffff'}).jpeg({quality: 90}).toBuffer()
    const staged = await bFS.prepareProcessedImage(jpeg, {purpose: 'pipeline', mimeType: 'image/jpeg'})
    const output = await f.db.transaction(tx => staged.register(tx, {id: source.id!, url: source.url}))
    const registered = await bFS.assetByUrl(output.outputUrl)
    const [record] = await f.db.select().from(assets).where(eq(assets.id, output.outputAssetId))
    assert.equal(registered.category, 'processed')
    assert.equal(record!.mimeType, 'image/jpeg')
    assert.equal(registered.source!.userId, f.b.userId)
    assert.equal(registered.name.endsWith('.jpg'), true)
    const [folder] = await f.db.select().from(assets).where(eq(assets.id, record!.parentId!))
    assert.equal(folder!.name, 'Pipeline results')
    assert.equal(folder!.category, 'processed')
    await assert.rejects(aFS.getImageFile(output.outputUrl), error => (error as {statusCode?: number}).statusCode === 404,
        'sharing a source does not share the recipient-owned derivative back to its owner')
    assert.deepEqual((await bFS.getImageFile(output.outputUrl)).buffer, jpeg)
    assert.equal((await aFS.assetByUrl(source.url)).category, 'uploaded')

    const revoked = await bFS.prepareProcessedImage(f.bytes, {purpose: 'pipeline', name: 'Safe output.png'})
    await aFS.revoke(source.id!, f.b.userId)
    await assert.rejects(f.db.transaction(tx => revoked.register(tx, {id: source.id!, url: source.url})),
        error => (error as {statusCode?: number}).statusCode === 404)
    await revoked.discard()
    assert.equal(f.objects.has(revoked.url.slice(1)), false)
    assert.deepEqual((await aFS.getImageFile(source.url)).buffer, f.bytes)
    const beforeMismatch = f.objects.size
    await assert.rejects(bFS.prepareProcessedImage(jpeg, {purpose: 'pipeline', mimeType: 'image/png'}),
        error => (error as {statusCode?: number}).statusCode === 415)
    assert.equal(f.objects.size, beforeMismatch, 'a misdeclared staged image removes only its new immutable object')
    await assert.rejects(bFS.prepareProcessedImage(f.bytes, {purpose: 'pipeline', name: '../private.png'}),
        error => (error as {statusCode?: number}).statusCode === 400)
}))

test('atomic publication holds shared grants until commit so a concurrent revoke serializes after success', integration, async () => fixture(async f => {
    const aFS = await useUserFS(f.a, f.raw, f.db), bFS = await useUserFS(f.b, f.raw, f.db)
    const source = await aFS.saveUpload('/', upload(f.bytes))
    await aFS.share(source.id!, f.b.userId, 'view')
    const repo = createBackgroundRemovalRepository(f.db), job = await enqueue(repo, f.b, source), owner = randomUUID()
    await repo.claim(owner)
    const staged = await bFS.prepareProcessedImage(f.bytes), registered = deferred(), release = deferred()
    const completing = repo.complete(job.id, owner, async tx => {
        const output = await staged.register(tx, {id: source.id!, url: source.url})
        registered.resolve()
        await release.promise
        return output
    })
    await registered.promise
    let revoked = false
    const revoking = aFS.revoke(source.id!, f.b.userId).then(() => {revoked = true})
    try {
        await waitForLock(f.pool, f.application)
        assert.equal(revoked, false)
        assert.equal((await f.db.select().from(assetShares)).length, 1)
    } finally {release.resolve()}
    assert.equal(await completing, true)
    await revoking
    assert.equal(revoked, true)
    const done = await repo.get(f.b, job.id)
    assert.equal(done.status, 'succeeded')
    assert.deepEqual((await bFS.getImageFile(done.outputUrl!)).buffer, f.bytes)
    await assert.rejects(bFS.getImageFile(source.url), (e: {statusCode?: number}) => e.statusCode === 404)
}))

test('publication holds inherited source ancestry until commit before concurrent sender subtree deletion', integration, async () => fixture(async f => {
    const aFS = await useUserFS(f.a, f.raw, f.db), bFS = await useUserFS(f.b, f.raw, f.db)
    const folder = await aFS.createFolder('/', 'Products'), source = await aFS.saveUpload('/Products', upload(f.bytes))
    await aFS.share(folder.id!, f.b.userId, 'view')
    const repo = createBackgroundRemovalRepository(f.db), job = await enqueue(repo, f.b, source), owner = randomUUID()
    await repo.claim(owner)
    const staged = await bFS.prepareProcessedImage(f.bytes), registered = deferred(), release = deferred()
    const completing = repo.complete(job.id, owner, async tx => {
        const output = await staged.register(tx, {id: source.id!, url: source.url})
        registered.resolve(); await release.promise; return output
    })
    await registered.promise
    let deleted = false
    const deletion = aFS.deleteFileOrFolder(folder.url, 'directory').then(() => {deleted = true})
    try {
        await waitForLock(f.pool, f.application)
        assert.equal(deleted, false)
        assert.equal((await f.db.select().from(assets).where(eq(assets.id, source.id!)))[0]!.deletedAt, null)
    } finally {release.resolve()}
    assert.equal(await completing, true)
    await deletion
    const done = await repo.get(f.b, job.id)
    assert.equal(done.status, 'succeeded')
    assert.deepEqual((await bFS.getImageFile(done.outputUrl!)).buffer, f.bytes)
    await assert.rejects(bFS.getImageFile(source.url), (e: {statusCode?: number}) => e.statusCode === 404)
}))

test('a lost lease after staging discards the exact cutout and never publishes under expired ownership', integration, async () => fixture(async f => {
    const storage = await useUserFS(f.a, f.raw, f.db), source = await storage.saveUpload('/', upload(f.bytes))
    const repo = createBackgroundRemovalRepository(f.db), job = await enqueue(repo, f.a, source)
    let output: string | undefined
    const wrapped = {...storage, prepareProcessedImage: async (bytes: Buffer) => {
        const staged = await storage.prepareProcessedImage(bytes)
        output = staged.url
        await f.db.update(backgroundRemovalJobs).set({leaseExpiresAt: sql`CURRENT_TIMESTAMP - interval '1 second'`}).where(eq(backgroundRemovalJobs.id, job.id))
        return staged
    }}
    let calls = 0
    const runner = createBackgroundRemovalRunner({repository: repo, actor: async () => f.a, storage: async () => wrapped,
        infer: async () => {calls++; return {buffer: f.bytes, mimeType: 'image/png', byteSize: f.bytes.length, width: 8, height: 6, modelVersion}}})
    await runner.kick(); await runner.close()
    assert.equal(calls, 2)
    assert.equal((await repo.get(f.a, job.id)).status, 'failed')
    assert.ok(output)
    assert.equal([...f.objects.keys()].some(key => key.endsWith(output!.split('/').at(-1)!)), false)
    assert.equal((await storage.listAssets()).files.some(image => image.category === 'processed'), false)
}))

test('unsupported stored checkpoint fails without running inference or substituting current weights', integration, async () => fixture(async f => {
    const storage = await useUserFS(f.a, f.raw, f.db), source = await storage.saveUpload('/', upload(f.bytes))
    const repo = createBackgroundRemovalRepository(f.db), job = await enqueue(repo, f.a, source, 'old-checkpoint-version')
    const runner = createBackgroundRemovalRunner({repository: repo, actor: async () => f.a, storage: async () => storage,
        infer: async () => {throw new Error('Inference must not run for a different checkpoint')}})
    await runner.kick(); await runner.close()
    const failed = await repo.get(f.a, job.id)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.attempts, 1)
    assert.equal(failed.error?.code, 'MODEL_UNAVAILABLE')
    assert.equal(failed.error?.retryable, false)
}))

test('disabled accounts after inference cannot stage or publish and native timeout remains safely retryable', integration, async () => fixture(async f => {
    const storage = await useUserFS(f.a, f.raw, f.db), source = await storage.saveUpload('/', upload(f.bytes))
    const repo = createBackgroundRemovalRepository(f.db), job = await enqueue(repo, f.a, source)
    const before = [...f.objects.keys()]
    const actor = async () => {
        const [account] = await f.db.select({disabledAt: users.disabledAt}).from(users).where(eq(users.id, f.a.userId))
        if (account?.disabledAt) throw createError({statusCode: 401, statusMessage: 'Unauthorized'})
        return f.a
    }
    const runner = createBackgroundRemovalRunner({repository: repo, actor, storage: async () => storage,
        infer: async () => {
            await f.db.update(users).set({disabledAt: sql`CURRENT_TIMESTAMP`}).where(eq(users.id, f.a.userId))
            return {buffer: f.bytes, mimeType: 'image/png', byteSize: f.bytes.length, width: 8, height: 6, modelVersion}
        }})
    await runner.kick(); await runner.close()
    const failed = await repo.get(f.a, job.id)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error?.code, 'SOURCE_UNAVAILABLE')
    assert.deepEqual([...f.objects.keys()], before)
    await f.db.update(users).set({disabledAt: null}).where(eq(users.id, f.a.userId))
    const timeoutJob = await enqueue(repo, f.a, source)
    const timing = createBackgroundRemovalRunner({repository: repo, actor, storage: async () => storage,
        infer: async () => {throw {code: 'TIMED_OUT', retryable: true, message: 'secret-native-path'}}})
    await timing.kick(); await timing.close()
    const timeout = await repo.get(f.a, timeoutJob.id)
    assert.equal(timeout.attempts, 2)
    assert.equal(timeout.error?.code, 'PROCESSING_TIMEOUT')
    assert.ok(!timeout.error?.message.includes('secret-native-path'))
}))
