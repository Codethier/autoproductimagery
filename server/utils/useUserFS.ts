import {createError} from 'h3'
import {randomUUID} from 'node:crypto'
import {createAssetRepository, MAX_ASSET_FOLDER_DEPTH, personalImageParts, type AssetActor} from './assetAccess'
import {useFS} from './useFS'
import {getDatabase} from './lib/db'
import {imagePathToUrl, parseImagePath, validateImagePathSegment} from './imageStoragePaths'
import {inspectDecodedImage} from './imageValidation'
import type {BufferedUploadFile} from './uploadPolicy'
import type {AssetFile} from '../../schemas/image-storage'

type RawStorage = Awaited<ReturnType<typeof useFS>>
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
        getImageFile: safe(readImage), getFile: safe(async (url: string) => (await readImage(url)).buffer),
        assertReadableImages: safe(assertReadableImages), saveUpload: safe(saveUpload),
        saveFile: safe(async (path: string, file: BufferedUploadFile) => (await saveUpload(path, file)).name),
        saveGeneratedImage: safe(saveGeneratedImage), removeGeneratedImage: safe(removeGeneratedImage),
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
