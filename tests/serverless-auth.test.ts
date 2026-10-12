import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
    AUTH_SESSION_TTL_SECONDS,
    createAuthSessionToken,
    getAuthSessionSecret,
    verifyAuthSessionToken,
} from '../server/utils/authSession.ts'
import { BoundedUploadGate, MAX_UPLOAD_STREAM_DURATION_MS, parseStreamingUpload } from '../server/utils/uploadPolicy.ts'

test('a session issued by one cold instance verifies on another with the same configured key', async () => {
    const secondInstance = await import(new URL('../server/utils/authSession.ts?second-instance', import.meta.url).href)
    const now = Date.UTC(2026, 9, 12)
    const key = 'test-session-key-with-more-than-32-characters'
    const token = createAuthSessionToken('example-user', 'example-password', now, key)
    assert.equal(secondInstance.verifyAuthSessionToken(token, 'example-user', 'example-password', now, key), true)
    assert.equal(secondInstance.verifyAuthSessionToken(token, 'example-user', 'example-password', now, `${key}-rotated`), false)
    assert.equal(secondInstance.verifyAuthSessionToken(token, 'example-user', 'changed', now, key), false)
    assert.equal(verifyAuthSessionToken(token, 'example-user', 'example-password', now + AUTH_SESSION_TTL_SECONDS * 1000, key), false)
    assert.equal(verifyAuthSessionToken('x'.repeat(2049), 'example-user', 'example-password', now, key), false)
    assert.equal(token.includes(key), false)
})

test('production rejects missing or short signing keys and accepts explicit runtime keys', () => {
    const previous = {
        NODE_ENV: process.env.NODE_ENV,
        AUTH_SESSION_SECRET: process.env.AUTH_SESSION_SECRET,
        NUXT_AUTH_SESSION_SECRET: process.env.NUXT_AUTH_SESSION_SECRET,
    }
    try {
        process.env.NODE_ENV = 'production'
        delete process.env.AUTH_SESSION_SECRET
        delete process.env.NUXT_AUTH_SESSION_SECRET
        assert.throws(() => getAuthSessionSecret(), /at least 32 characters/)
        assert.throws(() => getAuthSessionSecret({ authSessionSecret: 'short' }), /at least 32 characters/)
        const key = 'a-production-test-key-longer-than-32-characters'
        assert.equal(getAuthSessionSecret({ authSessionSecret: key }), key)
        process.env.AUTH_SESSION_SECRET = key
        assert.equal(getAuthSessionSecret(), key)
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    }
})

test('a queued upload expires within a bounded wait and cannot consume a later slot', async () => {
    const gate = new BoundedUploadGate(1, 1)
    let release!: () => void
    const first = gate.run(() => new Promise<void>(resolve => { release = resolve }))
    let queuedWasCalled = false
    await assert.rejects(gate.run(async () => { queuedWasCalled = true }, 10), (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 429)
        return true
    })
    assert.deepEqual(gate.snapshot(), { active: 1, queued: 0 })
    release()
    await first
    await gate.run(async () => undefined)
    assert.equal(queuedWasCalled, false)
    assert.deepEqual(gate.snapshot(), { active: 0, queued: 0 })
})

test('a stalled multipart request reaches its bounded stream deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const request = new Readable({ read() {} }) as Readable & { headers: Record<string, string> }
    request.headers = { 'content-type': 'multipart/form-data; boundary=serverless-test' }
    const parsed = parseStreamingUpload({ node: { req: request } } as never)
    t.mock.timers.tick(MAX_UPLOAD_STREAM_DURATION_MS)
    await assert.rejects(parsed, (error: unknown) => (error as { statusCode?: number }).statusCode === 408)
    request.destroy()
})
