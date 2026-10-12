import assert from "node:assert/strict"
import { Readable } from "node:stream"
import test from "node:test"
import {
    AUTH_SESSION_TTL_SECONDS,
    createAuthSessionToken,
    credentialsMatch,
    verifyAuthSessionToken,
} from "../server/utils/authSession.ts"
import { installBoundedRawBody } from "../server/utils/boundedRequestBody.ts"
import {
    MAX_UPLOAD_AGGREGATE_BYTES,
    MAX_UPLOAD_FILE_BYTES,
    MAX_UPLOAD_FILES,
    BoundedUploadGate,
    parseStreamingUpload,
} from "../server/utils/uploadPolicy.ts"
import {
    LOGIN_ACCOUNT_ATTEMPT_LIMIT,
    LOGIN_THROTTLE_WINDOW_MS,
    LoginThrottle,
} from "../server/utils/loginThrottle.ts"

test("auth sessions are opaque, signed, expiring, and invalidated by credential changes", () => {
    const now = Date.UTC(2026, 7, 14)
    const token = createAuthSessionToken("private-user", "private-password", now)
    const signatureStart = token.indexOf(".") + 1
    const tamperedToken = `${token.slice(0, signatureStart)}${token[signatureStart] === "A" ? "B" : "A"}${token.slice(signatureStart + 1)}`
    assert.equal(token.includes("private-user"), false)
    assert.equal(token.includes("private-password"), false)
    assert.equal(verifyAuthSessionToken(token, "private-user", "private-password", now), true)
    assert.equal(verifyAuthSessionToken(tamperedToken, "private-user", "private-password", now), false)
    assert.equal(verifyAuthSessionToken(token, "private-user", "changed", now), false)
    assert.equal(
        verifyAuthSessionToken(token, "private-user", "private-password", now + AUTH_SESSION_TTL_SECONDS * 1000),
        false,
    )
})

test("credential comparison validates both values", () => {
    assert.equal(credentialsMatch("user", "pass", "user", "pass"), true)
    assert.equal(credentialsMatch("wrong", "pass", "user", "pass"), false)
    assert.equal(credentialsMatch("user", "wrong", "user", "pass"), false)
})

test("bounded multipart buffering rejects declared and chunked oversized bodies", async () => {
    const declaredRequest = Readable.from([]) as Readable & { headers: Record<string, string> }
    declaredRequest.headers = { "content-length": "6" }
    assert.throws(
        () => installBoundedRawBody({ node: { req: declaredRequest } } as any, 5),
        (error: any) => error?.statusCode === 413,
    )

    const chunkedRequest = Readable.from([Buffer.from("123"), Buffer.from("456")]) as Readable & { headers: Record<string, string> }
    chunkedRequest.headers = { "transfer-encoding": "chunked" }
    await assert.rejects(
        installBoundedRawBody({ node: { req: chunkedRequest } } as any, 5),
        (error: any) => error?.statusCode === 413,
    )
})

type MultipartFile = { filename: string; type: string; data: Buffer }

function multipartBody(boundary: string, files: MultipartFile[], uploadPath = "products") {
    const chunks: Buffer[] = []
    for (const file of files) {
        chunks.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`,
        ))
        chunks.push(file.data, Buffer.from("\r\n"))
    }
    chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${uploadPath}\r\n--${boundary}--\r\n`,
    ))
    return Buffer.concat(chunks)
}

function multipartEvent(body: Buffer, boundary: string, chunks = 3) {
    const size = Math.max(1, Math.ceil(body.length / chunks))
    const request = Readable.from(Array.from(
        { length: Math.ceil(body.length / size) },
        (_, index) => body.subarray(index * size, Math.min(body.length, (index + 1) * size)),
    )) as Readable & { headers: Record<string, string> }
    request.headers = {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
    }
    return { node: { req: request } } as any
}

test("streaming multipart parser accepts bounded image fields without H3 body buffering", async () => {
    const boundary = "auth-storage-streaming-boundary"
    const body = multipartBody(boundary, [
        { filename: "one.png", type: "image/png", data: Buffer.from("first") },
        { filename: "two.png", type: "image/png", data: Buffer.from("second") },
    ])
    const parsed = await parseStreamingUpload(multipartEvent(body, boundary, 7))
    assert.equal(parsed.path, "products")
    assert.deepEqual(parsed.files.map(file => file.data.toString()), ["first", "second"])
})

test("streaming multipart parser rejects excess file count and per-file bytes", async () => {
    const boundary = "auth-storage-limits-boundary"
    const excessFiles = multipartBody(boundary, Array.from(
        { length: MAX_UPLOAD_FILES + 1 },
        (_, index) => ({ filename: `${index}.png`, type: "image/png", data: Buffer.from("x") }),
    ))
    await assert.rejects(
        parseStreamingUpload(multipartEvent(excessFiles, boundary)),
        (error: any) => error?.statusCode === 413,
    )

    const oversizedFile = multipartBody(boundary, [{
        filename: "large.png",
        type: "image/png",
        data: Buffer.alloc(MAX_UPLOAD_FILE_BYTES + 1),
    }])
    await assert.rejects(
        parseStreamingUpload(multipartEvent(oversizedFile, boundary, 32)),
        (error: any) => error?.statusCode === 413,
    )
    assert.ok(MAX_UPLOAD_AGGREGATE_BYTES < 101 * 1024 * 1024)
})

test("upload concurrency and queue depth are both bounded", async () => {
    const gate = new BoundedUploadGate(1, 1)
    let releaseFirst!: () => void
    const first = gate.run(() => new Promise<void>(resolve => { releaseFirst = resolve }))
    const second = gate.run(async () => "second")
    assert.deepEqual(gate.snapshot(), { active: 1, queued: 1 })
    await assert.rejects(
        gate.run(async () => "third"),
        (error: any) => error?.statusCode === 429,
    )
    releaseFirst()
    await first
    assert.equal(await second, "second")
    assert.deepEqual(gate.snapshot(), { active: 0, queued: 0 })
})

test("login throttle applies account limits, returns retry timing, and expires", () => {
    const throttle = new LoginThrottle()
    const now = Date.UTC(2026, 7, 14)
    for (let index = 0; index < LOGIN_ACCOUNT_ATTEMPT_LIMIT; index += 1) {
        assert.equal(throttle.consume(`192.0.2.${index}`, "target-user", now).allowed, true)
    }
    const blocked = throttle.consume("198.51.100.1", "target-user", now)
    assert.equal(blocked.allowed, false)
    assert.equal(blocked.retryAfterSeconds, LOGIN_THROTTLE_WINDOW_MS / 1000)
    assert.equal(throttle.consume("198.51.100.1", "target-user", now + LOGIN_THROTTLE_WINDOW_MS).allowed, true)
})
