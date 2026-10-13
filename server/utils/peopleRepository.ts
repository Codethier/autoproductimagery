import {randomUUID} from 'node:crypto'
import {and, asc, count, eq, gt, inArray, isNull, ne, or, sql} from 'drizzle-orm'
import {createError} from 'h3'
import {assets, people, personPhotos, personShares, systemPrompt, users} from '../db/schema'
import {getDatabase} from './lib/db'
import {assetCursorScope, canonicalAssetUrl, createAssetRepository, decodeAssetCursor, encodeAssetCursor, validAssetId, type AssetActor} from './assetAccess'
import {confirmedGenerationPriceCondition} from './generationVisibility'
import {AddPersonPhotosSchema, CreatePersonSchema, PeopleListQuerySchema, PersonPhotosQuerySchema, SharePersonSchema, UpdatePersonSchema, type Person, type PersonPhoto, type PersonShare, type PersonShareTarget} from '../../schemas/people'
import type {AssetSource} from '../../schemas/image-storage'

type Database = ReturnType<typeof getDatabase>
export type PeopleTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type Executor = Database | PeopleTransaction
type Actor = Pick<AssetActor, 'organizationId' | 'userId'> & {authVersion?: number}
const MAX_PEOPLE = 200
const MAX_PERSON_PHOTOS = 200
const scope = (actor: Actor) => and(eq(people.organizationId, actor.organizationId), eq(people.userId, actor.userId), isNull(people.deletedAt))
const enabledActor = (actor: Actor) => sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${actor.userId}
    AND ${users.organizationId} = ${actor.organizationId} AND ${users.disabledAt} IS NULL)`
const enabledProfileOwner = () => sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${people.userId}
    AND ${users.organizationId} = ${people.organizationId} AND ${users.disabledAt} IS NULL)`
const sharedCondition = (actor: Actor) => and(eq(people.organizationId, actor.organizationId), isNull(people.deletedAt), enabledProfileOwner(), enabledActor(actor),
    sql`EXISTS (SELECT 1 FROM ${personShares} WHERE ${personShares.personId} = ${people.id}
        AND ${personShares.organizationId} = ${actor.organizationId} AND ${personShares.recipientUserId} = ${actor.userId}
        AND ${personShares.sharedByUserId} = ${people.userId})`)
const readableCondition = (actor: Actor) => and(eq(people.organizationId, actor.organizationId), isNull(people.deletedAt), enabledProfileOwner(), enabledActor(actor),
    or(eq(people.userId, actor.userId), sharedCondition(actor)))
const notFound = (): never => {throw createError({statusCode: 404, statusMessage: 'Person not found'})}
const ownedAsset = (actor: Actor) => and(eq(assets.organizationId, actor.organizationId), eq(assets.ownerUserId, actor.userId), eq(assets.kind, 'file'), isNull(assets.deletedAt))
const matchingGeneration = (actor: Actor) => and(eq(systemPrompt.organizationId, actor.organizationId), eq(systemPrompt.userId, actor.userId), eq(systemPrompt.outputImage, assets.url))
const visibleGeneration = (actor: Actor) => and(matchingGeneration(actor), confirmedGenerationPriceCondition(), isNull(systemPrompt.outputImageDeletedAt),
    sql`(${systemPrompt.status} = 'succeeded' OR (${systemPrompt.status} IS NULL AND ${systemPrompt.errors} IS NULL))`)

async function activeActor(tx: PeopleTransaction, actor: Actor, accountLock: 'update' | 'share' = 'update') {
    const [row] = await tx.select({id: users.id, authVersion: users.authVersion}).from(users)
        .where(and(eq(users.id, actor.userId), eq(users.organizationId, actor.organizationId), isNull(users.disabledAt))).for(accountLock).limit(1)
    if (!row || actor.authVersion !== undefined && actor.authVersion !== row.authVersion) throw createError({statusCode: 401, statusMessage: 'Unauthorized'})
}
/** Hold this lock through pending-row admission so profile deletion cannot
 * race the ownership check or leave paid work linked to another account. */
export async function lockOwnedPerson(tx: PeopleTransaction, actor: Actor, id: string, accountLock: 'update' | 'share' = 'update') {
    await activeActor(tx, actor, accountLock)
    const [person] = await tx.select().from(people).where(and(eq(people.id, validAssetId(id)), scope(actor))).for('update').limit(1)
    return person ?? notFound()
}
function photoSlots(actor: Actor, personId: string) {
    // Count live image identities once, even when an existing generated image
    // is also attached manually. Unfinished rows reserve a slot before work.
    return sql`SELECT 'asset:' || ${personPhotos.assetId}::text AS identity FROM ${personPhotos}
        JOIN ${assets} ON ${assets.id} = ${personPhotos.assetId}
        WHERE ${personPhotos.personId} = ${personId} AND ${personPhotos.excluded} = false AND ${ownedAsset(actor)}
        UNION SELECT 'asset:' || ${assets.id}::text FROM ${systemPrompt}
        JOIN ${assets} ON ${assets.url} = ${systemPrompt.outputImage}
        WHERE ${systemPrompt.personId} = ${personId} AND ${matchingGeneration(actor)} AND ${ownedAsset(actor)}
            AND ${systemPrompt.status} = 'succeeded' AND ${systemPrompt.outputImageDeletedAt} IS NULL
            AND NOT EXISTS (SELECT 1 FROM ${personPhotos} WHERE ${personPhotos.personId} = ${personId}
                AND ${personPhotos.assetId} = ${assets.id} AND ${personPhotos.excluded} = true)
        UNION SELECT 'pending:' || ${systemPrompt.id}::text FROM ${systemPrompt}
        WHERE ${systemPrompt.personId} = ${personId} AND ${systemPrompt.organizationId} = ${actor.organizationId}
            AND ${systemPrompt.userId} = ${actor.userId} AND ${systemPrompt.status} = 'pending'`
}
export async function assertPersonPhotoCapacity(tx: PeopleTransaction, actor: Actor, id: string, additional: number) {
    const result = await tx.execute<{value: number}>(sql`SELECT count(*)::integer AS value FROM (${photoSlots(actor, id)}) slots`)
    if (Number(result.rows[0]?.value ?? 0) + additional > MAX_PERSON_PHOTOS) throw createError({statusCode: 409, statusMessage: 'A person can have at most 200 pictures. Remove a picture before adding more.'})
}

export function createPeopleRepository(actor: AssetActor & {authVersion?: number}, db: Database = getDatabase()) {
    async function requireOwnedPerson(id: string, executor: Executor = db) {
        const [row] = await executor.select().from(people).where(and(eq(people.id, validAssetId(id)), scope(actor), enabledProfileOwner())).limit(1)
        return row ?? notFound()
    }
    async function requirePerson(id: string, executor: Executor = db) {
        const [row] = await executor.select().from(people).where(and(eq(people.id, validAssetId(id)), readableCondition(actor))).limit(1)
        return row ?? notFound()
    }
    function visiblePhotos(ids: string[]) {
        const selected = sql`(${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`
        return sql`WITH photo_links AS (
            SELECT ${personPhotos.personId} AS person_id, ${personPhotos.assetId} AS asset_id,
                ${people.organizationId} AS organization_id, ${people.userId} AS owner_user_id FROM ${personPhotos}
                JOIN ${people} ON ${people.id} = ${personPhotos.personId} WHERE ${readableCondition(actor)} AND ${people.id} IN ${selected} AND ${personPhotos.excluded} = false
            UNION SELECT ${systemPrompt.personId}, ${assets.id}, ${people.organizationId}, ${people.userId} FROM ${systemPrompt}
                JOIN ${people} ON ${people.id} = ${systemPrompt.personId}
                JOIN ${assets} ON ${assets.url} = ${systemPrompt.outputImage}
                WHERE ${readableCondition(actor)} AND ${people.id} IN ${selected}
                    AND ${systemPrompt.organizationId} = ${people.organizationId} AND ${systemPrompt.userId} = ${people.userId}
                    AND NOT EXISTS (SELECT 1 FROM ${personPhotos} WHERE ${personPhotos.personId} = ${people.id}
                        AND ${personPhotos.assetId} = ${assets.id} AND ${personPhotos.excluded} = true)
        ), visible_photos AS (
            SELECT photo_links.person_id, ${assets.id} AS id, ${assets.url} AS url, ${assets.name} AS name,
                CASE WHEN ${assets.category} = 'processed' THEN '0' ELSE settled.price_usd END AS price_usd,
                CASE WHEN ${assets.category} = 'processed' THEN 'local-processing' ELSE settled.price_source END AS price_source,
                settled.generation_id
            FROM photo_links JOIN ${assets} ON ${assets.id} = photo_links.asset_id
            LEFT JOIN LATERAL (SELECT ${systemPrompt.id} AS generation_id, ${systemPrompt.priceUsd} AS price_usd,
                ${systemPrompt.priceSource} AS price_source FROM ${systemPrompt}
                WHERE ${systemPrompt.organizationId} = photo_links.organization_id AND ${systemPrompt.userId} = photo_links.owner_user_id
                    AND ${systemPrompt.outputImage} = ${assets.url} AND ${confirmedGenerationPriceCondition()}
                    AND ${systemPrompt.outputImageDeletedAt} IS NULL
                    AND (${systemPrompt.status} = 'succeeded' OR (${systemPrompt.status} IS NULL AND ${systemPrompt.errors} IS NULL))
                ORDER BY ${systemPrompt.id} DESC LIMIT 1) settled ON true
            WHERE ${assets.organizationId} = photo_links.organization_id AND ${assets.ownerUserId} = photo_links.owner_user_id
                AND ${assets.kind} = 'file' AND ${assets.deletedAt} IS NULL
                AND (${assets.category} <> 'generated' OR settled.generation_id IS NOT NULL)
        )`
    }
    type PhotoRow = {person_id: string; id: string; url: string; name: string; price_usd: string | null; price_source: string | null; generation_id: number | null; photo_count?: number}
    const photoDto = (row: PhotoRow): PersonPhoto => ({id: row.id, url: row.url, name: row.name, priceUsd: row.price_usd, priceSource: row.price_source, generationId: row.generation_id})
    async function projectPersons(rows: Array<typeof people.$inferSelect>): Promise<Person[]> {
        if (!rows.length) return []
        const otherOwners = [...new Set(rows.map(row => row.userId).filter(id => id !== actor.userId))]
        const [covers, owners] = await Promise.all([db.execute<PhotoRow>(sql`${visiblePhotos(rows.map(row => row.id))}
            SELECT * FROM (SELECT *, count(*) OVER (PARTITION BY person_id)::integer AS photo_count,
                row_number() OVER (PARTITION BY person_id ORDER BY id) AS position FROM visible_photos) ranked WHERE position = 1`),
            otherOwners.length ? db.select({userId: users.id, username: users.username, displayName: users.displayName}).from(users)
                .where(and(inArray(users.id, otherOwners), eq(users.organizationId, actor.organizationId), isNull(users.disabledAt))).limit(50) : Promise.resolve([])])
        const byId = new Map(covers.rows.map(row => [row.person_id, row]))
        const sources = new Map(owners.map(owner => [owner.userId, owner]))
        return rows.map(row => ({id: row.id, ownerUserId: row.userId,
            permissions: {view: true, edit: row.userId === actor.userId, share: row.userId === actor.userId},
            ...(row.userId !== actor.userId && sources.has(row.userId) ? {sharedBy: sources.get(row.userId)!} : {}),
            name: row.name, description: row.description,
            photoCount: Number(byId.get(row.id)?.photo_count ?? 0), cover: byId.has(row.id) ? photoDto(byId.get(row.id)!) : null,
            createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString()}))
    }
    async function list(query: unknown = {}) {
        const parsed = PeopleListQuerySchema.safeParse(query)
        if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid people listing request'})
        const {limit, search, cursor, scope: listScope, sourceId} = parsed.data
        const cursorScope = assetCursorScope(actor, ['people', listScope, sourceId ?? null, search]), after = decodeAssetCursor(cursor, cursorScope)
        const escaped = search.replace(/[\\%_]/g, match => '\\' + match)
        const rows = await db.select().from(people).where(and(listScope === 'shared' ? sharedCondition(actor) : and(scope(actor), enabledProfileOwner()),
            sourceId ? eq(people.userId, sourceId) : undefined, after ? gt(people.id, after) : undefined,
            search ? sql`(${people.name} ILIKE ${'%' + escaped + '%'} OR ${people.description} ILIKE ${'%' + escaped + '%'})` : undefined))
            .orderBy(asc(people.id)).limit(limit + 1)
        const page = rows.slice(0, limit)
        const sources: AssetSource[] = listScope === 'shared' ? await sharedSources() : []
        return {people: await projectPersons(page), nextCursor: rows.length > limit ? encodeAssetCursor(page.at(-1)!.id, cursorScope) : null, sources}
    }
    async function get(id: string, query: unknown = {}) {
        const row = await requirePerson(id)
        const parsed = PersonPhotosQuerySchema.safeParse(query)
        if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid people picture listing request'})
        const {limit, cursor} = parsed.data
        const cursorScope = assetCursorScope(actor, ['person-photos', row.id]), after = decodeAssetCursor(cursor, cursorScope)
        const [projected, result, counts] = await Promise.all([
            projectPersons([row]),
            db.execute<PhotoRow>(sql`${visiblePhotos([row.id])} SELECT * FROM visible_photos ${after ? sql`WHERE id > ${after}::uuid` : sql``} ORDER BY id LIMIT ${limit + 1}`),
            db.select({pendingCount: sql<number>`count(*) FILTER (WHERE ${systemPrompt.status} = 'pending' OR (${systemPrompt.status} = 'succeeded'
                AND ${systemPrompt.outputImageDeletedAt} IS NULL AND NOT COALESCE((${confirmedGenerationPriceCondition()}), false)))::integer`,
                failedCount: sql<number>`count(*) FILTER (WHERE ${systemPrompt.status} = 'failed')::integer`}).from(systemPrompt)
                .where(and(eq(systemPrompt.personId, row.id), eq(systemPrompt.organizationId, row.organizationId), eq(systemPrompt.userId, row.userId))),
        ])
        const page = result.rows.slice(0, limit)
        return {person: projected[0]!, photos: page.map(photoDto), nextCursor: result.rows.length > limit ? encodeAssetCursor(page.at(-1)!.id, cursorScope) : null,
            pendingCount: Number(counts[0]?.pendingCount ?? 0), failedCount: Number(counts[0]?.failedCount ?? 0)}
    }
    async function create(input: unknown) {
        const parsed = CreatePersonSchema.safeParse(input)
        if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'A person needs a name of 1–80 characters and a description of up to 4000 characters'})
        const row = await db.transaction(async tx => {
            await activeActor(tx, actor)
            const [total] = await tx.select({value: count()}).from(people).where(scope(actor))
            if (Number(total?.value ?? 0) >= MAX_PEOPLE) throw createError({statusCode: 409, statusMessage: 'This account can have at most 200 people'})
            const [created] = await tx.insert(people).values({id: randomUUID(), organizationId: actor.organizationId, userId: actor.userId, ...parsed.data}).returning()
            if (!created) throw new Error('Person was not created')
            return created
        })
        return {person: (await projectPersons([row]))[0]!}
    }
    async function update(id: string, input: unknown) {
        const parsed = UpdatePersonSchema.safeParse(input)
        if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid person name or description'})
        const row = await db.transaction(async tx => {
            await lockOwnedPerson(tx, actor, id)
            const [updated] = await tx.update(people).set({...parsed.data, updatedAt: sql`CURRENT_TIMESTAMP`}).where(and(eq(people.id, id), scope(actor))).returning()
            if (!updated) return notFound()
            return updated
        })
        return {person: (await projectPersons([row]))[0]!}
    }
    async function remove(id: string) {
        // Soft deletion avoids updating live paid generation rows/FKs. Their
        // history, charges and stored images survive removal of this profile.
        await db.transaction(async tx => {await lockOwnedPerson(tx, actor, id); await tx.update(people)
            .set({deletedAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP`}).where(and(eq(people.id, id), scope(actor)))})
        return {ok: true as const}
    }
    async function addPhotos(id: string, input: unknown) {
        const parsed = AddPersonPhotosSchema.safeParse(input)
        if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Select between 1 and 20 owned image files'})
        await requireOwnedPerson(id)
        const assetRepository = createAssetRepository(actor, db)
        const photoRows: Array<typeof assets.$inferSelect> = []
        for (const url of new Set(parsed.data.urls)) {
            const {row} = await assetRepository.requireAsset(canonicalAssetUrl(url))
            if (row.kind !== 'file' || row.ownerUserId !== actor.userId) throw createError({statusCode: 403, statusMessage: 'People pictures must be images owned by your account'})
            photoRows.push(row)
        }
        await db.transaction(async tx => {
            await lockOwnedPerson(tx, actor, id)
            const existing = await tx.execute<{identity: string}>(photoSlots(actor, id))
            const attached = new Set(existing.rows.map(row => row.identity))
            await assertPersonPhotoCapacity(tx, actor, id, photoRows.filter(row => !attached.has('asset:' + row.id)).length)
            // Recheck ownership, deletion and settled price under asset locks.
            // Metadata attachment never copies or changes the stored image.
            const available = await tx.select({id: assets.id}).from(assets).where(and(inArray(assets.id, photoRows.map(row => row.id)), ownedAsset(actor),
                sql`(${assets.category} <> 'generated' OR EXISTS (SELECT 1 FROM ${systemPrompt} WHERE ${visibleGeneration(actor)}))`)).for('share')
            if (available.length !== photoRows.length) throw createError({statusCode: 404, statusMessage: 'A selected image is no longer available'})
            await tx.insert(personPhotos).values(photoRows.map(row => ({id: randomUUID(), personId: id, assetId: row.id})))
                .onConflictDoUpdate({target: [personPhotos.personId, personPhotos.assetId], set: {excluded: false}})
            await tx.update(people).set({updatedAt: sql`CURRENT_TIMESTAMP`}).where(and(eq(people.id, id), scope(actor)))
        })
        return get(id)
    }
    async function removePhoto(id: string, assetId: string) {
        validAssetId(assetId)
        await db.transaction(async tx => {
            await lockOwnedPerson(tx, actor, id)
            const [image] = await tx.select({url: assets.url}).from(assets).where(and(eq(assets.id, assetId),
                eq(assets.organizationId, actor.organizationId), eq(assets.ownerUserId, actor.userId), eq(assets.kind, 'file'))).limit(1)
            if (!image) return
            const [manual] = await tx.select({id: personPhotos.id}).from(personPhotos)
                .where(and(eq(personPhotos.personId, id), eq(personPhotos.assetId, assetId))).limit(1)
            const [generated] = await tx.select({id: systemPrompt.id}).from(systemPrompt).where(and(eq(systemPrompt.personId, id),
                eq(systemPrompt.organizationId, actor.organizationId), eq(systemPrompt.userId, actor.userId), eq(systemPrompt.outputImage, image.url))).limit(1)
            if (!manual && !generated) return
            // A marker excludes both manual and generated associations without
            // taking a lock on a billing row while holding the account lock.
            await tx.insert(personPhotos).values({id: randomUUID(), personId: id, assetId, excluded: true})
                .onConflictDoUpdate({target: [personPhotos.personId, personPhotos.assetId], set: {excluded: true}})
            await tx.update(people).set({updatedAt: sql`CURRENT_TIMESTAMP`}).where(and(eq(people.id, id), scope(actor)))
        })
        return {ok: true as const}
    }
    async function sharedSources(): Promise<AssetSource[]> {
        return db.selectDistinct({userId: users.id, username: users.username, displayName: users.displayName}).from(personShares)
            .innerJoin(people, eq(people.id, personShares.personId)).innerJoin(users, eq(users.id, people.userId))
            .where(and(sharedCondition(actor), eq(personShares.organizationId, actor.organizationId), eq(personShares.recipientUserId, actor.userId),
                eq(personShares.sharedByUserId, people.userId), isNull(users.disabledAt)))
            .orderBy(asc(users.displayName), asc(users.id)).limit(200)
    }
    async function shareTargets(): Promise<PersonShareTarget[]> {
        return db.select({id: users.id, username: users.username, displayName: users.displayName}).from(users)
            .where(and(eq(users.organizationId, actor.organizationId), ne(users.id, actor.userId), isNull(users.disabledAt)))
            .orderBy(asc(users.displayName), asc(users.id)).limit(200)
    }
    async function sharesFor(id: string): Promise<PersonShare[]> {
        await requireOwnedPerson(id)
        const rows = await db.select({id: personShares.id, recipientUserId: personShares.recipientUserId,
            username: users.username, displayName: users.displayName, createdAt: personShares.createdAt}).from(personShares)
            .innerJoin(users, eq(users.id, personShares.recipientUserId)).where(and(eq(personShares.personId, id),
                eq(personShares.organizationId, actor.organizationId), eq(personShares.sharedByUserId, actor.userId), eq(users.organizationId, actor.organizationId)))
            .orderBy(asc(users.displayName), asc(users.id)).limit(200)
        return rows.map(row => ({...row, permission: 'view', createdAt: new Date(row.createdAt).toISOString()}))
    }
    async function share(id: string, input: unknown) {
        const parsed = SharePersonSchema.safeParse(input)
        if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Select a valid organization member'})
        await db.transaction(async tx => {
            // Inserting a share also takes recipient FK KEY SHARE locks.
            // Compatible account SHARE locks, acquired in UUID order before
            // the profile lock, avoid reciprocal owner/recipient deadlocks
            // while still serializing account disablement and version changes.
            const accounts = await tx.select({id: users.id}).from(users).where(and(eq(users.organizationId, actor.organizationId),
                inArray(users.id, [...new Set([actor.userId, parsed.data.recipientUserId])]), isNull(users.disabledAt)))
                .orderBy(asc(users.id)).for('share')
            await lockOwnedPerson(tx, actor, id, 'share')
            const recipient = accounts.find(user => user.id === parsed.data.recipientUserId && user.id !== actor.userId)
            if (!recipient) throw createError({statusCode: 404, statusMessage: 'Organization member not found'})
            const [total] = await tx.select({value: count()}).from(personShares).where(eq(personShares.personId, id))
            const [existing] = await tx.select({id: personShares.id}).from(personShares)
                .where(and(eq(personShares.personId, id), eq(personShares.recipientUserId, recipient.id))).limit(1)
            if (!existing && Number(total?.value ?? 0) >= 200) throw createError({statusCode: 409, statusMessage: 'This person has reached the sharing limit'})
            await tx.insert(personShares).values({id: randomUUID(), personId: id, organizationId: actor.organizationId,
                sharedByUserId: actor.userId, recipientUserId: recipient.id}).onConflictDoNothing()
        })
        return {shares: await sharesFor(id)}
    }
    async function revoke(id: string, recipientUserId: string) {
        validAssetId(recipientUserId)
        await db.transaction(async tx => {
            await lockOwnedPerson(tx, actor, id, 'share')
            await tx.delete(personShares).where(and(eq(personShares.personId, id), eq(personShares.organizationId, actor.organizationId),
                eq(personShares.sharedByUserId, actor.userId), eq(personShares.recipientUserId, recipientUserId)))
        })
        return {ok: true as const}
    }
    return {list, get, create, update, remove, addPhotos, removePhoto, requirePerson, requireOwnedPerson, sharedSources, shareTargets, sharesFor, share, revoke}
}

export function peopleRequestError(error: unknown): never {
    const status = (error as {statusCode?: number})?.statusCode
    if (status && [400, 401, 403, 404, 409, 413, 415, 425, 429].includes(status)) throw error
    throw createError({statusCode: 503, statusMessage: 'People are temporarily unavailable'})
}
