import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {Pool} from 'pg'
import sharp from 'sharp'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {eq} from 'drizzle-orm'
import {DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand} from '@aws-sdk/client-s3'
import {organizations, users, assets} from '../server/db/schema.ts'
import {createAssetRepository, type AssetActor} from '../server/utils/assetAccess.ts'
import {createBackgroundRemovalRepository} from '../server/utils/backgroundRemovalJobs.ts'
import {createBackgroundRemovalRunner} from '../server/utils/backgroundRemovalRunner.ts'
import {useUserFS} from '../server/utils/useUserFS.ts'
import {createS3ImageStorage, type ImageStorageCommand} from '../server/utils/useFS.ts'
import {getBackgroundRemovalModel} from '../schemas/background-removal-models.ts'

const integration = {skip: !process.env.TEST_DATABASE_URL, timeout: 60_000}
async function fixture(work: (f: {db: ReturnType<typeof drizzle>; a: AssetActor; b: AssetActor;
    raw: ReturnType<typeof createS3ImageStorage>; objects: Map<string, Buffer>; bytes: Buffer}) => Promise<void>) {
    const schema = `cutout_runner_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({connectionString: process.env.TEST_DATABASE_URL!, max: 1})
    const pool = new Pool({connectionString: process.env.TEST_DATABASE_URL!, max: 3, options: `-c search_path=${schema} -c timezone=UTC`})
    try {
        await admin.query(`CREATE SCHEMA "${schema}"`)
        const db = drizzle({client: pool})
        await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle/postgres', import.meta.url)), migrationsSchema: schema})
        const org = randomUUID()
        const a: AssetActor = {organizationId: org, userId: randomUUID(), username: 'a', displayName: 'A', role: 'owner'}
        const b: AssetActor = {...a, userId: randomUUID(), username: 'b', displayName: 'B', role: 'user'}
        await db.insert(organizations).values({id: org, name: 'Local test'})
        await db.insert(users).values([a, b].map(actor => ({id: actor.userId, organizationId: org,
            username: actor.username, normalizedUsername: actor.username, displayName: actor.displayName, role: actor.role, passwordHash: 'unused-test'})))
        const objects = new Map<string, Buffer>()
        const raw = createS3ImageStorage({bucket: 'local-test', prefix: 'images', client: {async send(command: ImageStorageCommand) {
            const missing = () => Object.assign(new Error('private storage diagnostic'), {name: 'NoSuchKey', $metadata: {httpStatusCode: 404}})
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
        await work({db, a, b, raw, objects, bytes})
    } finally {
        await pool.end()
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await admin.end()
    }
}
const upload = (data: Buffer) => ({name: 'files' as const, filename: 'product.png', type: 'image/png', data})

test('CPU cutouts publish atomically into recipient-owned library and preserve shared original bytes', integration, async () => fixture(async f => {
    const aFS = await useUserFS(f.a, f.raw, f.db)
    const bFS = await useUserFS(f.b, f.raw, f.db)
    const original = await aFS.saveUpload('/', upload(f.bytes))
    await aFS.share(original.id!, f.b.userId, 'view')
    const repo = createBackgroundRemovalRepository(f.db)
    const job = await repo.enqueue(f.b, {sourceAssetId: original.id!, sourceUrl: original.url, model: 'birefnet-lite',
        modelVersion: getBackgroundRemovalModel('birefnet-lite').version, idempotencyKey: randomUUID()})
    let calls = 0
    const runner = createBackgroundRemovalRunner({repository: repo, actor: async () => f.b,
        storage: async () => bFS, infer: async input => {
            calls++
            assert.deepEqual(input.buffer, f.bytes)
            assert.equal((await bFS.listAssets()).files.length, 0)
            return {buffer: f.bytes, mimeType: 'image/png', byteSize: f.bytes.length, width: 8, height: 6,
                modelVersion: getBackgroundRemovalModel(input.model).version}
        }})
    await Promise.all([runner.kick(), runner.kick(), runner.kick()])
    await runner.close()
    assert.equal(calls, 1)
    const done = await repo.get(f.b, job.id)
    assert.equal(done.status, 'succeeded')
    assert.equal(done.providerPriceUsd, '0')
    const output = await bFS.assetByUrl(done.outputUrl!)
    assert.equal(output.category, 'processed')
    assert.equal(output.ownerUserId, f.b.userId)
    assert.equal(output.priceUsd, '0')
    assert.equal(output.priceSource, 'local-processing')
    assert.deepEqual((await aFS.getImageFile(original.url)).buffer, f.bytes)
    assert.deepEqual((await bFS.getImageFile(done.outputUrl!)).buffer, f.bytes)
    await assert.rejects(aFS.getImageFile(done.outputUrl!), (error: {statusCode?: number}) => error.statusCode === 404)
    const folders = (await bFS.listAssets({direct: true})).dirs!
    assert.equal(folders[0]!.name, 'Cutouts')
    assert.equal(folders[0]!.itemCount, 1)
}))

test('revoking a shared source during inference prevents output registration and storage', integration, async () => fixture(async f => {
    const aFS = await useUserFS(f.a, f.raw, f.db), bFS = await useUserFS(f.b, f.raw, f.db)
    const original = await aFS.saveUpload('/', upload(f.bytes))
    await aFS.share(original.id!, f.b.userId, 'view')
    const repo = createBackgroundRemovalRepository(f.db)
    const job = await repo.enqueue(f.b, {sourceAssetId: original.id!, sourceUrl: original.url, model: 'birefnet-lite',
        modelVersion: getBackgroundRemovalModel('birefnet-lite').version, idempotencyKey: randomUUID()})
    const before = [...f.objects.keys()]
    const runner = createBackgroundRemovalRunner({repository: repo, actor: async () => f.b, storage: async () => bFS,
        infer: async () => {
            await aFS.revoke(original.id!, f.b.userId)
            return {buffer: f.bytes, mimeType: 'image/png', byteSize: f.bytes.length, width: 8, height: 6, modelVersion: job.modelVersion}
        }})
    await runner.kick()
    await runner.close()
    const done = await repo.get(f.b, job.id)
    assert.equal(done.status, 'failed')
    assert.equal(done.error!.code, 'SOURCE_UNAVAILABLE')
    assert.equal(done.outputUrl, null)
    assert.deepEqual([...f.objects.keys()], before)
}))

test('staged cutout is invisible before commit and is removed when atomic publication fails', integration, async () => fixture(async f => {
    const storage = await useUserFS(f.a, f.raw, f.db)
    const original = await storage.saveUpload('/', upload(f.bytes))
    const staged = await storage.prepareProcessedImage(f.bytes)
    await assert.rejects(storage.getImageFile(staged.url), (error: {statusCode?: number}) => error.statusCode === 404)
    await f.db.update(assets).set({deletedAt: new Date().toISOString()}).where(eq(assets.id, original.id!))
    await assert.rejects(f.db.transaction(tx => staged.register(tx, {id: original.id!, url: original.url})))
    await staged.discard()
    assert.equal([...f.objects.keys()].some(key => key.endsWith(staged.url.split('/').at(-1)!)), false)
    assert.equal((await createAssetRepository(f.a, f.db).list()).files.length, 0)
}))

test('insufficient native memory produces one terminal safe job error without storing an output', integration, async () => fixture(async f => {
    const storage = await useUserFS(f.a, f.raw, f.db)
    const original = await storage.saveUpload('/', upload(f.bytes))
    const repo = createBackgroundRemovalRepository(f.db)
    const job = await repo.enqueue(f.a, {sourceAssetId: original.id!, sourceUrl: original.url, model: 'birefnet',
        modelVersion: getBackgroundRemovalModel('birefnet').version, idempotencyKey: randomUUID()})
    const before = [...f.objects.keys()]
    let calls = 0
    const runner = createBackgroundRemovalRunner({repository: repo, actor: async () => f.a, storage: async () => storage,
        infer: async () => {calls++; throw {code: 'INSUFFICIENT_MEMORY', retryable: false, message: 'native private diagnostic'}}})
    await runner.kick()
    await runner.close()
    const failed = await repo.get(f.a, job.id)
    assert.equal(calls, 1)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error!.code, 'INSUFFICIENT_MEMORY')
    assert.equal(failed.error!.retryable, false)
    assert.doesNotMatch(failed.error!.message, /private diagnostic/)
    assert.equal(failed.outputUrl, null)
    assert.deepEqual([...f.objects.keys()], before)
}))
