import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import sharp from "sharp"

const run = promisify(execFile)
const projectRoot = path.resolve(".")
const artifactRoot = path.join(projectRoot, ".codex", "artifacts", "2026-10-12-s3-import-tests")

async function fixture() {
    await fs.mkdir(artifactRoot, { recursive: true })
    const directory = await fs.mkdtemp(path.join(artifactRoot, "dry-run-"))
    return {
        directory,
        async cleanup() {
            const absolute = path.resolve(directory)
            assert.ok(absolute.startsWith(path.resolve(artifactRoot) + path.sep))
            await fs.rm(absolute, { recursive: true, force: true })
        },
    }
}
function dryRun(source: string) {
    return run(process.execPath, [
        "--import", "./tests/register-typescript.mjs", "scripts/import-local-images.ts",
        "--source", source, "--dry-run",
    ], {
        cwd: projectRoot, timeout: 15_000,
        env: {
            ...process.env, APP_ENV: "production",
            S3_ENDPOINT: "", S3_REGION: "", S3_BUCKET: "", S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "",
        },
    })
}

test("image import dry-run decodes local images and reports counts/bytes without S3 credentials or mutation", async () => {
    const source = await fixture()
    try {
        const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: "blue" } }).png().toBuffer()
        await fs.mkdir(path.join(source.directory, "foo#bar"))
        await fs.mkdir(path.join(source.directory, "empty"))
        await fs.writeFile(path.join(source.directory, "foo#bar", "product#one.png"), image)
        const result = await dryRun(source.directory)
        assert.deepEqual(JSON.parse(result.stdout), {
            dryRun: true, files: 1, folders: 2, bytes: image.byteLength,
            imported: 0, alreadyPresent: 0, target: "none",
        })
        assert.deepEqual(await fs.readFile(path.join(source.directory, "foo#bar", "product#one.png")), image)
    } finally { await source.cleanup() }
})

test("image import dry-run rejects corrupt image content before reporting a successful audit", async () => {
    const source = await fixture()
    try {
        await fs.writeFile(path.join(source.directory, "corrupt.png"), Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("invalid"),
        ]))
        await assert.rejects(dryRun(source.directory), (error: { stderr?: string; stdout?: string }) => {
            assert.match(error.stderr ?? "", /Invalid or corrupt image/)
            assert.equal((error.stdout ?? "").trim(), "")
            assert.doesNotMatch(error.stderr ?? "", /Image storage is not configured/)
            return true
        })
    } finally { await source.cleanup() }
})

test("image import dry-run accepts real JPEG extension aliases while rejecting mismatched PNG filenames", async () => {
    const source = await fixture()
    try {
        const image = await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } }).jpeg().toBuffer()
        await fs.writeFile(path.join(source.directory, "legacy.jpeg"), image)
        const audit = JSON.parse((await dryRun(source.directory)).stdout)
        assert.equal(audit.files, 1)
        assert.equal(audit.bytes, image.byteLength)
        assert.equal(audit.imported, 0)
        await fs.rename(path.join(source.directory, "legacy.jpeg"), path.join(source.directory, "mismatch.png"))
        await assert.rejects(dryRun(source.directory), (error: { stdout?: string }) => {
            assert.equal((error.stdout ?? "").trim(), "")
            return true
        })
    } finally { await source.cleanup() }
})

test("image import dry-run rejects source junctions or symlinks without reading outside the source", async (t) => {
    const source = await fixture()
    const outside = await fixture()
    try {
        await fs.writeFile(path.join(outside.directory, "outside.png"), "outside")
        try {
            await fs.symlink(outside.directory, path.join(source.directory, "link"), process.platform === "win32" ? "junction" : "dir")
        } catch (error) {
            if (error && typeof error === "object" && "code" in error && ["EPERM", "EACCES"].includes(String(error.code))) {
                t.skip("link creation is not permitted on this host")
                return
            }
            throw error
        }
        await assert.rejects(dryRun(source.directory), (error: { stderr?: string; stdout?: string }) => {
            assert.match(error.stderr ?? "", /contains a link or junction/)
            assert.equal((error.stdout ?? "").trim(), "")
            return true
        })
    } finally {
        await source.cleanup()
        await outside.cleanup()
    }
})
