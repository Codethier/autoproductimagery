import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import sharp from 'sharp'
import {Pool} from 'pg'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {eq} from 'drizzle-orm'
import {DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand} from '@aws-sdk/client-s3'
import {assets, assetShares, organizations, users} from '../server/db/schema.ts'
import {createAssetRepository, canonicalAssetUrl, decodeAssetCursor, encodeAssetCursor, assetCursorScope, type AssetActor} from '../server/utils/assetAccess.ts'
import {createS3ImageStorage, type ImageStorageCommand} from '../server/utils/useFS.ts'
import {useUserFS} from '../server/utils/useUserFS.ts'
import {getDatabasePoolConfig} from '../server/utils/lib/db.ts'
import {adoptLegacyAssets} from '../scripts/lib/legacyAssetAdoption.ts'
import {ShareAssetSchema} from '../schemas/image-storage.ts'

const integration = {skip: !process.env.TEST_DATABASE_URL, timeout: 60_000}
const status = (code: number) => (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === code)
const actor = (organizationId: string, username: string, role: 'owner' | 'user' = 'user'): AssetActor => ({organizationId, userId: randomUUID(), username, displayName: username, role})

class MemoryS3 {
    readonly objects = new Map<string, Buffer>()
    readonly commands: ImageStorageCommand[] = []
    failDelete = false
    beforeDelete?: () => Promise<void>
    async send(command: ImageStorageCommand): Promise<unknown> {
        this.commands.push(command)
        const missing = () => Object.assign(new Error('secret driver details'), {name: 'NoSuchKey', $metadata: {httpStatusCode: 404}})
        if (command instanceof PutObjectCommand) {
            if (this.objects.has(command.input.Key!)) throw Object.assign(new Error('conflict'), {name: 'PreconditionFailed', $metadata: {httpStatusCode: 412}})
            this.objects.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array)); return {}
        }
        if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand) {
            const body = this.objects.get(command.input.Key!)
            if (!body) throw missing()
            return command instanceof GetObjectCommand ? {Body: Readable.from([body]), ContentLength: body.length} : {ContentLength: body.length}
        }
        if (command instanceof DeleteObjectCommand || command instanceof DeleteObjectsCommand) {
            await this.beforeDelete?.()
            if (this.failDelete) throw new Error('secret driver details')
            if (command instanceof DeleteObjectCommand) this.objects.delete(command.input.Key!)
            else command.input.Delete?.Objects?.forEach(object => this.objects.delete(object.Key!))
            return {}
        }
        if (command instanceof ListObjectsV2Command) {
            const entries = new Map<string, 'file' | 'folder'>()
            for (const key of [...this.objects.keys()].filter(key => key.startsWith(command.input.Prefix!)).sort()) {
                const remainder = key.slice(command.input.Prefix!.length)
                const separator = command.input.Delimiter ? remainder.indexOf(command.input.Delimiter) : -1
                if (separator >= 0) entries.set(command.input.Prefix! + remainder.slice(0, separator + 1), 'folder')
                else entries.set(key, 'file')
            }
            const contents = [...entries.keys()]
            const after = command.input.ContinuationToken
            const remaining = contents.filter(key => !after || key > after)
            const selected = remaining.slice(0, command.input.MaxKeys ?? 1000)
            return {Contents: selected.filter(key => entries.get(key) === 'file').map(Key => ({Key})),
                CommonPrefixes: selected.filter(key => entries.get(key) === 'folder').map(Prefix => ({Prefix})), IsTruncated: selected.length < remaining.length,
                NextContinuationToken: selected.length < remaining.length ? selected.at(-1) : undefined}
        }
        throw new Error('Unsupported mock operation')
    }
}

async function fixture(work: (f: {db: ReturnType<typeof drizzle>; storage: ReturnType<typeof createS3ImageStorage>; s3: MemoryS3; alice: AssetActor; bob: AssetActor; owner: AssetActor; outsider: AssetActor; bytes: Buffer}) => Promise<void>) {
    const connectionString = process.env.TEST_DATABASE_URL!
    const schema = `imagery_acl_${randomUUID().replaceAll('-', '')}`
    const administrator = new Pool({connectionString, max: 1})
    const pool = new Pool({...getDatabasePoolConfig({DATABASE_URL: connectionString}), options: `-c search_path=${schema} -c timezone=UTC`})
    try {
        await administrator.query(`CREATE SCHEMA "${schema}"`)
        const db = drizzle({client: pool})
        await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle/postgres', import.meta.url)), migrationsSchema: schema})
        const org = randomUUID(), other = randomUUID()
        await db.insert(organizations).values([{id: org, name: 'Studio'}, {id: other, name: 'Other studio'}])
        const alice = actor(org, 'alice'), bob = actor(org, 'bob'), owner = actor(org, 'owner', 'owner'), outsider = actor(other, 'outsider', 'owner')
        await db.insert(users).values([alice, bob, owner, outsider].map(a => ({id: a.userId, organizationId: a.organizationId,
            username: a.username, normalizedUsername: a.username, displayName: a.displayName, passwordHash: 'unused-local-test-hash', role: a.role})))
        const s3 = new MemoryS3()
        const storage = createS3ImageStorage({client: s3, bucket: 'local-test', prefix: 'images'})
        const bytes = await sharp({create: {width: 4, height: 3, channels: 4, background: '#246d6c'}}).png().toBuffer()
        await work({db, storage, s3, alice, bob, owner, outsider, bytes})
    } finally {
        await pool.end()
        await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await administrator.end()
    }
}
const upload = (bytes: Buffer, filename = 'product.png') => ({name: 'files' as const, filename, type: 'image/png', data: bytes})

test('asset URLs and listing cursors reject ambiguous paths and another user or query scope', () => {
    const a = actor(randomUUID(), 'alice'), b = {...a, userId: randomUUID()}
    const scope = assetCursorScope(a, ['all', '/'])
    const cursor = encodeAssetCursor(randomUUID(), scope)
    assert.ok(decodeAssetCursor(cursor, scope))
    assert.throws(() => decodeAssetCursor(cursor, assetCursorScope(b, ['all', '/'])), status(400))
    assert.throws(() => decodeAssetCursor(cursor, assetCursorScope(a, ['shared', '/'])), status(400))
    for (const url of ['/images/../a.png', '/images/%2e%2e/a.png', '/images/a%2fb.png', '/images/a%2520b.png', 'https://example.test/a.png', '/images/a.png?x=1', '/images/a.png#fragment', '/images/%61.png']) {
        assert.throws(() => canonicalAssetUrl(url), status(400))
    }
})

test('sharing requests default to view and reject edit or other permissions', () => {
    const recipientUserId = randomUUID()
    assert.deepEqual(ShareAssetSchema.parse({recipientUserId}), {recipientUserId, permission: 'view'})
    assert.equal(ShareAssetSchema.safeParse({recipientUserId, permission: 'view'}).success, true)
    for (const permission of ['edit', 'owner', 'download', null, true]) {
        assert.equal(ShareAssetSchema.safeParse({recipientUserId, permission}).success, false)
    }
})

test('each user has an immutable private namespace; organization owners cannot read others private assets', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const ownerFS = await useUserFS(f.owner, f.storage, f.db), outsiderFS = await useUserFS(f.outsider, f.storage, f.db)
    const first = await aliceFS.saveUpload('/', upload(f.bytes)), second = await bobFS.saveUpload('/', upload(f.bytes))
    assert.notEqual(first.url, second.url)
    assert.match(first.url, new RegExp(`^/images/organizations/${f.alice.organizationId}/users/${f.alice.userId}/objects/[a-f\\d-]+/product.png$`))
    assert.equal(first.folder, '/')
    assert.equal((await aliceFS.getImageFile(first.url)).width, 4)
    for (const strangerFS of [bobFS, ownerFS, outsiderFS]) {
        await assert.rejects(strangerFS.getImageFile(first.url), status(404))
        await assert.rejects(strangerFS.assertReadableImages([first.url]), status(404))
        await assert.rejects(strangerFS.deleteFileOrFolder(first.url, 'file'), status(404))
        assert.deepEqual((await strangerFS.resolveAssets([first.url])).map(item => item.url), [])
    }
    assert.deepEqual((await aliceFS.listAssets()).files.map(file => file.url), [first.url])
    assert.deepEqual((await ownerFS.listAssets()).files, [])
    const requestCount = f.s3.commands.length
    await bobFS.listAssets()
    assert.equal(f.s3.commands.length, requestCount, 'user listing must query the registry instead of enumerating S3')
    await aliceFS.share(first.id!, f.owner.userId, 'view')
    assert.equal((await ownerFS.getImageFile(first.url)).mimeType, 'image/png')
    await assert.rejects(aliceFS.share(first.id!, f.outsider.userId, 'view'), status(404))
    await assert.rejects(aliceFS.share(first.id!, randomUUID(), 'view'), status(404))
}))

test('folder sharing inherits to descendants and new uploads, is source grouped, and revocation immediately denies reads and generation sources', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const folder = await aliceFS.createFolder('/', 'Products')
    await aliceFS.createFolder('/Products', 'Summer')
    const nested = await aliceFS.saveUpload('/Products/Summer', upload(f.bytes))
    const privateImage = await aliceFS.saveUpload('/', upload(f.bytes, 'private.png'))
    await aliceFS.share(folder.id!, f.bob.userId, 'view')
    const shared = await bobFS.listAssets({scope: 'shared'})
    assert.equal(shared.files.length, 0)
    assert.equal(shared.dirs[0]?.id, folder.id)
    assert.deepEqual(shared.sources.map(source => source.userId), [f.alice.userId])
    assert.equal((await bobFS.readDir('/', {folderId: folder.id!})).dirs[0]?.name, 'Summer')
    assert.equal((await bobFS.getImageFile(nested.url)).height, 3)
    await bobFS.assertReadableImages([nested.url])
    await assert.rejects(bobFS.getImageFile(privateImage.url), status(404))
    await assert.rejects(bobFS.saveUpload(folder.url!, upload(f.bytes)), status(403))
    await assert.rejects(bobFS.createFolder(folder.url!, 'Forbidden'), status(403))
    await assert.rejects(bobFS.deleteFileOrFolder(nested.url, 'file'), status(403))
    await assert.rejects(bobFS.share(folder.id!, f.owner.userId, 'view'), status(403))
    const added = await aliceFS.saveUpload('/Products', upload(f.bytes, 'new.png'))
    assert.equal((await bobFS.getImageFile(added.url)).width, 4)
    await aliceFS.revoke(folder.id!, f.bob.userId)
    for (const url of [nested.url, added.url]) await assert.rejects(bobFS.assertReadableImages([url]), status(404))
    assert.deepEqual((await bobFS.listAssets({scope: 'shared'})).dirs, [])
    assert.deepEqual(await bobFS.resolveAssets([nested.url, added.url]), [])
}))

test('historical edit grants remain readable generation sources but cannot authorize any shared mutations', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const folder = await aliceFS.createFolder('/', 'Campaign')
    const image = await aliceFS.saveUpload('/Campaign', upload(f.bytes))
    const output = await aliceFS.saveGeneratedImage(f.bytes)
    const outputAsset = await aliceFS.assetByUrl(output.url)
    const grantId = randomUUID()
    await f.db.insert(assetShares).values([
        {id: grantId, assetId: folder.id!, organizationId: f.alice.organizationId, sharedByUserId: f.alice.userId, recipientUserId: f.bob.userId, permission: 'edit'},
        {id: randomUUID(), assetId: outputAsset.id!, organizationId: f.alice.organizationId, sharedByUserId: f.alice.userId, recipientUserId: f.bob.userId, permission: 'edit'},
    ])
    await assert.rejects(Reflect.apply(aliceFS.share, undefined, [folder.id!, f.bob.userId, 'edit']), status(400))
    const received = await bobFS.readDir('/', {folderId: folder.id!})
    assert.deepEqual(received.files[0]?.permissions, {view: true, edit: false, share: false})
    assert.deepEqual(received.folder?.permissions, {view: true, edit: false, share: false})
    assert.equal((await aliceFS.sharesFor(folder.id!))[0]?.permission, 'view')
    assert.equal((await f.db.select().from(assetShares).where(eq(assetShares.id, grantId)))[0]?.permission, 'edit', 'runtime restriction does not rewrite historical grants')
    assert.equal((await bobFS.getImageFile(image.url)).width, 4)
    await bobFS.assertReadableImages([image.url, output.url])
    const beforeMutations = f.s3.commands.length
    await assert.rejects(bobFS.saveUpload(folder.url!, upload(f.bytes)), status(403))
    await assert.rejects(bobFS.createFolder(folder.url!, 'Draft'), status(403))
    await assert.rejects(bobFS.deleteFileOrFolder(image.url, 'file'), status(403))
    await assert.rejects(bobFS.deleteFileOrFolder(folder.url!, 'directory'), status(403))
    await assert.rejects(bobFS.removeGeneratedImage(output.url), status(403))
    await assert.rejects(bobFS.share(folder.id!, f.owner.userId, 'view'), status(403))
    await assert.rejects(bobFS.revoke(folder.id!, f.bob.userId), status(403))
    await assert.rejects(bobFS.sharesFor(image.id!), status(403))
    assert.equal(f.s3.commands.length, beforeMutations, 'denied shared mutations must not reach S3')
    const derivative = await bobFS.saveGeneratedImage((await bobFS.getImageFile(image.url)).buffer)
    assert.match(derivative.url, new RegExp(`/users/${f.bob.userId}/output/`))
    await assert.rejects(aliceFS.getImageFile(derivative.url), status(404))
    assert.equal((await aliceFS.getImageFile(image.url)).width, 4)
    await aliceFS.createFolder('/Campaign', 'Owner draft')
    await aliceFS.deleteFileOrFolder(folder.url!, 'directory')
    await assert.rejects(bobFS.getImageFile(image.url), status(404))
}))

test('deleting then uploading the same filename cannot reuse replay URLs or inherit a deleted file share', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const first = await aliceFS.saveUpload('/', upload(f.bytes))
    await aliceFS.share(first.id!, f.bob.userId, 'view')
    await aliceFS.deleteFileOrFolder(first.url, 'file')
    const second = await aliceFS.saveUpload('/', upload(f.bytes))
    assert.equal(second.name, first.name)
    assert.notEqual(second.url, first.url)
    assert.notEqual(second.id, first.id)
    await assert.rejects(aliceFS.getImageFile(first.url), status(404))
    await assert.rejects(bobFS.getImageFile(first.url), status(404))
    await assert.rejects(bobFS.getImageFile(second.url), status(404))
    assert.equal((await aliceFS.getImageFile(second.url)).width, 4)
}))

test('generated images register immutable actor-owned output paths and exact rollback rejects sibling outputs', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const output = await aliceFS.saveGeneratedImage(f.bytes)
    assert.match(output.url, new RegExp(`/organizations/${f.alice.organizationId}/users/${f.alice.userId}/output/img-`))
    assert.equal((await aliceFS.listAssets({scope: 'generated'})).files[0]?.url, output.url)
    assert.equal((await aliceFS.listAssets({scope: 'uploads'})).files.length, 0)
    await assert.rejects(bobFS.removeGeneratedImage(output.url), status(404))
    await aliceFS.removeGeneratedImage(output.url)
    assert.equal((await aliceFS.listAssets({scope: 'generated'})).files.length, 0)
    await assert.rejects(aliceFS.getImageFile(output.url), status(404))
}))

test('registry pagination binds cursor to actor/source/search, and revoked favorites omit inaccessible metadata', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const images = await Promise.all(['one.png', 'two.png', 'three.png'].map(name => aliceFS.saveUpload('/', upload(f.bytes, name))))
    const first = await aliceFS.listAssets({limit: 2})
    assert.equal(first.files.length, 2); assert.ok(first.nextCursor)
    const second = await aliceFS.listAssets({limit: 2, cursor: first.nextCursor})
    assert.equal(second.files.length, 1)
    assert.equal(new Set([...first.files, ...second.files].map(image => image.id)).size, 3)
    await assert.rejects(bobFS.listAssets({cursor: first.nextCursor}), status(400))
    await assert.rejects(aliceFS.listAssets({query: 'one', cursor: first.nextCursor}), status(400))
    assert.equal((await aliceFS.listAssets({query: '%'})).files.length, 0, 'search wildcards must be literal')
    await aliceFS.share(images[0]!.id!, f.bob.userId, 'view')
    assert.deepEqual((await bobFS.resolveAssets(images.map(file => file.url))).map(file => file.id), [images[0]!.id])
    await aliceFS.revoke(images[0]!.id!, f.bob.userId)
    assert.deepEqual(await bobFS.resolveAssets(images.map(file => file.url)), [])
}))

test('folder tombstones deny concurrent writes during deletion and partial storage failures permit a safe retry', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db)
    const folder = await aliceFS.createFolder('/', 'Retry')
    const image = await aliceFS.saveUpload('/Retry', upload(f.bytes))
    let concurrentWriteChecked = false
    f.s3.beforeDelete = async () => {
        if (concurrentWriteChecked) return
        concurrentWriteChecked = true
        await assert.rejects(aliceFS.saveUpload('/Retry', upload(f.bytes, 'too-late.png')), status(404))
    }
    f.s3.failDelete = true
    await assert.rejects(aliceFS.deleteFileOrFolder(folder.url!, 'directory'), status(503))
    assert.equal(concurrentWriteChecked, true)
    assert.equal((await aliceFS.getImageFile(image.url)).width, 4)
    f.s3.failDelete = false
    await aliceFS.deleteFileOrFolder(folder.url!, 'directory')
    assert.equal((await aliceFS.listAssets()).files.length, 0)
    assert.deepEqual((await aliceFS.readDir('/')).dirs, [])
}))

test('cycles, cross-owner parent links and unregistered legacy objects fail closed even for an organization owner', integration, async () => fixture(async f => {
    const repo = createAssetRepository(f.alice, f.db)
    const row = await repo.register({ownerUserId: f.alice.userId, name: 'Cycle', kind: 'folder', category: 'uploaded', url: `/images/organizations/${f.alice.organizationId}/users/${f.alice.userId}/Cycle`})
    await f.db.update(assets).set({parentId: row.id}).where(eq(assets.id, row.id))
    await assert.rejects(repo.requireAsset(row.id), status(404))
    const ownerFS = await useUserFS(f.owner, f.storage, f.db)
    await f.storage.importImage('/legacy.png', f.bytes)
    await assert.rejects(ownerFS.getImageFile('/images/legacy.png'), status(404))
    await assert.rejects(ownerFS.getImageFile(`/images/organizations/${f.alice.organizationId}/users/${f.alice.userId}/../legacy.png`), status(400))
}))

test('legacy adoption is explicit, bootstrap-owner-only, bounded, idempotent and never restores deleted URLs', integration, async () => fixture(async f => {
    await f.db.update(users).set({isBootstrapOwner: true}).where(eq(users.id, f.owner.userId))
    await f.storage.createFolder('/', 'Legacy')
    await f.storage.importImage('/Legacy/original.png', f.bytes)
    const ownerFS = await useUserFS(f.owner, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    await ownerFS.saveUpload('/', upload(f.bytes, 'new-private.png'))
    const options = {organizationId: f.owner.organizationId, ownerUserId: f.owner.userId, storage: f.storage, db: f.db}
    await assert.rejects(adoptLegacyAssets({...options, ownerUserId: f.bob.userId}), /original bootstrap/)
    await assert.rejects(adoptLegacyAssets({...options, maxEntries: 1}), /entry limit/)
    const plan = await adoptLegacyAssets(options)
    assert.equal(plan.planned, 2)
    assert.equal(plan.adopted, 0)
    await assert.rejects(ownerFS.getImageFile('/images/Legacy/original.png'), status(404))
    const result = await adoptLegacyAssets({...options, apply: true})
    assert.equal(result.adopted, 2)
    assert.equal((await ownerFS.getImageFile('/images/Legacy/original.png')).width, 4)
    assert.equal((await ownerFS.readDir('/Legacy')).files[0]?.name, 'original.png')
    await assert.rejects(bobFS.getImageFile('/images/Legacy/original.png'), status(404))
    assert.equal((await adoptLegacyAssets({...options, apply: true})).adopted, 0)
    await ownerFS.deleteFileOrFolder('/images/Legacy/original.png', 'file')
    await f.storage.importImage('/Legacy/original.png', f.bytes)
    const retry = await adoptLegacyAssets({...options, apply: true})
    assert.equal(retry.skippedDeleted, 1)
    await assert.rejects(ownerFS.getImageFile('/images/Legacy/original.png'), status(404))
}))

test('shared recipients cannot delete a folder named objects; owner deletion only removes registered descendants', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const folder = await aliceFS.createFolder('/', 'objects')
    await aliceFS.share(folder.id!, f.bob.userId, 'view')
    const privateImage = await aliceFS.saveUpload('/', upload(f.bytes, 'private.png'))
    const sharedImage = await aliceFS.saveUpload('/objects', upload(f.bytes, 'shared.png'))
    await assert.rejects(bobFS.getImageFile(privateImage.url), status(404))
    await assert.rejects(bobFS.deleteFileOrFolder(folder.url!, 'directory'), status(403))
    const beforeDelete = f.s3.commands.length
    await aliceFS.deleteFileOrFolder(folder.url!, 'directory')
    assert.ok(f.s3.commands.slice(beforeDelete).every(command => command instanceof DeleteObjectsCommand), 'deletion must batch only exact registered keys without physical prefix enumeration')
    assert.equal((await aliceFS.getImageFile(privateImage.url)).width, 4)
    await assert.rejects(aliceFS.getImageFile(sharedImage.url), status(404))
    assert.deepEqual((await aliceFS.listAssets()).files.map(file => file.url), [privateImage.url])
}))
