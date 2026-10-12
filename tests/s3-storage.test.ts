import assert from "node:assert/strict"
import { Readable } from "node:stream"
import test from "node:test"
import sharp from "sharp"
import {
    DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand,
    ListObjectsV2Command, PutObjectCommand,
} from "@aws-sdk/client-s3"
import {
    createS3ImageStorage, DELETE_TREE_ENTRY_LIMIT,
    type ImageStorageCommand, type ImageStorageTransport,
} from "../server/utils/useFS.ts"
import { canonicalImageExtension, detectImageType, inspectDecodedImage, MAX_STORED_IMAGE_BYTES } from "../server/utils/imageValidation.ts"
import { parseImagePath } from "../server/utils/imageStoragePaths.ts"

type StoredObject = { bytes: Buffer; contentType: string }
function s3Failure(name: string, statusCode: number, message = "redact-me: credentials=/private/source/access-key") {
    return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: statusCode } })
}

class FakeS3 implements ImageStorageTransport {
    readonly objects = new Map<string, StoredObject>()
    readonly commands: ImageStorageCommand[] = []
    override?: (command: ImageStorageCommand, signal: AbortSignal) => Promise<unknown> | undefined

    async send(command: ImageStorageCommand, { abortSignal }: { abortSignal: AbortSignal }): Promise<unknown> {
        this.commands.push(command)
        const custom = this.override?.(command, abortSignal)
        if (custom) return custom
        if (command instanceof PutObjectCommand) {
            const input = command.input
            assert.equal(input.Bucket, "private-images")
            assert.equal(input.IfNoneMatch, "*")
            assert.ok(input.Key?.startsWith("test-images/"))
            if (this.objects.has(input.Key!)) throw s3Failure("PreconditionFailed", 412)
            assert.ok(input.Body instanceof Uint8Array)
            this.objects.set(input.Key!, { bytes: Buffer.from(input.Body), contentType: input.ContentType! })
            return {}
        }
        if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
            const object = this.objects.get(command.input.Key!)
            if (!object) throw s3Failure("NoSuchKey", 404)
            return command instanceof GetObjectCommand
                ? { Body: Readable.from([object.bytes]), ContentLength: object.bytes.byteLength, ContentType: object.contentType }
                : { ContentLength: object.bytes.byteLength, ContentType: object.contentType }
        }
        if (command instanceof DeleteObjectCommand) {
            this.objects.delete(command.input.Key!)
            return {}
        }
        if (command instanceof DeleteObjectsCommand) {
            for (const object of command.input.Delete!.Objects!) this.objects.delete(object.Key!)
            return {}
        }
        if (command instanceof ListObjectsV2Command) {
            const input = command.input
            const entries = new Map<string, { kind: "file" | "folder"; key: string }>()
            for (const key of [...this.objects.keys()].sort()) {
                if (!key.startsWith(input.Prefix!)) continue
                const tail = key.slice(input.Prefix!.length)
                const index = tail.indexOf(input.Delimiter ?? "\0")
                if (input.Delimiter && index >= 0) {
                    const directory = input.Prefix! + tail.slice(0, index + 1)
                    entries.set(directory, { kind: "folder", key: directory })
                } else entries.set(key, { kind: "file", key })
            }
            const after = input.ContinuationToken?.startsWith("after:")
                ? input.ContinuationToken.slice("after:".length) : input.StartAfter
            const all = [...entries.values()].filter(item => !after || item.key > after)
            const selected = all.slice(0, input.MaxKeys ?? 1000)
            const more = selected.length < all.length
            return {
                Contents: selected.filter(item => item.kind === "file").map(item => ({ Key: item.key })),
                CommonPrefixes: selected.filter(item => item.kind === "folder").map(item => ({ Prefix: item.key })),
                IsTruncated: more, NextContinuationToken: more ? "after:" + selected.at(-1)!.key : undefined,
            }
        }
        throw new Error("Unsupported test command")
    }
}

function fixture(options: { timeoutMs?: number } = {}) {
    const client = new FakeS3()
    const storage = createS3ImageStorage({ client, bucket: "private-images", prefix: "test-images", ...options })
    return { client, storage }
}
async function png(width = 3, height = 2) {
    return sharp({ create: { width, height, channels: 4, background: "#ffcc00" } }).png().toBuffer()
}
function upload(bytes: Buffer, filename = "product.jpeg") {
    return { name: "files" as const, filename, type: "image/jpeg", data: bytes }
}
function bmff(majorBrand: string, compatibleBrands: string[] = []): Buffer {
    const size = 16 + compatibleBrands.length * 4
    const bytes = Buffer.alloc(size)
    bytes.writeUInt32BE(size, 0)
    bytes.write("ftyp", 4, "ascii")
    bytes.write(majorBrand, 8, "ascii")
    compatibleBrands.forEach((brand, index) => bytes.write(brand, 16 + index * 4, "ascii"))
    return bytes
}

test("canonical image paths reject traversal, URLs, separators, ambiguous encodings, and unsafe names before S3 access", async () => {
    const { client, storage } = fixture()
    const invalid = [
        "../secret.png", "/images/../secret.png", "/images/%2e%2e/secret.png", "/images/a%2Fb.png",
        "/images/a%5Cb.png", "/images/%252e%252e/secret.png", "/images/secret%00.png", "/images/bad%zz.png",
        "https://example.com/a.png", "C:\\outside.png", "//bucket/secret.png", "/images/a//b.png",
        "/images/a.png?secret=1", "/images/__proto__/a.png", "/images/constructor/a.png", "/images/NUL.png",
    ]
    for (const value of invalid) {
        await assert.rejects(storage.getFile(value), (error: { statusCode?: number }) => error.statusCode === 400)
    }
    assert.equal(client.commands.length, 0)
    assert.deepEqual(parseImagePath("/images/catalog/product%20one.png"), ["catalog", "product one.png"])
    assert.throws(() => createS3ImageStorage({ client, bucket: "private-images", prefix: "../outside" }))
    await assert.rejects(storage.deleteFileOrFolder("/"), (error: { statusCode?: number }) => error.statusCode === 400)
    assert.equal(client.commands.length, 0)
})

test("S3 folders persist empty directories and delimiter listing remains paginated and scoped", async () => {
    const { client, storage } = fixture()
    await storage.createFolder("/", "catalog")
    await storage.createFolder("/", "empty")
    const root = await storage.readDir("/", { limit: 1 })
    assert.equal(root.dirs.length, 1)
    assert.ok(root.nextCursor)
    const next = await storage.readDir("/", { limit: 1, cursor: root.nextCursor })
    assert.deepEqual([...root.dirs, ...next.dirs].map(entry => entry.name).sort(), ["catalog", "empty"])
    assert.deepEqual((await storage.readDir("/empty")).files, [])
    await assert.rejects(storage.readDir("/catalog", { cursor: root.nextCursor }), (error: { statusCode?: number }) => error.statusCode === 400)
    await assert.rejects(storage.createFolder("/", "empty"), (error: { statusCode?: number }) => error.statusCode === 409)
    client.objects.set("outside/secret.png", { bytes: await png(), contentType: "image/png" })
    client.objects.set("test-images/private.txt", { bytes: Buffer.from("arbitrary"), contentType: "text/plain" })
    assert.equal((await storage.readDir("/")).files.length, 0)
})

test("bounded pagination handles marker truncation and unsupported StartAfter without losing terminal overflow", async () => {
    const { client, storage } = fixture()
    client.objects.set("test-images/", { bytes: Buffer.alloc(0), contentType: "application/x-directory" })
    await storage.createFolder("/", "child")
    const bytes = await png()
    await storage.saveFile("/", upload(bytes, "one.png"))
    await storage.saveFile("/", upload(bytes, "two.png"))
    client.override = command => {
        if (command instanceof ListObjectsV2Command && command.input.StartAfter) {
            return Promise.resolve({ KeyCount: 0, Contents: [], IsTruncated: false })
        }
        if (command instanceof ListObjectsV2Command && command.input.MaxKeys === 1
            && !command.input.StartAfter && !command.input.ContinuationToken
            && client.objects.has(command.input.Prefix!)) {
            return Promise.resolve({
                KeyCount: 1, Contents: [{ Key: command.input.Prefix }], IsTruncated: false,
            })
        }
        return undefined
    }
    const files: string[] = []
    const dirs: string[] = []
    let cursor: string | undefined
    const cursors: string[] = []
    let pages = 0
    do {
        const page = await storage.readDir("/", { limit: 1, cursor })
        pages += 1
        assert.ok(page.files.length + page.dirs.length <= 1)
        files.push(...page.files.map(file => file.name))
        dirs.push(...page.dirs.map(directory => directory.name))
        cursor = page.nextCursor
        if (cursor) cursors.push(cursor)
    } while (cursor)
    assert.deepEqual(files.sort(), ["one.png", "two.png"])
    assert.deepEqual(dirs, ["child"])
    assert.equal(pages, 3)
    const terminalOverflow = JSON.parse(Buffer.from(cursors.at(-1)!, "base64url").toString("utf8"))
    assert.equal(terminalOverflow.exhausted, true)
    assert.equal(terminalOverflow.token, undefined)
    assert.deepEqual(terminalOverflow.pending, [{ kind: "file", name: "two.png" }])
    const listings = client.commands.filter((command): command is ListObjectsV2Command => command instanceof ListObjectsV2Command
        && command.input.Delimiter === "/" && command.input.Prefix === "test-images/")
    assert.equal(listings.length, 2)
    assert.equal(listings[0]!.input.ContinuationToken, undefined)
    for (const command of listings) {
        assert.equal(command.input.StartAfter, undefined)
        assert.equal(command.input.MaxKeys, 2)
    }
    assert.ok(listings[1]!.input.ContinuationToken)
    assert.deepEqual((await storage.readDir("/child", { limit: 1 })).files, [])
    assert.deepEqual((await storage.readDir("/child", { limit: 1 })).dirs, [])
    await storage.deleteFileOrFolder("/child", "directory")
    assert.equal(client.objects.has("test-images/child/"), false)
    assert.equal(client.objects.has("test-images/"), true)
})

test("buffered directory cursors reject unsupported, unconfined, oversized, or inconsistent pending entries", async () => {
    const { client, storage } = fixture()
    const bytes = await png()
    await storage.saveFile("/", upload(bytes, "one.png"))
    await storage.saveFile("/", upload(bytes, "two.png"))
    const page = await storage.readDir("/", { limit: 1 })
    assert.ok(page.nextCursor)
    const record = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8"))
    const badStates = [
        { ...record, pending: [{ kind: "file", name: "../outside.png" }] },
        { ...record, pending: [{ kind: "file", name: "arbitrary.txt" }] },
        { ...record, pending: [{ kind: "directory", name: "nested/child" }] },
        { ...record, pending: [{ kind: "unknown", name: "one.png" }] },
        { ...record, pending: [{ kind: "file", name: "one.png" }, { kind: "file", name: "two.png" }] },
        { ...record, exhausted: true, token: "unexpected-token" },
        { ...record, exhausted: false, token: "" },
        { ...record, exhausted: false, token: "x".repeat(4097) },
        { ...record, unknown: true },
    ]
    const before = client.commands.length
    for (const state of badStates) {
        const cursor = Buffer.from(JSON.stringify(state)).toString("base64url")
        await assert.rejects(storage.readDir("/", { cursor, limit: 1 }), (error: { statusCode?: number }) => error.statusCode === 400)
    }
    assert.equal(client.commands.length, before)
    const lastPage = await storage.readDir("/", { cursor: page.nextCursor, limit: 1 })
    assert.deepEqual(lastPage.files, [{ name: "two.png" }])
    assert.equal(lastPage.nextCursor, undefined)
    assert.equal(client.commands.length, before)
})

test("concurrent upload collisions never overwrite and decoded content controls extension and MIME", async () => {
    const { client, storage } = fixture()
    const firstBytes = await png(2, 3)
    const secondBytes = await png(4, 5)
    const names = await Promise.all([
        storage.saveFile("/", upload(firstBytes)), storage.saveFile("/", upload(secondBytes)),
    ])
    assert.deepEqual([...names].sort(), ["product (1).png", "product.png"])
    assert.equal(client.objects.size, 2)
    assert.equal(client.objects.get("test-images/" + names[0])!.contentType, "image/png")
    assert.deepEqual((await storage.getImageFile("/images/" + encodeURIComponent(names[0]!))).buffer, firstBytes)
    assert.deepEqual((await storage.getImageFile("/images/" + encodeURIComponent(names[1]!))).buffer, secondBytes)
    const dto = storage.parseFileDirEntToSelectableFile([{ name: "product one.png" }], "/catalog")
    assert.equal(dto[0]!.url, "/images/catalog/product%20one.png")
    assert.equal(JSON.stringify(dto).includes(process.cwd()), false)
})

test("hash characters remain usable in logical folder and filename paths with encoded asset URLs", async () => {
    const { storage } = fixture()
    await storage.createFolder("/", "foo#bar")
    assert.deepEqual((await storage.readDir("/")).dirs, [{ name: "foo#bar" }])
    const bytes = await png()
    const name = await storage.saveFile("/foo#bar", upload(bytes, "product#one.jpg"))
    assert.equal(name, "product#one.png")
    const files = (await storage.readDir("/foo#bar")).files
    const dto = storage.parseFileDirEntToSelectableFile(files, "/foo#bar")
    assert.equal(dto[0]!.url, "/images/foo%23bar/product%23one.png")
    assert.deepEqual(await storage.getFile(dto[0]!.url), bytes)
    await assert.rejects(storage.getFile("/images/foo#bar/product#one.png"), (error: { statusCode?: number }) => error.statusCode === 400)
    await storage.deleteFileOrFolder("/foo#bar/product#one.png")
    assert.equal(await storage.fileExists(dto[0]!.url), false)
    await storage.deleteFileOrFolder("/foo#bar")
    assert.deepEqual((await storage.readDir("/")).dirs, [])
})

test("concurrent same-name objects and folders remain browsable and typed deletion preserves the other entry", async () => {
    for (const entryType of ["file", "directory"] as const) {
        const { client, storage } = fixture()
        let markerWaiting!: () => void
        let releaseMarker!: () => void
        const waiting = new Promise<void>(resolve => { markerWaiting = resolve })
        const release = new Promise<void>(resolve => { releaseMarker = resolve })
        client.override = command => {
            if (!(command instanceof PutObjectCommand) || command.input.Key !== "test-images/foo.png/") return undefined
            markerWaiting()
            return release.then(() => {
                client.objects.set("test-images/foo.png/", { bytes: Buffer.alloc(0), contentType: "application/x-directory" })
                return {}
            })
        }
        const folderCreation = storage.createFolder("/", "foo.png")
        await waiting
        const bytes = await png()
        assert.equal(await storage.saveFile("/", upload(bytes, "foo.png")), "foo.png")
        releaseMarker()
        await folderCreation
        client.override = undefined
        const root = await storage.readDir("/")
        assert.deepEqual(root.files, [{ name: "foo.png" }])
        assert.deepEqual(root.dirs, [{ name: "foo.png" }])
        assert.deepEqual(await storage.getFile("/images/foo.png"), bytes)
        assert.deepEqual((await storage.readDir("/foo.png")).files, [])
        await storage.saveFile("/foo.png", upload(bytes, "child.png"))
        const destructiveCallsBefore = client.commands.filter(command => command instanceof DeleteObjectCommand || command instanceof DeleteObjectsCommand).length
        await assert.rejects(storage.deleteFileOrFolder("/foo.png"), (error: { statusCode?: number; data?: { code?: string } }) => {
            assert.equal(error.statusCode, 409)
            assert.equal(error.data?.code, "ambiguous_entry")
            return true
        })
        assert.equal(client.commands.filter(command => command instanceof DeleteObjectCommand || command instanceof DeleteObjectsCommand).length, destructiveCallsBefore)
        await storage.deleteFileOrFolder("/foo.png", entryType)
        assert.equal(client.objects.has("test-images/foo.png"), entryType === "directory")
        assert.equal(client.objects.has("test-images/foo.png/"), entryType === "file")
        assert.equal(client.objects.has("test-images/foo.png/child.png"), entryType === "file")
    }
})

test("upload filename collisions also recognize imported folders without explicit markers", async () => {
    const { client, storage } = fixture()
    const bytes = await png()
    client.objects.set("test-images/foo.png/child.png", { bytes, contentType: "image/png" })
    assert.equal(await storage.saveFile("/", upload(bytes, "foo.png")), "foo (1).png")
    assert.equal(client.objects.has("test-images/foo.png"), false)
    assert.deepEqual((await storage.readDir("/foo.png")).files, [{ name: "child.png" }])
})

test("storage fully decodes image content and rejects corrupt, truncated, unsupported, and animated payloads", async () => {
    const { client, storage } = fixture()
    const corruptPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not-a-real-png")])
    for (const bytes of [corruptPng, (await png()).subarray(0, 30), Buffer.from("<svg></svg>"), bmff("isom", ["mp42"])]) {
        await assert.rejects(storage.saveFile("/", upload(bytes)), (error: { statusCode?: number }) => error.statusCode === 415)
    }
    assert.equal(client.objects.size, 0)
    assert.equal(detectImageType(bmff("heic", ["mif1"])), "heic")
    assert.equal(detectImageType(bmff("mif1", ["heix"])), "heic")
    assert.equal(detectImageType(bmff("avif", ["mif1"])), null)
    const animated = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), {
        raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
    }).gif({ delay: [100, 100] }).toBuffer()
    await assert.rejects(inspectDecodedImage(animated), (error: { statusCode?: number }) => error.statusCode === 415)
    const inspection = await inspectDecodedImage(await png(4, 7))
    assert.deepEqual({ width: inspection.width, height: inspection.height, mimeType: inspection.mimeType }, { width: 4, height: 7, mimeType: "image/png" })
})

test("generated output records actual metadata and cleanup removes exactly the failed output", async () => {
    const { client, storage } = fixture()
    const bytes = await png(5, 9)
    const output = await storage.saveGeneratedImage(bytes, "image/jpeg")
    const sibling = await storage.saveGeneratedImage(bytes)
    assert.equal(output.mimeType, "image/png")
    assert.equal(output.bytes, bytes.byteLength)
    assert.equal(output.width, 5)
    assert.equal(output.height, 9)
    assert.notEqual(output.url, sibling.url)
    await storage.removeGeneratedImage(output.url)
    assert.equal(await storage.fileExists(output.url), false)
    assert.equal(await storage.fileExists(sibling.url), true)
    assert.equal(client.objects.has("test-images/output/"), true)
    await assert.rejects(storage.removeGeneratedImage("/images/output"), (error: { statusCode?: number }) => error.statusCode === 400)
    await assert.rejects(storage.removeGeneratedImage("/images/catalog/product.png"), (error: { statusCode?: number }) => error.statusCode === 400)
})

test("explicit legacy import preserves exact URLs, is resumable, and rejects conflicting content", async () => {
    const { storage } = fixture()
    await storage.createFolder("/", "images")
    const bytes = await png(2, 4)
    const url = "/images/images/legacy%20one.png"
    assert.equal(await storage.importImage(url, bytes), "imported")
    assert.equal(await storage.importImage(url, bytes), "already_present")
    assert.deepEqual((await storage.readDir("/images")).files, [{ name: "legacy one.png" }])
    await assert.rejects(storage.importImage(url, await png(3, 4)), (error: { data?: { code?: string } }) => error.data?.code === "import_conflict")
    await assert.rejects(storage.importImage("/images/images/wrong.jpg", bytes), (error: { statusCode?: number }) => error.statusCode === 415)
    assert.deepEqual(await storage.getFile(url), bytes)
})

test("legacy JPEG and TIFF extension aliases preserve exact imported filenames and URLs", async () => {
    const { storage } = fixture()
    const jpeg = await sharp({ create: { width: 5, height: 3, channels: 3, background: "blue" } }).jpeg().toBuffer()
    const tiff = await sharp({ create: { width: 2, height: 4, channels: 3, background: "green" } }).tiff().toBuffer()
    assert.equal(canonicalImageExtension("legacy.JPEG"), "jpg")
    assert.equal(canonicalImageExtension("legacy.tif"), "tiff")
    assert.equal(await storage.importImage("/images/legacy.jpeg", jpeg), "imported")
    assert.equal(await storage.importImage("/images/scan.tif", tiff), "imported")
    const entries = (await storage.readDir("/")).files
    assert.deepEqual(entries, [{ name: "legacy.jpeg" }, { name: "scan.tif" }])
    assert.deepEqual(storage.parseFileDirEntToSelectableFile(entries, "/").map(file => file.url), ["/images/legacy.jpeg", "/images/scan.tif"])
    const image = await storage.getImageFile("/images/legacy.jpeg")
    assert.deepEqual(image.buffer, jpeg)
    assert.equal(image.mimeType, "image/jpeg")
    assert.equal(image.width, 5)
    assert.equal(image.height, 3)
    assert.deepEqual(await storage.getFile("/images/scan.tif"), tiff)
    await assert.rejects(storage.importImage("/images/mismatch.png", jpeg), (error: { statusCode?: number }) => error.statusCode === 415)
})

test("missing objects and provider failures expose only bounded, redacted diagnostics", async () => {
    const { client, storage } = fixture()
    await assert.rejects(storage.getFile("/images/missing.png"), (error: { statusCode?: number; data?: object }) => {
        assert.equal(error.statusCode, 404)
        assert.equal(JSON.stringify(error).includes("missing.png"), false)
        assert.equal(JSON.stringify(error).includes("redact-me"), false)
        assert.ok(error.data && "diagnosticId" in error.data)
        return true
    })
    client.override = () => Promise.reject(s3Failure("AccessDenied", 403))
    await assert.rejects(storage.getFile("/images/private.png"), (error: { statusCode?: number }) => {
        assert.equal(error.statusCode, 503)
        assert.equal(JSON.stringify(error).includes("access-key"), false)
        return true
    })
})

test("S3 requests and body consumption have deadlines, and streamed image bytes are bounded", async () => {
    const { client, storage } = fixture({ timeoutMs: 20 })
    let signal: AbortSignal | undefined
    client.override = (_command, receivedSignal) => {
        signal = receivedSignal
        return new Promise(() => undefined)
    }
    await assert.rejects(storage.getFile("/images/stuck.png"), (error: { statusCode?: number }) => error.statusCode === 504)
    assert.equal(signal!.aborted, true)
    const stalled = new Readable({ read() {} })
    client.override = () => Promise.resolve({ Body: stalled })
    await assert.rejects(storage.getFile("/images/stalled-body.png"), (error: { statusCode?: number }) => error.statusCode === 504)
    assert.equal(stalled.destroyed, true)
    const oversized = Readable.from([Buffer.alloc(MAX_STORED_IMAGE_BYTES), Buffer.alloc(1)])
    client.override = () => Promise.resolve({ Body: oversized, ContentLength: 1 })
    await assert.rejects(storage.getFile("/images/large.png"), (error: { statusCode?: number }) => error.statusCode === 413)
    assert.equal(oversized.destroyed, true)
})

test("recursive deletes remain inside the exact folder and preserve its marker on partial failure", async () => {
    const { client, storage } = fixture()
    await storage.createFolder("/", "catalog")
    client.objects.set("test-images/catalog/a.png", { bytes: await png(), contentType: "image/png" })
    client.objects.set("test-images/catalogue/keep.png", { bytes: await png(), contentType: "image/png" })
    client.override = command => command instanceof DeleteObjectsCommand
        ? Promise.resolve({ Errors: [{ Key: "test-images/catalog/a.png", Message: "redact-me" }] }) : undefined
    await assert.rejects(storage.deleteFileOrFolder("catalog"), (error: { statusCode?: number; data?: { code?: string } }) => {
        assert.equal(error.statusCode, 503)
        assert.equal(error.data?.code, "partial_delete")
        assert.equal(JSON.stringify(error).includes("redact-me"), false)
        return true
    })
    assert.equal(client.objects.has("test-images/catalog/"), true)
    client.override = undefined
    await storage.deleteFileOrFolder("catalog")
    assert.equal(client.objects.has("test-images/catalog/"), false)
    assert.equal(client.objects.has("test-images/catalog/a.png"), false)
    assert.equal(client.objects.has("test-images/catalogue/keep.png"), true)
})

test("oversized recursive deletion is rejected before any object is removed", async () => {
    const { client, storage } = fixture()
    for (let index = 0; index <= DELETE_TREE_ENTRY_LIMIT; index += 1) {
        client.objects.set(`test-images/large/${index}.png`, { bytes: Buffer.alloc(0), contentType: "image/png" })
    }
    await assert.rejects(storage.deleteFileOrFolder("large"), (error: { statusCode?: number }) => error.statusCode === 413)
    assert.equal(client.commands.some(command => command instanceof DeleteObjectsCommand || command instanceof DeleteObjectCommand), false)
    assert.equal(client.objects.size, DELETE_TREE_ENTRY_LIMIT + 1)
})
