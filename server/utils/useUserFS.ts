import {createError} from 'h3'
import {randomUUID} from 'node:crypto'
import {createAssetRepository, MAX_ASSET_FOLDER_DEPTH, personalImageParts, type AssetActor} from './assetAccess'
import {useFS} from './useFS'
import {getDatabase} from './lib/db'
import {imagePathToUrl, parseImagePath, validateImagePathSegment} from './imageStoragePaths'
import {inspectDecodedImage} from './imageValidation'
import type {BufferedUploadFile} from './uploadPolicy'
import type {AssetFile} from '../../schemas/image-storage'
import sharp from 'sharp'
import {createImageDeliveryCache, type ImageRepresentation} from './imageDeliveryCache'
import {imageDeliveryEtag, imageDeliveryRevision, matchesImageEtag, IMAGE_PREVIEW_SIZES, type ImagePreviewSize} from './imageDeliveryPolicy'
import {MAX_IMAGE_PIXELS} from './imageValidation'
import {and, asc, eq, inArray, isNull, sql} from 'drizzle-orm'
import {assets, assetShares, users} from '../db/schema'
import type {BackgroundRemovalTransaction} from './backgroundRemovalJobs'

type RawStorage = Awaited<ReturnType<typeof useFS>>
// One warm-instance cache per storage backend; no disk dependency or cross-backend key collisions.
type DeliveryCaches = {original: ReturnType<typeof createImageDeliveryCache>; preview: ReturnType<typeof createImageDeliveryCache>}
const deliveryCaches = new WeakMap<RawStorage, DeliveryCaches>()
function deliveryCache(storage: RawStorage) {
    let cache = deliveryCaches.get(storage)
    if (!cache) {
        // Separate limiter pools avoid nested-cache deadlocks. Reserve the preview slot BEFORE
        // fetching its original, so queued transforms cannot retain dozens of evicted buffers.
        cache = {original: createImageDeliveryCache({maxBytes: 48 * 1024 * 1024}),
            preview: createImageDeliveryCache({maxBytes: 16 * 1024 * 1024, maxEntries: 256})}
        deliveryCaches.set(storage, cache)
    }
    return cache
}
function rawDirectory(parts: readonly string[]) { return '/' + parts.map(encodeURIComponent).join('/') }
function safeAssetOperation<T>(work: () => Promise<T>): Promise<T> {
    return work().catch(error => {
        if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
            && error.statusCode >= 400 && error.statusCode <= 504) throw error
        throw createError({statusCode: 503, statusMessage: 'Your image library is temporarily unavailable'})
    })
}

/** Every request gets an actor-bound registry facade. The raw bucket is never enumerated for a user. */
export async function useUserFS(actor: AssetActor, storage?: RawStorage, database = getDatabase()) {
    const raw = storage ?? await useFS()
    const repository = createAssetRepository(actor, database)
    const ownParts = personalImageParts(actor)
    let namespaceReady: Promise<void> | undefined
    async function ensureRawFolders(parts: string[]) {
            for (let index = 0; index < parts.length; index++) {
                try { await raw.createFolder(rawDirectory(parts.slice(0, index)), parts[index]!) }
                catch (error) { if (!(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 409)) throw error }
            }
    }
    async function ensureNamespace() {
        namespaceReady ??= ensureRawFolders(ownParts).catch(error => {namespaceReady = undefined; throw error})
        await namespaceReady
    }
    async function writeTarget(path = '/', folderId?: string) {
        const parent = await repository.resolveFolder(path, folderId, 'edit')
        if (parent && parent.depth >= MAX_ASSET_FOLDER_DEPTH) throw createError({statusCode: 400, statusMessage: 'Folder nesting limit reached'})
        if (!parent) await ensureNamespace()
        return {parent, parts: parent ? parseImagePath(parent.row.url) : ownParts,
            ownerUserId: parent?.row.ownerUserId ?? actor.userId}
    }
    async function readImage(url: string) {
        const {row} = await repository.requireAsset(url)
        if (row.kind !== 'file') throw createError({statusCode: 404, statusMessage: 'Image not found'})
        return raw.getImageFile(row.url)
    }
    async function getImageForDelivery(url: string, preview?: ImagePreviewSize, ifNoneMatch?: string) {
        if (preview !== undefined && !IMAGE_PREVIEW_SIZES.includes(preview)) {
            throw createError({statusCode: 400, statusMessage: 'Invalid image preview size'})
        }
        // Fresh registry access on EVERY delivery, before either a 304 or an in-memory hit.
        // A cached buffer never authorizes a revoked share, deleted asset or unpaid output.
        const {row} = await createAssetRepository(actor, database).requireAsset(url)
        if (row.kind !== 'file') throw createError({statusCode: 404, statusMessage: 'Image not found'})
        const etag = imageDeliveryEtag(actor, row, preview)
        if (matchesImageEtag(ifNoneMatch, etag)) return {etag, notModified: true as const}
        const cache = deliveryCache(raw)
        // Fetch and fully validate once per cache admission; rejected/corrupt images are never cached.
        const original = () => cache.original.get(imageDeliveryRevision(row), () => raw.getImageFile(row.url))
        const image: ImageRepresentation = preview === undefined ? await original()
            : await cache.preview.get(imageDeliveryRevision(row, preview), async () => {
                const source = await original()
                const {data, info} = await sharp(source.buffer, {failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true})
                    .rotate().resize(preview, preview, {fit: 'inside', withoutEnlargement: true})
                    .webp({quality: 82, effort: 3}).toBuffer({resolveWithObject: true})
                return {buffer: data, mimeType: 'image/webp', width: info.width, height: info.height}
            })
        return {...image, etag, notModified: false as const}
    }
    async function saveUpload(path: string, file: BufferedUploadFile) {
        const target = await writeTarget(path)
        const inspection = await inspectDecodedImage(file.data)
        const objectParts = [...personalImageParts({...actor, userId: target.ownerUserId}), 'objects', randomUUID()]
        await ensureRawFolders(objectParts)
        const name = await raw.saveFile(rawDirectory(objectParts), file)
        const url = imagePathToUrl([...objectParts, name])
        try {
            if (target.parent) await repository.requireAsset(target.parent.row.id, 'edit')
            const row = await repository.register({ownerUserId: target.ownerUserId, parentId: target.parent?.row.id ?? null,
                url, name, kind: 'file', category: 'uploaded', byteSize: file.data.byteLength,
                mimeType: inspection.mimeType, width: inspection.width, height: inspection.height})
            return await repository.dto(row)
        } catch (error) {
            await raw.deleteFileOrFolder(rawDirectory(parseImagePath(url)), 'file').catch(() => undefined)
            await raw.deleteFolderMarker(rawDirectory(objectParts)).catch(() => undefined)
            throw error
        }
    }
    async function createFolder(path: string, name: string) {
        validateImagePathSegment(name)
        const target = await writeTarget(path)
        const url = imagePathToUrl([...target.parts, name])
        if (await repository.byUrl(url)) throw createError({statusCode: 409, statusMessage: 'Folder already exists'})
        await raw.createFolder(rawDirectory(target.parts), name)
        try {
            if (target.parent) await repository.requireAsset(target.parent.row.id, 'edit')
            const row = await repository.register({ownerUserId: target.ownerUserId, parentId: target.parent?.row.id ?? null,
                url, name, kind: 'folder', category: 'uploaded'})
            return repository.folderDto(row)
        } catch (error) {
            // A folder marker was created by this operation. Never remove an existing folder after a registry conflict.
            await raw.deleteFolderMarker(rawDirectory(parseImagePath(url))).catch(() => undefined)
            throw error
        }
    }
    async function ensureGeneratedFolder() {
        await ensureNamespace()
        const url = imagePathToUrl([...ownParts, 'output'])
        const existing = await repository.byUrl(url)
        if (existing) {
            if (existing.kind !== 'folder' || existing.ownerUserId !== actor.userId) throw createError({statusCode: 409, statusMessage: 'Generated image folder is unavailable'})
            return existing
        }
        try { await raw.createFolder(rawDirectory(ownParts), 'output') }
        catch (error) { if (!(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 409)) throw error }
        try { return await repository.register({ownerUserId: actor.userId, parentId: null, url, name: 'output', kind: 'folder', category: 'generated'}) }
        catch (error) {
            const raced = await repository.byUrl(url)
            if (raced?.kind === 'folder' && raced.ownerUserId === actor.userId) return raced
            throw error
        }
    }
    async function saveGeneratedImage(data: Buffer, declaredMimeType?: string) {
        const folder = await ensureGeneratedFolder()
        const output = await raw.saveGeneratedImage(data, declaredMimeType, {organizationId: actor.organizationId, userId: actor.userId})
        try {
            await repository.requireAsset(folder.id, 'edit')
            await repository.register({ownerUserId: actor.userId, parentId: folder.id, url: output.url,
                name: parseImagePath(output.url).at(-1)!, kind: 'file', category: 'generated',
                byteSize: output.bytes, mimeType: output.mimeType, width: output.width, height: output.height})
            return output
        } catch (error) {
            await raw.removeGeneratedImage(output.url).catch(() => undefined)
            throw error
        }
    }
    /** Stage one immutable cutout. Its registry row is published only with a successful job. */
    async function prepareProcessedImage(data: Buffer) {
        await ensureRawFolders([...ownParts, 'cutouts'])
        const output = await raw.saveGeneratedImage(data, 'image/png', {organizationId: actor.organizationId, userId: actor.userId})
        return {
            ...output,
            discard: () => raw.removeGeneratedImage(output.url),
            register: async (tx: BackgroundRemovalTransaction, source: {id: string; url: string}) => {
                // Serialize with owner subtree deletion and repeat authorization after inference.
                await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.organizationId + ':' + actor.userId}, 0))`)
                const fresh = createAssetRepository(actor, tx as unknown as typeof database)
                const candidate = await fresh.requireAsset(source.url)
                const chain = await fresh.ancestors(candidate.row)
                // Hold publication's source/grant checks until commit. Revocation and
                // subtree tombstoning either finish first or serialize after publication.
                await tx.select({id: assets.id}).from(assets).where(and(eq(assets.organizationId, actor.organizationId),
                    inArray(assets.id, chain.map(row => row.id)))).orderBy(asc(assets.id)).for('share')
                if (candidate.row.ownerUserId !== actor.userId) {
                    await tx.select({id: assetShares.id}).from(assetShares).where(and(eq(assetShares.organizationId, actor.organizationId),
                        eq(assetShares.recipientUserId, actor.userId), inArray(assetShares.assetId, chain.map(row => row.id))))
                        .orderBy(asc(assetShares.id)).for('share')
                }
                const [enabled] = await tx.select({id: users.id}).from(users).where(and(eq(users.id, actor.userId),
                    eq(users.organizationId, actor.organizationId), isNull(users.disabledAt))).for('share')
                if (!enabled) throw createError({statusCode: 401, statusMessage: 'Unauthorized'})
                const original = await fresh.requireAsset(source.url)
                if (original.row.id !== source.id || original.row.kind !== 'file') throw createError({statusCode: 404, statusMessage: 'Image not found'})
                const folderUrl = imagePathToUrl([...ownParts, 'cutouts'])
                let [folder] = await tx.select().from(assets).where(and(eq(assets.url, folderUrl),
                    eq(assets.organizationId, actor.organizationId), isNull(assets.deletedAt))).limit(1)
                if (folder && (folder.kind !== 'folder' || folder.ownerUserId !== actor.userId || folder.category !== 'processed')) {
                    throw createError({statusCode: 409, statusMessage: 'Cutout folder is unavailable'})
                }
                if (!folder) {
                    ;[folder] = await tx.insert(assets).values({id: randomUUID(), organizationId: actor.organizationId,
                        ownerUserId: actor.userId, createdByUserId: actor.userId, parentId: null,
                        url: folderUrl, name: 'Cutouts', kind: 'folder', category: 'processed'}).returning()
                }
                if (!folder) throw new Error('Could not register cutout folder')
                const id = randomUUID()
                await tx.insert(assets).values({id, organizationId: actor.organizationId, ownerUserId: actor.userId,
                    createdByUserId: actor.userId, parentId: folder.id, url: output.url,
                    name: `Cutout · ${original.row.name.replace(/\.[^.]+$/, '')}.png`, kind: 'file', category: 'processed',
                    byteSize: output.bytes, mimeType: output.mimeType, width: output.width, height: output.height})
                return {outputAssetId: id, outputUrl: output.url}
            },
        }
    }
    async function removeGeneratedImage(url: string) {
        const {row} = await repository.requireAsset(url, 'edit')
        if (row.category !== 'generated' || row.kind !== 'file' || row.ownerUserId !== actor.userId) throw createError({statusCode: 403, statusMessage: 'Only your generated outputs can be removed here'})
        await raw.removeGeneratedImage(row.url)
        await repository.markDeleted([row.id])
    }
    async function deleteFileOrFolder(path: string, entryType?: 'file' | 'directory') {
        let found
        if (path.startsWith('/images/')) found = await repository.requireAsset(path, 'edit')
        else {
            const parts = parseImagePath(path, true)
            if (!parts.length) throw createError({statusCode: 400, statusMessage: 'Cannot delete root'})
            found = await repository.requireAsset(imagePathToUrl([...ownParts, ...parts]), 'edit')
        }
        const expectedKind = entryType === 'file' ? 'file' : entryType === 'directory' ? 'folder' : undefined
        if (expectedKind && found.row.kind !== expectedKind) throw createError({statusCode: 404, statusMessage: 'Asset not found'})
        const {rows, deletedAt} = await repository.prepareDeletion(found.row.id)
        // The complete bounded registry set is determined before deleting any object.
        // Uploaded blobs have immutable UUID paths and may be physically outside their logical folder.
        try {
            const entries = rows.map(row => ({url: row.url, kind: row.kind}))
            for (const row of rows.filter(row => row.kind === 'file')) {
                const parts = parseImagePath(row.url)
                if (parts.length === 7 && parts[0] === 'organizations' && parts[2] === 'users' && parts[4] === 'objects') {
                    entries.push({url: imagePathToUrl(parts.slice(0, -1)), kind: 'folder'})
                }
            }
            await raw.deleteRegisteredEntries(entries)
        } catch (error) {await repository.restoreDeletion(rows, deletedAt); throw error}
    }
    async function assertReadableImages(urls: readonly string[]) {
        if (urls.length > 200) throw createError({statusCode: 400, statusMessage: 'Too many image sources'})
        for (const url of new Set(urls)) {
            const {row} = await repository.requireAsset(url)
            if (row.kind !== 'file') throw createError({statusCode: 404, statusMessage: 'Image not found'})
        }
    }
    const safe = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => (...args: A) => safeAssetOperation(() => fn(...args))
    return {
        getImageForDelivery: safe(getImageForDelivery),
        getImageFile: safe(readImage), getFile: safe(async (url: string) => (await readImage(url)).buffer),
        assertReadableImages: safe(assertReadableImages), saveUpload: safe(saveUpload),
        saveFile: safe(async (path: string, file: BufferedUploadFile) => (await saveUpload(path, file)).name),
        saveGeneratedImage: safe(saveGeneratedImage), removeGeneratedImage: safe(removeGeneratedImage),
        prepareProcessedImage: safe(prepareProcessedImage),
        createFolder: safe(createFolder), deleteFileOrFolder: safe(deleteFileOrFolder),
        listAssets: safe(repository.list),
        readDir: safe(async (path: string, pagination: {cursor?: string; limit?: number; folderId?: string} = {}) => repository.list({path, ...pagination, direct: true})),
        parseFileDirEntToSelectableFile: (files: AssetFile[]) => files,
        fileExists: safe(async (url: string) => {await assertReadableImages([url]); return raw.fileExists(url)}),
        shareTargets: safe(repository.shareTargets), sharesFor: safe(repository.sharesFor),
        share: safe(repository.share), revoke: safe(repository.revoke), assetByUrl: safe(async (url: string) => repository.dto((await repository.requireAsset(url)).row)),
        resolveAssets: safe(async (urls: string[]) => {
            if (urls.length > 200) throw createError({statusCode: 400, statusMessage: 'Too many image sources'})
            const result: AssetFile[] = []
            for (const url of new Set(urls)) {
                try {const found = await repository.requireAsset(url); if (found.row.kind === 'file') result.push(await repository.dto(found.row, found))}
                catch (error) {if (!(error && typeof error === 'object' && 'statusCode' in error && (error.statusCode === 404 || error.statusCode === 425))) throw error}
            }
            return result
        }),
    }
}
