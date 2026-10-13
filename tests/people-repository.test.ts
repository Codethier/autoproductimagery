import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {Pool} from 'pg'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {count, eq, sql} from 'drizzle-orm'
import {assets, organizations, people, personPhotos, personShares, systemPrompt, users, accountGenerationCharges} from '../server/db/schema.ts'
import {createAssetRepository, type AssetActor} from '../server/utils/assetAccess.ts'
import {createPeopleRepository, peopleRequestError} from '../server/utils/peopleRepository.ts'
import {getDatabasePoolConfig} from '../server/utils/lib/db.ts'
import {useDB} from '../server/utils/useDB.ts'
import {CreatePersonSchema, UpdatePersonSchema, AddPersonPhotosSchema, PeopleListQuerySchema, PersonPhotosQuerySchema, SharePersonSchema} from '../schemas/people.ts'
import {createDefaultSettings, ImageGenerationRequestSchema} from '../schemas/image-generation.ts'

const integration = {skip: !process.env.TEST_DATABASE_URL, timeout: 60_000}
const status = (code: number) => (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === code)
const actor = (organizationId: string, username: string, role: 'owner' | 'user' = 'user'): AssetActor => ({organizationId, userId: randomUUID(), username, displayName: username, role})
type Database = ReturnType<typeof drizzle>
async function fixture(work: (f: {db: Database; alice: AssetActor; bob: AssetActor; owner: AssetActor; outsider: AssetActor; queries: string[]}) => Promise<void>) {
    const connectionString = process.env.TEST_DATABASE_URL!
    const schema = `imagery_people_${randomUUID().replaceAll('-', '')}`
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
    return createAssetRepository(actor, db).register({ownerUserId: actor.userId, parentId: null, name: 'person.png', kind: 'file', category,
        url: `/images/organizations/${actor.organizationId}/users/${actor.userId}/objects/${randomUUID()}/person.png`,
        byteSize: 1200, mimeType: 'image/png', width: 40, height: 30})
}
async function output(db: Database, actor: AssetActor, personId: string, values: Partial<typeof systemPrompt.$inferInsert> = {}) {
    const image = await sourceImage(db, actor, 'generated')
    const [generation] = await db.insert(systemPrompt).values({organizationId: actor.organizationId, userId: actor.userId, personId,
        TextPrompt: 'A studio portrait', outputImage: image.url, status: 'succeeded', priceUsd: '0.04', priceSource: 'gateway', billingState: 'confirmed', ...values}).returning()
    return {image, generation: generation!}
}
const pendingData = (personId?: string, batchId = randomUUID()) => ({personId, batchId, prompt: 'Studio portrait', inputImages: [], modelImages: [],
    requestedModel: 'google/gemini-3.1-flash-image', effectiveModel: 'google/gemini-3.1-flash-image',
    generationConfig: {schemaVersion: 1 as const, profileVersion: 1, requestedModel: 'google/gemini-3.1-flash-image',
        effectiveModel: 'google/gemini-3.1-flash-image' as const, settings: createDefaultSettings('google/gemini-3.1-flash-image'), storeInputImages: true}})

test('people schemas enforce bounded names, descriptions, strict JSON, query bounds and factory output counts', () => {
    assert.deepEqual(CreatePersonSchema.parse({name: '  Ada  '}), {name: 'Ada', description: ''})
    for (const value of [{name: ''}, {name: 'x'.repeat(81)}, {name: 'Ada', description: 'x'.repeat(4001)}, {name: 'Ada', userId: randomUUID()}]) {
        assert.equal(CreatePersonSchema.safeParse(value).success, false)
    }
    assert.equal(UpdatePersonSchema.safeParse({}).success, false)
    assert.equal(UpdatePersonSchema.safeParse({description: ''}).success, true)
    assert.equal(AddPersonPhotosSchema.safeParse({urls: []}).success, false)
    assert.equal(AddPersonPhotosSchema.safeParse({urls: Array.from({length: 21}, () => '/images/a.png')}).success, false)
    assert.deepEqual(PeopleListQuerySchema.parse({}), {limit: 30, search: '', scope: 'mine'})
    for (const query of [{limit: 51}, {limit: 0}, {search: 'x'.repeat(101)}, {cursor: 'x'.repeat(513)}, {unknown: true}]) {
        assert.equal(PeopleListQuerySchema.safeParse(query).success, false)
    }
    assert.equal(PersonPhotosQuerySchema.safeParse({limit: '40'}).success, true)
    assert.equal(PeopleListQuerySchema.safeParse({scope: 'shared', sourceId: randomUUID()}).success, true)
    assert.equal(PeopleListQuerySchema.safeParse({sourceId: randomUUID()}).success, false)
    assert.equal(SharePersonSchema.safeParse({recipientUserId: randomUUID(), permission: 'edit'}).success, false)
    const request = {prompt: 'Portrait', model: 'openai/gpt-image-2', inputImages: [], settings: createDefaultSettings('openai/gpt-image-2'), personId: randomUUID(), personPictureCount: 4}
    assert.equal(ImageGenerationRequestSchema.safeParse(request).success, true)
    assert.equal(ImageGenerationRequestSchema.safeParse({...request, settings: {...request.settings, numberOfImages: 2}}).success, false)
    assert.throws(() => peopleRequestError(new Error('postgres://private:secret@host/db')), status(503))
})

test('people profiles are private across organization users and owner accounts', integration, async () => fixture(async f => {
    const repository = createPeopleRepository(f.alice, f.db)
    const created = await repository.create({name: 'Ada', description: 'Warm studio portraits'})
    assert.equal(created.person.photoCount, 0)
    assert.equal(created.person.cover, null)
    assert.equal((await repository.list()).people.length, 1)
    for (const other of [f.bob, f.owner, f.outsider]) {
        const privateRepository = createPeopleRepository(other, f.db)
        assert.equal((await privateRepository.list()).people.length, 0)
        await assert.rejects(() => privateRepository.get(created.person.id), status(404))
        await assert.rejects(() => privateRepository.update(created.person.id, {name: 'Changed'}), status(404))
        await assert.rejects(() => privateRepository.remove(created.person.id), status(404))
    }
    await repository.update(created.person.id, {name: 'Ada Lovelace', description: ''})
    assert.equal((await repository.get(created.person.id)).person.name, 'Ada Lovelace')
}))

test('people gallery reveals only live confirmed generated images including zero-price images', integration, async () => fixture(async f => {
    const repository = createPeopleRepository(f.alice, f.db), person = (await repository.create({name: 'Ada'})).person
    const zero = await output(f.db, f.alice, person.id, {priceUsd: '0'})
    const awaiting = await output(f.db, f.alice, person.id, {priceUsd: '0.01', priceSource: 'estimate', billingState: 'awaiting'})
    await output(f.db, f.alice, person.id, {priceUsd: null, priceSource: null, billingState: null})
    await output(f.db, f.alice, person.id, {priceUsd: '0.01', usageJson: {gatewayBilling: {isByok: true}}})
    const deleted = await output(f.db, f.alice, person.id)
    await f.db.update(assets).set({deletedAt: sql`CURRENT_TIMESTAMP`}).where(eq(assets.id, deleted.image.id))
    await output(f.db, f.alice, person.id, {outputImageDeletedAt: new Date().toISOString()})
    await f.db.insert(systemPrompt).values([{...pendingData(person.id), organizationId: f.alice.organizationId, userId: f.alice.userId, TextPrompt: 'Queued portrait', outputImage: '', status: 'pending'},
        {organizationId: f.alice.organizationId, userId: f.alice.userId, personId: person.id, TextPrompt: 'Failed portrait', outputImage: '', status: 'failed', errors: 'Provider failed'}])
    const page = await repository.get(person.id)
    assert.equal(page.person.photoCount, 1)
    assert.equal(page.photos[0]!.id, zero.image.id)
    assert.equal(page.photos[0]!.priceUsd, '0')
    assert.equal(page.person.cover!.url, zero.image.url)
    assert.equal(page.pendingCount, 4)
    assert.equal(page.failedCount, 1)
    assert.ok(!JSON.stringify(page).includes(awaiting.image.url))
    await f.db.update(systemPrompt).set({priceUsd: '0.03', priceSource: 'gateway', billingState: 'confirmed'}).where(eq(systemPrompt.id, awaiting.generation.id))
    assert.equal((await repository.get(person.id)).person.photoCount, 2)
    assert.equal((await repository.list()).people[0]!.photoCount, 2)
}))

test('photo attachment is owned-only, idempotent and rejects unpriced generated media', integration, async () => fixture(async f => {
    const repository = createPeopleRepository(f.alice, f.db), person = (await repository.create({name: 'Ada'})).person
    const owned = await sourceImage(f.db, f.alice), shared = await sourceImage(f.db, f.bob)
    await createAssetRepository(f.bob, f.db).share(shared.id, f.alice.userId, 'view')
    await assert.rejects(() => repository.addPhotos(person.id, {urls: [shared.url]}), status(403))
    const pending = await output(f.db, f.alice, person.id, {billingState: 'awaiting', priceSource: 'estimate'})
    await assert.rejects(() => repository.addPhotos(person.id, {urls: [pending.image.url]}), status(425))
    await repository.addPhotos(person.id, {urls: [owned.url, owned.url]})
    await repository.addPhotos(person.id, {urls: [owned.url]})
    assert.equal((await repository.get(person.id)).photos.length, 1)
    await f.db.update(assets).set({deletedAt: sql`CURRENT_TIMESTAMP`}).where(eq(assets.id, owned.id))
    assert.equal((await repository.get(person.id)).person.photoCount, 0)
}))

test('unlink markers and profile deletion preserve generated images and billing history', integration, async () => fixture(async f => {
    const repository = createPeopleRepository(f.alice, f.db), person = (await repository.create({name: 'Ada'})).person
    const generated = await output(f.db, f.alice, person.id)
    await repository.addPhotos(person.id, {urls: [generated.image.url]})
    assert.equal((await repository.get(person.id)).person.photoCount, 1)
    await repository.removePhoto(person.id, generated.image.id)
    assert.equal((await repository.get(person.id)).person.photoCount, 0)
    const [linked] = await f.db.select().from(systemPrompt).where(eq(systemPrompt.id, generated.generation.id))
    assert.equal(linked!.personId, person.id)
    assert.equal(linked!.priceUsd, '0.04')
    const [marker] = await f.db.select().from(personPhotos).where(eq(personPhotos.personId, person.id))
    assert.equal(marker!.excluded, true)
    await repository.addPhotos(person.id, {urls: [generated.image.url]})
    assert.equal((await repository.get(person.id)).person.photoCount, 1)
    await repository.remove(person.id)
    await assert.rejects(() => repository.get(person.id), status(404))
    assert.equal((await repository.list()).people.length, 0)
    const [preservedImage] = await f.db.select().from(assets).where(eq(assets.id, generated.image.id))
    assert.equal(preservedImage!.deletedAt, null)
    assert.equal((await f.db.select().from(systemPrompt).where(eq(systemPrompt.id, generated.generation.id)))[0]!.personId, person.id)
}))

test('people and photo pagination is SQL-bounded, stable and owner/query scoped', integration, async () => fixture(async f => {
    const repository = createPeopleRepository(f.alice, f.db)
    const ids = []
    for (const name of ['Ada', 'Ada Two', 'Ada Three', 'Other']) ids.push((await repository.create({name})).person.id)
    f.queries.length = 0
    const first = await repository.list({search: 'Ada', limit: 2})
    assert.equal(first.people.length, 2)
    assert.ok(first.nextCursor)
    assert.ok(f.queries[0]!.toLowerCase().includes('limit'))
    assert.ok(f.queries.length <= 2)
    const next = await repository.list({search: 'Ada', limit: 2, cursor: first.nextCursor!})
    assert.equal(next.people.length, 1)
    assert.equal(next.nextCursor, null)
    assert.equal(new Set([...first.people, ...next.people].map(row => row.id)).size, 3)
    await assert.rejects(() => repository.list({search: 'Other', cursor: first.nextCursor!}), status(400))
    await assert.rejects(() => createPeopleRepository(f.bob, f.db).list({search: 'Ada', cursor: first.nextCursor!}), status(400))
    const personId = ids[0]!
    for (let index = 0; index < 3; index++) {const source = await sourceImage(f.db, f.alice); await repository.addPhotos(personId, {urls: [source.url]})}
    const photos = await repository.get(personId, {limit: 2})
    assert.equal(photos.photos.length, 2)
    assert.ok(photos.nextCursor)
    const tail = await repository.get(personId, {limit: 2, cursor: photos.nextCursor!})
    assert.equal(tail.photos.length, 1)
    assert.equal(tail.nextCursor, null)
    assert.equal(photos.person.photoCount, 3)
}))

test('pending generation linkage enforces private ownership atomically and survives removed profiles after paid work', integration, async () => fixture(async f => {
    const repository = createPeopleRepository(f.alice, f.db), person = (await repository.create({name: 'Ada'})).person
    const database = await useDB(f.db, f.alice), otherDatabase = await useDB(f.db, f.owner), unscoped = await useDB(f.db)
    await assert.rejects(() => otherDatabase.createPendingGeneration(pendingData(person.id)), status(404))
    await assert.rejects(() => unscoped.createPendingGeneration(pendingData(person.id)), status(400))
    const data = pendingData(person.id)
    const row = await database.createPendingGeneration(data)
    assert.equal(row.personId, person.id)
    assert.equal((await repository.get(person.id)).pendingCount, 1)
    await repository.remove(person.id)
    await assert.rejects(() => database.createPendingGeneration(pendingData(person.id)), status(404))
    const extraPaid = await database.createPendingGeneration(data)
    assert.equal(extraPaid.personId, null)
    assert.equal(extraPaid.batchId, row.batchId)
    const [charges] = await f.db.select({value: count()}).from(accountGenerationCharges)
    assert.equal(Number(charges!.value), 2)
    await f.db.update(users).set({disabledAt: sql`CURRENT_TIMESTAMP`}).where(eq(users.id, f.alice.userId))
    await assert.rejects(() => repository.create({name: 'Disabled'}), status(401))
}))

test('profile and picture caps serialize simultaneous admission and count generated/manual identities once', integration, async () => fixture(async f => {
    const repository = createPeopleRepository(f.alice, f.db)
    await f.db.insert(people).values(Array.from({length: 199}, (_, index) => ({id: randomUUID(), organizationId: f.alice.organizationId, userId: f.alice.userId, name: `Person ${index}`})))
    const creations = await Promise.allSettled([repository.create({name: 'Last one'}), repository.create({name: 'Too many'})])
    assert.equal(creations.filter(result => result.status === 'fulfilled').length, 1)
    const person = (creations.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof repository.create>>>).value.person
    const photoRows = Array.from({length: 200}, () => ({id: randomUUID(), organizationId: f.alice.organizationId, ownerUserId: f.alice.userId, createdByUserId: f.alice.userId,
        name: 'person.png', kind: 'file' as const, category: 'uploaded' as const, url: `/images/organizations/${f.alice.organizationId}/users/${f.alice.userId}/objects/${randomUUID()}/person.png`, mimeType: 'image/png', width: 40, height: 30}))
    await f.db.insert(assets).values(photoRows)
    await f.db.insert(personPhotos).values(photoRows.map(row => ({id: randomUUID(), personId: person.id, assetId: row.id})))
    await repository.addPhotos(person.id, {urls: [photoRows[0]!.url]})
    const newImage = await sourceImage(f.db, f.alice)
    await assert.rejects(() => repository.addPhotos(person.id, {urls: [newImage.url]}), status(409))
    await assert.rejects(() => (async () => (await useDB(f.db, f.alice)).createPendingGeneration(pendingData(person.id)))(), status(409))
    await repository.removePhoto(person.id, photoRows[0]!.id)
    await repository.addPhotos(person.id, {urls: [newImage.url]})
    assert.equal((await repository.get(person.id)).person.photoCount, 200)
}))

test('profile removal finishes while generation settlement holds its output row, then exact credit posting succeeds', integration, async () => fixture(async f => {
    const repository = createPeopleRepository(f.alice, f.db), person = (await repository.create({name: 'Ada'})).person
    await f.db.update(users).set({creditBalanceUnits: '1000000000000'}).where(eq(users.id, f.alice.userId))
    const database = await useDB(f.db, f.alice), row = await database.createPendingGeneration(pendingData(person.id))
    const image = await sourceImage(f.db, f.alice, 'generated')
    let locked!: () => void, release!: () => void
    const rowLocked = new Promise<void>(resolve => {locked = resolve}), proceed = new Promise<void>(resolve => {release = resolve})
    // Pause the real completed-row UPDATE before recordGenerationCharge takes
    // its account lock. Deletion must finish without locking that billing row.
    const pausedDb = new Proxy(f.db, {get(target, property) {
        if (property !== 'transaction') {
            const value = Reflect.get(target, property)
            return typeof value === 'function' ? value.bind(target) : value
        }
        return (work: any) => target.transaction(tx => work(new Proxy(tx, {get(executor, operation) {
            const value = Reflect.get(executor, operation)
            if (operation !== 'update') return typeof value === 'function' ? value.bind(executor) : value
            return (table: unknown) => {
                const intercept = (builder: any): any => new Proxy(builder, {get(chain, method) {
                    const original = Reflect.get(chain, method)
                    if (typeof original !== 'function') return original
                    if (method === 'returning' && table === systemPrompt) return async (...args: any[]) => {
                        const result = await original.apply(chain, args)
                        locked(); await proceed
                        return result
                    }
                    return (...args: any[]) => intercept(original.apply(chain, args))
                }})
                return intercept(value.call(executor, table))
            }
        }})))
    }})
    const settlement = (await useDB(pausedDb, f.alice)).completeGeneration(row.id, {outputImage: image.url,
        outputMetadata: {mimeType: 'image/png', bytes: 1200, width: 40, height: 30, warnings: []},
        billing: {priceUsd: '0.25', priceSource: 'gateway', gatewayGenerationId: 'gen_test_concurrent_people', usageJson: {gatewayBilling: {isByok: false}}},
        log: {status: 'succeeded', model: 'google/gemini-3.1-flash-image', prompt: 'Portrait'}})
    try {
        await rowLocked
        await repository.remove(person.id)
    } finally {release()}
    assert.equal((await settlement).row.billingState, 'confirmed')
    const [user] = await f.db.select().from(users).where(eq(users.id, f.alice.userId))
    assert.equal(user!.creditBalanceUnits, '750000000000')
    const [charge] = await f.db.select().from(accountGenerationCharges).where(eq(accountGenerationCharges.generationId, row.id))
    assert.equal(charge!.confirmedUnits, '250000000000')
    assert.equal((await f.db.select().from(assets).where(eq(assets.id, image.id)))[0]!.deletedAt, null)
    await assert.rejects(() => repository.get(person.id), status(404))
}))

test('same-organization people sharing is idempotent, readable and strictly view-only for recipients', integration, async () => fixture(async f => {
    const ownerRepository = createPeopleRepository(f.alice, f.db), recipientRepository = createPeopleRepository(f.bob, f.db)
    const person = (await ownerRepository.create({name: 'Ada', description: 'Portrait reference'})).person
    const original = await output(f.db, f.alice, person.id)
    await assert.rejects(() => recipientRepository.get(person.id), status(404))
    const shared = await Promise.all([ownerRepository.share(person.id, {recipientUserId: f.bob.userId}), ownerRepository.share(person.id, {recipientUserId: f.bob.userId})])
    assert.equal(shared[0]!.shares.length, 1)
    assert.equal(shared[0]!.shares[0]!.id, shared[1]!.shares[0]!.id)
    assert.equal(shared[0]!.shares[0]!.permission, 'view')
    assert.equal((await recipientRepository.list()).people.length, 0)
    const listing = await recipientRepository.list({scope: 'shared'})
    assert.equal(listing.people.length, 1)
    assert.deepEqual(listing.people[0]!.permissions, {view: true, edit: false, share: false})
    assert.equal(listing.people[0]!.ownerUserId, f.alice.userId)
    assert.deepEqual(listing.people[0]!.sharedBy, {userId: f.alice.userId, username: f.alice.username, displayName: f.alice.displayName})
    assert.deepEqual(listing.sources, [listing.people[0]!.sharedBy])
    const detail = await recipientRepository.get(person.id)
    assert.equal(detail.photos[0]!.id, original.image.id)
    assert.equal(detail.photos[0]!.priceUsd, '0.04')
    for (const mutate of [() => recipientRepository.update(person.id, {name: 'Changed'}), () => recipientRepository.remove(person.id),
        () => recipientRepository.addPhotos(person.id, {urls: [original.image.url]}), () => recipientRepository.removePhoto(person.id, original.image.id),
        () => recipientRepository.sharesFor(person.id), () => recipientRepository.share(person.id, {recipientUserId: f.owner.userId}),
        () => recipientRepository.revoke(person.id, f.bob.userId), () => recipientRepository.requireOwnedPerson(person.id)]) {
        await assert.rejects(mutate, status(404))
    }
    await assert.rejects(() => (async () => (await useDB(f.db, f.bob)).createPendingGeneration(pendingData(person.id)))(), status(404))
    await assert.rejects(() => createPeopleRepository(f.owner, f.db).get(person.id), status(404))
    await assert.rejects(() => createPeopleRepository(f.outsider, f.db).get(person.id), status(404))
}))

test('people share targets enforce enabled organization membership, owner control and strict recipient requests', integration, async () => fixture(async f => {
    const repository = createPeopleRepository(f.alice, f.db), person = (await repository.create({name: 'Ada'})).person
    const targets = await repository.shareTargets()
    assert.deepEqual(new Set(targets.map(row => row.id)), new Set([f.bob.userId, f.owner.userId]))
    for (const recipientUserId of [f.alice.userId, f.outsider.userId, randomUUID()]) await assert.rejects(() => repository.share(person.id, {recipientUserId}), status(404))
    await assert.rejects(() => repository.share(person.id, {recipientUserId: f.bob.userId, permission: 'edit'}), status(400))
    await f.db.update(users).set({disabledAt: sql`CURRENT_TIMESTAMP`}).where(eq(users.id, f.bob.userId))
    await assert.rejects(() => repository.share(person.id, {recipientUserId: f.bob.userId}), status(404))
    assert.equal((await repository.shareTargets()).some(row => row.id === f.bob.userId), false)
    assert.equal((await f.db.select().from(personShares)).length, 0)
}))

test('shared people expose future settled photos and withdraw unlinked, expired, revoked and deleted access', integration, async () => fixture(async f => {
    const owner = createPeopleRepository(f.alice, f.db), reader = createPeopleRepository(f.bob, f.db), person = (await owner.create({name: 'Ada'})).person
    await owner.share(person.id, {recipientUserId: f.bob.userId})
    const awaiting = await output(f.db, f.alice, person.id, {billingState: 'awaiting', priceSource: 'estimate', priceUsd: '0.01'})
    let view = await reader.get(person.id)
    assert.equal(view.person.photoCount, 0)
    assert.equal(view.pendingCount, 1)
    assert.ok(!JSON.stringify(view).includes(awaiting.image.url))
    await f.db.update(systemPrompt).set({billingState: 'confirmed', priceSource: 'gateway', priceUsd: '0'}).where(eq(systemPrompt.id, awaiting.generation.id))
    assert.equal((await reader.get(person.id)).photos[0]!.priceUsd, '0')
    await owner.removePhoto(person.id, awaiting.image.id)
    assert.equal((await reader.get(person.id)).photos.length, 0)
    await owner.addPhotos(person.id, {urls: [awaiting.image.url]})
    assert.equal((await reader.get(person.id)).photos.length, 1)
    await f.db.update(systemPrompt).set({outputImageDeletedAt: sql`CURRENT_TIMESTAMP`}).where(eq(systemPrompt.id, awaiting.generation.id))
    assert.equal((await reader.get(person.id)).photos.length, 0)
    await owner.revoke(person.id, f.bob.userId)
    await assert.rejects(() => reader.get(person.id), status(404))
    assert.equal((await reader.list({scope: 'shared'})).people.length, 0)
    await owner.share(person.id, {recipientUserId: f.bob.userId})
    await owner.remove(person.id)
    await assert.rejects(() => reader.get(person.id), status(404))
    assert.equal((await reader.list({scope: 'shared'})).sources.length, 0)
    assert.equal((await f.db.select().from(assets).where(eq(assets.id, awaiting.image.id)))[0]!.deletedAt, null)
}))

test('disabled owners/recipients and forged cross-owner grants cannot expose people', integration, async () => fixture(async f => {
    const owner = createPeopleRepository(f.alice, f.db), reader = createPeopleRepository(f.bob, f.db), person = (await owner.create({name: 'Ada'})).person
    await output(f.db, f.alice, person.id)
    await owner.share(person.id, {recipientUserId: f.bob.userId})
    await f.db.update(users).set({disabledAt: sql`CURRENT_TIMESTAMP`}).where(eq(users.id, f.alice.userId))
    await assert.rejects(() => reader.get(person.id), status(404))
    assert.equal((await reader.list({scope: 'shared'})).people.length, 0)
    await f.db.update(users).set({disabledAt: null}).where(eq(users.id, f.alice.userId))
    await f.db.update(users).set({disabledAt: sql`CURRENT_TIMESTAMP`}).where(eq(users.id, f.bob.userId))
    await assert.rejects(() => reader.get(person.id), status(404))
    await f.db.update(users).set({disabledAt: null}).where(eq(users.id, f.bob.userId))
    await f.db.update(personShares).set({sharedByUserId: f.owner.userId}).where(eq(personShares.personId, person.id))
    await assert.rejects(() => reader.get(person.id), status(404))
    assert.equal((await reader.list({scope: 'shared'})).sources.length, 0)
}))

test('shared people source grouping and cursors stay recipient/scope/source bound', integration, async () => fixture(async f => {
    const alice = createPeopleRepository(f.alice, f.db), owner = createPeopleRepository(f.owner, f.db), reader = createPeopleRepository(f.bob, f.db)
    for (const repository of [alice, alice, owner]) {
        const person = (await repository.create({name: 'Portrait'})).person
        await repository.share(person.id, {recipientUserId: f.bob.userId})
    }
    const page = await reader.list({scope: 'shared', sourceId: f.alice.userId, limit: 1})
    assert.equal(page.people.length, 1)
    assert.equal(page.people[0]!.ownerUserId, f.alice.userId)
    assert.deepEqual(new Set(page.sources.map(row => row.userId)), new Set([f.alice.userId, f.owner.userId]))
    assert.ok(page.nextCursor)
    assert.equal((await reader.list({scope: 'shared', sourceId: f.alice.userId, cursor: page.nextCursor!, limit: 1})).people.length, 1)
    await assert.rejects(() => reader.list({scope: 'shared', sourceId: f.owner.userId, cursor: page.nextCursor!}), status(400))
    await assert.rejects(() => reader.list({scope: 'mine', cursor: page.nextCursor!}), status(400))
    await assert.rejects(() => createPeopleRepository(f.owner, f.db).list({scope: 'shared', sourceId: f.alice.userId, cursor: page.nextCursor!}), status(400))
}))

test('reciprocal people sharing completes without taking recipient account locks', integration, async () => fixture(async f => {
    const alice = createPeopleRepository(f.alice, f.db), bob = createPeopleRepository(f.bob, f.db)
    const first = (await alice.create({name: 'Ada'})).person, second = (await bob.create({name: 'Bea'})).person
    const result = await Promise.all([alice.share(first.id, {recipientUserId: f.bob.userId}), bob.share(second.id, {recipientUserId: f.alice.userId})])
    assert.equal(result[0]!.shares.length, 1)
    assert.equal(result[1]!.shares.length, 1)
    assert.equal((await alice.list({scope: 'shared'})).people[0]!.id, second.id)
    assert.equal((await bob.list({scope: 'shared'})).people[0]!.id, first.id)
}))
