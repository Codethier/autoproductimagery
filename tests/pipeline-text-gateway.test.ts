import assert from 'node:assert/strict'
import test from 'node:test'
import {useGateway, PIPELINE_TEXT_MODEL_ID, type PipelineTextRequest} from '../server/utils/useGateway.ts'
import {extractGatewayErrorBilling} from '../server/utils/billingGatewayError.ts'

test('pipeline utility nodes use one Gateway text model, exact billing, bounded images and revocation before paid work', async t => {
    const stubs = {
        useRuntimeConfig: () => ({AiGatewayApiKey: 'invalid-local-test-key-no-paid-calls'}),
        createError: (data: {statusMessage: string}) => Object.assign(new Error(data.statusMessage), data),
    }
    for (const [name, value] of Object.entries(stubs)) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, name)
        Object.defineProperty(globalThis, name, {configurable: true, value})
        t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name))
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    let text = 'A red linen shirt on a white studio background.', cost = 0.000000000001, finishReason = 'stop', byok = false
    let providerFailure = false, outputFile = false, revoked = false, revokeDuringRead = false, mediaType = 'image/png'
    let imageBuffer = png
    let providerCalls = 0, providerStarts = 0, lookups = 0
    const events: string[] = [], reads: string[] = [], bodies: Record<string, unknown>[] = []
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/config')) return Response.json({models: [{id: PIPELINE_TEXT_MODEL_ID, name: 'Gemini Flash',
            modelType: 'language', pricing: {input: '0.000001', output: '0.000002'}}]})
        if (url.pathname === '/v1/generation') {
            lookups++
            assert.equal(url.searchParams.get('id'), 'gen_pipeline_text')
            return Response.json({data: {id: 'gen_pipeline_text', total_cost: cost, upstream_inference_cost: cost, usage: cost,
                created_at: '2026-10-14T12:00:00Z', model: PIPELINE_TEXT_MODEL_ID, is_byok: byok, provider_name: 'google',
                streamed: false, finish_reason: finishReason, latency: 1, generation_time: 2, native_tokens_prompt: 5,
                native_tokens_completion: 7, native_tokens_reasoning: 0, native_tokens_cached: 0, native_tokens_cache_creation: 0,
                billable_web_search_calls: 0}})
        }
        assert.ok(url.pathname.endsWith('/language-model'))
        assert.equal(new Headers(init?.headers).get('ai-language-model-id'), PIPELINE_TEXT_MODEL_ID)
        assert.ok(init?.signal instanceof AbortSignal)
        providerCalls++; events.push('provider-call')
        bodies.push(JSON.parse(String(init?.body)))
        if (providerFailure) return Response.json({generationId: 'gen_pipeline_failure', error: {
            type: 'internal_server_error', message: 'Synthetic failure containing /app/private/path'}}, {status: 502})
        return Response.json({content: [
            {type: 'text', text},
            ...(outputFile ? [{type: 'file', data: png.toString('base64'), mediaType: 'image/png'}] : []),
        ], finishReason: {unified: 'stop', raw: 'STOP'},
        usage: {inputTokens: {total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0}, outputTokens: {total: 7, text: 7, reasoning: 0}},
        providerMetadata: {gateway: {generationId: 'gen_pipeline_text'}}, warnings: []})
    })
    const gateway = await useGateway({async getImageFile(url) {
        reads.push(url)
        if (revokeDuringRead && reads.length === 2) revoked = true
        return {buffer: imageBuffer, mimeType: mediaType}
    }, async assertReadableImages(urls) {
        events.push('authorize')
        assert.ok(urls.length <= 8)
        if (revoked) throw Object.assign(new Error('Asset not found'), {statusCode: 404})
    }})
    const start = async () => {providerStarts++; events.push('provider-start')}
    const request: PipelineTextRequest = {model: PIPELINE_TEXT_MODEL_ID, prompt: 'Describe only the clothing.',
        system: 'Return a short product description.', imageUrls: ['/images/product/shirt.png'], temperature: 0.2, maxOutputTokens: 512}
    const result = await gateway.generatePipelineText(request, undefined, start)
    assert.equal(result.text, text)
    assert.equal(result.billing.priceUsd, '0.000000000001')
    assert.equal(result.billing.priceSource, 'gateway')
    assert.equal(result.billing.gatewayGenerationId, 'gen_pipeline_text')
    assert.deepEqual(events, ['authorize', 'provider-start', 'provider-call'])
    const body = bodies[0]!
    assert.equal(body.temperature, 0.2)
    assert.equal(body.maxOutputTokens, 512)
    assert.deepEqual((body.providerOptions as Record<string, unknown>).google, {thinkingConfig: {thinkingBudget: 0}, responseModalities: ['TEXT']})
    assert.ok(JSON.stringify(body).includes('Return a short product description.'))
    assert.ok(JSON.stringify(body).includes(png.toString('base64')))
    assert.equal(body.tools, undefined)
    cost = 0
    assert.equal((await gateway.generatePipelineText({...request, imageUrls: []}, undefined, start)).billing.priceUsd, '0.000000000000')
    assert.equal(providerCalls, 2)

    for (const invalid of [
        {...request, model: 'openai/gpt-image-2'}, {...request, temperature: 3}, {...request, maxOutputTokens: 4097},
        {...request, system: 'x'.repeat(20_001)}, {...request, prompt: ' '}, {...request, tools: {web: true}},
        {...request, imageUrls: Array.from({length: 9}, () => '/images/a.png')},
        {...request, imageUrls: ['https://example.com/image.png']},
    ]) await assert.rejects(gateway.generatePipelineText(invalid as PipelineTextRequest, undefined, start),
        error => (error as {statusCode?: number}).statusCode === 400)
    assert.equal(providerCalls, 2)
    assert.equal(providerStarts, 2)

    reads.length = 0; events.length = 0; revokeDuringRead = true
    await assert.rejects(gateway.generatePipelineText({...request, imageUrls: ['/images/first.png', '/images/second.png']}, undefined, start),
        error => (error as {statusCode?: number}).statusCode === 404)
    assert.deepEqual(events, ['authorize'])
    assert.equal(providerCalls, 2)
    assert.equal(providerStarts, 2)
    revoked = false; revokeDuringRead = false; mediaType = 'image/gif'
    await assert.rejects(gateway.generatePipelineText(request, undefined, start), error => (error as {statusCode?: number}).statusCode === 415)
    mediaType = 'image/png'; imageBuffer = Buffer.alloc(25 * 1024 * 1024)
    await assert.rejects(gateway.generatePipelineText({...request, imageUrls: Array.from({length: 5}, () => '/images/a.png')}, undefined, start),
        error => (error as {statusCode?: number}).statusCode === 413)
    imageBuffer = png
    assert.equal(providerCalls, 2)
    const cancelled = new AbortController(); cancelled.abort(new Error('Local cancellation before provider'))
    await assert.rejects(gateway.generatePipelineText(request, cancelled.signal, start), /Local cancellation/)
    assert.equal(providerCalls, 2)

    byok = true
    assert.notEqual((await gateway.generatePipelineText(request, undefined, start)).billing.priceSource, 'gateway')
    byok = false; finishReason = 'pending'
    assert.notEqual((await gateway.generatePipelineText(request, undefined, start)).billing.priceSource, 'gateway')
    finishReason = 'stop'; cost = 0.125
    for (const invalidText of ['', 'x'.repeat(20_001)]) {
        text = invalidText
        await assert.rejects(gateway.generatePipelineText(request, undefined, start), error => {
            const billing = extractGatewayErrorBilling(error)
            assert.equal(billing?.priceUsd, '0.125000000000')
            assert.equal(billing?.gatewayGenerationId, 'gen_pipeline_text')
            return true
        })
    }
    text = 'Valid text'; outputFile = true
    await assert.rejects(gateway.generatePipelineText(request, undefined, start), error => !!extractGatewayErrorBilling(error))
    outputFile = false; providerFailure = true
    await assert.rejects(gateway.generatePipelineText(request, undefined, start), error => {
        assert.equal(extractGatewayErrorBilling(error)?.gatewayGenerationId, 'gen_pipeline_failure')
        assert.ok(!JSON.stringify(error).includes('/app/private/path'))
        return true
    })
    assert.ok(lookups >= 7)
})
