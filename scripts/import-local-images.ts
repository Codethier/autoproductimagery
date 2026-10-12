import { constants, promises as fs } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { imagePathToUrl, validateImagePathSegment } from "../server/utils/imageStoragePaths.ts"
import { canonicalImageExtension, inspectDecodedImage, MAX_STORED_IMAGE_BYTES } from "../server/utils/imageValidation.ts"
import { useFS } from "../server/utils/useFS.ts"

const { values } = parseArgs({
    options: {
        source: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "confirm-development": { type: "boolean", default: false },
    },
})
const deploymentEnvironment = process.env.APP_ENV ?? process.env.RAILWAY_ENVIRONMENT_NAME
if (!values.source || (!values["dry-run"] && (!values["confirm-development"] || !["dev", "development"].includes(deploymentEnvironment ?? "")))) {
    throw new Error("Usage: node --import ./tests/register-typescript.mjs scripts/import-local-images.ts --source <image-root> --dry-run. To apply, set APP_ENV=development, load development credentials, and replace --dry-run with --confirm-development.")
}

const source = path.resolve(values.source)
const rootStat = await fs.lstat(source)
const rootReal = await fs.realpath(source)
const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || comparable(rootReal) !== comparable(source)) {
    throw new Error("Image import source must be a real directory without links or junctions")
}
// Dry runs do not initialize an S3 client or require any cloud credentials.
const storage = values["dry-run"] ? undefined : await useFS()
type ImportEntry = { parts: string[]; directory: boolean }
const entries: ImportEntry[] = []
const pending: string[][] = [[]]
while (pending.length) {
    const parts = pending.pop()!
    const location = path.join(rootReal, ...parts)
    const stat = await fs.lstat(location)
    const real = await fs.realpath(location)
    if (stat.isSymbolicLink() || comparable(real) !== comparable(location)) {
        throw new Error("Image import source contains a link or junction")
    }
    if (parts.length) entries.push({ parts, directory: stat.isDirectory() })
    if (entries.length > 10_000) throw new Error("Image import is limited to 10000 entries per source tree")
    if (stat.isDirectory()) {
        for (const name of await fs.readdir(location)) {
            validateImagePathSegment(name)
            pending.push([...parts, name])
        }
    } else if (!stat.isFile() || stat.size > MAX_STORED_IMAGE_BYTES) {
        throw new Error("Image import source contains an unsupported or oversized entry")
    }
}

// Parents first, with deterministic order so interruption can be safely resumed.
entries.sort((left, right) => left.parts.length - right.parts.length || left.parts.join("/").localeCompare(right.parts.join("/")))
let imported = 0
let alreadyPresent = 0
let folders = 0
let files = 0
let totalBytes = 0
for (const entry of entries) {
    const relative = entry.parts.join("/")
    if (entry.directory) {
        folders += 1
        if (!storage) continue
        try {
            await storage.createFolder(entry.parts.slice(0, -1).join("/"), entry.parts.at(-1)!)
        } catch (error) {
            if (!(error && typeof error === "object" && "statusCode" in error && error.statusCode === 409)) throw error
        }
        continue
    }
    const file = path.join(rootReal, ...entry.parts)
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW
    const handle = await fs.open(file, constants.O_RDONLY | noFollow)
    try {
        const stat = await handle.stat()
        const real = await fs.realpath(file)
        if (!stat.isFile() || stat.size > MAX_STORED_IMAGE_BYTES || comparable(real) !== comparable(file)) {
            throw new Error("Image import source changed during import")
        }
        const chunks: Buffer[] = []
        let bytes = 0
        while (true) {
            const chunk = Buffer.alloc(Math.min(1024 * 1024, MAX_STORED_IMAGE_BYTES + 1 - bytes))
            const result = await handle.read(chunk, 0, chunk.byteLength, null)
            if (!result.bytesRead) break
            bytes += result.bytesRead
            if (bytes > MAX_STORED_IMAGE_BYTES) throw new Error("Image import source grew beyond its byte limit")
            chunks.push(chunk.subarray(0, result.bytesRead))
        }
        const data = Buffer.concat(chunks, bytes)
        chunks.length = 0
        files += 1
        totalBytes += bytes
        if (!storage) {
            const inspection = await inspectDecodedImage(data)
            const filename = entry.parts.at(-1)!
            if (canonicalImageExtension(filename) !== inspection.extension) {
                throw new Error("Imported image extension must match decoded content")
            }
            continue
        }
        const result = await storage.importImage(imagePathToUrl(entry.parts), data)
        if (result === "imported") imported += 1
        else alreadyPresent += 1
    } catch (error) {
        const reason = error && typeof error === "object" && "statusMessage" in error ? String(error.statusMessage) : "Image import failed"
        throw new Error(`${reason}; stopped at logical path ${relative}`)
    } finally { await handle.close() }
}
console.log(JSON.stringify({
    dryRun: values["dry-run"], files, folders, bytes: totalBytes,
    imported, alreadyPresent, target: values["dry-run"] ? "none" : "development",
}))
