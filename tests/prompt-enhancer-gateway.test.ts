import assert from 'node:assert/strict'
import test from 'node:test'
import {useGateway, type PipelineTextRequest} from '../server/utils/useGateway.ts'
import {extractGatewayErrorBilling} from '../server/utils/billingGatewayError.ts'

test('selected enhancer models send exact native effort settings and record the selected model charge', async t => {
    const stubs = {useRuntimeConfig: () => ({AiGatewayApiKey: 'invalid-local-test-key-no-paid-calls'}),
        createError: (data: {statusMessage: string}) => Object.assign(new Error(data.statusMessage), data)}
    for (const [name, value] of Object.entries(stubs)) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, name)
        Object.defineProperty(globalThis, name, {configurable: true, value})
        t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name))
    }
    let selectedModel = 'zai/glm-5.3-flash', failure = false, starts = 0
    const bodies: Record<string, unknown>[] = [], modelIds: string[] = []
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/config')) return Response.json({models: ['zai/glm-5.3-flash', 'openai/gpt-6-luna'].map(id => ({
            id, name: id, modelType: 'language', pricing: {input: '0.000001', output: '0.000002'},
        }))})
        if (url.pathname === '/v1/generation') return Response.json({data: {
            id: 'gen_selected_enhancer', total_cost: 0.123456789012, upstream_inference_cost: 0.123456789012,
            usage: 0.123456789012, created_at: '2026-10-14T12:00:00Z', model: selectedModel, is_byok: false,
            provider_name: selectedModel.startsWith('zai/') ? 'zai' : 'openai', streamed: false, finish_reason: 'stop',
            latency: 1, generation_time: 2, native_tokens_prompt: 5, native_tokens_completion: 13,
            native_tokens_reasoning: 6, native_tokens_cached: 0, native_tokens_cache_creation: 0, billable_web_search_calls: 0,
        }})
        assert.ok(url.pathname.endsWith('/language-model'))
        modelIds.push(new Headers(init?.headers).get('ai-language-model-id')!)
        bodies.push(JSON.parse(String(init?.body)))
        assert.ok(init?.signal instanceof AbortSignal)
        if (failure) return Response.json({generationId: 'gen_selected_failure', error: {
            type: 'internal_server_error', message: 'Synthetic failure with secret-looking /app/private/data'}}, {status: 502})
        return Response.json({content: [{type: 'text', text: 'Keep the green label sharp in a softly lit studio.'}],
            finishReason: {unified: 'stop', raw: 'STOP'},
            usage: {inputTokens: {total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0}, outputTokens: {total: 13, text: 7, reasoning: 6}},
            providerMetadata: {gateway: {generationId: 'gen_selected_enhancer'}}, warnings: []})
    })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    const gateway = await useGateway({async getImageFile() {return {buffer: png, mimeType: 'image/png'}}, async assertReadableImages() {}})
    const start = async () => {starts++}
    const glm: PipelineTextRequest = {model: 'zai/glm-5.3-flash', reasoningEffort: 'high', temperature: 0.3, maxOutputTokens: 8192,
        prompt: 'Improve the prompt while preserving the green product label', imageUrls: ['/images/product.png']}
    const first = await gateway.generatePipelineText(glm, undefined, start)
    assert.equal(first.billing.model, 'zai/glm-5.3-flash')
    assert.equal(first.billing.priceUsd, '0.123456789012')
    assert.equal(first.billing.reasoningTokens, 6)
    assert.deepEqual(bodies[0]!.providerOptions, {gateway: {only: ['zai']}, zai: {thinking: {type: 'enabled'}, reasoningEffort: 'high'}})
    assert.equal(bodies[0]!.maxOutputTokens, 8192)
    assert.equal(bodies[0]!.temperature, 0.3)
    assert.ok(JSON.stringify(bodies[0]).includes(png.toString('base64')))
    selectedModel = 'openai/gpt-6-luna'
    const luna: PipelineTextRequest = {model: 'openai/gpt-6-luna', reasoningEffort: 'max', maxOutputTokens: 16384, prompt: 'A red bag'}
    const second = await gateway.generatePipelineText(luna, undefined, start)
    assert.equal(second.billing.model, 'openai/gpt-6-luna')
    assert.equal(second.billing.priceSource, 'gateway')
    assert.deepEqual(bodies[1]!.providerOptions, {gateway: {only: ['openai']}, openai: {reasoningEffort: 'max'}})
    assert.equal('temperature' in bodies[1]!, false)
    await gateway.generatePipelineText({...luna, reasoningEffort: 'none', temperature: 0.8}, undefined, start)
    assert.equal(bodies[2]!.temperature, 0.8)
    assert.deepEqual(modelIds, ['zai/glm-5.3-flash', 'openai/gpt-6-luna', 'openai/gpt-6-luna'])
    for (const request of [{...glm, reasoningEffort: 'medium'}, {...glm, temperature: 1.1}, {...luna, temperature: 0.5},
        {...luna, reasoningEffort: 'minimal'}, {...luna, providerOptions: {openai: {serviceTier: 'priority'}}}])
        await assert.rejects(gateway.generatePipelineText(request as PipelineTextRequest, undefined, start),
            error => (error as {statusCode?: number}).statusCode === 400)
    assert.equal(starts, 3)
    const abort = new AbortController(); abort.abort(new Error('Cancelled before selected enhancer call'))
    await assert.rejects(gateway.generatePipelineText(luna, abort.signal, start), /Cancelled before selected enhancer call/)
    assert.equal(starts, 3)
    failure = true
    await assert.rejects(gateway.generatePipelineText(luna, undefined, start), error => {
        assert.equal(extractGatewayErrorBilling(error)?.gatewayGenerationId, 'gen_selected_failure')
        assert.ok(!JSON.stringify(error).includes('/app/private/data')); return true
    })
    assert.equal(modelIds.length, 4, 'The failed paid request must not retry automatically')
})
