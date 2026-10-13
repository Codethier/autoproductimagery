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
import {assets, assetShares, organizations, systemPrompt, users} from '../server/db/schema.ts'
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

async function fixture(work: (f: {db: ReturnType<typeof drizzle>; storage: ReturnType<typeof createS3ImageStorage>; s3: MemoryS3; alice: AssetActor; bob: AssetActor; owner: AssetActor; outsider: AssetActor; bytes: Buffer; queries: string[]}) => Promise<void>) {
    const connectionString = process.env.TEST_DATABASE_URL!
    const schema = `imagery_acl_${randomUUID().replaceAll('-', '')}`
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
        const s3 = new MemoryS3()
        const storage = createS3ImageStorage({client: s3, bucket: 'local-test', prefix: 'images'})
        const bytes = await sharp({create: {width: 4, height: 3, channels: 4, background: '#246d6c'}}).png().toBuffer()
        await work({db, storage, s3, alice, bob, owner, outsider, bytes, queries})
    } finally {
        await pool.end()
        await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await administrator.end()
    }
}
const upload = (bytes: Buffer, filename = 'product.png') => ({name: 'files' as const, filename, type: 'image/png', data: bytes})
async function pricedGeneration(db: ReturnType<typeof drizzle>, actor: AssetActor, outputImage: string, values: Partial<typeof systemPrompt.$inferInsert> = {}) {
    const [row] = await db.insert(systemPrompt).values({organizationId: actor.organizationId, userId: actor.userId,
        TextPrompt: 'Disposable local price fixture', outputImage, status: 'succeeded', billingState: 'confirmed',
        priceUsd: '0.125000000000', priceSource: 'gateway', usageJson: {gatewayBilling: {isByok: false}}, ...values}).returning()
    return row!
}

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
test('processed asset DTOs distinguish pipeline destinations from cutouts for owners and shared recipients', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const original = await aliceFS.saveUpload('/', upload(f.bytes))
    const source = {id: original.id!, url: original.url}
    const cutout = await aliceFS.prepareProcessedImage(f.bytes)
    const cutoutRow = await f.db.transaction(tx => cutout.register(tx, source))
    const crop = await aliceFS.prepareProcessedImage(f.bytes, {purpose: 'pipeline', name: 'Crop.png'})
    const cropRow = await f.db.transaction(tx => crop.register(tx, source))
    const files = await aliceFS.resolveAssets([cutoutRow.outputUrl, cropRow.outputUrl, original.url])
    assert.equal(files.find(file => file.url === cutoutRow.outputUrl)?.processingPurpose, 'background-removal')
    assert.equal(files.find(file => file.url === cropRow.outputUrl)?.processingPurpose, 'pipeline')
    assert.equal(files.find(file => file.url === original.url)?.processingPurpose, undefined)
    for (const file of files.filter(file => file.category === 'processed')) {
        assert.equal(file.priceUsd, '0'); assert.equal(file.priceSource, 'local-processing')
    }
    await aliceFS.share(cropRow.outputAssetId, f.bob.userId, 'view')
    const [shared] = await bobFS.resolveAssets([cropRow.outputUrl])
    assert.equal(shared?.processingPurpose, 'pipeline')
    assert.equal(shared?.permissions?.edit, false)
    assert.equal(shared?.sharedBy?.userId, f.alice.userId)
}))

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

test('folder counts include immediate visible children, remain independent of search and pagination, and require no storage reads', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db)
    const catalog = await aliceFS.createFolder('/', 'Catalog')
    const empty = await aliceFS.createFolder('/', 'Empty')
    const summer = await aliceFS.createFolder('/Catalog', 'Summer')
    const first = await aliceFS.saveUpload('/Catalog', upload(f.bytes, 'one.png'))
    await aliceFS.saveUpload('/Catalog', upload(f.bytes, 'two.png'))
    await aliceFS.saveUpload('/Catalog/Summer', upload(f.bytes, 'nested.png'))
    await aliceFS.saveUpload('/', upload(f.bytes, 'outside.png'))
    assert.equal(empty.itemCount, 0, 'newly created empty folders return a zero count')
    const before = f.s3.commands.length
    f.queries.length = 0
    const root = await aliceFS.readDir('/')
    assert.equal(root.dirs.find(folder => folder.id === catalog.id)?.itemCount, 3, 'two images plus one folder, without counting grandchildren')
    assert.equal(root.dirs.find(folder => folder.id === empty.id)?.itemCount, 0)
    assert.equal(f.queries.filter(query => query.includes('count(') && query.includes('group by')).length, 1, 'one grouped count query covers all returned folders')
    const filtered = await aliceFS.listAssets({direct: true, query: 'Catalog', limit: 1})
    assert.equal(filtered.dirs[0]?.itemCount, 3)
    assert.equal(filtered.files.length, 0)
    const expected = new Map([[catalog.id, 3], [empty.id, 0]])
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
        const page = await aliceFS.readDir('/', {limit: 1, cursor})
        for (const folder of page.dirs) {
            assert.equal(folder.itemCount, expected.get(folder.id))
            seen.add(folder.id!)
        }
        cursor = page.nextCursor
    } while (cursor)
    assert.equal(seen.size, 2)
    const contents = await aliceFS.readDir('/Catalog', {limit: 1})
    assert.equal(contents.folder?.itemCount, 3, 'current-folder metadata reports the whole immediate folder even on a short page')
    assert.equal((await aliceFS.listAssets({folderId: catalog.id, query: 'not present'})).folder?.itemCount, 3)
    const summerContents = await aliceFS.readDir('/Catalog/Summer')
    assert.equal(summerContents.folder?.id, summer.id)
    assert.equal(summerContents.folder?.itemCount, 1)
    assert.equal(f.s3.commands.length, before, 'counts, search and paginated listings only query PostgreSQL')
    await aliceFS.deleteFileOrFolder(first.url, 'file')
    assert.equal((await aliceFS.readDir('/Catalog')).folder?.itemCount, 2)
    await aliceFS.deleteFileOrFolder(summer.url!, 'directory')
    assert.equal((await aliceFS.readDir('/Catalog')).folder?.itemCount, 1)
}))

test('shared folder counts follow exact-price, retention and tenant visibility without exposing private or held outputs', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const outputs = await Promise.all(Array.from({length: 9}, () => aliceFS.saveGeneratedImage(f.bytes)))
    const repo = createAssetRepository(f.alice, f.db)
    const firstAsset = await repo.byUrl(outputs[0]!.url)
    const folderId = firstAsset!.parentId!
    const histories = await Promise.all([
        pricedGeneration(f.db, f.alice, outputs[0]!.url, {billingState: 'awaiting', priceSource: 'estimate'}),
        pricedGeneration(f.db, f.alice, outputs[1]!.url, {priceUsd: '0.000000000000'}),
        pricedGeneration(f.db, f.alice, outputs[2]!.url),
        pricedGeneration(f.db, f.alice, outputs[3]!.url),
        pricedGeneration(f.db, f.alice, outputs[4]!.url, {outputImageDeletedAt: new Date().toISOString()}),
        pricedGeneration(f.db, f.alice, outputs[5]!.url, {usageJson: {gatewayBilling: {isByok: true}}}),
        pricedGeneration(f.db, f.alice, outputs[6]!.url, {status: 'failed', errors: 'Local failed fixture'}),
        pricedGeneration(f.db, f.bob, outputs[7]!.url),
    ])
    // A valid sibling cannot settle another URL, owner or organization, and duplicate
    // provider rows do not multiply the number of visible assets.
    await pricedGeneration(f.db, f.alice, outputs[2]!.url)
    await pricedGeneration(f.db, f.outsider, outputs[8]!.url)
    await f.db.update(assets).set({deletedAt: new Date().toISOString()}).where(eq(assets.url, outputs[3]!.url))
    await f.db.insert(assets).values([
        {id: randomUUID(), organizationId: f.alice.organizationId, ownerUserId: f.bob.userId, createdByUserId: f.bob.userId,
            parentId: folderId, url: '/images/local-test-other-owner.png', name: 'Other owner', kind: 'file', category: 'uploaded'},
        {id: randomUUID(), organizationId: f.outsider.organizationId, ownerUserId: f.outsider.userId, createdByUserId: f.outsider.userId,
            parentId: folderId, url: '/images/local-test-other-organization.png', name: 'Other organization', kind: 'folder', category: 'uploaded'},
    ])
    const beforePrivate = f.s3.commands.length
    assert.deepEqual((await bobFS.readDir('/')).dirs, [])
    assert.deepEqual((await bobFS.listAssets({scope: 'shared'})).dirs, [])
    await assert.rejects(bobFS.readDir('/', {folderId}), status(404))
    assert.deepEqual((await (await useUserFS(f.owner, f.storage, f.db)).readDir('/')).dirs, [], 'organization owners do not see another user’s private folder count')
    assert.equal(f.s3.commands.length, beforePrivate)
    await aliceFS.share(folderId, f.bob.userId, 'view')
    const before = f.s3.commands.length
    const shared = await bobFS.listAssets({scope: 'shared', sourceUserId: f.alice.userId, limit: 1})
    assert.equal(shared.dirs[0]?.itemCount, 2)
    assert.equal(shared.dirs[0]?.sharedBy?.userId, f.alice.userId)
    const first = await bobFS.readDir('/', {folderId, limit: 1})
    assert.equal(first.folder?.itemCount, 2)
    assert.ok(first.nextCursor)
    assert.equal((await bobFS.readDir('/', {folderId, limit: 1, cursor: first.nextCursor})).folder?.itemCount, 2)
    assert.equal((await bobFS.listAssets({folderId, query: 'absent', limit: 1})).folder?.itemCount, 2)
    await f.db.update(systemPrompt).set({billingState: 'confirmed', priceSource: 'gateway', priceUsd: '0.000000000000'}).where(eq(systemPrompt.id, histories[0]!.id))
    assert.equal((await bobFS.listAssets({scope: 'shared'})).dirs[0]?.itemCount, 3, 'settling a zero charge makes the output count visible')
    await f.db.update(systemPrompt).set({outputImageDeletedAt: new Date().toISOString()}).where(eq(systemPrompt.id, histories[1]!.id))
    assert.equal((await bobFS.readDir('/', {folderId})).folder?.itemCount, 2, 'retention removes expired outputs from counts immediately')
    await f.db.update(assets).set({deletedAt: new Date().toISOString()}).where(eq(assets.url, outputs[2]!.url))
    assert.equal((await bobFS.readDir('/', {folderId})).folder?.itemCount, 1)
    await aliceFS.revoke(folderId, f.bob.userId)
    assert.deepEqual((await bobFS.listAssets({scope: 'shared'})).dirs, [])
    await assert.rejects(bobFS.readDir('/', {folderId}), status(404))
    assert.equal(f.s3.commands.length, before, 'count changes and revocation must not fetch or enumerate any S3 objects')
}))

test('historical edit grants remain readable generation sources but cannot authorize any shared mutations', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const folder = await aliceFS.createFolder('/', 'Campaign')
    const image = await aliceFS.saveUpload('/Campaign', upload(f.bytes))
    const output = await aliceFS.saveGeneratedImage(f.bytes)
    await pricedGeneration(f.db, f.alice, output.url)
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
    await pricedGeneration(f.db, f.bob, derivative.url)
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
    await pricedGeneration(f.db, f.alice, output.url)
    assert.match(output.url, new RegExp(`/organizations/${f.alice.organizationId}/users/${f.alice.userId}/output/img-`))
    assert.equal((await aliceFS.listAssets({scope: 'generated'})).files[0]?.url, output.url)
    assert.equal((await aliceFS.listAssets({scope: 'uploads'})).files.length, 0)
    await assert.rejects(bobFS.removeGeneratedImage(output.url), status(404))
    await aliceFS.removeGeneratedImage(output.url)
    assert.equal((await aliceFS.listAssets({scope: 'generated'})).files.length, 0)
    await assert.rejects(aliceFS.getImageFile(output.url), status(404))
}))

test('generated images stay locked until an exact same-owner final price exists, with authorization checked before price or S3 access', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const ownerFS = await useUserFS(f.owner, f.storage, f.db), outsiderFS = await useUserFS(f.outsider, f.storage, f.db)
    const repository = createAssetRepository(f.alice, f.db)
    const cases: Array<{label: string; values?: Partial<typeof systemPrompt.$inferInsert>; historyOwner?: AssetActor; visible: boolean; orphan?: boolean}> = [
        {label: 'orphan', visible: false, orphan: true},
        {label: 'estimated', visible: false, values: {priceSource: 'estimate', billingState: 'awaiting'}},
        {label: 'awaiting', visible: false, values: {priceSource: 'gateway', billingState: 'awaiting'}},
        {label: 'pending-generation', visible: false, values: {status: 'pending'}},
        {label: 'failed-generation', visible: false, values: {status: 'failed', errors: 'Provider failed'}},
        {label: 'missing-price', visible: false, values: {priceUsd: null}},
        {label: 'negative-price', visible: false, values: {priceUsd: '-0.1'}},
        {label: 'non-decimal-price', visible: false, values: {priceUsd: '1e-7'}},
        {label: 'BYOK', visible: false, values: {priceUsd: '0', usageJson: {gatewayBilling: {isByok: true, upstreamInferenceCost: 0.12}}}},
        {label: 'legacy-BYOK', visible: false, values: {billingState: null, priceUsd: '0', usageJson: {gatewayBilling: {isByok: true}}}},
        {label: 'other-user-price', visible: false, historyOwner: f.bob},
        {label: 'other-organization-price', visible: false, historyOwner: f.outsider},
        {label: 'expired-output', visible: false, values: {outputImageDeletedAt: new Date().toISOString()}},
        {label: 'zero', visible: true, values: {priceUsd: '0.000000000000'}},
        {label: 'tiny-exact', visible: true, values: {priceUsd: '0.000000000001'}},
        {label: 'legacy-confirmed', visible: true, values: {status: null, billingState: null, errors: null}},
    ]
    const outputs: Array<{url: string; visible: boolean; label: string; priceUsd?: string | null}> = []
    let folderId: string | undefined
    for (const entry of cases) {
        const output = await aliceFS.saveGeneratedImage(f.bytes)
        const asset = await repository.byUrl(output.url)
        assert.ok(asset)
        folderId ??= asset.parentId!
        if (!entry.orphan) await pricedGeneration(f.db, entry.historyOwner ?? f.alice, output.url, entry.values)
        outputs.push({url: output.url, visible: entry.visible, label: entry.label, priceUsd: entry.values?.priceUsd ?? '0.125000000000'})
    }
    await aliceFS.share(folderId!, f.bob.userId, 'view')
    for (const output of outputs) {
        const before = f.s3.commands.length
        if (output.visible) {
            const metadata = await aliceFS.assetByUrl(output.url)
            assert.equal(metadata.priceUsd, output.priceUsd, output.label)
            assert.equal((await bobFS.getImageFile(output.url)).width, 4, output.label)
            await bobFS.assertReadableImages([output.url])
        } else {
            for (const readable of [aliceFS, bobFS]) {
                await assert.rejects(readable.getImageFile(output.url), status(425), output.label)
                await assert.rejects(readable.getFile(output.url), status(425), output.label)
                await assert.rejects(readable.fileExists(output.url), status(425), output.label)
                await assert.rejects(readable.assetByUrl(output.url), status(425), output.label)
                await assert.rejects(readable.assertReadableImages([output.url]), status(425), output.label)
                assert.deepEqual(await readable.resolveAssets([output.url]), [], output.label)
            }
            assert.equal(f.s3.commands.length, before, `${output.label}: held image bytes and object metadata must never be requested`)
        }
        for (const unauthorized of [ownerFS, outsiderFS]) {
            await assert.rejects(unauthorized.getImageFile(output.url), status(404), output.label)
            await assert.rejects(unauthorized.assertReadableImages([output.url]), status(404), output.label)
            assert.deepEqual(await unauthorized.resolveAssets([output.url]), [], output.label)
        }
    }
    const visibleUrls = outputs.filter(output => output.visible).map(output => output.url).sort()
    assert.deepEqual((await aliceFS.listAssets({scope: 'generated'})).files.map(file => file.url).sort(), visibleUrls)
    assert.deepEqual((await bobFS.readDir('/', {folderId})).files.map(file => file.url).sort(), visibleUrls)
    assert.deepEqual((await bobFS.resolveAssets(outputs.map(output => output.url))).map(file => file.url).sort(), visibleUrls, 'favorites only resolve confirmed shared images')
    const orphan = outputs.find(output => output.label === 'orphan')!
    await assert.rejects(bobFS.removeGeneratedImage(orphan.url), status(403), 'sharing never permits cleanup')
    await aliceFS.removeGeneratedImage(orphan.url)
    await assert.rejects(aliceFS.getImageFile(orphan.url), status(404), 'the original owner can remove an unlinked or unpaid output')
    assert.equal((await bobFS.getImageFile(outputs.find(output => output.label === 'zero')!.url)).width, 4, 'cleanup only deletes its exact output')
}))

test('shared folder listing filters held outputs before pagination and unlocks a persisted exact price on the next read', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const repository = createAssetRepository(f.alice, f.db)
    const generated = []
    for (let index = 0; index < 6; index++) {
        const output = await aliceFS.saveGeneratedImage(f.bytes)
        const asset = await repository.byUrl(output.url)
        assert.ok(asset)
        generated.push(asset)
    }
    generated.sort((left, right) => left.id.localeCompare(right.id))
    const folderId = generated[0]!.parentId!
    await aliceFS.share(folderId, f.bob.userId, 'view')
    // Earlier UUIDs fill any unfiltered first page. Only the final two are
    // priced; a SQL LIMIT applied too early would return an empty page here.
    for (const asset of generated.slice(0, 4)) await pricedGeneration(f.db, f.alice, asset.url, {billingState: 'awaiting', priceSource: 'estimate'})
    for (const asset of generated.slice(4)) await pricedGeneration(f.db, f.alice, asset.url, {priceUsd: '0.000000000001'})
    const before = f.s3.commands.length
    const first = await bobFS.readDir('/', {folderId, limit: 1})
    assert.deepEqual(first.files.map(file => file.id), [generated[4]!.id])
    assert.ok(first.nextCursor)
    const second = await bobFS.readDir('/', {folderId, limit: 1, cursor: first.nextCursor})
    assert.deepEqual(second.files.map(file => file.id), [generated[5]!.id])
    assert.equal(second.nextCursor, undefined)
    assert.equal(f.s3.commands.length, before, 'listing and prices require no S3 object reads')
    const held = generated[0]!
    await assert.rejects(bobFS.assertReadableImages([held.url]), status(425))
    const [history] = await f.db.select().from(systemPrompt).where(eq(systemPrompt.outputImage, held.url))
    await f.db.update(systemPrompt).set({billingState: 'confirmed', priceSource: 'gateway', priceUsd: '0.000000000000'}).where(eq(systemPrompt.id, history!.id))
    assert.equal((await bobFS.getImageFile(held.url)).height, 3, 'newly settled zero prices unlock for the recipient')
    await bobFS.assertReadableImages([held.url])
    assert.equal((await bobFS.resolveAssets([held.url]))[0]?.priceUsd, '0.000000000000')
}))

test('listing price prefetch cannot replace a valid output price with failed or BYOK legacy duplicates', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db)
    const output = await aliceFS.saveGeneratedImage(f.bytes)
    await pricedGeneration(f.db, f.alice, output.url, {priceUsd: '0.100000000000'})
    await pricedGeneration(f.db, f.alice, output.url, {status: 'failed', errors: 'Failed legacy duplicate', priceUsd: '90'})
    await pricedGeneration(f.db, f.alice, output.url, {status: null, errors: 'Interrupted legacy duplicate', priceUsd: '80'})
    await pricedGeneration(f.db, f.alice, output.url, {billingState: null, priceUsd: '0', usageJson: {gatewayBilling: {isByok: true}}})
    const listing = await aliceFS.listAssets({scope: 'generated'})
    assert.equal(listing.files.length, 1)
    assert.equal(listing.files[0]?.priceUsd, '0.100000000000')
    assert.equal((await aliceFS.assetByUrl(output.url)).priceUsd, '0.100000000000')
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

test('delivery coalesces original S3 reads, caches bounded previews, and keeps downloads byte-exact', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db)
    const bytes = await sharp({create: {width: 2400, height: 1600, channels: 4, background: '#246d6c'}}).png().toBuffer()
    const image = await aliceFS.saveUpload('/', upload(bytes, 'large-product.png'))
    const before = f.s3.commands.filter(command => command instanceof GetObjectCommand).length
    const deliveries = await Promise.all([
        aliceFS.getImageForDelivery(image.url), aliceFS.getImageForDelivery(image.url, 160),
        aliceFS.getImageForDelivery(image.url, 480), aliceFS.getImageForDelivery(image.url, 960),
        aliceFS.getImageForDelivery(image.url, 1600), aliceFS.getImageForDelivery(image.url, 480),
    ])
    assert.equal(f.s3.commands.filter(command => command instanceof GetObjectCommand).length - before, 1, 'concurrent representations fetch and validate the original once')
    const [original, ...previews] = deliveries
    assert.ok(original && !original.notModified)
    assert.equal(original.mimeType, 'image/png')
    assert.deepEqual(original.buffer, bytes, 'downloads and generation source originals retain their exact image bytes')
    const sizes = [160, 480, 960, 1600, 480]
    for (const [index, preview] of previews.entries()) {
        assert.equal(preview.notModified, false)
        if (preview.notModified) continue
        const metadata = await sharp(preview.buffer).metadata()
        assert.equal(preview.mimeType, 'image/webp')
        assert.equal(metadata.format, 'webp')
        assert.ok(preview.width <= sizes[index]! && preview.height <= sizes[index]!)
        assert.equal(preview.width, sizes[index])
        assert.equal(preview.height, Math.round(sizes[index]! * 2 / 3))
        assert.equal(metadata.width, preview.width)
        assert.equal(metadata.height, preview.height)
    }
    assert.equal(new Set(deliveries.slice(0, 5).map(delivery => delivery.etag)).size, 5, 'each preview size and the original have a distinct ETag')
    const nextRequestFS = await useUserFS(f.alice, f.storage, f.db)
    const again = await nextRequestFS.getImageForDelivery(image.url, 480)
    assert.equal(again.notModified, false)
    assert.equal(again.etag, deliveries[2]!.etag)
    if (!again.notModified && !deliveries[2]!.notModified) assert.deepEqual(again.buffer, deliveries[2]!.buffer)
    assert.equal(f.s3.commands.filter(command => command instanceof GetObjectCommand).length - before, 1, 'warm preview reads need no S3 transfer')
    const revalidated = await (await useUserFS(f.alice, f.storage, f.db)).getImageForDelivery(image.url, 480, again.etag)
    assert.deepEqual(revalidated, {etag: again.etag, notModified: true})
    assert.equal(f.s3.commands.filter(command => command instanceof GetObjectCommand).length - before, 1, 'authorized conditional reads do not load the original')
}))

test('warm delivery caches and known ETags cannot bypass sharing revocation, deletion, or organization boundaries', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const outsiderFS = await useUserFS(f.outsider, f.storage, f.db)
    const folder = await aliceFS.createFolder('/', 'Cached campaign')
    const image = await aliceFS.saveUpload('/Cached campaign', upload(f.bytes))
    await aliceFS.share(folder.id!, f.bob.userId, 'view')
    const owned = await aliceFS.getImageForDelivery(image.url, 480)
    const shared = await bobFS.getImageForDelivery(image.url, 480)
    assert.notEqual(owned.etag, shared.etag, 'browser ETags bind a representation to the current authenticated account')
    assert.deepEqual(await bobFS.getImageForDelivery(image.url, 480, shared.etag), {etag: shared.etag, notModified: true})
    const foreignValidator = await bobFS.getImageForDelivery(image.url, 480, owned.etag)
    assert.equal(foreignValidator.notModified, false, 'another account’s validator cannot produce a 304')
    const beforeDenied = f.s3.commands.length
    for (const knownTag of [undefined, owned.etag, shared.etag, '*']) {
        await assert.rejects(outsiderFS.getImageForDelivery(image.url, 480, knownTag), status(404))
    }
    await aliceFS.revoke(folder.id!, f.bob.userId)
    for (const knownTag of [undefined, shared.etag, '*']) {
        await assert.rejects(bobFS.getImageForDelivery(image.url, 480, knownTag), status(404))
    }
    assert.equal(f.s3.commands.length, beforeDenied, 'denied cache reads must not request any storage metadata or bytes')
    await aliceFS.deleteFileOrFolder(folder.url!, 'directory')
    const afterDeleted = f.s3.commands.length
    for (const knownTag of [undefined, owned.etag, '*']) {
        await assert.rejects(aliceFS.getImageForDelivery(image.url, 480, knownTag), status(404))
    }
    assert.equal(f.s3.commands.length, afterDeleted, 'a tombstoned image stays inaccessible even when its preview bytes are cached')
}))

test('delivery authorization checks current exact pricing before warm bytes or a conditional 304', integration, async () => fixture(async f => {
    const aliceFS = await useUserFS(f.alice, f.storage, f.db), bobFS = await useUserFS(f.bob, f.storage, f.db)
    const output = await aliceFS.saveGeneratedImage(f.bytes)
    const asset = await createAssetRepository(f.alice, f.db).byUrl(output.url)
    assert.ok(asset)
    assert.ok(asset.parentId)
    await aliceFS.share(asset.parentId, f.bob.userId, 'view')
    const beforeHeld = f.s3.commands.length
    for (const fs of [aliceFS, bobFS]) {
        await assert.rejects(fs.getImageForDelivery(output.url, 480), status(425))
        await assert.rejects(fs.getImageForDelivery(output.url, 480, '*'), status(425))
    }
    assert.equal(f.s3.commands.length, beforeHeld, 'unpriced generated images never reach storage')
    const row = await pricedGeneration(f.db, f.alice, output.url, {priceUsd: '0.000000000000'})
    const owned = await aliceFS.getImageForDelivery(output.url, 480)
    const shared = await bobFS.getImageForDelivery(output.url, 480)
    assert.equal(owned.notModified, false)
    assert.equal(shared.notModified, false)
    assert.deepEqual(await bobFS.getImageForDelivery(output.url, 480, shared.etag), {etag: shared.etag, notModified: true})
    await f.db.update(systemPrompt).set({billingState: 'awaiting', priceSource: 'estimate'}).where(eq(systemPrompt.id, row.id))
    const beforeReheld = f.s3.commands.length
    const currentAliceFS = await useUserFS(f.alice, f.storage, f.db), currentBobFS = await useUserFS(f.bob, f.storage, f.db)
    await assert.rejects(currentAliceFS.getImageForDelivery(output.url, 480, owned.etag), status(425))
    await assert.rejects(currentBobFS.getImageForDelivery(output.url, 480, shared.etag), status(425))
    await assert.rejects(currentBobFS.getImageForDelivery(output.url, 480), status(425))
    assert.equal(f.s3.commands.length, beforeReheld, 'price checks must run again for every memory-cache hit and conditional request')
    const uploaded = await aliceFS.saveUpload('/', upload(f.bytes, 'uploaded-price-independent.png'))
    assert.equal((await aliceFS.getImageForDelivery(uploaded.url, 160)).notModified, false, 'ordinary uploads do not require a generation price')
}))
