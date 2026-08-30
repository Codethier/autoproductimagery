import { promises as fs, constants as fsConstants } from "node:fs"
import type { Dirent } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createError } from "h3"
import sharp from "sharp"
import type { SelectableFile } from "~~/schemas/main.dto"
import type { BufferedUploadFile } from "./uploadPolicy"

const BASE_DIR = path.resolve("./data/images")
const BASE_PARENT = path.dirname(BASE_DIR)
const INVALID_NAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i
const DIAGNOSTIC_ENTRY_LIMIT = 25
const DELETE_TREE_ENTRY_LIMIT = 10_000
const MAX_IMAGE_PIXELS = 40_000_000
const MAX_STORED_IMAGE_BYTES = 25 * 1024 * 1024
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"])

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    tiff: "image/tiff",
    heic: "image/heic",
}

const SHARP_FORMAT_BY_EXTENSION: Record<string, string> = {
    png: "png",
    jpg: "jpeg",
    gif: "gif",
    webp: "webp",
    bmp: "magick",
    tiff: "tiff",
    heic: "heif",
}

type ImageInspection = {
    extension: string
    mimeType: string
    width: number
    height: number
    hasAlpha?: boolean
}

function sanitizeName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed || trimmed === "." || trimmed === "..") {
        throw createError({ statusCode: 400, statusMessage: "Invalid name" })
    }
    if (INVALID_NAME_CHARS.test(trimmed) || RESERVED_NAMES.test(trimmed)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid name" })
    }
    return trimmed
}

function normalizedForComparison(value: string) {
    const normalized = path.resolve(value).replace(/[\\/]+$/, "")
    return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized
}

function isWithin(base: string, target: string) {
    const normalizedBase = normalizedForComparison(base)
    const normalizedTarget = normalizedForComparison(target)
    return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + path.sep)
}

function normalizeRelativePath(relative: string): string {
    const normalized = String(relative ?? "").replaceAll("\\", "/")
    const segments = normalized.split("/").filter(Boolean)
    for (const segment of segments) {
        if (segment === "." || segment === ".." || INVALID_NAME_CHARS.test(segment)) {
            throw createError({ statusCode: 400, statusMessage: "Invalid path" })
        }
    }
    return segments.join(path.sep)
}

function resolveWithin(base: string, relative: string): string {
    const resolved = path.resolve(base, normalizeRelativePath(relative))
    if (!isWithin(base, resolved)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid path" })
    }
    return resolved
}

function decodeUrlPath(relative: string): string {
    try {
        return decodeURIComponent(relative)
    } catch {
        throw createError({ statusCode: 400, statusMessage: "Invalid path encoding" })
    }
}

function toImageRelativePath(value: string): string {
    const decoded = decodeUrlPath(String(value ?? ""))
    const normalized = decoded.replaceAll("\\", "/")
    if (normalized === "/images") return ""
    if (!normalized.startsWith("/images/")) {
        throw createError({ statusCode: 400, statusMessage: "Image path must be inside /images/" })
    }
    return normalized.slice("/images/".length)
}

function isHeicBmff(data: Buffer): boolean {
    if (data.length < 16 || data.subarray(4, 8).toString("ascii") !== "ftyp") return false
    const boxSize = data.readUInt32BE(0)
    if (boxSize < 16 || boxSize > data.length) return false
    if (HEIC_BRANDS.has(data.subarray(8, 12).toString("ascii"))) return true
    for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
        if (HEIC_BRANDS.has(data.subarray(offset, offset + 4).toString("ascii"))) return true
    }
    return false
}

const IMAGE_MAGIC_SIGNATURES: Array<{ ext: string; check: (buffer: Buffer) => boolean }> = [
    { ext: "png", check: buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { ext: "jpg", check: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
    { ext: "gif", check: buffer => buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii")) },
    { ext: "webp", check: buffer => buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP" },
    { ext: "bmp", check: buffer => buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d },
    { ext: "tiff", check: buffer => buffer.length >= 4 && ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) || (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)) },
    { ext: "heic", check: isHeicBmff },
]

export function detectImageType(data: Buffer): string | null {
    for (const signature of IMAGE_MAGIC_SIGNATURES) {
        if (signature.check(data)) return signature.ext
    }
    return null
}

async function inspectDecodedImage(data: Buffer, providerPayload = false): Promise<ImageInspection> {
    const extension = detectImageType(data)
    const badPayload = (message: string, statusCode = providerPayload ? 502 : 415): never => {
        throw createError({ statusCode, statusMessage: message })
    }
    if (!extension) return badPayload(providerPayload
        ? "Provider returned an unsupported image payload"
        : "Unsupported file type — image required")

    try {
        const image = sharp(data, {
            failOn: "error",
            limitInputPixels: MAX_IMAGE_PIXELS,
            sequentialRead: true,
        })
        const metadata = await image.metadata()
        if (!metadata.width || !metadata.height || !metadata.format) {
            return badPayload(providerPayload ? "Provider returned an invalid image" : "Invalid image")
        }
        if ((metadata.pages ?? 1) !== 1) {
            return badPayload("Animated or multi-page images are not supported")
        }
        if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
            return badPayload("Image dimensions are too large", 413)
        }
        const expectedFormat = SHARP_FORMAT_BY_EXTENSION[extension]
        if (expectedFormat && metadata.format !== expectedFormat) {
            return badPayload(providerPayload ? "Provider returned an invalid image" : "Image content does not match its format")
        }

        // stats() walks every decoded pixel but returns only a tiny aggregate,
        // unlike raw().toBuffer(), which would allocate width × height × channels.
        const decodedStats = await image.clone().stats()
        if (decodedStats.channels.length === 0) return badPayload(providerPayload ? "Provider returned an invalid image" : "Invalid image")
        return {
            extension,
            mimeType: IMAGE_MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
            width: metadata.width,
            height: metadata.height,
            hasAlpha: metadata.hasAlpha,
        }
    } catch (error: any) {
        if (typeof error?.statusCode === "number") throw error
        const tooLarge = /pixel limit|too large|exceeds/i.test(String(error?.message || ""))
        return badPayload(
            tooLarge ? "Image dimensions are too large" : (providerPayload ? "Provider returned an invalid image" : "Invalid or corrupt image"),
            tooLarge ? 413 : undefined,
        )
    }
}

async function initializeImageRoot() {
    await fs.mkdir(BASE_PARENT, { recursive: true })
    const parentReal = await fs.realpath(BASE_PARENT)
    if (normalizedForComparison(parentReal) !== normalizedForComparison(BASE_PARENT)) {
        throw createError({ statusCode: 500, statusMessage: "Image storage root is unsafe" })
    }
    await fs.mkdir(BASE_DIR, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
    })
    const rootStat = await fs.lstat(BASE_DIR)
    const rootReal = await fs.realpath(BASE_DIR)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
        || normalizedForComparison(rootReal) !== normalizedForComparison(BASE_DIR)) {
        throw createError({ statusCode: 500, statusMessage: "Image storage root is unsafe" })
    }
    return rootReal
}

async function assertSafeExistingPath(rootReal: string, target: string) {
    if (!isWithin(BASE_DIR, target)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid path" })
    }
    const relative = path.relative(BASE_DIR, target)
    let current = BASE_DIR
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment)
        const stat = await fs.lstat(current)
        if (stat.isSymbolicLink()) {
            throw createError({ statusCode: 400, statusMessage: "Symbolic links are not allowed in image storage" })
        }
        const real = await fs.realpath(current)
        if (!isWithin(rootReal, real)) {
            throw createError({ statusCode: 400, statusMessage: "Image path escapes storage root" })
        }
    }
}

async function ensureSafeDirectory(rootReal: string, target: string) {
    await assertSafeExistingPath(rootReal, target)
    const stat = await fs.lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw createError({ statusCode: 400, statusMessage: "Image directory is invalid" })
    }
}

async function ensureSafeChildDirectory(rootReal: string, target: string) {
    const parent = path.dirname(target)
    await ensureSafeDirectory(rootReal, parent)
    try {
        await fs.mkdir(target)
    } catch (error: any) {
        if (error?.code !== "EEXIST") throw error
    }
    await ensureSafeDirectory(rootReal, target)
}

async function secureReadFile(rootReal: string, target: string) {
    await assertSafeExistingPath(rootReal, target)
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0)
    const handle = await fs.open(target, fsConstants.O_RDONLY | noFollow)
    try {
        const stat = await handle.stat()
        if (!stat.isFile()) throw createError({ statusCode: 404, statusMessage: "File not found" })
        if (stat.size > MAX_STORED_IMAGE_BYTES) throw createError({ statusCode: 413, statusMessage: "Stored image is too large" })
        const afterOpenReal = await fs.realpath(target)
        if (!isWithin(rootReal, afterOpenReal)) {
            throw createError({ statusCode: 400, statusMessage: "Image path escapes storage root" })
        }
        return await handle.readFile()
    } finally {
        await handle.close()
    }
}

async function openExclusive(dir: string, filename: string, data: Buffer): Promise<string> {
    const extension = path.extname(filename)
    const stem = path.basename(filename, extension)
    for (let counter = 0; counter <= 10_000; counter += 1) {
        const candidate = counter === 0 ? path.join(dir, filename) : path.join(dir, `${stem} (${counter})${extension}`)
        try {
            const handle = await fs.open(candidate, "wx")
            try {
                await handle.writeFile(data)
                await handle.sync()
            } finally {
                await handle.close()
            }
            return candidate
        } catch (error: any) {
            if (error?.code !== "EEXIST") throw error
        }
    }
    throw createError({ statusCode: 500, statusMessage: "Could not allocate unique filename" })
}

async function assertTreeHasNoLinks(target: string) {
    const pending = [target]
    let visited = 0
    while (pending.length > 0) {
        const current = pending.pop()!
        const stat = await fs.lstat(current)
        if (stat.isSymbolicLink()) {
            throw createError({ statusCode: 400, statusMessage: "Symbolic links are not allowed in image storage" })
        }
        visited += 1
        if (visited > DELETE_TREE_ENTRY_LIMIT) {
            throw createError({ statusCode: 413, statusMessage: "Folder is too large to delete safely" })
        }
        if (!stat.isDirectory()) continue
        for (const entry of await fs.readdir(current)) pending.push(path.join(current, entry))
    }
}

function errorInfo(error: any) {
    if (!error) return undefined
    return {
        code: typeof error?.code === "string" ? error.code : undefined,
        message: String(error?.statusMessage || error?.message || error),
        statusCode: typeof error?.statusCode === "number" ? error.statusCode : undefined,
    }
}

export async function useFS() {
    const rootReal = await initializeImageRoot()

    function resolvePath(relative: string) {
        return resolveWithin(BASE_DIR, relative ?? "/")
    }

    async function listDirs(relative: string): Promise<Dirent[]> {
        const target = resolvePath(relative)
        await ensureSafeDirectory(rootReal, target)
        return (await fs.readdir(target, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    }

    async function listFiles(relative: string): Promise<Dirent[]> {
        const target = resolvePath(relative)
        await ensureSafeDirectory(rootReal, target)
        return (await fs.readdir(target, { withFileTypes: true })).filter(entry => entry.isFile() && !entry.isSymbolicLink())
    }

    async function readDir(relative: string) {
        const target = resolvePath(relative)
        await ensureSafeDirectory(rootReal, target)
        const entries = await fs.readdir(target, { withFileTypes: true })
        const files = entries.filter(entry => entry.isFile() && !entry.isSymbolicLink())
        const dirs = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        files.sort((left, right) => left.name.localeCompare(right.name))
        dirs.sort((left, right) => left.name.localeCompare(right.name))
        return { files, dirs }
    }

    function relativePathToUrl(relative: string, name: string) {
        const joined = normalizeRelativePath(path.join(relative || "", name))
        const encoded = joined.split(path.sep).filter(Boolean).map(encodeURIComponent).join("/")
        return `/images/${encoded}`
    }

    function parseFileDirEntToSelectableFile(dirents: Dirent[], relative: string): SelectableFile[] {
        return dirents.map(entry => ({
            name: entry.name,
            selectedModel: false,
            selectedImage: false,
            selectedMask: false,
            url: relativePathToUrl(relative, entry.name),
        }))
    }

    async function createFolder(relative: string, folderName: string) {
        const safeName = sanitizeName(folderName)
        const parent = resolvePath(relative)
        await ensureSafeDirectory(rootReal, parent)
        const target = resolveWithin(BASE_DIR, path.join(normalizeRelativePath(relative), safeName))
        try {
            await fs.mkdir(target)
        } catch (error: any) {
            if (error?.code === "EEXIST") throw createError({ statusCode: 409, statusMessage: "Folder already exists" })
            throw error
        }
        await ensureSafeDirectory(rootReal, target)
    }

    async function saveFile(relative: string, file: BufferedUploadFile) {
        if (!file.filename) throw createError({ statusCode: 400, statusMessage: "Missing filename" })
        if (file.data.byteLength > MAX_STORED_IMAGE_BYTES) throw createError({ statusCode: 413, statusMessage: "Image is too large" })
        if (file.type && !file.type.toLowerCase().startsWith("image/")) {
            throw createError({ statusCode: 415, statusMessage: "Declared content-type is not an image" })
        }
        const inspection = await inspectDecodedImage(file.data)
        const originalName = sanitizeName(path.basename(file.filename))
        const stem = path.basename(originalName, path.extname(originalName))
        const safeName = `${stem}.${inspection.extension}`
        const directory = resolvePath(relative)
        await ensureSafeDirectory(rootReal, directory)
        return path.basename(await openExclusive(directory, safeName, file.data))
    }

    async function deleteFileOrFolder(relative: string) {
        const target = resolvePath(relative)
        if (target === BASE_DIR) throw createError({ statusCode: 400, statusMessage: "Cannot delete root" })
        try {
            await assertSafeExistingPath(rootReal, target)
            await assertTreeHasNoLinks(target)
            await fs.rm(target, { recursive: true, force: false })
        } catch (error: any) {
            if (error?.code === "ENOENT") throw createError({ statusCode: 404, statusMessage: "Not found" })
            throw error
        }
    }

    async function getFileDiagnostics(relative: string, error?: any) {
        let decodedPath: string | undefined
        let decodeError: string | undefined
        let resolvedPath: string | undefined
        let parentPath: string | undefined
        let parentEntriesSample: string[] = []
        let statError: ReturnType<typeof errorInfo> | undefined
        try {
            decodedPath = decodeURIComponent(String(relative ?? ""))
        } catch (decodeFailure: any) {
            decodeError = String(decodeFailure?.message || decodeFailure)
        }
        try {
            resolvedPath = resolveWithin(BASE_DIR, toImageRelativePath(decodedPath ?? String(relative ?? "")))
            parentPath = path.dirname(resolvedPath)
            await fs.lstat(resolvedPath).catch((failure: any) => { statError = errorInfo(failure) })
            await ensureSafeDirectory(rootReal, parentPath)
            parentEntriesSample = (await fs.readdir(parentPath)).slice(0, DIAGNOSTIC_ENTRY_LIMIT)
        } catch (failure: any) {
            statError = errorInfo(failure)
        }
        return {
            originalPath: String(relative ?? ""),
            decodedPath,
            decodeError,
            cwd: path.resolve("."),
            baseDir: BASE_DIR,
            rootReal,
            resolvedPath,
            parentPath,
            parentEntriesSample,
            statError,
            thrownError: errorInfo(error),
        }
    }

    async function getFile(relative: string): Promise<Buffer> {
        let target: string
        try {
            target = resolveWithin(BASE_DIR, toImageRelativePath(relative))
            return await secureReadFile(rootReal, target)
        } catch (error: any) {
            const diagnosticId = randomUUID()
            console.warn("[image-file-load] Could not read image file", {
                diagnosticId,
                ...await getFileDiagnostics(relative, error),
            })
            const statusCode = error?.code === "ENOENT" ? 404
                : (Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500 ? Number(error.statusCode) : 500)
            const statusMessage = statusCode === 404 ? "File not found"
                : (statusCode < 500 ? String(error?.statusMessage || "Invalid image path") : "Could not read image file")
            throw createError({
                statusCode,
                statusMessage,
                data: { reason: statusMessage, diagnosticId },
            })
        }
    }

    async function fileExists(relative: string) {
        const target = resolveWithin(BASE_DIR, toImageRelativePath(relative))
        try {
            await assertSafeExistingPath(rootReal, target)
            const stat = await fs.lstat(target)
            return stat.isFile() && !stat.isSymbolicLink()
        } catch (error: any) {
            if (error?.code === "ENOENT") return false
            throw error
        }
    }

    async function getImageFile(relative: string) {
        const buffer = await getFile(relative)
        return { buffer, ...await inspectDecodedImage(buffer) }
    }

    async function saveGeneratedImage(data: Buffer, _declaredMimeType?: string) {
        if (data.byteLength > MAX_STORED_IMAGE_BYTES) {
            throw createError({ statusCode: 502, statusMessage: "Provider returned an image that is too large" })
        }
        const inspection = await inspectDecodedImage(data, true)
        const outputDirectory = resolveWithin(BASE_DIR, "output")
        await ensureSafeChildDirectory(rootReal, outputDirectory)
        const id = randomUUID()
        const filename = `img-${Date.now()}-${id}.${inspection.extension}`
        const destination = resolveWithin(outputDirectory, filename)
        const temporary = resolveWithin(outputDirectory, `.tmp-${id}.${inspection.extension}`)
        try {
            const handle = await fs.open(temporary, "wx")
            try {
                await handle.writeFile(data)
                await handle.sync()
            } finally {
                await handle.close()
            }
            await fs.rename(temporary, destination)
            await assertSafeExistingPath(rootReal, destination)
        } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => undefined)
            throw error
        }
        return {
            url: `/images/output/${filename}`,
            mimeType: inspection.mimeType,
            bytes: data.length,
            width: inspection.width,
            height: inspection.height,
        }
    }

    async function removeGeneratedImage(url: string) {
        const target = resolveWithin(BASE_DIR, toImageRelativePath(url))
        const outputDirectory = resolveWithin(BASE_DIR, "output")
        if (target === outputDirectory || !isWithin(outputDirectory, target)) {
            throw createError({ statusCode: 400, statusMessage: "Only generated output files can be removed here" })
        }
        try {
            await assertSafeExistingPath(rootReal, target)
            const stat = await fs.lstat(target)
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw createError({ statusCode: 400, statusMessage: "Generated output path is invalid" })
            }
            await fs.rm(target, { force: true })
        } catch (error: any) {
            if (error?.code !== "ENOENT") throw error
        }
    }

    return {
        listDirs,
        listFiles,
        readDir,
        parseFileDirEntToSelectableFile,
        createFolder,
        saveFile,
        deleteFileOrFolder,
        getFile,
        getImageFile,
        saveGeneratedImage,
        removeGeneratedImage,
        fileExists,
    }
}
