import {randomUUID} from 'node:crypto'
import {and, eq, inArray, sql} from 'drizzle-orm'
import {assets, users} from '../../server/db/schema.ts'
import {getDatabase} from '../../server/utils/lib/db.ts'
import {MAX_ASSET_FOLDER_DEPTH, MAX_REGISTERED_TREE_ENTRIES, validAssetId} from '../../server/utils/assetAccess.ts'
import {imagePathToUrl, validateImagePathSegment} from '../../server/utils/imageStoragePaths.ts'
import {isRetentionManagedImageUrl} from '../../server/utils/generatedImageRetention.ts'
import type {useFS} from '../../server/utils/useFS.ts'

type Storage = Awaited<ReturnType<typeof useFS>>
/** Explicit metadata adoption only. No request-time ownership inference and no bucket writes. */
export async function adoptLegacyAssets(options: {organizationId: string; ownerUserId: string; storage: Storage;
    db?: ReturnType<typeof getDatabase>; maxEntries?: number; apply?: boolean}) {
    const db = options.db ?? getDatabase()
    const organizationId = validAssetId(options.organizationId), ownerUserId = validAssetId(options.ownerUserId)
    const maxEntries = options.maxEntries ?? 1_000
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_REGISTERED_TREE_ENTRIES) throw new Error('Invalid legacy adoption limit')
    const [owner] = await db.select().from(users).where(and(eq(users.id, ownerUserId), eq(users.organizationId, organizationId), eq(users.isBootstrapOwner, true))).limit(1)
    if (!owner || owner.role !== 'owner' || owner.disabledAt) throw new Error('Legacy assets can only be adopted by the original bootstrap organization owner')
    type Entry = {id: string; parts: string[]; url: string; kind: 'file' | 'folder'; bytes?: number; mimeType?: string; width?: number; height?: number}
    const entries: Entry[] = []
    const pending: string[][] = [[]]
    let pages = 0
    while (pending.length) {
        const parts = pending.shift()!
        if (parts.length >= MAX_ASSET_FOLDER_DEPTH) throw new Error('Legacy folder nesting exceeds the supported limit')
        let cursor: string | undefined
        do {
            const page = await options.storage.readDir('/' + parts.map(encodeURIComponent).join('/'), {limit: 200, cursor})
            if (++pages > MAX_REGISTERED_TREE_ENTRIES) throw new Error('Legacy adoption scan is too large')
            for (const folder of page.dirs) {
                const name = validateImagePathSegment(folder.name)
                if (!parts.length && name === 'organizations') continue
                const child = [...parts, name]
                entries.push({id: randomUUID(), parts: child, url: imagePathToUrl(child), kind: 'folder'})
                pending.push(child)
            }
            for (const file of page.files) {
                const child = [...parts, validateImagePathSegment(file.name)]
                entries.push({id: randomUUID(), parts: child, url: imagePathToUrl(child), kind: 'file'})
            }
            if (entries.length > maxEntries) throw new Error('Legacy adoption exceeds the explicit entry limit')
            cursor = page.nextCursor
        } while (cursor)
    }
    entries.sort((a, b) => a.parts.length - b.parts.length || a.url.localeCompare(b.url))
    const existing = entries.length ? await db.select().from(assets).where(inArray(assets.url, entries.map(entry => entry.url))) : []
    if (existing.some(row => row.organizationId !== organizationId || row.ownerUserId !== ownerUserId)) throw new Error('Legacy paths conflict with an existing asset owner')
    const known = new Map(existing.filter(row => !row.deletedAt).map(row => [row.url, row]))
    const tombstones = new Set(existing.filter(row => row.deletedAt && !known.has(row.url)).map(row => row.url))
    const entryMap = new Map(entries.map(entry => [entry.url, entry]))
    const skipped = new Set<string>()
    for (const entry of entries) {
        const parentUrl = entry.parts.length > 1 ? imagePathToUrl(entry.parts.slice(0, -1)) : undefined
        if (tombstones.has(entry.url) || (parentUrl && skipped.has(parentUrl))) {skipped.add(entry.url); continue}
        const registered = known.get(entry.url)
        if (registered) {
            if (registered.kind !== entry.kind) throw new Error('Legacy asset metadata conflicts with storage')
            if (registered.parentId !== (parentUrl ? entryMap.get(parentUrl)?.id : null)) throw new Error('Legacy asset parent metadata conflicts with storage')
            entry.id = registered.id
        }
        if (entry.kind === 'file' && !registered) {
            const image = await options.storage.getImageFile(entry.url)
            Object.assign(entry, {bytes: image.buffer.length, mimeType: image.mimeType, width: image.width, height: image.height})
            image.buffer = Buffer.alloc(0)
        }
    }
    const plan = entries.filter(entry => !known.has(entry.url) && !skipped.has(entry.url))
    if (options.apply && plan.length) {
        await db.transaction(async transaction => {
            await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId + ':' + ownerUserId}, 0))`)
            const ids = new Map(entries.filter(entry => !skipped.has(entry.url)).map(entry => [entry.url, entry.id]))
            for (const entry of plan) {
                const parentId = entry.parts.length > 1 ? ids.get(imagePathToUrl(entry.parts.slice(0, -1))) : null
                if (entry.parts.length > 1 && !parentId) throw new Error('Legacy asset parent was not planned')
                await transaction.insert(assets).values({id: entry.id, organizationId, ownerUserId, createdByUserId: ownerUserId,
                    parentId, url: entry.url, name: entry.parts.at(-1)!, kind: entry.kind,
                    category: entry.kind === 'file' && isRetentionManagedImageUrl(entry.url) ? 'generated' : 'uploaded',
                    byteSize: entry.bytes, mimeType: entry.mimeType, width: entry.width, height: entry.height})
            }
        })
    }
    return {dryRun: !options.apply, scanned: entries.length, existing: known.size, skippedDeleted: skipped.size,
        planned: plan.length, adopted: options.apply ? plan.length : 0, files: plan.filter(entry => entry.kind === 'file').length,
        folders: plan.filter(entry => entry.kind === 'folder').length}
}
