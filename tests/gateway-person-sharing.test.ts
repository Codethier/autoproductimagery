import assert from 'node:assert/strict'
import test from 'node:test'
import {useGateway} from '../server/utils/useGateway.ts'
import {createDefaultSettings, ImageGenerationRequestSchema} from '../schemas/image-generation.ts'

test('both Gateway adapters reauthorize every decoded image before paid work and stop on intervening People-share revocation', async t => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    const first = '/images/people/first-portrait.png', second = '/images/people/second-portrait.png', mask = '/images/mask/edit.png'
    let revokeDuringRead = true, revoked = false, providerStarts = 0, providerCalls = 0
    let cancelDuringAuthorization: AbortController | undefined
    const reads: string[] = [], checks: string[][] = [], events: string[] = []
    const stubs = {
        useRuntimeConfig: () => ({AiGatewayApiKey: 'invalid-local-test-key-no-paid-calls'}),
        createError: (data: {statusMessage: string}) => Object.assign(new Error(data.statusMessage), data),
    }
    for (const [name, value] of Object.entries(stubs)) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, name)
        Object.defineProperty(globalThis, name, {configurable: true, value})
        t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name))
    }
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/config')) return Response.json({models: []})
        providerCalls += 1; events.push('provider-call')
        assert.ok(init?.signal instanceof AbortSignal)
        if (url.pathname.endsWith('/language-model')) return Response.json({
            content: [{type: 'text', text: 'Synthetic test response without a billable provider'}],
            finishReason: {unified: 'stop', raw: 'STOP'},
            usage: {inputTokens: {total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0}, outputTokens: {total: 1, text: 1, reasoning: 0}}, warnings: [],
        })
        assert.ok(url.pathname.endsWith('/image-model'))
        return Response.json({images: [], warnings: [], usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2}})
    })
    const gateway = await useGateway({
        async getImageFile(path: string) {
            reads.push(path)
            if (path === second && revokeDuringRead) revoked = true
            return {buffer: png, mimeType: 'image/png' as const, width: 1, height: 1, hasAlpha: true}
        },
        async assertReadableImages(paths: readonly string[]) {
            checks.push([...paths]); events.push('authorize')
            cancelDuringAuthorization?.abort(new Error('Account request cancelled during final source authorization'))
            if (revoked && paths.includes(first)) throw Object.assign(new Error('Asset not found'), {statusCode: 404})
        },
    })
    const started = () => {providerStarts += 1; events.push('provider-start')}
    for (const model of ['google/gemini-3.1-flash-image', 'openai/gpt-image-2.5-sunburst'] as const) {
        revoked = false; reads.length = 0; checks.length = 0; events.length = 0; revokeDuringRead = true
        const request = ImageGenerationRequestSchema.parse({model, prompt: 'Keep the same person while changing their outfit', settings: createDefaultSettings(model),
            inputImages: [first], modelImages: [second], ...(model === 'openai/gpt-image-2.5-sunburst' ? {maskImage: mask} : {})})
        const expected = [first, second, ...(request.maskImage ? [mask] : [])]
        const previousStarts = providerStarts, previousCalls = providerCalls
        await assert.rejects(gateway.generateAnyImage(request, undefined, started), error => (error as {statusCode?: number}).statusCode === 404)
        assert.deepEqual(reads, expected, 'revocation happens after the first reference was decoded and while the next source loads')
        assert.deepEqual(checks, [expected], 'final authorization includes source, shared references and any decoded mask')
        assert.deepEqual(events, ['authorize'])
        assert.equal(providerStarts, previousStarts)
        assert.equal(providerCalls, previousCalls, 'a revoked source never reaches a paid provider request')

        revokeDuringRead = false; revoked = false; events.length = 0
        await assert.rejects(gateway.generateAnyImage(request, undefined, started), /no image/i)
        assert.deepEqual(events, ['authorize', 'provider-start', 'provider-call'])
        assert.equal(providerStarts, previousStarts + 1)
        assert.equal(providerCalls, previousCalls + 1)

        cancelDuringAuthorization = new AbortController(); events.length = 0
        const beforeCancellation = providerStarts
        await assert.rejects(gateway.generateAnyImage(request, cancelDuringAuthorization.signal, started), /Account request cancelled during final source authorization/)
        assert.deepEqual(events, ['authorize'])
        assert.equal(providerStarts, beforeCancellation)
        cancelDuringAuthorization = undefined
    }
})
