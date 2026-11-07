import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import test from 'node:test'
import {assertMethod, createApp, createError, defineEventHandler, toNodeListener} from 'h3'

// Exercise the actual serving route over HTTP. Authentication and its actor-bound
// storage facade are adapters; ACL, pricing and storage behavior have integration
// coverage in organization-assets.test.ts. No external storage is contacted.
const key = '__imageDeliveryApiTest'
const actor = {organizationId: 'local-organization', userId: 'local-user'}
const source = '/images/organizations/local-organization/users/local-user/objects/local-blob/product.png'
const etag = 'W/"local-account-original"'
const bytes = Buffer.from('validated-image-test-adapter')
Object.assign(globalThis, {
    defineEventHandler, assertMethod,
    useAuth: async () => {
        const env = (globalThis as any)[key]
        env.order.push('authenticate')
        if (env.authError) throw env.authError
        return actor
    },
    useUserFS: async (account: unknown) => {
        const env = (globalThis as any)[key]
        env.order.push('actor-storage')
        assert.deepEqual(account, actor)
        return {getImageForDelivery: async (...args: unknown[]) => {
            env.order.push('authorize-delivery')
            env.calls.push(args)
            if (env.deliveryError) throw env.deliveryError
            return env.result
        }}
    },
})
const handler = (await import('../server/api/data/[...name].get.ts')).default

async function fixture(work: (context: {env: any; request: (query?: string, headers?: Record<string, string>, method?: string) => Promise<Response>}) => Promise<void>) {
    const env: any = {order: [], calls: [], result: {etag, notModified: false, buffer: bytes, mimeType: 'image/png', width: 4, height: 3}}
    ;(globalThis as any)[key] = env
    const app = createApp({debug: false})
    app.use(defineEventHandler(event => {
        event.context.params = {name: source.slice('/images/'.length)}
        return handler(event)
    }))
    const server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const origin = `http://127.0.0.1:${address.port}`
    try {
        await work({env, request: (query = '', headers = {}, method = 'GET') => fetch(`${origin}/api/data${source}${query}`, {headers, method})})
    } finally {
        server.closeIdleConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
}

test('authenticated image responses are private revalidated representations with original bytes and bounded preview selection', async () => fixture(async ({env, request}) => {
    const original = await request()
    assert.equal(original.status, 200)
    assert.equal(original.headers.get('cache-control'), 'private, no-cache, must-revalidate')
    assert.equal(original.headers.get('vary'), 'Cookie')
    assert.equal(original.headers.get('etag'), etag)
    assert.equal(original.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(original.headers.get('content-type'), 'image/png')
    assert.equal(original.headers.get('content-length'), String(bytes.length))
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes)
    assert.deepEqual(env.calls[0], [source, undefined, undefined])
    assert.deepEqual(env.order, ['authenticate', 'actor-storage', 'authorize-delivery'])
    for (const size of [160, 480, 960, 1600]) {
        const preview = await request(`?preview=${size}`)
        assert.equal(preview.status, 200)
        await preview.arrayBuffer()
        assert.deepEqual(env.calls.at(-1), [source, size, undefined])
    }
}))

test('conditional image responses pass validators through current authorization and return a bodyless 304', async () => fixture(async ({env, request}) => {
    env.result = {etag, notModified: true}
    const response = await request('?preview=480', {'if-none-match': etag, cookie: 'local-test-session=actor'})
    assert.equal(response.status, 304)
    assert.equal(response.headers.get('cache-control'), 'private, no-cache, must-revalidate')
    assert.equal(response.headers.get('vary'), 'Cookie')
    assert.equal(response.headers.get('etag'), etag)
    assert.equal(response.headers.get('content-length'), null)
    assert.equal((await response.arrayBuffer()).byteLength, 0)
    assert.deepEqual(env.calls, [[source, 480, etag]])
    assert.deepEqual(env.order, ['authenticate', 'actor-storage', 'authorize-delivery'])
}))

test('invalid and duplicate preview queries cannot create arbitrary transforms or reach storage', async () => fixture(async ({env, request}) => {
    const queries = ['?preview=0', '?preview=161', '?preview=480.0', '?preview=0480', '?preview=-1', '?preview=',
        '?preview=160&preview=480', '?preview=480&preview=480', '?preview[]=480', '?width=480', '?preview=480&format=webp']
    for (const query of queries) {
        const response = await request(query)
        assert.equal(response.status, 400, query)
        assert.equal(response.headers.get('cache-control'), 'private, no-store')
        assert.equal(response.headers.get('vary'), 'Cookie')
        await response.arrayBuffer()
    }
    assert.deepEqual(env.calls, [])
    assert.ok(env.order.every((item: string) => item === 'authenticate'))
}))

test('known browser validators never turn unauthenticated, revoked, or unpriced requests into cached image responses', async () => fixture(async ({env, request}) => {
    for (const statusCode of [401, 404, 425]) {
        env.calls = []; env.order = []
        const error = createError({statusCode, statusMessage: 'Image request denied'})
        env.authError = statusCode === 401 ? error : undefined
        env.deliveryError = statusCode !== 401 ? error : undefined
        const response = await request('?preview=480', {'if-none-match': etag})
        assert.equal(response.status, statusCode)
        assert.equal(response.headers.get('cache-control'), 'private, no-store')
        assert.equal(response.headers.get('vary'), 'Cookie')
        assert.equal(response.headers.get('etag'), null)
        const body = Buffer.from(await response.arrayBuffer())
        assert.equal(body.includes(bytes), false)
        assert.equal(env.calls.length, statusCode === 401 ? 0 : 1)
    }
}))
