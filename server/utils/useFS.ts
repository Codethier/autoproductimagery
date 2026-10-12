import { createHash, randomUUID } from "node:crypto"
import { createError } from "h3"
import {
    DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand,
    ListObjectsV2Command, PutObjectCommand, S3Client,
    type GetObjectCommandOutput, type HeadObjectCommandOutput,
    type ListObjectsV2CommandOutput, type DeleteObjectsCommandOutput,
} from "@aws-sdk/client-s3"
import type { SelectableFile } from "~~/schemas/main.dto"
import type { AssetFile, AssetListingPage } from "~~/schemas/image-storage"
import type { BufferedUploadFile } from "./uploadPolicy"
import { canonicalImageExtension, hasSupportedImageExtension, inspectDecodedImage, MAX_STORED_IMAGE_BYTES } from "./imageValidation"
import { imagePathToUrl, normalizeImageStoragePrefix, parseImagePath, validateImagePathSegment } from "./imageStoragePaths"

export const DELETE_TREE_ENTRY_LIMIT = 10_000
export const S3_OPERATION_TIMEOUT_MS = 30_000
export const ASSET_LIST_SCAN_PAGE_LIMIT = 4
const DEFAULT_DIRECTORY_PAGE_SIZE = 100
const MAX_DIRECTORY_PAGE_SIZE = 500
const MAX_FILENAME_ATTEMPTS = 32
const MAX_DELETE_LIST_PAGES = 32

export type ImageStorageCommand = DeleteObjectCommand | DeleteObjectsCommand | GetObjectCommand
    | HeadObjectCommand | ListObjectsV2Command | PutObjectCommand
export type ImageStorageTransport = {
    send(command: ImageStorageCommand, options: { abortSignal: AbortSignal }): Promise<unknown>
}
export type ImageStorageEntry = { name: string }
export type ImageDirectoryPage = {
    files: ImageStorageEntry[]
    dirs: ImageStorageEntry[]
    nextCursor?: string
}
type DirectoryCursorEntry = { kind: "file" | "directory"; name: string }
type DirectoryCursor = { token?: string; exhausted: boolean; pending: DirectoryCursorEntry[] }

const safeStorageErrors = new WeakSet<object>()
function storageError(statusCode: number, message: string, code: string, retryable = false) {
    const error = createError({
        statusCode, statusMessage: message,
        data: { reason: message, code, retryable, diagnosticId: randomUUID() },
    })
    safeStorageErrors.add(error)
    return error
}
function normalizeStorageError(error: unknown) {
    if (error && typeof error === "object" && safeStorageErrors.has(error)) return error
    const failure = error && typeof error === "object" ? error as {
        name?: unknown; $metadata?: { httpStatusCode?: unknown }
    } : {}
    const status = failure.$metadata?.httpStatusCode
    if (status === 404 || failure.name === "NoSuchKey" || failure.name === "NotFound") {
        return storageError(404, "File not found", "not_found")
    }
    if (status === 412 || failure.name === "PreconditionFailed" || failure.name === "ConditionalRequestConflict") {
        return storageError(409, "An image storage entry already exists", "already_exists", true)
    }
    if (failure.name === "AbortError" || failure.name === "TimeoutError") {
        return storageError(504, "Image storage request timed out", "storage_timeout", true)
    }
    return storageError(503, "Image storage is temporarily unavailable", "storage_unavailable", true)
}
function isStorageErrorCode(error: unknown, code: string): boolean {
    return Boolean(error && typeof error === "object" && safeStorageErrors.has(error)
        && "data" in error && (error.data as { code?: unknown })?.code === code)
}
function destroyBody(body: unknown) {
    if (body && typeof body === "object" && "destroy" in body && typeof body.destroy === "function") body.destroy()
}
async function readBoundedBody(body: unknown, signal: AbortSignal): Promise<Buffer> {
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        if (body.byteLength > MAX_STORED_IMAGE_BYTES) throw storageError(413, "Stored image is too large", "image_too_large")
        return Buffer.from(body)
    }
    if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
        throw storageError(503, "Image storage returned an invalid response", "storage_unavailable", true)
    }
    const chunks: Buffer[] = []
    let bytes = 0
    const abort = () => destroyBody(body)
    signal.addEventListener("abort", abort, { once: true })
    try {
        for await (const chunk of body as AsyncIterable<unknown>) {
            if (signal.aborted) throw storageError(504, "Image storage request timed out", "storage_timeout", true)
            if (!(chunk instanceof Uint8Array)) throw storageError(503, "Image storage returned an invalid response", "storage_unavailable", true)
            bytes += chunk.byteLength
            if (bytes > MAX_STORED_IMAGE_BYTES) throw storageError(413, "Stored image is too large", "image_too_large")
            chunks.push(Buffer.from(chunk))
        }
        return Buffer.concat(chunks, bytes)
    } finally {
        signal.removeEventListener("abort", abort)
        destroyBody(body)
        chunks.length = 0
    }
}

export function createS3ImageStorage(options: {
    client: ImageStorageTransport; bucket: string; prefix?: string; timeoutMs?: number
}) {
    const { client, bucket } = options
    if (!bucket || bucket.length > 255 || /[\s/\\\x00-\x1f]/.test(bucket)) {
        throw storageError(500, "Image storage configuration is invalid", "storage_configuration")
    }
    const prefix = normalizeImageStoragePrefix(options.prefix ?? "images")
    const timeoutMs = options.timeoutMs ?? S3_OPERATION_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
        throw storageError(500, "Image storage configuration is invalid", "storage_configuration")
    }

    // Include response-body consumption in the same deadline as the S3 request.
    async function execute<T, R = T>(command: ImageStorageCommand, consume?: (result: T, signal: AbortSignal) => Promise<R>): Promise<R> {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                controller.abort()
                reject(storageError(504, "Image storage request timed out", "storage_timeout", true))
            }, timeoutMs)
        })
        try {
            const request = client.send(command, { abortSignal: controller.signal }).then(async response => {
                if (controller.signal.aborted) {
                    if (response && typeof response === "object" && "Body" in response) destroyBody(response.Body)
                    throw storageError(504, "Image storage request timed out", "storage_timeout", true)
                }
                return consume ? consume(response as T, controller.signal) : response as R
            })
            return await Promise.race([request, timeout])
        } catch (error) { throw normalizeStorageError(error) }
        finally { clearTimeout(timer) }
    }

    function boundedKey(key: string) {
        if (Buffer.byteLength(key, "utf8") > 1024) throw createError({ statusCode: 400, statusMessage: "Image path is too long" })
        return key
    }
    function objectKey(parts: readonly string[]) { return boundedKey(prefix + parts.map(validateImagePathSegment).join("/")) }
    function folderKey(parts: readonly string[]) { return boundedKey(parts.length ? objectKey(parts) + "/" : prefix) }
    async function head(key: string): Promise<HeadObjectCommandOutput | undefined> {
        try { return await execute<HeadObjectCommandOutput>(new HeadObjectCommand({ Bucket: bucket, Key: key })) }
        catch (error) {
            if (isStorageErrorCode(error, "not_found")) return undefined
            throw error
        }
    }
    async function directoryExists(parts: readonly string[]): Promise<boolean> {
        if (!parts.length) return true
        if (await head(folderKey(parts))) return true
        // Imported objects can have parents without explicit markers.
        const result = await execute<ListObjectsV2CommandOutput>(new ListObjectsV2Command({
            Bucket: bucket, Prefix: folderKey(parts), MaxKeys: 1,
        }))
        return Boolean(result.Contents?.length)
    }
    async function assertDirectory(parts: readonly string[]) {
        if (!await directoryExists(parts)) throw storageError(404, "Image folder not found", "not_found")
    }
    function cursorScope(parts: readonly string[]) {
        return createHash("sha256").update(bucket + "/" + folderKey(parts)).digest("base64url")
    }
    function decodeCursor(cursor: string | undefined, parts: readonly string[]): DirectoryCursor {
        if (!cursor) return { exhausted: false, pending: [] }
        try {
            if (cursor.length > 8192 || !/^[a-zA-Z\d_-]+$/.test(cursor)) throw new Error("invalid")
            const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
            if (!value || typeof value !== "object" || Object.keys(value).some(key => !["scope", "token", "exhausted", "pending"].includes(key))) throw new Error("invalid")
            const record = value as { scope?: unknown; token?: unknown; exhausted?: unknown; pending?: unknown }
            if (record.scope !== cursorScope(parts) || typeof record.exhausted !== "boolean" || !Array.isArray(record.pending)
                || record.pending.length > 1) throw new Error("invalid")
            if (record.exhausted ? record.token !== undefined
                : typeof record.token !== "string" || !record.token || Buffer.byteLength(record.token) > 4096) throw new Error("invalid")
            const pending = record.pending.map((entry: unknown): DirectoryCursorEntry => {
                if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => !["kind", "name"].includes(key))) throw new Error("invalid")
                const item = entry as { kind?: unknown; name?: unknown }
                if ((item.kind !== "file" && item.kind !== "directory") || typeof item.name !== "string") throw new Error("invalid")
                validateImagePathSegment(item.name)
                if (item.kind === "file" && !hasSupportedImageExtension(item.name)) throw new Error("invalid")
                if (item.kind === "file") objectKey([...parts, item.name])
                else folderKey([...parts, item.name])
                return { kind: item.kind, name: item.name }
            })
            return { token: record.token as string | undefined, exhausted: record.exhausted, pending }
        } catch { throw createError({ statusCode: 400, statusMessage: "Invalid image directory cursor" }) }
    }
    function encodeCursor(state: DirectoryCursor, parts: readonly string[]) {
        const cursor = Buffer.from(JSON.stringify({ scope: cursorScope(parts), ...state })).toString("base64url")
        if (cursor.length > 8192) throw storageError(503, "Image storage returned an invalid response", "storage_unavailable", true)
        return cursor
    }
    function safeListedName(key: string, directoryPrefix: string, folder = false): string | undefined {
        if (!key.startsWith(directoryPrefix)) return undefined
        const raw = key.slice(directoryPrefix.length)
        const name = folder && raw.endsWith("/") ? raw.slice(0, -1) : raw
        try { return validateImagePathSegment(name) }
        catch { return undefined }
    }
    async function readDir(relative: string, pagination: { cursor?: string; limit?: number } = {}): Promise<ImageDirectoryPage> {
        const parts = parseImagePath(relative, true)
        const limit = pagination.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DIRECTORY_PAGE_SIZE) {
            throw createError({ statusCode: 400, statusMessage: "Invalid image directory page size" })
        }
        const state = decodeCursor(pagination.cursor, parts)
        await assertDirectory(parts)
        const directoryPrefix = folderKey(parts)
        const returned = state.pending.splice(0, limit)
        const remaining = limit - returned.length
        if (remaining > 0 && !state.exhausted) {
            // Some compatible backends terminate marker-only MaxKeys=1 pages
            // incorrectly and do not support StartAfter. Fetch at least two
            // entries and carry the single possible overflow in our cursor.
            const requestedKeys = Math.max(2, remaining)
            const result = await execute<ListObjectsV2CommandOutput>(new ListObjectsV2Command({
                Bucket: bucket, Prefix: directoryPrefix, Delimiter: "/", MaxKeys: requestedKeys,
                ContinuationToken: state.token,
            }))
            if ((result.Contents?.length ?? 0) + (result.CommonPrefixes?.length ?? 0) > requestedKeys) {
                throw storageError(503, "Image storage returned an invalid response", "storage_unavailable", true)
            }
            for (const entry of result.Contents ?? []) {
                if (!entry.Key) continue
                const name = safeListedName(entry.Key, directoryPrefix)
                if (name && hasSupportedImageExtension(name)) state.pending.push({ kind: "file", name })
            }
            for (const entry of result.CommonPrefixes ?? []) {
                if (!entry.Prefix) continue
                const name = safeListedName(entry.Prefix, directoryPrefix, true)
                if (name) state.pending.push({ kind: "directory", name })
            }
            const nextToken = result.IsTruncated ? result.NextContinuationToken : undefined
            if (result.IsTruncated && (!nextToken || nextToken === state.token || Buffer.byteLength(nextToken) > 4096)) {
                throw storageError(503, "Image storage returned an invalid response", "storage_unavailable", true)
            }
            state.token = nextToken
            state.exhausted = !result.IsTruncated
            returned.push(...state.pending.splice(0, remaining))
        }
        const files = returned.filter(entry => entry.kind === "file").map(({ name }) => ({ name }))
        const dirs = returned.filter(entry => entry.kind === "directory").map(({ name }) => ({ name }))
        files.sort((left, right) => left.name.localeCompare(right.name))
        dirs.sort((left, right) => left.name.localeCompare(right.name))
        return {
            files, dirs,
            nextCursor: state.pending.length || !state.exhausted ? encodeCursor(state, parts) : undefined,
        }
    }
    function parseFileDirEntToSelectableFile(entries: ImageStorageEntry[], relative: string): SelectableFile[] {
        const parts = parseImagePath(relative, true)
        return entries.map(entry => ({
            name: validateImagePathSegment(entry.name),
            selectedModel: false, selectedImage: false, selectedMask: false,
            url: imagePathToUrl([...parts, entry.name]),
        }))
    }
    // A global library does not traverse folders one by one or read image bytes.
    // Searches scan a fixed number of bounded S3 pages, returning continuation
    // even when this request found no matches.
    async function listAssets(options: {
        scope?: 'all' | 'uploads' | 'generated'; path?: string; query?: string; cursor?: string; limit?: number
    } = {}): Promise<AssetListingPage> {
        const scope = options.scope ?? 'all'
        const query = (options.query ?? '').trim().toLocaleLowerCase()
        const limit = options.limit ?? 60
        if (!['all', 'uploads', 'generated'].includes(scope) || !Number.isInteger(limit) || limit < 1 || limit > 100
            || query.length > 200 || /[\x00-\x1f\x7f]/.test(query)) {
            throw createError({statusCode: 400, statusMessage: 'Invalid asset listing request'})
        }
        const parts = parseImagePath(options.path ?? '/', true)
        if (scope === 'generated' && parts.length) throw createError({statusCode: 400, statusMessage: 'Invalid generated asset folder'})
        const listingPrefix = scope === 'generated' ? folderKey(['output']) : folderKey(parts)
        const assetScope = createHash('sha256').update(JSON.stringify([bucket, listingPrefix, scope, query])).digest('base64url')
        function assetForKey(key: string, bytes?: number, modifiedAt?: string): AssetFile | undefined {
            if (!key.startsWith(listingPrefix) || key.endsWith('/')) return undefined
            const parts = key.slice(prefix.length).split('/')
            try {
                if (!parts.length || parts.length > 64 || (scope === 'uploads' && parts[0] === 'output')) return undefined
                parts.forEach(validateImagePathSegment)
                const name = parts.at(-1)!
                if (!hasSupportedImageExtension(name) || (query && !parts.join('/').toLocaleLowerCase().includes(query))) return undefined
                boundedKey(key)
                return {
                    name, url: imagePathToUrl(parts), folder: parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/',
                    selectedImage: false, selectedModel: false, selectedMask: false,
                    ...(typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0 ? {bytes} : {}),
                    ...(modifiedAt && Number.isFinite(Date.parse(modifiedAt)) ? {modifiedAt} : {}),
                }
            } catch { return undefined }
        }
        let token: string | undefined
        let exhausted = false
        let pending: AssetFile[] = []
        if (options.cursor) {
            try {
                if (options.cursor.length > 8192 || !/^[a-zA-Z\d_-]+$/.test(options.cursor)) throw new Error('invalid')
                const record = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as Record<string, unknown>
                if (!record || typeof record !== 'object' || Array.isArray(record)
                    || Object.keys(record).some(key => !['scope', 'token', 'exhausted', 'pending'].includes(key))
                    || record.scope !== assetScope || typeof record.exhausted !== 'boolean' || !Array.isArray(record.pending)
                    || record.pending.length > 1 || (record.exhausted ? record.token !== undefined
                        : typeof record.token !== 'string' || !record.token || Buffer.byteLength(record.token) > 4096)) throw new Error('invalid')
                exhausted = record.exhausted
                token = record.token as string | undefined
                pending = record.pending.map((key: unknown) => {
                    if (typeof key !== 'string') throw new Error('invalid')
                    const file = assetForKey(key)
                    if (!file) throw new Error('invalid')
                    return file
                })
            } catch { throw createError({statusCode: 400, statusMessage: 'Invalid asset listing cursor'}) }
        }
        const files = pending.splice(0, limit)
        for (let page = 0; page < ASSET_LIST_SCAN_PAGE_LIMIT && files.length < limit && !exhausted; page += 1) {
            const requestedKeys = Math.max(2, limit - files.length)
            const result = await execute<ListObjectsV2CommandOutput>(new ListObjectsV2Command({
                Bucket: bucket, Prefix: listingPrefix, MaxKeys: requestedKeys, ContinuationToken: token,
            }))
            if ((result.Contents?.length ?? 0) > requestedKeys || result.CommonPrefixes?.length) {
                throw storageError(503, 'Image storage returned an invalid response', 'storage_unavailable', true)
            }
            for (const entry of result.Contents ?? []) {
                if (!entry.Key) continue
                const date = entry.LastModified
                const file = assetForKey(entry.Key, entry.Size, date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined)
                if (!file) continue
                if (files.length < limit) files.push(file)
                else pending.push(file)
            }
            const nextToken = result.IsTruncated ? result.NextContinuationToken : undefined
            if (result.IsTruncated && (!nextToken || nextToken === token || Buffer.byteLength(nextToken) > 4096)) {
                throw storageError(503, 'Image storage returned an invalid response', 'storage_unavailable', true)
            }
            token = nextToken
            exhausted = !result.IsTruncated
        }
        let nextCursor: string | undefined
        if (pending.length || !exhausted) {
            nextCursor = Buffer.from(JSON.stringify({
                scope: assetScope, token, exhausted,
                pending: pending.map(file => objectKey(parseImagePath(file.url))),
            })).toString('base64url')
            if (nextCursor.length > 8192) throw storageError(503, 'Image storage returned an invalid response', 'storage_unavailable', true)
        }
        return {files, nextCursor}
    }
    async function createFolder(relative: string, folderName: string) {
        const parts = parseImagePath(relative, true)
        const name = validateImagePathSegment(folderName)
        await assertDirectory(parts)
        const child = [...parts, name]
        if (await head(objectKey(child)) || await directoryExists(child)) {
            throw storageError(409, "Folder already exists", "already_exists")
        }
        await execute(new PutObjectCommand({
            Bucket: bucket, Key: folderKey(child), Body: Buffer.alloc(0), ContentLength: 0,
            ContentType: "application/x-directory", IfNoneMatch: "*",
        }))
    }
    async function saveFile(relative: string, file: BufferedUploadFile) {
        const parts = parseImagePath(relative, true)
        if (!file.filename) throw createError({ statusCode: 400, statusMessage: "Missing filename" })
        const originalName = validateImagePathSegment(file.filename)
        if (file.type && !file.type.toLowerCase().startsWith("image/")) {
            throw createError({ statusCode: 415, statusMessage: "Declared content-type is not an image" })
        }
        const inspection = await inspectDecodedImage(file.data)
        const extensionIndex = originalName.lastIndexOf(".")
        const stem = extensionIndex > 0 ? originalName.slice(0, extensionIndex) : originalName
        await assertDirectory(parts)
        for (let counter = 0; counter < MAX_FILENAME_ATTEMPTS; counter += 1) {
            const name = `${stem}${counter ? ` (${counter})` : ""}.${inspection.extension}`
            validateImagePathSegment(name)
            if (await directoryExists([...parts, name])) continue
            try {
                await execute(new PutObjectCommand({
                    Bucket: bucket, Key: objectKey([...parts, name]), Body: file.data,
                    ContentLength: file.data.byteLength, ContentType: inspection.mimeType, IfNoneMatch: "*",
                }))
                return name
            } catch (error) {
                if (!isStorageErrorCode(error, "already_exists")) throw error
            }
        }
        throw storageError(409, "Could not allocate a unique image filename", "already_exists", true)
    }
    async function getFile(relative: string): Promise<Buffer> {
        const parts = parseImagePath(relative)
        if (!parts.length) throw createError({ statusCode: 400, statusMessage: "An image filename is required" })
        return execute<GetObjectCommandOutput, Buffer>(new GetObjectCommand({
            Bucket: bucket, Key: objectKey(parts),
        }), async (result, signal) => {
            if (typeof result.ContentLength === "number" && result.ContentLength > MAX_STORED_IMAGE_BYTES) {
                destroyBody(result.Body)
                throw storageError(413, "Stored image is too large", "image_too_large")
            }
            return readBoundedBody(result.Body, signal)
        })
    }
    async function getImageFile(relative: string) {
        const buffer = await getFile(relative)
        return { buffer, ...await inspectDecodedImage(buffer) }
    }
    async function fileExists(relative: string) {
        const parts = parseImagePath(relative)
        return parts.length > 0 && Boolean(await head(objectKey(parts)))
    }
    // Maintenance import preserves historical URLs. Unlike uploads it must never
    // rename a collision; an existing object must contain exactly the same bytes.
    async function importImage(relative: string, data: Buffer): Promise<"imported" | "already_present"> {
        const parts = parseImagePath(relative)
        const filename = parts.at(-1)
        if (!filename) throw createError({ statusCode: 400, statusMessage: "An image filename is required" })
        const inspection = await inspectDecodedImage(data)
        const extension = canonicalImageExtension(filename)
        if (extension !== inspection.extension) {
            throw createError({ statusCode: 415, statusMessage: "Imported image extension must match decoded content" })
        }
        await assertDirectory(parts.slice(0, -1))
        try {
            await execute(new PutObjectCommand({
                Bucket: bucket, Key: objectKey(parts), Body: data,
                ContentLength: data.byteLength, ContentType: inspection.mimeType, IfNoneMatch: "*",
            }))
            return "imported"
        } catch (error) {
            if (!isStorageErrorCode(error, "already_exists")) throw error
            if ((await getFile(relative)).equals(data)) return "already_present"
            throw storageError(409, "Imported image conflicts with existing content", "import_conflict")
        }
    }
    let outputFolderReady: Promise<void> | undefined
    async function ensureOutputFolder() {
        outputFolderReady ??= execute(new PutObjectCommand({
            Bucket: bucket, Key: folderKey(["output"]), Body: Buffer.alloc(0), ContentLength: 0,
            ContentType: "application/x-directory", IfNoneMatch: "*",
        })).then(() => undefined).catch(error => {
            if (isStorageErrorCode(error, "already_exists")) return
            outputFolderReady = undefined
            throw error
        })
        await outputFolderReady
    }
    async function saveGeneratedImage(data: Buffer, _declaredMimeType?: string, namespace?: {organizationId: string; userId: string}) {
        const inspection = await inspectDecodedImage(data, true)
        const outputParts = namespace
            ? ['organizations', namespace.organizationId, 'users', namespace.userId, 'output'] : ['output']
        if (namespace && (![namespace.organizationId, namespace.userId].every(value => /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)))) {
            throw createError({statusCode: 400, statusMessage: 'Invalid image namespace'})
        }
        if (namespace) {
            try {
                await execute(new PutObjectCommand({Bucket: bucket, Key: folderKey(outputParts), Body: Buffer.alloc(0),
                    ContentLength: 0, ContentType: 'application/x-directory', IfNoneMatch: '*'}))
            } catch (error) { if (!isStorageErrorCode(error, 'already_exists')) throw error }
        } else await ensureOutputFolder()
        const filename = `img-${Date.now()}-${randomUUID()}.${inspection.extension}`
        await execute(new PutObjectCommand({
            Bucket: bucket, Key: objectKey([...outputParts, filename]), Body: data,
            ContentLength: data.byteLength, ContentType: inspection.mimeType, IfNoneMatch: "*",
        }))
        return {
            url: imagePathToUrl([...outputParts, filename]), mimeType: inspection.mimeType,
            bytes: data.byteLength, width: inspection.width, height: inspection.height,
        }
    }
    async function removeGeneratedImage(url: string) {
        const parts = parseImagePath(url)
        const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
        const legacy = parts.length === 2 && parts[0] === 'output'
        const scoped = parts.length === 6 && parts[0] === 'organizations' && uuid.test(parts[1]!)
            && parts[2] === 'users' && uuid.test(parts[3]!) && parts[4] === 'output'
        if ((!legacy && !scoped) || !/^img-\d+-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.(png|jpg|gif|webp|bmp|tiff|heic)$/.test(parts.at(-1)!)) {
            throw createError({ statusCode: 400, statusMessage: "Only generated output files can be removed here" })
        }
        await execute(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(parts) }))
    }
    async function deleteFileOrFolder(relative: string, entryType?: "file" | "directory") {
        const parts = parseImagePath(relative, true)
        if (!parts.length) throw createError({ statusCode: 400, statusMessage: "Cannot delete root" })
        if (entryType !== undefined && entryType !== "file" && entryType !== "directory") {
            throw createError({ statusCode: 400, statusMessage: "Invalid image entry type" })
        }
        const fileKey = objectKey(parts)
        const file = entryType === "directory" ? undefined : await head(fileKey)
        if (entryType === "file" && !file) throw storageError(404, "File not found", "not_found")
        if (file) {
            if (entryType === undefined && await directoryExists(parts)) {
                throw storageError(409, "Choose whether to delete the image or folder", "ambiguous_entry")
            }
            await execute(new DeleteObjectCommand({ Bucket: bucket, Key: fileKey }))
            return
        }
        const directoryPrefix = folderKey(parts)
        const keys: string[] = []
        let token: string | undefined
        let pages = 0
        do {
            pages += 1
            const result = await execute<ListObjectsV2CommandOutput>(new ListObjectsV2Command({
                Bucket: bucket, Prefix: directoryPrefix, MaxKeys: 1000, ContinuationToken: token,
            }))
            for (const entry of result.Contents ?? []) {
                if (!entry.Key || !entry.Key.startsWith(directoryPrefix)) {
                    throw storageError(503, "Image storage returned an invalid response", "storage_unavailable", true)
                }
                keys.push(entry.Key)
                if (keys.length > DELETE_TREE_ENTRY_LIMIT) {
                    throw createError({ statusCode: 413, statusMessage: "Folder is too large to delete safely" })
                }
            }
            const previousToken = token
            token = result.IsTruncated ? result.NextContinuationToken : undefined
            if (result.IsTruncated && (!token || token === previousToken || pages >= MAX_DELETE_LIST_PAGES)) {
                throw storageError(503, "Image storage returned an invalid response", "storage_unavailable", true)
            }
        } while (token)
        if (!keys.length) throw storageError(404, "Image folder not found", "not_found")
        // Bound the complete deletion set before the first destructive call.
        // Keep the folder marker until all children have been deleted.
        const children = keys.filter(key => key !== directoryPrefix)
        for (let offset = 0; offset < children.length; offset += 1000) {
            const result = await execute<DeleteObjectsCommandOutput>(new DeleteObjectsCommand({
                Bucket: bucket, Delete: { Objects: children.slice(offset, offset + 1000).map(Key => ({ Key })), Quiet: true },
            }))
            if (result.Errors?.length) {
                throw storageError(503, "Some images could not be deleted; retry the folder deletion", "partial_delete", true)
            }
        }
        if (keys.includes(directoryPrefix)) await execute(new DeleteObjectCommand({ Bucket: bucket, Key: directoryPrefix }))
        if (parts.length === 1 && parts[0] === "output") outputFolderReady = undefined
    }
    async function deleteFolderMarker(relative: string) {
        const parts = parseImagePath(relative, true)
        if (!parts.length) throw createError({statusCode: 400, statusMessage: 'Cannot delete root'})
        // Actor-bound callers already determine their registry deletion set.
        // Removing a marker must never sweep unrelated physical descendants.
        await execute(new DeleteObjectCommand({Bucket: bucket, Key: folderKey(parts)}))
    }
    async function deleteRegisteredEntries(entries: Array<{url: string; kind: 'file' | 'folder'}>) {
        if (entries.length > DELETE_TREE_ENTRY_LIMIT * 2) throw createError({statusCode: 413, statusMessage: 'Folder is too large to delete safely'})
        const keys = [...new Set(entries.map(entry => {
            const parts = parseImagePath(entry.url)
            if (!parts.length || imagePathToUrl(parts) !== entry.url || (entry.kind !== 'file' && entry.kind !== 'folder')) {
                throw createError({statusCode: 400, statusMessage: 'Invalid registered image path'})
            }
            return entry.kind === 'folder' ? folderKey(parts) : objectKey(parts)
        }))]
        // No bucket listing and no recursive prefix deletion: the caller authorizes every exact key.
        for (let offset = 0; offset < keys.length; offset += 1000) {
            const result = await execute<DeleteObjectsCommandOutput>(new DeleteObjectsCommand({Bucket: bucket,
                Delete: {Objects: keys.slice(offset, offset + 1000).map(Key => ({Key})), Quiet: true}}))
            if (result.Errors?.length) throw storageError(503, 'Some images could not be deleted; retry the folder deletion', 'partial_delete', true)
        }
        if (entries.some(entry => entry.kind === 'folder' && entry.url === '/images/output')) outputFolderReady = undefined
    }
    return {
        readDir, listAssets,
        listDirs: async (relative: string) => (await readDir(relative)).dirs,
        listFiles: async (relative: string) => (await readDir(relative)).files,
        parseFileDirEntToSelectableFile, createFolder, saveFile, deleteFileOrFolder, deleteFolderMarker, deleteRegisteredEntries,
        getFile, getImageFile, saveGeneratedImage, removeGeneratedImage, fileExists, importImage,
    }
}

let cachedStorage: ReturnType<typeof createS3ImageStorage> | undefined
let cachedClient: S3Client | undefined

// The scheduled worker has a finite lifetime; release SDK connections when it exits.
export function closeImageStorage() {
    cachedClient?.destroy()
    cachedClient = undefined
    cachedStorage = undefined
}

export async function useFS() {
    if (cachedStorage) return cachedStorage
    const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PREFIX, S3_FORCE_PATH_STYLE } = process.env
    if (!S3_ENDPOINT || !S3_REGION || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
        throw storageError(500, "Image storage is not configured", "storage_configuration")
    }
    try {
        const endpoint = new URL(S3_ENDPOINT)
        if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("invalid")
        if (S3_FORCE_PATH_STYLE && S3_FORCE_PATH_STYLE !== "true" && S3_FORCE_PATH_STYLE !== "false") throw new Error("invalid")
    } catch { throw storageError(500, "Image storage configuration is invalid", "storage_configuration") }
    const client = new S3Client({
        endpoint: S3_ENDPOINT, region: S3_REGION,
        credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
        forcePathStyle: S3_FORCE_PATH_STYLE !== "false", maxAttempts: 2,
        requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    })
    cachedStorage = createS3ImageStorage({ client, bucket: S3_BUCKET, prefix: S3_PREFIX })
    cachedClient = client
    return cachedStorage
}
