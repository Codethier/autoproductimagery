import assert from 'node:assert/strict'
import test from 'node:test'
import {hasConfirmedGenerationPrice, extractConfirmedGatewayPrice, normalizeUsd} from '../schemas/generation-billing.ts'
import {createBillingMetadataFetch} from '../server/utils/billingMetadataFetch.ts'
import {extractGatewayErrorBilling, extractGatewayErrorGenerationId} from '../server/utils/billingGatewayError.ts'
import {allocateGenerationBilling} from '../server/utils/generationBilling.ts'
import {useGateway} from '../server/utils/useGateway.ts'
import {createDefaultSettings, ImageGenerationRequestSchema} from '../schemas/image-generation.ts'

test('confirmed prices require authoritative Gateway settlement and accept valid zero', () => {
    assert.equal(hasConfirmedGenerationPrice({priceUsd: '0.000000000000', priceSource: 'gateway', billingState: 'confirmed'}), true)
    assert.equal(hasConfirmedGenerationPrice({priceUsd: '0.1', priceSource: 'gateway', billingState: null}), true, 'legacy final prices remain usable')
    for (const row of [
        {priceUsd: '0.1', priceSource: 'estimate'},
        {priceUsd: '0.1', priceSource: 'unknown'},
        {priceUsd: null, priceSource: 'gateway'},
        {priceUsd: '-1', priceSource: 'gateway'},
        {priceUsd: 'NaN', priceSource: 'gateway'},
        {priceUsd: '0.1', priceSource: 'gateway', billingState: 'outstanding'},
        {priceUsd: '0.1', priceSource: 'gateway', billingState: 'pending'},
        {priceUsd: '0.1', priceSource: 'gateway', billingState: 'released'},
        {priceUsd: '0', priceSource: 'gateway', billingState: null, usageJson: {gatewayBilling: {isByok: true}}},
        {priceUsd: '0.1', priceSource: 'gateway', billingState: 'confirmed', usageJson: {gatewayBilling: {isByok: 'true'}}},
    ]) assert.equal(hasConfirmedGenerationPrice(row), false)
    assert.equal(normalizeUsd(0.00000001), '0.000000010000')
    assert.equal(normalizeUsd(0.000000000001), '0.000000000001')
    assert.equal(normalizeUsd(0.0000000000001), undefined, 'positive cost below accounting precision must not become free')
    for (const invalid of [NaN, Infinity, -Infinity, -1, null, {}, ' 0.1', '1e-5']) assert.equal(normalizeUsd(invalid), undefined)
    assert.equal(extractConfirmedGatewayPrice({id: 'gen_correct', totalCost: 0, finishReason: 'stop', isByok: false}, 'gen_correct'), '0.000000000000')
    for (const change of [
        {id: 'gen_wrong'}, {totalCost: -1}, {totalCost: Infinity}, {totalCost: '0.1'},
        {finishReason: ''}, {finishReason: 'pending'}, {finishReason: 'running'}, {finishReason: 'unknown'}, {finishReason: null},
        {isByok: true, upstreamInferenceCost: 0.1}, {isByok: undefined}, {isByok: null},
    ]) assert.equal(extractConfirmedGatewayPrice({id: 'gen_correct', totalCost: 0.1, finishReason: 'stop', isByok: false, ...change}, 'gen_correct'), undefined)
})

test('failed Gateway calls retain only bounded documented generation identities without inventing a price', () => {
    assert.equal(extractGatewayErrorGenerationId({generationId: 'gen_paid_error'}), 'gen_paid_error')
    assert.equal(extractGatewayErrorGenerationId({lastError: {cause: {generationId: 'gen_nested'}}}), 'gen_nested')
    assert.equal(extractGatewayErrorGenerationId({generationId: 'https://other.test/generation'}), undefined)
    assert.equal(extractGatewayErrorGenerationId({requestId: 'gen_request_not_generation'}), undefined)
    const cycle: {cause?: unknown} = {}; cycle.cause = cycle
    assert.equal(extractGatewayErrorGenerationId(cycle), undefined)
})

test('metadata requests abort real fetch work while provider requests retain their own signals', async () => {
    const fetchImplementation: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
        assert.ok(init?.signal instanceof AbortSignal)
        init.signal.addEventListener('abort', () => reject(init.signal!.reason), {once: true})
    })
    // AbortSignal.timeout uses an unref timer. A normal timer keeps this
    // isolated unit test alive without changing the production deadline.
    const keepAlive = setTimeout(() => undefined, 1_000)
    try {
        const bounded = createBillingMetadataFetch(fetchImplementation, 10)
        await assert.rejects(bounded('https://ai-gateway.vercel.sh/v1/generation?id=gen_test'), {name: 'TimeoutError'})
        const cancellation = new AbortController()
        const pending = bounded(new Request('https://ai-gateway.vercel.sh/v3/ai/config', {signal: cancellation.signal}))
        cancellation.abort(new Error('Caller cancelled'))
        await assert.rejects(pending, /Caller cancelled/)
    } finally {clearTimeout(keepAlive)}
    const signal = AbortSignal.timeout(1_000)
    const providerFetch = createBillingMetadataFetch(async (_input, init) => {
        assert.equal(init?.signal, signal)
        return new Response('ok')
    }, 10)
    await providerFetch('https://ai-gateway.vercel.sh/v3/ai/image-model', {signal})
})

test('Gateway SDK lookup verifies final records and preserves billing on empty image outputs', async t => {
    const stubs = {
        useRuntimeConfig: () => ({AiGatewayApiKey: 'test-only-invalid-key'}),
        createError: (data: {statusMessage: string}) => Object.assign(new Error(data.statusMessage), data),
    }
    for (const [name, value] of Object.entries(stubs)) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, name)
        Object.defineProperty(globalThis, name, {configurable: true, value})
        t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name))
    }
    let totalCost = 0.000000000001
    let finishReason = 'stop'
    let recordId = 'gen_paid'
    let lookupMissing = false
    let emptyImages = false
    let isByok = false
    let providerFailure = false
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/config')) return Response.json({models: []})
        if (url.pathname === '/v1/generation') {
            assert.ok(init?.signal instanceof AbortSignal, 'billing request itself is abortable')
            if (lookupMissing) return Response.json({error: 'Not available yet'}, {status: 404})
            return Response.json({data: {
                id: recordId, total_cost: totalCost, upstream_inference_cost: 0, usage: totalCost,
                created_at: '2026-10-13T12:00:00Z', model: 'openai/gpt-image-2.5-sunburst',
                is_byok: isByok, provider_name: 'openai', streamed: false, finish_reason: finishReason,
                latency: 1, generation_time: 2, native_tokens_prompt: 100, native_tokens_completion: 200,
                native_tokens_reasoning: 0, native_tokens_cached: 0, native_tokens_cache_creation: 0, billable_web_search_calls: 0,
            }})
        }
        if (providerFailure) return Response.json({generationId: 'gen_paid_error', error: {type: 'internal_server_error', message: 'Synthetic paid provider failure'}}, {status: 502})
        if (url.pathname.endsWith('/language-model')) return Response.json({
            content: [{type: 'text', text: 'Synthetic no-image response'}],
            finishReason: {unified: 'stop', raw: 'STOP'},
            usage: {inputTokens: {total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0},
                outputTokens: {total: 200, text: 200, reasoning: 0}},
            providerMetadata: {gateway: {generationId: 'gen_paid'}}, warnings: [],
        })
        assert.ok(url.pathname.endsWith('/image-model'))
        return Response.json({images: emptyImages ? [] : [png.toString('base64'), png.toString('base64')],
            warnings: [], usage: {inputTokens: 100, outputTokens: 200, totalTokens: 300},
            providerMetadata: {gateway: {generationId: 'gen_paid'}}})
    })
    const gateway = await useGateway({getImageFile: async () => ({buffer: png, mimeType: 'image/png'})})
    const zero = await gateway.getGenerationBilling('gen_paid')
    assert.equal(zero?.priceUsd, '0.000000000001')
    assert.equal(zero?.priceSource, 'gateway')
    totalCost = 0
    assert.equal((await gateway.getGenerationBilling('gen_paid'))?.priceUsd, '0.000000000000')
    isByok = true
    assert.equal((await gateway.getGenerationBilling('gen_paid'))?.priceUsd, undefined, 'BYOK Gateway debit cannot prove the external invoice')
    assert.equal((await gateway.getGenerationBilling('gen_paid'))?.priceSource, 'unknown')
    isByok = false
    recordId = 'gen_other'
    assert.equal((await gateway.getGenerationBilling('gen_paid'))?.priceSource, 'unknown')
    recordId = 'gen_paid'; finishReason = 'pending'
    assert.equal((await gateway.getGenerationBilling('gen_paid'))?.priceUsd, undefined)
    finishReason = 'stop'; lookupMissing = true
    assert.equal(await gateway.getGenerationBilling('gen_paid'), undefined)
    lookupMissing = false; totalCost = 0.100000000001
    const request = ImageGenerationRequestSchema.parse({
        model: 'openai/gpt-image-2.5-sunburst', prompt: 'Synthetic test only', inputImages: [], modelImages: [],
        settings: {...createDefaultSettings('openai/gpt-image-2.5-sunburst'), numberOfImages: 2},
    })
    const images = await gateway.generateAnyImage(request)
    assert.equal(images.length, 2)
    assert.equal(images[0]!.billing.priceUsd, '0.100000000001')
    const shares = images.map((image, index) => allocateGenerationBilling(image.billing, index, 2))
    assert.deepEqual(shares.map(share => share.priceUsd), ['0.050000000001', '0.050000000000'])
    emptyImages = true
    await assert.rejects(gateway.generateAnyImage(request), error => {
        const billing = extractGatewayErrorBilling(error)
        assert.equal(billing?.priceUsd, '0.100000000001')
        assert.equal(billing?.gatewayGenerationId, 'gen_paid')
        assert.equal(billing?.priceSource, 'gateway')
        return true
    })
    const languageRequest = ImageGenerationRequestSchema.parse({
        model: 'google/gemini-3.1-flash-image', prompt: 'Synthetic test only', inputImages: [], modelImages: [],
        settings: createDefaultSettings('google/gemini-3.1-flash-image'),
    })
    await assert.rejects(gateway.generateAnyImage(languageRequest), error => {
        const billing = extractGatewayErrorBilling(error)
        assert.equal(billing?.priceUsd, '0.100000000001')
        assert.equal(billing?.gatewayGenerationId, 'gen_paid')
        assert.equal(billing?.priceSource, 'gateway')
        return true
    })
    providerFailure = true
    for (const failedRequest of [request, languageRequest]) await assert.rejects(gateway.generateAnyImage(failedRequest), error => {
        const billing = extractGatewayErrorBilling(error)
        assert.equal(billing?.gatewayGenerationId, 'gen_paid_error')
        assert.equal(billing?.priceSource, 'unknown')
        assert.equal(billing?.priceUsd, undefined, 'provider failure identity permits later reconciliation but never implies a charge')
        return true
    })
})
