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

async function uniqueDestination(dir: string, filename: string): Promise<string> {
    const ext = path.extname(filename)
    const stem = path.basename(filename, ext)
    let candidate = path.join(dir, filename)
    let counter = 1
    while (true) {
        try {
            await fs.access(candidate)
            candidate = path.join(dir, `${stem} (${counter})${ext}`)
            counter += 1
        } catch {
            return candidate
        }
    }
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
        const safeName = sanitizeName(path.basename(file.filename))
        const dir = resolvePath(relative)
        await fs.mkdir(dir, { recursive: true })
        const destination = await uniqueDestination(dir, safeName)
        await fs.writeFile(destination, file.data)
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
        const target = resolveWithin(DATA_ROOT, relative)
        try {
            return await fs.readFile(target)
        } catch (err: any) {
            if (err?.code === "ENOENT") {
                throw createError({ statusCode: 404, statusMessage: "File not found" })
            }
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
    }
}
