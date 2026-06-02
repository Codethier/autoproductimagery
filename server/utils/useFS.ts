import { promises as fs } from "fs"
import path from "node:path"
import type { Dirent } from "node:fs"
import type { MultiPartData } from "h3"
import { createError } from "h3"
import type { SelectableFile } from "~~/schemas/main.dto"

const BASE_DIR = path.resolve("./data/images")
const DATA_ROOT = path.resolve("./data")

const INVALID_NAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i

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

function resolveWithin(base: string, relative: string): string {
    const cleaned = relative.replace(/^[/\\]+/, "")
    const resolved = path.resolve(base, cleaned)
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
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

async function openExclusive(dir: string, filename: string, data: Buffer): Promise<string> {
    const ext = path.extname(filename)
    const stem = path.basename(filename, ext)
    let counter = 0
    while (true) {
        const candidate = counter === 0
            ? path.join(dir, filename)
            : path.join(dir, `${stem} (${counter})${ext}`)
        try {
            const handle = await fs.open(candidate, "wx")
            try {
                await handle.writeFile(data)
            } finally {
                await handle.close()
            }
            return candidate
        } catch (err: any) {
            if (err?.code !== "EEXIST") throw err
            counter += 1
            if (counter > 10000) {
                throw createError({ statusCode: 500, statusMessage: "Could not allocate unique filename" })
            }
        }
    }
}

const IMAGE_MAGIC_SIGNATURES: Array<{ ext: string; check: (b: Buffer) => boolean }> = [
    { ext: "png", check: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
    { ext: "jpg", check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { ext: "gif", check: (b) => b.length >= 6 && b.slice(0, 6).toString("ascii").match(/^GIF8[79]a$/) !== null },
    { ext: "webp", check: (b) => b.length >= 12 && b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WEBP" },
    { ext: "bmp", check: (b) => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d },
    { ext: "tiff", check: (b) => b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) },
    { ext: "heic", check: (b) => b.length >= 12 && b.slice(4, 8).toString("ascii") === "ftyp" },
]

function detectImageType(data: Buffer): string | null {
    for (const sig of IMAGE_MAGIC_SIGNATURES) {
        if (sig.check(data)) return sig.ext
    }
    return null
}

export async function useFS() {
    await fs.mkdir(BASE_DIR, { recursive: true })

    function resolvePath(relative: string): string {
        return resolveWithin(BASE_DIR, relative ?? "/")
    }

    async function listDirs(relative: string): Promise<Dirent[]> {
        const target = resolvePath(relative)
        const entries = await fs.readdir(target, { withFileTypes: true })
        return entries.filter((d) => d.isDirectory())
    }

    async function listFiles(relative: string): Promise<Dirent[]> {
        const target = resolvePath(relative)
        const entries = await fs.readdir(target, { withFileTypes: true })
        return entries.filter((d) => d.isFile())
    }

    async function readDir(relative: string) {
        const target = resolvePath(relative)
        const entries = await fs.readdir(target, { withFileTypes: true })
        const files = entries.filter((d) => d.isFile())
        const dirs = entries.filter((d) => d.isDirectory())
        files.sort((a, b) => a.name.localeCompare(b.name))
        dirs.sort((a, b) => a.name.localeCompare(b.name))
        return { files, dirs }
    }

    function parentPathToUrl(parentPath: string, name: string): string {
        const rel = path.relative(DATA_ROOT, path.resolve(parentPath))
        const url = rel.split(path.sep).map(encodeURIComponent).join("/")
        return `/${url}/${encodeURIComponent(name)}`
    }

    function parseFileDirEntToSelectableFile(dirents: Dirent[]): SelectableFile[] {
        return dirents.map((d) => ({
            parentPath: d.parentPath,
            name: d.name,
            selectedModel: false,
            selectedImage: false,
            url: parentPathToUrl(d.parentPath, d.name),
        }))
    }

    async function createFolder(relative: string, folderName: string): Promise<void> {
        const safeName = sanitizeName(folderName)
        const parent = resolvePath(relative)
        const target = resolveWithin(BASE_DIR, path.join(relative ?? "/", safeName))
        await fs.mkdir(parent, { recursive: true })
        try {
            await fs.mkdir(target)
        } catch (err: any) {
            if (err?.code === "EEXIST") {
                throw createError({ statusCode: 409, statusMessage: "Folder already exists" })
            }
            throw err
        }
    }

    async function saveFile(relative: string, file: MultiPartData): Promise<string> {
        if (!file.filename) {
            throw createError({ statusCode: 400, statusMessage: "Missing filename" })
        }
        const detected = detectImageType(file.data)
        if (!detected) {
            throw createError({ statusCode: 415, statusMessage: "Unsupported file type — image required" })
        }
        if (file.type && !file.type.toLowerCase().startsWith("image/")) {
            throw createError({ statusCode: 415, statusMessage: "Declared content-type is not an image" })
        }
        const safeName = sanitizeName(path.basename(file.filename))
        const dir = resolvePath(relative)
        await fs.mkdir(dir, { recursive: true })
        const destination = await openExclusive(dir, safeName, file.data)
        return path.basename(destination)
    }

    async function deleteFileOrFolder(relative: string): Promise<void> {
        const target = resolvePath(relative)
        if (target === BASE_DIR) {
            throw createError({ statusCode: 400, statusMessage: "Cannot delete root" })
        }
        try {
            await fs.rm(target, { recursive: true, force: false })
        } catch (err: any) {
            if (err?.code === "ENOENT") {
                throw createError({ statusCode: 404, statusMessage: "Not found" })
            }
            throw err
        }
    }

    async function getFile(relative: string): Promise<Buffer> {
        const target = resolveWithin(DATA_ROOT, decodeUrlPath(relative))
        try {
            return await fs.readFile(target)
        } catch (err: any) {
            if (err?.code === "ENOENT") {
                throw createError({ statusCode: 404, statusMessage: "File not found" })
            }
            throw err
        }
    }

    async function fileExists(relative: string): Promise<boolean> {
        const target = resolveWithin(DATA_ROOT, decodeUrlPath(relative))
        try {
            const stat = await fs.stat(target)
            return stat.isFile()
        } catch (err: any) {
            if (err?.code === "ENOENT") return false
            throw err
        }
    }

    return {
        listDirs,
        listFiles,
        readDir,
        parentPathToUrl,
        parseFileDirEntToSelectableFile,
        createFolder,
        saveFile,
        deleteFileOrFolder,
        rootFS: fs,
        getFile,
        fileExists,
    }
}
