import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import test from 'node:test'
import {createApp, createError, defineEventHandler, toNodeListener, type EventHandler} from 'h3'
import {privatePaymentResponse, readPaymentBody} from '../server/utils/accountPayments.ts'

async function withServer(handler: EventHandler, work: (base: string) => Promise<void>) {
    const server = createServer(toNodeListener(createApp().use(handler)))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as {port: number}
    try {await work(`http://127.0.0.1:${address.port}`)}
    finally {server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))}
}

test('payment mutations accept only bounded JSON from the exact browser origin and return private responses', async () => {
    await withServer(defineEventHandler(async event => {privatePaymentResponse(event); return readPaymentBody(event)}), async base => {
        const valid = await fetch(base, {method: 'POST', headers: {'content-type': 'application/json', origin: base}, body: '{"amountUsd":"5"}'})
        assert.equal(valid.status, 200)
        assert.equal(valid.headers.get('cache-control'), 'private, no-store')
        assert.equal(valid.headers.get('vary'), 'Cookie')
        assert.deepEqual(await valid.json(), {amountUsd: '5'})
        for (const headers of [
            {origin: 'https://evil.example'}, {origin: base.replace('http:', 'https:')}, {origin: base + '/'},
            {origin: 'https://evil.example', 'x-forwarded-host': 'evil.example'}, {'sec-fetch-site': 'cross-site'},
        ]) {
            const result = await fetch(base, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: '{}'})
            assert.equal(result.status, 403)
            assert.equal(result.headers.get('cache-control'), 'private, no-store')
        }
        const wrongType = await fetch(base, {method: 'POST', headers: {origin: base, 'content-type': 'text/plain'}, body: '{}'})
        assert.equal(wrongType.status, 415)
        const invalidJson = await fetch(base, {method: 'POST', headers: {origin: base, 'content-type': 'application/json'}, body: '{'})
        assert.equal(invalidJson.status, 400)
        const oversized = await fetch(base, {method: 'POST', headers: {origin: base, 'content-type': 'application/json'}, body: JSON.stringify({note: 'x'.repeat(5000)})})
        assert.equal(oversized.status, 413)
        const chunked = await fetch(base, {method: 'POST', headers: {origin: base, 'content-type': 'application/json'}, duplex: 'half',
            body: (async function* () {yield '{"note":"'; for (let i = 0; i < 5; i++) yield 'x'.repeat(1024); yield '"}'})()} as RequestInit)
        assert.equal(chunked.status, 413)
    })
})

test('all payment routes set no-store and Cookie variation before an unauthenticated rejection', async () => {
    const globalRecord = globalThis as unknown as Record<string, unknown>
    const previousHandler = globalRecord.defineEventHandler, previousAuth = globalRecord.useAuth
    try {
        globalRecord.defineEventHandler = defineEventHandler
        globalRecord.useAuth = async () => {throw createError({statusCode: 401, statusMessage: 'Unauthorized'})}
        for (const path of ['../server/api/account/payments.get.ts', '../server/api/org/users/[id]/payments.get.ts', '../server/api/org/users/[id]/payments.post.ts']) {
            const module = await import(new URL(path, import.meta.url).href)
            await withServer(module.default, async base => {
                const result = await fetch(base, {method: path.endsWith('.post.ts') ? 'POST' : 'GET'})
                assert.equal(result.status, 401)
                assert.equal(result.headers.get('cache-control'), 'private, no-store')
                assert.equal(result.headers.get('vary'), 'Cookie')
                const body = await result.text()
                assert.equal(body.includes('DATABASE_URL'), false)
            })
        }
    } finally {
        if (previousHandler === undefined) delete globalRecord.defineEventHandler; else globalRecord.defineEventHandler = previousHandler
        if (previousAuth === undefined) delete globalRecord.useAuth; else globalRecord.useAuth = previousAuth
    }
})
