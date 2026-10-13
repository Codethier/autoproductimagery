import {createHash, randomUUID} from 'node:crypto'
import {createError} from 'h3'
import {and, asc, eq, gt, inArray, isNull, ne, sql} from 'drizzle-orm'
import {alias} from 'drizzle-orm/pg-core'
import {assets, assetShares, users} from '../db/schema'
import {getDatabase} from './lib/db'
import {imagePathToUrl, parseImagePath, validateImagePathSegment} from './imageStoragePaths'
import type {AssetFile, AssetFolder, AssetPermissions, AssetSource} from '../../schemas/image-storage'

export type AssetActor = {userId: string; organizationId: string; username: string; displayName: string; role: 'owner' | 'user'}
export type AssetRecord = typeof assets.$inferSelect
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
    const sourceCache = new Map<string, Promise<AssetSource>>([[actor.userId, Promise.resolve({userId: actor.userId, username: actor.username, displayName: actor.displayName})]])
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
    async function access(row: AssetRecord, intent: 'view' | 'edit' | 'share' = 'view') {
        const chain = await ancestors(row)
        if (row.ownerUserId === actor.userId) return {permissions: {view: true, edit: true, share: true}, sharedBy: undefined, depth: chain.length}
        const grants = await db.select().from(assetShares).where(and(eq(assetShares.organizationId, actor.organizationId),
            eq(assetShares.recipientUserId, actor.userId), inArray(assetShares.assetId, chain.map(item => item.id))))
        if (!grants.length) assetNotFound()
        // Sharing permits viewing, downloading and generation inputs only.
        // Historical edit grants remain readable but never authorize mutations.
        const permissions: AssetPermissions = {view: true, edit: false, share: false}
        if (intent !== 'view') throw createError({statusCode: 403, statusMessage: 'This asset is shared with read-only access'})
        return {permissions, sharedBy: await source(grants[0]!.sharedByUserId), depth: chain.length}
    }
    async function requireAsset(idOrUrl: string, intent: 'view' | 'edit' | 'share' = 'view') {
        const row = idOrUrl.startsWith('/images/') ? await byUrl(idOrUrl) : await byId(idOrUrl)
        if (!row) assetNotFound()
        return {row, ...await access(row, intent)}
    }
    function logicalPath(row: AssetRecord) {
        const parts = parseImagePath(row.url)
        const prefix = personalImageParts({...actor, userId: row.ownerUserId})
        const personal = prefix.every((segment, index) => parts[index] === segment)
        return '/' + (personal ? parts.slice(prefix.length) : parts).join('/')
    }
    async function dto(row: AssetRecord, inherited?: {permissions: AssetPermissions; sharedBy?: AssetSource}): Promise<AssetFile> {
        const grant = inherited ?? await access(row)
        const owner = await source(row.ownerUserId)
        const path = logicalPath(row)
        const containingFolder = row.parentId ? await byId(row.parentId) : undefined
        return {id: row.id, kind: row.kind, name: row.name, url: row.url,
            folder: row.kind === 'folder' ? path : containingFolder ? logicalPath(containingFolder) : '/',
            ownerUserId: row.ownerUserId, permissions: grant.permissions, source: owner,
            ...(grant.sharedBy ? {sharedBy: grant.sharedBy} : {}),
            selectedImage: false, selectedModel: false, selectedMask: false,
            ...(row.byteSize !== null ? {bytes: row.byteSize} : {}), modifiedAt: new Date(row.updatedAt).toISOString()}
    }
    async function folderDto(row: AssetRecord, inherited?: {permissions: AssetPermissions; sharedBy?: AssetSource}): Promise<AssetFolder> {
        const file = await dto(row, inherited)
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
        const mapped = await Promise.all(rows.map(row => dto(row)))
        const files = mapped.filter(file => file.kind === 'file')
        const dirs: AssetFolder[] = mapped.filter(file => file.kind === 'folder').map(file => ({...file, path: logicalPath(rows.find(row => row.id === file.id)!)}))
        return {files, dirs, sources: [...new Map(mapped.filter(file => file.sharedBy).map(file => [file.sharedBy!.userId, file.sharedBy!])).values()],
            ...(folder ? {folder: await folderDto(folder.row, folder)} : {}), nextCursor: next}
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
    return {byId, byUrl, requireAsset, ancestors, source, dto, folderDto, logicalPath, resolveFolder, list, descendants, register, markDeleted, prepareDeletion, restoreDeletion, shareTargets, sharesFor, share, revoke, db}
}
