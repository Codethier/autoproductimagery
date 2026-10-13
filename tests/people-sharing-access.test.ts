import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
import {fileURLToPath} from 'node:url'
import {readFileSync} from 'node:fs'
import {registerHooks, stripTypeScriptTypes} from 'node:module'
import {parse, compileScript} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {createSSRApp, h, reactive, ref} from 'vue'
import {Pool} from 'pg'
import sharp from 'sharp'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {eq, sql} from 'drizzle-orm'
import {GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand} from '@aws-sdk/client-s3'
import {organizations, users, assets, people, personPhotos, personShares, systemPrompt} from '../server/db/schema.ts'
import {createAssetRepository, type AssetActor} from '../server/utils/assetAccess.ts'
import {createPeopleRepository} from '../server/utils/peopleRepository.ts'
import {useUserFS} from '../server/utils/useUserFS.ts'
import {createS3ImageStorage, type ImageStorageCommand} from '../server/utils/useFS.ts'
import {createBackgroundRemovalRepository} from '../server/utils/backgroundRemovalJobs.ts'
import {getBackgroundRemovalModel} from '../schemas/background-removal-models.ts'
import {createDefaultSettings} from '../schemas/image-generation.ts'

const integration = {skip: !process.env.TEST_DATABASE_URL, timeout: 60_000}
const status = (code: number) => (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === code)
const upload = (data: Buffer, filename = 'portrait.png') => ({name: 'files' as const, filename, type: 'image/png', data})
function deferred() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done}); return {promise, resolve}}
async function fixture(work: (f: {db: ReturnType<typeof drizzle>; pool: Pool; application: string; alice: AssetActor; bob: AssetActor;
    owner: AssetActor; outsider: AssetActor; raw: ReturnType<typeof createS3ImageStorage>; objects: Map<string, Buffer>; commands: ImageStorageCommand[]; bytes: Buffer}) => Promise<void>) {
    const schema = `people_read_${randomUUID().replaceAll('-', '')}`, application = `people-access-${randomUUID()}`
    const administrator = new Pool({connectionString: process.env.TEST_DATABASE_URL!, max: 1})
    const pool = new Pool({connectionString: process.env.TEST_DATABASE_URL!, max: 6,
        options: `-c search_path=${schema} -c timezone=UTC -c application_name=${application}`})
    try {
        await administrator.query(`CREATE SCHEMA "${schema}"`)
        const db = drizzle({client: pool})
        await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle/postgres', import.meta.url)), migrationsSchema: schema})
        const org = randomUUID(), otherOrg = randomUUID()
        await db.insert(organizations).values([{id: org, name: 'Studio'}, {id: otherOrg, name: 'Other studio'}])
        const actor = (organizationId: string, username: string, role: 'owner' | 'user' = 'user'): AssetActor => ({organizationId, userId: randomUUID(), username, displayName: username, role})
        const alice = actor(org, 'Alice'), bob = actor(org, 'Bob'), owner = actor(org, 'Owner', 'owner'), outsider = actor(otherOrg, 'Outsider', 'owner')
        await db.insert(users).values([alice, bob, owner, outsider].map(a => ({id: a.userId, organizationId: a.organizationId, username: a.username,
            normalizedUsername: a.username.toLowerCase(), displayName: a.displayName, role: a.role, passwordHash: 'unused-local-test'})))
        const objects = new Map<string, Buffer>(), commands: ImageStorageCommand[] = []
        const raw = createS3ImageStorage({bucket: 'local-test', prefix: 'images', client: {async send(command: ImageStorageCommand) {
            commands.push(command)
            if (command instanceof PutObjectCommand) {
                if (objects.has(command.input.Key!)) throw Object.assign(new Error('private conflict'), {name: 'PreconditionFailed', $metadata: {httpStatusCode: 412}})
                objects.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array)); return {}
            }
            if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand) {
                const body = objects.get(command.input.Key!)
                if (!body) throw Object.assign(new Error('private storage diagnostic'), {name: 'NoSuchKey', $metadata: {httpStatusCode: 404}})
                return command instanceof GetObjectCommand ? {Body: Readable.from([body]), ContentLength: body.length} : {ContentLength: body.length}
            }
            if (command instanceof DeleteObjectCommand) {objects.delete(command.input.Key!); return {}}
            return {Contents: [], CommonPrefixes: [], IsTruncated: false}
        }}})
        const bytes = await sharp({create: {width: 8, height: 6, channels: 4, background: '#305e87'}}).png().toBuffer()
        await work({db, pool, application, alice, bob, owner, outsider, raw, objects, commands, bytes})
    } finally {
        await pool.end(); await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await administrator.end()
    }
}
async function sharePerson(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
    const repository = createPeopleRepository(f.alice, f.db)
    const person = (await repository.create({name: 'Alex', description: 'A versatile studio model'})).person
    await f.db.insert(personShares).values({id: randomUUID(), personId: person.id, organizationId: f.alice.organizationId,
        sharedByUserId: f.alice.userId, recipientUserId: f.bob.userId})
    return {repository, person}
}

test('People grants authorize original, cached preview and generation-reference reads without granting edit/share or folder access', integration, async () => fixture(async f => {
    const {repository, person} = await sharePerson(f)
    const aliceFS = await useUserFS(f.alice, f.raw, f.db), bobFS = await useUserFS(f.bob, f.raw, f.db)
    const image = await aliceFS.saveUpload('/', upload(f.bytes))
    await repository.addPhotos(person.id, {urls: [image.url]})
    const recipient = createAssetRepository(f.bob, f.db)
    const visible = await recipient.requireAsset(image.url)
    assert.deepEqual(visible.permissions, {view: true, edit: false, share: false})
    assert.equal(visible.sharedBy?.userId, f.alice.userId)
    assert.equal(visible.personGrant?.personId, person.id)
    assert.deepEqual((await bobFS.getImageFile(image.url)).buffer, f.bytes)
    await bobFS.assertReadableImages([image.url])
    assert.deepEqual((await bobFS.resolveAssets([image.url])).map(item => item.url), [image.url])
    const preview = await bobFS.getImageForDelivery(image.url, 480)
    assert.deepEqual(await bobFS.getImageForDelivery(image.url, 480, preview.etag), {etag: preview.etag, notModified: true})
    assert.deepEqual((await bobFS.listAssets({scope: 'shared'})).files, [], 'People grants do not create independent file shares')
    await assert.rejects(recipient.requireAsset(image.url, 'edit'), status(403))
    await assert.rejects(recipient.requireAsset(image.url, 'share'), status(403))
    await assert.rejects(bobFS.deleteFileOrFolder(image.url, 'file'), status(403))
    const unrelated = await aliceFS.saveUpload('/', upload(f.bytes, 'private.png'))
    await assert.rejects(bobFS.getImageFile(unrelated.url), status(404))
    for (const other of [f.owner, f.outsider]) await assert.rejects((await useUserFS(other, f.raw, f.db)).getImageFile(image.url), status(404))
    const folder = await aliceFS.createFolder('/', 'Private portraits')
    await assert.rejects(recipient.requireAsset(folder.url!), status(404))
}))

test('future People generation outputs become references only after exact price confirmation, including legitimate zero prices', integration, async () => fixture(async f => {
    const {person} = await sharePerson(f)
    const aliceFS = await useUserFS(f.alice, f.raw, f.db), bobFS = await useUserFS(f.bob, f.raw, f.db)
    const output = await aliceFS.saveGeneratedImage(f.bytes)
    const [generation] = await f.db.insert(systemPrompt).values({organizationId: f.alice.organizationId, userId: f.alice.userId, personId: person.id,
        TextPrompt: 'New angle of Alex', outputImage: output.url, status: 'succeeded', priceUsd: '0.01', priceSource: 'estimate', billingState: 'awaiting'}).returning()
    const before = f.commands.length
    for (const action of [() => bobFS.getImageFile(output.url), () => bobFS.assertReadableImages([output.url]), () => bobFS.getImageForDelivery(output.url, 480, '*')]) {
        await assert.rejects(action(), status(425))
    }
    assert.equal(f.commands.length, before, 'held outputs never request S3 bytes or metadata')
    await f.db.update(systemPrompt).set({priceUsd: '0', priceSource: 'gateway', billingState: 'confirmed'}).where(eq(systemPrompt.id, generation!.id))
    await bobFS.assertReadableImages([output.url])
    assert.equal((await bobFS.getImageFile(output.url)).width, 8)
    const preview = await bobFS.getImageForDelivery(output.url, 160)
    await f.db.update(systemPrompt).set({usageJson: {gatewayBilling: {isByok: true}}}).where(eq(systemPrompt.id, generation!.id))
    await assert.rejects(bobFS.getImageForDelivery(output.url, 160, preview.etag), status(425))
}))

test('People revocation, unlink, profile deletion and disabled accounts deny warm bytes while independent image shares remain valid', integration, async () => fixture(async f => {
    const {repository, person} = await sharePerson(f)
    const aliceFS = await useUserFS(f.alice, f.raw, f.db), bobFS = await useUserFS(f.bob, f.raw, f.db)
    const image = await aliceFS.saveUpload('/', upload(f.bytes))
    await repository.addPhotos(person.id, {urls: [image.url]})
    const preview = await bobFS.getImageForDelivery(image.url, 480)
    await repository.removePhoto(person.id, image.id!)
    await assert.rejects(bobFS.getImageForDelivery(image.url, 480, preview.etag), status(404))
    await repository.addPhotos(person.id, {urls: [image.url]})
    await f.db.delete(personShares).where(eq(personShares.personId, person.id))
    await assert.rejects(bobFS.getImageForDelivery(image.url, 480, preview.etag), status(404))
    await f.db.insert(personShares).values({id: randomUUID(), personId: person.id, organizationId: f.alice.organizationId,
        sharedByUserId: f.alice.userId, recipientUserId: f.bob.userId})
    await f.db.update(users).set({disabledAt: sql`CURRENT_TIMESTAMP`}).where(eq(users.id, f.alice.userId))
    await assert.rejects(bobFS.getImageForDelivery(image.url, 480, preview.etag), status(404))
    await f.db.update(users).set({disabledAt: null}).where(eq(users.id, f.alice.userId))
    await f.db.update(users).set({disabledAt: sql`CURRENT_TIMESTAMP`}).where(eq(users.id, f.bob.userId))
    await assert.rejects(bobFS.getImageFile(image.url), status(404))
    await f.db.update(users).set({disabledAt: null}).where(eq(users.id, f.bob.userId))
    await aliceFS.share(image.id!, f.bob.userId, 'view')
    await repository.remove(person.id)
    assert.equal((await bobFS.getImageForDelivery(image.url, 480, preview.etag)).notModified, true, 'a separate image share survives removal of a People grant')
    await aliceFS.revoke(image.id!, f.bob.userId)
    await assert.rejects(bobFS.getImageForDelivery(image.url, 480, preview.etag), status(404))
    assert.deepEqual((await aliceFS.getImageFile(image.url)).buffer, f.bytes, 'unlink/revoke/delete keep original media')
}))

test('malformed cross-owner and cross-organization People associations cannot authorize images', integration, async () => fixture(async f => {
    const {repository, person} = await sharePerson(f)
    const aliceFS = await useUserFS(f.alice, f.raw, f.db), bobFS = await useUserFS(f.bob, f.raw, f.db)
    const owned = await aliceFS.saveUpload('/', upload(f.bytes)), otherOwnerImage = await (await useUserFS(f.owner, f.raw, f.db)).saveUpload('/', upload(f.bytes))
    await f.db.insert(personPhotos).values({id: randomUUID(), personId: person.id, assetId: otherOwnerImage.id!})
    await assert.rejects(bobFS.getImageFile(otherOwnerImage.url), status(404))
    await repository.addPhotos(person.id, {urls: [owned.url]})
    await f.db.update(personShares).set({sharedByUserId: f.owner.userId}).where(eq(personShares.personId, person.id))
    await assert.rejects(bobFS.getImageFile(owned.url), status(404))
    await f.db.update(personShares).set({sharedByUserId: f.alice.userId, organizationId: f.outsider.organizationId}).where(eq(personShares.personId, person.id))
    await assert.rejects(bobFS.getImageFile(owned.url), status(404))
    await f.db.update(personShares).set({organizationId: f.alice.organizationId}).where(eq(personShares.personId, person.id))
    await f.db.update(people).set({organizationId: f.outsider.organizationId}).where(eq(people.id, person.id))
    await assert.rejects(bobFS.getImageFile(owned.url), status(404))
}))

test('CPU cutout publication locks People grants until commit and refuses a grant revoked during inference', integration, async () => fixture(async f => {
    const {repository, person} = await sharePerson(f)
    const aliceFS = await useUserFS(f.alice, f.raw, f.db), bobFS = await useUserFS(f.bob, f.raw, f.db)
    const image = await aliceFS.saveUpload('/', upload(f.bytes))
    await repository.addPhotos(person.id, {urls: [image.url]})
    const jobs = createBackgroundRemovalRepository(f.db), worker = randomUUID()
    const model = getBackgroundRemovalModel('birefnet-lite')
    const job = await jobs.enqueue(f.bob, {sourceAssetId: image.id!, sourceUrl: image.url, model: model.id, modelVersion: model.version, idempotencyKey: randomUUID()})
    await jobs.claim(worker)
    const staged = await bobFS.prepareProcessedImage(f.bytes), registered = deferred(), release = deferred()
    const completion = jobs.complete(job.id, worker, async tx => {
        const result = await staged.register(tx, {id: image.id!, url: image.url}); registered.resolve(); await release.promise; return result
    })
    await registered.promise
    const revocation = repository.revoke(person.id, f.bob.userId)
    try {
        let blocked = false
        for (let attempt = 0; attempt < 100; attempt++) {
            const state = await f.pool.query<{blocked: boolean}>('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid() AND wait_event_type = \'Lock\') AS blocked', [f.application])
            if (state.rows[0]?.blocked) {blocked = true; break}
            await new Promise(done => setTimeout(done, 10))
        }
        assert.equal(blocked, true, 'owner revocation waits for publication’s account/profile/share locks')
    } finally {release.resolve()}
    assert.equal(await completion, true)
    assert.equal((await jobs.get(f.bob, job.id)).status, 'succeeded')
    await revocation
    await assert.rejects(bobFS.getImageFile(image.url), status(404))
    const rejected = await bobFS.prepareProcessedImage(f.bytes)
    await assert.rejects(f.db.transaction(tx => rejected.register(tx, {id: image.id!, url: image.url})), status(404))
    await rejected.discard()
}))

const sharedPageUrl = new URL('../app/pages/shared.vue', import.meta.url).href
const sharedEnvironmentKey = '__sharedPeoplePageTest'
registerHooks({load(url, context, nextLoad) {
    if (url !== sharedPageUrl) return nextLoad(url, context)
    const filename = fileURLToPath(url)
    const source = readFileSync(filename, 'utf8').replace('</script>', 'defineExpose({view, selectedUrls, usePeopleReferences, referenceLimit})\n</script>')
    const {descriptor} = parse(source, {filename})
    const compiled = compileScript(descriptor, {id: filename, inlineTemplate: true})
    const services = `const definePageMeta = () => {}; const useHead = () => {};
        const useDataStore = () => globalThis.${sharedEnvironmentKey}.store;
        const useAccount = () => globalThis.${sharedEnvironmentKey}.account;
        const navigateTo = async path => {globalThis.${sharedEnvironmentKey}.navigation.push(path)};`
    return {format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(`import {computed, ref, watch, nextTick} from 'vue';\n${services}\n${compiled.content}`)}
}})
async function renderSharedPage(peopleView = false) {
    const store = reactive({models: ['/images/existing.png'], selectedModel: 'google/gemini-3.1-flash-image',
        generationSettings: createDefaultSettings('google/gemini-3.1-flash-image'), editSource: '/images/product.png', inputImages: ['/images/batch.png'], composerPrompt: 'Preserve this creative direction'})
    const environment = {store, account: {epoch: ref(1), identity: ref('studio.alice')}, navigation: [] as string[], exposed: null as any}
    ;(globalThis as any)[sharedEnvironmentKey] = environment
    const {default: Page} = await import(sharedPageUrl)
    const originalSetup = Page.setup
    const component = {...Page, setup(props: unknown, context: any) {
        return originalSetup(props, {...context, expose(value: any) {environment.exposed = value; value.view.value = peopleView ? 'people' : 'images'; context.expose(value)}})
    }}
    const app = createSSRApp({render: () => h(component)})
    app.component('UIcon', {render: () => h('span')})
    app.component('AssetBrowser', {props: ['title', 'initialScope', 'sharedOnly'], setup: (props: any) => () => h('div', {'data-test': 'shared-images', 'data-scope': props.initialScope, 'data-shared': props.sharedOnly})})
    app.component('PeopleBrowser', {props: ['sharedOnly', 'selectedUrls', 'maxSelection'], setup: (props: any) => () => h('div', {'data-test': 'shared-people', 'data-shared': props.sharedOnly, 'data-limit': props.maxSelection})})
    const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
    const html = await renderToString(app)
    assert.deepEqual(warnings, [])
    return {html, ...environment}
}

test('Shared with me retains its image view and exposes a separate accessible People tab with shared-only selection', async () => {
    const images = await renderSharedPage()
    assert.match(images.html, /role="tablist" aria-label="Shared collections"/)
    assert.match(images.html, /id="shared-images-tab"[^>]*aria-selected="true"/)
    assert.match(images.html, /id="shared-people-tab"[^>]*aria-selected="false"/)
    assert.match(images.html, /data-test="shared-images" data-scope="shared" data-shared(?:="")?>/)
    assert.doesNotMatch(images.html, /data-test="shared-people"/)
    const peopleView = await renderSharedPage(true)
    assert.match(peopleView.html, /id="shared-people-tab"[^>]*aria-selected="true"/)
    assert.match(peopleView.html, /id="shared-people-content" role="tabpanel" aria-labelledby="shared-people-tab"/)
    assert.match(peopleView.html, /data-test="shared-people" data-shared(?:="")? data-limit="13"/)
    assert.deepEqual(peopleView.exposed.selectedUrls.value, ['/images/existing.png'])
})

test('Shared People references preserve workspace inputs and reject stale-account, public and over-limit selections', async () => {
    const page = await renderSharedPage(true), settings = JSON.stringify(page.store.generationSettings)
    await page.exposed.usePeopleReferences(['/images/existing.png', '/images/shared-person.png', '/images/shared-person.png'])
    assert.deepEqual(page.store.models, ['/images/existing.png', '/images/shared-person.png'])
    assert.deepEqual(page.navigation, ['/edit'])
    assert.equal(page.store.editSource, '/images/product.png')
    assert.deepEqual(page.store.inputImages, ['/images/batch.png'])
    assert.equal(page.store.composerPrompt, 'Preserve this creative direction')
    assert.equal(JSON.stringify(page.store.generationSettings), settings)
    await page.exposed.usePeopleReferences(['https://example.com/public.png'])
    await page.exposed.usePeopleReferences(Array.from({length: 14}, (_, index) => `/images/portrait-${index}.png`))
    assert.deepEqual(page.navigation, ['/edit'])
    assert.deepEqual(page.store.models, ['/images/existing.png', '/images/shared-person.png'])
    page.account.epoch.value += 1; page.account.identity.value = 'studio.bob'; page.store.models = ['/images/bob.png']
    await page.exposed.usePeopleReferences(['/images/alice-private.png'])
    assert.deepEqual(page.store.models, ['/images/bob.png'])
    assert.deepEqual(page.navigation, ['/edit'])
})
