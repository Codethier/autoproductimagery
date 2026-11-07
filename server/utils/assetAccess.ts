import {createHash, randomUUID} from 'node:crypto'
import {createError} from 'h3'
import {and, asc, eq, gt, inArray, isNull, ne, sql, type SQLWrapper} from 'drizzle-orm'
import {alias} from 'drizzle-orm/pg-core'
import {assets, assetShares, users, systemPrompt, people, personPhotos, personShares} from '../db/schema'
import {confirmedGenerationPriceCondition} from './generationVisibility'
import {getDatabase} from './lib/db'
import {imagePathToUrl, parseImagePath, validateImagePathSegment} from './imageStoragePaths'
import type {AssetFile, AssetFolder, AssetPermissions, AssetSource} from '../../schemas/image-storage'

export type AssetActor = {userId: string; organizationId: string; username: string; displayName: string; role: 'owner' | 'user'}
export type AssetRecord = typeof assets.$inferSelect
export type PeoplePhotoGrant = {personId: string; shareId: string; ownerUserId: string}
export type OwnedImageMetadata = {id: string; url: string; name: string; priceUsd: string | null; priceSource: string | null;
    width?: number; height?: number; mimeType?: string; bytes?: number}
type Database = ReturnType<typeof getDatabase>
export const MAX_ASSET_FOLDER_DEPTH = 32
export const MAX_REGISTERED_TREE_ENTRIES = 10_000
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
export function validAssetId(id: string) {
    if (!UUID.test(id)) throw createError({statusCode: 404, statusMessage: 'Asset not found'})
    return id
}
export function assetNotFound(): never { throw createError({statusCode: 404, statusMessage: 'Asset not found'}) }
export function canonicalAssetUrl(url: string) {
    const canonical = imagePathToUrl(parseImagePath(url))
    if (!url.startsWith('/images/') || canonical !== url) throw createError({statusCode: 400, statusMessage: 'Invalid image path'})
    return canonical
}
export function personalImageParts(actor: AssetActor) {
    return ['organizations', validAssetId(actor.organizationId), 'users', validAssetId(actor.userId)]
}
export function assetCursorScope(actor: AssetActor, query: unknown) {
    return createHash('sha256').update(JSON.stringify([actor.organizationId, actor.userId, query])).digest('base64url')
}
export function decodeAssetCursor(cursor: string | undefined, scope: string): string | undefined {
    if (!cursor) return
    try {
        if (cursor.length > 512 || !/^[a-zA-Z\d_-]+$/.test(cursor)) throw new Error('invalid')
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {scope?: unknown; after?: unknown}
        if (!value || Object.keys(value).length !== 2 || value.scope !== scope || typeof value.after !== 'string' || !UUID.test(value.after)) throw new Error('invalid')
        return value.after
    } catch { throw createError({statusCode: 400, statusMessage: 'Invalid asset listing cursor'}) }
}
export function encodeAssetCursor(after: string, scope: string) { return Buffer.from(JSON.stringify({scope, after})).toString('base64url') }

export function createAssetRepository(actor: AssetActor, db: Database = getDatabase()) {
    const parent = alias(assets, 'parent_asset')
    const personOwner = alias(users, 'person_photo_owner')
    const personRecipient = alias(users, 'person_photo_recipient')
    const sourceCache = new Map<string, Promise<AssetSource>>([[actor.userId, Promise.resolve({userId: actor.userId, username: actor.username, displayName: actor.displayName})]])
    const priceCache = new Map<string, {priceUsd: string | null; priceSource: string | null; billingState: 'pending' | 'awaiting' | 'confirmed' | 'released' | null}>()
    type OutputIdentity = {organizationId: SQLWrapper; ownerUserId: SQLWrapper; url: SQLWrapper}
    function outputMatch(row?: AssetRecord, reference: OutputIdentity = assets) {
        return and(eq(systemPrompt.organizationId, row?.organizationId ?? reference.organizationId),
            eq(systemPrompt.userId, row?.ownerUserId ?? reference.ownerUserId), eq(systemPrompt.outputImage, row?.url ?? reference.url))
    }
    function visibleOutput(row?: AssetRecord, reference: OutputIdentity = assets) {
        return and(outputMatch(row, reference), confirmedGenerationPriceCondition(), isNull(systemPrompt.outputImageDeletedAt),
            sql`(${systemPrompt.status} = 'succeeded' OR (${systemPrompt.status} IS NULL AND ${systemPrompt.errors} IS NULL))`)
    }
    /** Call only for authorized folders. Count immediate visible entries independently of listing filters. */
    async function folderItemCounts(folders: AssetRecord[]) {
        if (!folders.length) return new Map<string, number>()
        const countedFolder = alias(assets, 'counted_folder')
        const child = alias(assets, 'counted_child')
        const counts = await db.select({folderId: countedFolder.id, itemCount: sql<number>`count(${child.id})::integer`})
            .from(countedFolder).leftJoin(child, and(eq(child.parentId, countedFolder.id),
                eq(child.organizationId, countedFolder.organizationId), eq(child.ownerUserId, countedFolder.ownerUserId),
                isNull(child.deletedAt), sql`(${child.kind} <> 'file' OR ${child.category} <> 'generated' OR EXISTS (
                    SELECT 1 FROM ${systemPrompt} WHERE ${visibleOutput(undefined, child)}
                ))`))
            .where(and(inArray(countedFolder.id, [...new Set(folders.map(row => row.id))]),
                eq(countedFolder.organizationId, actor.organizationId), eq(countedFolder.kind, 'folder'), isNull(countedFolder.deletedAt)))
            .groupBy(countedFolder.id)
        return new Map(counts.map(row => [row.folderId, row.itemCount]))
    }
    async function confirmedOutput(row: AssetRecord) {
        if (row.kind !== 'file' || row.category !== 'generated') return undefined
        const cached = priceCache.get(row.url)
        if (cached) return cached
        const [price] = await db.select({priceUsd: systemPrompt.priceUsd, priceSource: systemPrompt.priceSource,
            billingState: systemPrompt.billingState}).from(systemPrompt).where(visibleOutput(row)).limit(1)
        if (!price) throw createError({statusCode: 425, statusMessage: 'Image ready; waiting for its final price to be confirmed'})
        priceCache.set(row.url, price)
        return price
    }
    /** A bounded private projection may refer to hundreds of owned pipeline
     * outputs. Authorize those identities together in a fresh SQL snapshot;
     * shared identities still use the ordinary live-grant checks. */
    async function ownedImageMetadata(urls: readonly string[]): Promise<{images: OwnedImageMetadata[]; ownedUrls: string[]}> {
        if (urls.length > 2500) throw createError({statusCode: 400, statusMessage: 'Too many image identities'})
        const unique = [...new Set(urls.map(canonicalAssetUrl))]
        if (!unique.length) return {images: [], ownedUrls: []}
        const result = await db.execute<{id: string; url: string; name: string; category: string; width: number | null; height: number | null;
            mime_type: string | null; byte_size: string | null; price_usd: string | null; price_source: string | null; allowed: boolean}>(sql`
            WITH RECURSIVE ancestry AS (
                SELECT ${assets.id} AS root_id, ${assets.id} AS id, ${assets.parentId} AS parent_id,
                    1 AS depth, ARRAY[${assets.id}] AS visited
                FROM ${assets}
                WHERE ${assets.organizationId} = ${actor.organizationId}::uuid AND ${assets.ownerUserId} = ${actor.userId}::uuid
                    AND ${inArray(assets.url, unique)} AND ${assets.kind} = 'file' AND ${assets.deletedAt} IS NULL
                UNION ALL
                SELECT ancestry.root_id, ${parent.id}, ${parent.parentId}, ancestry.depth + 1, ancestry.visited || ${parent.id}
                FROM ${assets} AS parent_asset JOIN ancestry ON ${parent.id} = ancestry.parent_id
                WHERE ${parent.organizationId} = ${actor.organizationId}::uuid AND ${parent.ownerUserId} = ${actor.userId}::uuid
                    AND ${parent.kind} = 'folder' AND ${parent.deletedAt} IS NULL AND ancestry.depth < ${MAX_ASSET_FOLDER_DEPTH}
                    AND NOT (${parent.id} = ANY(ancestry.visited))
            ), roots AS (SELECT DISTINCT root_id FROM ancestry WHERE parent_id IS NULL)
            SELECT ${assets.id} AS id, ${assets.url} AS url, ${assets.name} AS name, ${assets.category} AS category,
                ${assets.width} AS width, ${assets.height} AS height, ${assets.mimeType} AS mime_type, ${assets.byteSize}::text AS byte_size,
                CASE WHEN ${assets.category} = 'processed' THEN '0' ELSE price.price_usd END AS price_usd,
                CASE WHEN ${assets.category} = 'processed' THEN 'local-processing' ELSE price.price_source END AS price_source,
                (roots.root_id IS NOT NULL AND ${assets.kind} = 'file' AND ${assets.deletedAt} IS NULL
                    AND (${assets.category} <> 'generated' OR price.generation_id IS NOT NULL)
                    AND EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${actor.userId}::uuid
                        AND ${users.organizationId} = ${actor.organizationId}::uuid AND ${users.disabledAt} IS NULL)) AS allowed
            FROM ${assets} LEFT JOIN roots ON roots.root_id = ${assets.id}
            LEFT JOIN LATERAL (
                SELECT ${systemPrompt.id} AS generation_id, ${systemPrompt.priceUsd} AS price_usd, ${systemPrompt.priceSource} AS price_source
                FROM ${systemPrompt} WHERE ${visibleOutput()} ORDER BY ${systemPrompt.id} DESC LIMIT 1
            ) price ON ${assets.category} = 'generated'
            WHERE ${assets.organizationId} = ${actor.organizationId}::uuid AND ${assets.ownerUserId} = ${actor.userId}::uuid
                AND ${inArray(assets.url, unique)}
        `)
        return {ownedUrls: result.rows.map(row => row.url), images: result.rows.filter(row => row.allowed).map(row => ({
            id: row.id, url: row.url, name: row.name, priceUsd: row.price_usd, priceSource: row.price_source,
            ...(row.width !== null ? {width: row.width} : {}), ...(row.height !== null ? {height: row.height} : {}),
            ...(row.mime_type !== null ? {mimeType: row.mime_type} : {}), ...(row.byte_size !== null ? {bytes: Number(row.byte_size)} : {}),
        }))}
    }
    async function byId(id: string) {
        const [row] = await db.select().from(assets).where(and(eq(assets.id, validAssetId(id)), eq(assets.organizationId, actor.organizationId), isNull(assets.deletedAt))).limit(1)
        return row
    }
    async function byUrl(url: string) {
        const [row] = await db.select().from(assets).where(and(eq(assets.url, canonicalAssetUrl(url)), eq(assets.organizationId, actor.organizationId), isNull(assets.deletedAt))).limit(1)
        return row
    }
    async function ancestors(row: AssetRecord) {
        const result = await db.execute<{id: string; parent_id: string | null; owner_id: string; depth: number}>(sql`
            WITH RECURSIVE ancestry AS (
                SELECT ${assets.id} AS id, ${assets.parentId} AS parent_id, ${assets.ownerUserId} AS owner_id,
                    1 AS depth, ARRAY[${assets.id}] AS visited
                FROM ${assets}
                WHERE ${assets.id} = ${row.id} AND ${assets.organizationId} = ${actor.organizationId} AND ${assets.deletedAt} IS NULL
                UNION ALL
                SELECT ${parent.id}, ${parent.parentId}, ${parent.ownerUserId}, ancestry.depth + 1,
                    ancestry.visited || ${parent.id}
                FROM ${assets} AS parent_asset JOIN ancestry ON ${parent.id} = ancestry.parent_id
                WHERE ${parent.organizationId} = ${actor.organizationId} AND ${parent.ownerUserId} = ${row.ownerUserId}
                    AND ${parent.deletedAt} IS NULL AND ancestry.depth < ${MAX_ASSET_FOLDER_DEPTH}
                    AND NOT (${parent.id} = ANY(ancestry.visited))
            ) SELECT id, parent_id, owner_id, depth FROM ancestry ORDER BY depth ASC
        `)
        const chain = result.rows
        if (!chain.length || chain.at(-1)?.parent_id !== null) assetNotFound()
        return chain
    }
    async function source(userId: string): Promise<AssetSource> {
        let value = sourceCache.get(userId)
        if (!value) {
            value = (async () => {
                const [user] = await db.select({userId: users.id, username: users.username, displayName: users.displayName}).from(users)
                    .where(and(eq(users.id, userId), eq(users.organizationId, actor.organizationId))).limit(1)
                if (!user) assetNotFound()
                return user
            })()
            sourceCache.set(userId, value)
        }
        return value
    }
    async function peoplePhotoGrant(row: AssetRecord): Promise<PeoplePhotoGrant | undefined> {
        if (row.kind !== 'file') return
        const [grant] = await db.select({personId: people.id, shareId: personShares.id, ownerUserId: people.userId})
            .from(personShares).innerJoin(people, eq(people.id, personShares.personId))
            .innerJoin(personOwner, and(eq(personOwner.id, people.userId), eq(personOwner.organizationId, people.organizationId), isNull(personOwner.disabledAt)))
            .innerJoin(personRecipient, and(eq(personRecipient.id, personShares.recipientUserId), eq(personRecipient.organizationId, people.organizationId), isNull(personRecipient.disabledAt)))
            .where(and(eq(personShares.organizationId, actor.organizationId), eq(people.organizationId, actor.organizationId),
                eq(personShares.recipientUserId, actor.userId), eq(personShares.sharedByUserId, people.userId),
                eq(people.userId, row.ownerUserId), isNull(people.deletedAt),
                sql`NOT EXISTS (SELECT 1 FROM ${personPhotos} WHERE ${personPhotos.personId} = ${people.id}
                    AND ${personPhotos.assetId} = ${row.id} AND ${personPhotos.excluded} = true)`,
                sql`(EXISTS (SELECT 1 FROM ${personPhotos} WHERE ${personPhotos.personId} = ${people.id}
                    AND ${personPhotos.assetId} = ${row.id} AND ${personPhotos.excluded} = false)
                    OR EXISTS (SELECT 1 FROM ${systemPrompt} WHERE ${systemPrompt.personId} = ${people.id}
                        AND ${systemPrompt.organizationId} = ${people.organizationId} AND ${systemPrompt.userId} = ${people.userId}
                        AND ${systemPrompt.outputImage} = ${row.url} AND ${systemPrompt.outputImageDeletedAt} IS NULL
                        AND (${systemPrompt.status} = 'succeeded' OR (${systemPrompt.status} IS NULL AND ${systemPrompt.errors} IS NULL))))`))
            .orderBy(asc(people.id)).limit(1)
        return grant
    }
    /** In a publication transaction, serialize with profile/share/unlink and
     * account mutations before locking media. People mutations lock users
     * before profiles; keeping that order avoids account/profile deadlocks. */
    async function lockPeoplePhotoGrant(row: AssetRecord, grant: PeoplePhotoGrant) {
        const enabled = await db.select({id: users.id}).from(users).where(and(eq(users.organizationId, actor.organizationId),
            inArray(users.id, [...new Set([actor.userId, row.ownerUserId])]), isNull(users.disabledAt))).orderBy(asc(users.id)).for('share')
        if (enabled.length !== new Set([actor.userId, row.ownerUserId]).size) assetNotFound()
        const [person] = await db.select({id: people.id}).from(people).where(and(eq(people.id, grant.personId),
            eq(people.organizationId, actor.organizationId), eq(people.userId, row.ownerUserId), isNull(people.deletedAt))).for('share').limit(1)
        if (!person) assetNotFound()
        const [share] = await db.select({id: personShares.id}).from(personShares).where(and(eq(personShares.id, grant.shareId),
            eq(personShares.personId, person.id), eq(personShares.organizationId, actor.organizationId),
            eq(personShares.sharedByUserId, row.ownerUserId), eq(personShares.recipientUserId, actor.userId))).for('share').limit(1)
        if (!share || !await peoplePhotoGrant(row)) assetNotFound()
    }
    async function access(row: AssetRecord, intent: 'view' | 'edit' | 'share' = 'view') {
        const chain = await ancestors(row)
        if (row.ownerUserId === actor.userId) return {permissions: {view: true, edit: true, share: true}, sharedBy: undefined, depth: chain.length, personGrant: undefined}
        const grants = await db.select().from(assetShares).where(and(eq(assetShares.organizationId, actor.organizationId),
            eq(assetShares.recipientUserId, actor.userId), inArray(assetShares.assetId, chain.map(item => item.id))))
        const personGrant = grants.length ? undefined : await peoplePhotoGrant(row)
        if (!grants.length && !personGrant) assetNotFound()
        // Sharing permits viewing, downloading and generation inputs only.
        // Historical edit grants remain readable but never authorize mutations.
        const permissions: AssetPermissions = {view: true, edit: false, share: false}
        if (intent !== 'view') throw createError({statusCode: 403, statusMessage: 'This asset is shared with read-only access'})
        return {permissions, sharedBy: await source(grants[0]?.sharedByUserId ?? personGrant!.ownerUserId), depth: chain.length, personGrant}
    }
    async function requireAsset(idOrUrl: string, intent: 'view' | 'edit' | 'share' = 'view') {
        const row = idOrUrl.startsWith('/images/') ? await byUrl(idOrUrl) : await byId(idOrUrl)
        if (!row) assetNotFound()
        const grant = await access(row, intent)
        // Authorize before applying the price gate, and before any S3 read.
        // Exact owner cleanup remains possible for an unlinked output.
        if (intent !== 'edit') await confirmedOutput(row)
        return {row, ...grant}
    }
    function logicalPath(row: AssetRecord) {
        const parts = parseImagePath(row.url)
        const prefix = personalImageParts({...actor, userId: row.ownerUserId})
        const personal = prefix.every((segment, index) => parts[index] === segment)
        return '/' + (personal ? parts.slice(prefix.length) : parts).join('/')
    }
    async function dto(row: AssetRecord, inherited?: {permissions: AssetPermissions; sharedBy?: AssetSource}, itemCount?: number): Promise<AssetFile> {
        const grant = inherited ?? await access(row)
        const owner = await source(row.ownerUserId)
        const path = logicalPath(row)
        const containingFolder = row.parentId ? await byId(row.parentId) : undefined
        // This is a display hint from the registered logical destination, never
        // an authorization rule or a guess from a caller-controlled filename.
        const processingPurpose = row.kind === 'file' && row.category === 'processed'
            ? containingFolder?.category === 'processed' && containingFolder.ownerUserId === row.ownerUserId
                && containingFolder.organizationId === row.organizationId
                ? containingFolder.url === imagePathToUrl([...personalImageParts({...actor, userId: row.ownerUserId}), 'pipeline-results'])
                    ? 'pipeline' as const
                    : containingFolder.url === imagePathToUrl([...personalImageParts({...actor, userId: row.ownerUserId}), 'cutouts'])
                        ? 'background-removal' as const : 'local' as const
                : 'local' as const
            : undefined
        const price = await confirmedOutput(row)
        const count = row.kind === 'folder' ? itemCount ?? (await folderItemCounts([row])).get(row.id) ?? 0 : undefined
        return {id: row.id, kind: row.kind, name: row.name, url: row.url,
            category: row.category, ...(price ?? (row.kind === 'file' && row.category === 'processed'
                ? {priceUsd: '0', priceSource: 'local-processing'} : {})),
            ...(processingPurpose ? {processingPurpose} : {}),
            ...(count !== undefined ? {itemCount: count} : {}),
            folder: row.kind === 'folder' ? path : containingFolder ? logicalPath(containingFolder) : '/',
            ownerUserId: row.ownerUserId, permissions: grant.permissions, source: owner,
            ...(grant.sharedBy ? {sharedBy: grant.sharedBy} : {}),
            selectedImage: false, selectedModel: false, selectedMask: false,
            ...(row.byteSize !== null ? {bytes: row.byteSize} : {}), modifiedAt: new Date(row.updatedAt).toISOString()}
    }
    async function folderDto(row: AssetRecord, inherited?: {permissions: AssetPermissions; sharedBy?: AssetSource}, itemCount?: number): Promise<AssetFolder> {
        const file = await dto(row, inherited, itemCount)
        return {...file, path: logicalPath(row)}
    }
    async function resolveFolder(path = '/', folderId?: string, intent: 'view' | 'edit' = 'view') {
        if (folderId) {
            const found = await requireAsset(folderId, intent)
            if (found.row.kind !== 'folder') assetNotFound()
            return found
        }
        const parts = parseImagePath(path, true)
        if (!parts.length) return undefined
        const url = path.startsWith('/images/') ? canonicalAssetUrl(path)
            : imagePathToUrl([...personalImageParts(actor), ...parts])
        let found
        const personal = await byUrl(url)
        if (personal) found = await requireAsset(personal.id, intent)
        else {
            // Legacy paths require an explicit registry adoption; S3 existence never establishes ownership.
            const adopted = !path.startsWith('/images/') ? await byUrl(imagePathToUrl(parts)) : undefined
            if (!adopted || adopted.ownerUserId !== actor.userId) assetNotFound()
            found = await requireAsset(adopted.id, intent)
        }
        if (found.row.kind !== 'folder') assetNotFound()
        return found
    }
    async function list(options: {scope?: 'all' | 'uploads' | 'generated' | 'shared'; path?: string; folderId?: string; sourceUserId?: string; query?: string; cursor?: string; limit?: number; direct?: boolean} = {}) {
        const limit = options.limit ?? 60
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw createError({statusCode: 400, statusMessage: 'Invalid asset listing page size'})
        const scope = options.scope ?? 'all'
        const folder = await resolveFolder(options.path, options.folderId)
        const query = (options.query ?? '').trim()
        if (query.length > 200 || /[\x00-\x1f\x7f]/.test(query)) throw createError({statusCode: 400, statusMessage: 'Invalid asset search'})
        const cursorScope = assetCursorScope(actor, [scope, folder?.row.id ?? null, options.sourceUserId ?? null, query, options.direct ?? false])
        const after = decodeAssetCursor(options.cursor, cursorScope)
        const conditions = [eq(assets.organizationId, actor.organizationId), isNull(assets.deletedAt)]
        // Visibility must filter before LIMIT so held outputs cannot consume
        // a page or leak through a shared folder or favorites resolution.
        conditions.push(sql`(${assets.kind} <> 'file' OR ${assets.category} <> 'generated' OR EXISTS (
            SELECT 1 FROM ${systemPrompt} WHERE ${visibleOutput()}
        ))`)
        if (after) conditions.push(gt(assets.id, after))
        if (query) {
            const escaped = query.replace(/[\\%_]/g, '\\$&')
            conditions.push(sql`${assets.name} ILIKE ${'%' + escaped + '%'} ESCAPE '\\'`)
        }
        if (scope === 'uploads') conditions.push(eq(assets.category, 'uploaded'))
        if (scope === 'generated') conditions.push(eq(assets.category, 'generated'))
        let rows: AssetRecord[]
        if (scope === 'shared' && !folder) {
            if (options.sourceUserId) validAssetId(options.sourceUserId)
            const grants = db.select({assetId: assetShares.assetId}).from(assetShares).where(and(
                eq(assetShares.organizationId, actor.organizationId), eq(assetShares.recipientUserId, actor.userId),
                ...(options.sourceUserId ? [eq(assetShares.sharedByUserId, options.sourceUserId)] : [])))
            conditions.push(inArray(assets.id, grants), ne(assets.ownerUserId, actor.userId))
            rows = await db.select().from(assets).where(and(...conditions)).orderBy(asc(assets.id)).limit(limit + 1)
        } else {
            const owner = folder?.row.ownerUserId ?? actor.userId
            conditions.push(eq(assets.ownerUserId, owner))
            if (options.direct) conditions.push(folder ? eq(assets.parentId, folder.row.id) : isNull(assets.parentId))
            else if (folder) {
                const tree = await descendants(folder.row)
                conditions.push(inArray(assets.id, tree.filter(row => row.id !== folder.row.id).map(row => row.id)))
            } else conditions.push(eq(assets.kind, 'file'))
            rows = await db.select().from(assets).where(and(...conditions)).orderBy(asc(assets.id)).limit(limit + 1)
        }
        const next = rows.length > limit ? encodeAssetCursor(rows[limit - 1]!.id, cursorScope) : undefined
        rows = rows.slice(0, limit)
        const outputs = rows.filter(row => row.kind === 'file' && row.category === 'generated')
        if (outputs.length) {
            const prices = await db.select({url: systemPrompt.outputImage, ownerUserId: systemPrompt.userId,
                priceUsd: systemPrompt.priceUsd, priceSource: systemPrompt.priceSource, billingState: systemPrompt.billingState})
                .from(systemPrompt).where(and(eq(systemPrompt.organizationId, actor.organizationId),
                    inArray(systemPrompt.outputImage, outputs.map(row => row.url)), confirmedGenerationPriceCondition(),
                    isNull(systemPrompt.outputImageDeletedAt),
                    sql`(${systemPrompt.status} = 'succeeded' OR (${systemPrompt.status} IS NULL AND ${systemPrompt.errors} IS NULL))`))
            for (const price of prices) if (outputs.some(row => row.url === price.url && row.ownerUserId === price.ownerUserId)) priceCache.set(price.url, price)
        }
        const folders = rows.filter(row => row.kind === 'folder')
        // Sharing is inherited through folder ancestry; verify each returned folder before
        // the single count query can inspect any of its children.
        const folderGrants = new Map(await Promise.all(folders.map(async row => [row.id, await access(row)] as const)))
        const counts = await folderItemCounts([...folders, ...(folder ? [folder.row] : [])])
        const mapped = await Promise.all(rows.map(row => dto(row, folderGrants.get(row.id), counts.get(row.id))))
        const files = mapped.filter(file => file.kind === 'file')
        const dirs: AssetFolder[] = mapped.filter(file => file.kind === 'folder').map(file => ({...file, path: logicalPath(rows.find(row => row.id === file.id)!)}))
        return {files, dirs, sources: [...new Map(mapped.filter(file => file.sharedBy).map(file => [file.sharedBy!.userId, file.sharedBy!])).values()],
            ...(folder ? {folder: await folderDto(folder.row, folder, counts.get(folder.row.id))} : {}), nextCursor: next}
    }
    async function descendants(row: AssetRecord) {
        const child = alias(assets, 'child_asset')
        const result = await db.execute<{id: string; depth: number}>(sql`
            WITH RECURSIVE tree AS (
                SELECT ${assets.id} AS id, 1 AS depth, ARRAY[${assets.id}] AS visited FROM ${assets}
                WHERE ${assets.id} = ${row.id} AND ${assets.organizationId} = ${actor.organizationId} AND ${assets.deletedAt} IS NULL
                UNION ALL
                SELECT ${child.id}, tree.depth + 1, tree.visited || ${child.id}
                FROM ${assets} AS child_asset JOIN tree ON ${child.parentId} = tree.id
                WHERE ${child.organizationId} = ${actor.organizationId} AND ${child.ownerUserId} = ${row.ownerUserId}
                    AND ${child.deletedAt} IS NULL AND tree.depth < ${MAX_ASSET_FOLDER_DEPTH}
                    AND NOT (${child.id} = ANY(tree.visited))
            ) SELECT id, depth FROM tree LIMIT ${MAX_REGISTERED_TREE_ENTRIES + 1}
        `)
        if (result.rows.length > MAX_REGISTERED_TREE_ENTRIES) throw createError({statusCode: 413, statusMessage: 'Folder is too large to process safely'})
        return result.rows
    }
    async function register(data: Omit<typeof assets.$inferInsert, 'id' | 'organizationId' | 'createdByUserId'>) {
        canonicalAssetUrl(data.url)
        const row = await db.transaction(async transaction => {
            // Registration and subtree tombstoning serialize per owner across app instances.
            await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.organizationId + ':' + data.ownerUserId}, 0))`)
            if (data.parentId) {
                const parent = await createAssetRepository(actor, transaction as unknown as Database).requireAsset(data.parentId, 'edit')
                if (parent.row.kind !== 'folder' || parent.row.ownerUserId !== data.ownerUserId || parent.depth >= MAX_ASSET_FOLDER_DEPTH) assetNotFound()
            } else if (data.ownerUserId !== actor.userId) assetNotFound()
            const [inserted] = await transaction.insert(assets).values({...data, id: randomUUID(), organizationId: actor.organizationId, createdByUserId: actor.userId}).returning()
            return inserted
        })
        if (!row) throw createError({statusCode: 503, statusMessage: 'Could not register image'})
        return row
    }
    async function markDeleted(ids: string[]) {
        if (!ids.length) return
        await db.update(assets).set({deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString()})
            .where(and(eq(assets.organizationId, actor.organizationId), inArray(assets.id, ids)))
    }
    async function prepareDeletion(id: string) {
        const initial = await requireAsset(id, 'edit')
        return db.transaction(async transaction => {
            await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.organizationId + ':' + initial.row.ownerUserId}, 0))`)
            const scoped = createAssetRepository(actor, transaction as unknown as Database)
            const {row} = await scoped.requireAsset(id, 'edit')
            const ids = row.kind === 'folder' ? (await scoped.descendants(row)).map(item => item.id) : [row.id]
            const rows = await transaction.select().from(assets).where(and(eq(assets.organizationId, actor.organizationId), eq(assets.ownerUserId, row.ownerUserId), inArray(assets.id, ids)))
            const deletedAt = new Date().toISOString()
            await transaction.update(assets).set({deletedAt, updatedAt: deletedAt}).where(and(eq(assets.organizationId, actor.organizationId), inArray(assets.id, ids)))
            return {rows, deletedAt}
        })
    }
    async function restoreDeletion(rows: AssetRecord[], deletedAt: string) {
        if (!rows.length) return
        await db.transaction(async transaction => {
            await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.organizationId + ':' + rows[0]!.ownerUserId}, 0))`)
            await transaction.update(assets).set({deletedAt: null, updatedAt: new Date().toISOString()}).where(and(eq(assets.organizationId, actor.organizationId),
                inArray(assets.id, rows.map(row => row.id)), eq(assets.deletedAt, deletedAt)))
        })
    }
    async function shareTargets() {
        return db.select({id: users.id, username: users.username, displayName: users.displayName}).from(users)
            .where(and(eq(users.organizationId, actor.organizationId), ne(users.id, actor.userId), isNull(users.disabledAt))).orderBy(asc(users.displayName)).limit(200)
    }
    async function sharesFor(id: string) {
        await requireAsset(id, 'share')
        return db.select({id: assetShares.id, recipientUserId: assetShares.recipientUserId, permission: sql<'view'>`'view'`,
            username: users.username, displayName: users.displayName, createdAt: assetShares.createdAt}).from(assetShares)
            .innerJoin(users, eq(users.id, assetShares.recipientUserId)).where(and(eq(assetShares.organizationId, actor.organizationId), eq(assetShares.assetId, id))).limit(200)
    }
    async function share(id: string, recipientUserId: string, permission: 'view') {
        const {row} = await requireAsset(id, 'share')
        if (permission !== 'view') throw createError({statusCode: 400, statusMessage: 'Invalid sharing permission'})
        const [recipient] = await db.select({id: users.id}).from(users).where(and(eq(users.id, validAssetId(recipientUserId)),
            eq(users.organizationId, actor.organizationId), isNull(users.disabledAt), ne(users.id, actor.userId))).limit(1)
        if (!recipient) assetNotFound()
        const existing = await sharesFor(id)
        if (existing.length >= 200 && !existing.some(grant => grant.recipientUserId === recipientUserId)) throw createError({statusCode: 409, statusMessage: 'This asset has reached its sharing limit'})
        await db.insert(assetShares).values({id: randomUUID(), assetId: row.id, organizationId: actor.organizationId,
            sharedByUserId: actor.userId, recipientUserId, permission}).onConflictDoUpdate({target: [assetShares.assetId, assetShares.recipientUserId], set: {permission, sharedByUserId: actor.userId}})
    }
    async function revoke(id: string, recipientUserId: string) {
        await requireAsset(id, 'share')
        await db.delete(assetShares).where(and(eq(assetShares.organizationId, actor.organizationId), eq(assetShares.assetId, id),
            eq(assetShares.recipientUserId, validAssetId(recipientUserId))))
    }
    return {byId, byUrl, requireAsset, ancestors, source, dto, folderDto, logicalPath, resolveFolder, list, descendants, register, markDeleted, prepareDeletion, restoreDeletion, shareTargets, sharesFor, share, revoke, lockPeoplePhotoGrant, ownedImageMetadata, db}
}
