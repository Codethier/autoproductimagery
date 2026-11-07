import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createDefaultSettings,
    IMAGE_MODEL_PROFILES,
    ImageGenerationRequestSchema,
    SUPPORTED_IMAGE_MODEL_IDS,
} from '../schemas/image-generation.ts'
import { GenerationRequestTimeoutError } from '../server/utils/generationLimiter.ts'
import { useGateway } from '../server/utils/useGateway.ts'

test('request cancellation prevents paid calls and aborts both Gateway adapters in flight', async t => {
    let sourceReads = 0
    let sourceMimeType = 'image/png'
    let sourceBuffer = Buffer.alloc(0)
    let paidStarts = 0
    const onProviderStart = () => {paidStarts += 1}
    let abortDuringRead: AbortController | undefined
    const stubs = {
        useRuntimeConfig: () => ({ AiGatewayApiKey: 'test-only-key' }),
        useFS: async () => ({ getImageFile: async () => {
            sourceReads += 1
            abortDuringRead?.abort(new GenerationRequestTimeoutError())
            return { buffer: sourceBuffer, mimeType: sourceMimeType }
        } }),
        createError: (data: { statusMessage: string }) => Object.assign(new Error(data.statusMessage), data),
    }
    for (const [name, value] of Object.entries(stubs)) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, name)
        Object.defineProperty(globalThis, name, { configurable: true, value })
        t.after(() => {
            if (previous) Object.defineProperty(globalThis, name, previous)
            else Reflect.deleteProperty(globalThis, name)
        })
    }
    let calls = 0
    let started!: () => void
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith('/config')) return Response.json({ models: [] })
        calls += 1
        assert.ok(init?.signal instanceof AbortSignal)
        started()
        return new Promise<Response>((_resolve, reject) => {
            if (init.signal!.aborted) reject(init.signal!.reason)
            else init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        })
    })
    const gateway = await useGateway()
    for (const adapter of ['gateway-image', 'gateway-language-image'] as const) {
        const model = SUPPORTED_IMAGE_MODEL_IDS.find(id => IMAGE_MODEL_PROFILES[id].adapter === adapter)!
        const request = ImageGenerationRequestSchema.parse({
            model,
            prompt: 'Product photo',
            settings: createDefaultSettings(model),
            inputImages: [],
            modelImages: [],
        })
        const reason = new GenerationRequestTimeoutError()
        await assert.rejects(gateway.generateAnyImage(request, AbortSignal.abort(reason), onProviderStart), error => error === reason)
        const abort = new AbortController()
        const providerStarted = new Promise<void>(resolve => { started = resolve })
        const pending = gateway.generateAnyImage(request, abort.signal, onProviderStart)
        await providerStarted
        abort.abort(reason)
        await assert.rejects(pending, error => error === reason)
    }
    assert.equal(calls, 2)
    assert.equal(paidStarts, 2, 'only the two requests reaching the provider boundary start paid accounting')
    assert.equal(sourceReads, 0)
    abortDuringRead = new AbortController()
    const sourceRequest = ImageGenerationRequestSchema.parse({
        model: 'openai/gpt-image-2.5-sunburst',
        prompt: 'Product photo',
        settings: createDefaultSettings('openai/gpt-image-2.5-sunburst'),
        inputImages: ['/images/input/first.png'],
        modelImages: ['/images/reference/second.png'],
    })
    await assert.rejects(gateway.generateAnyImage(sourceRequest, abortDuringRead.signal, onProviderStart), GenerationRequestTimeoutError)
    assert.equal(sourceReads, 1, 'cancelled requests stop reading subsequent objects')
    assert.equal(calls, 2, 'reference read cancellation prevents paid work')
    assert.equal(paidStarts, 2, 'cancelled source loads must not create outstanding paid charges')
    abortDuringRead = undefined
    sourceMimeType = 'image/heic'
    await assert.rejects(gateway.generateAnyImage(sourceRequest, undefined, onProviderStart), /does not accept image\/heic/)
    assert.equal(paidStarts, 2, 'model-specific input MIME rejection happens before paid accounting')
    sourceMimeType = 'image/png'
    sourceBuffer = Buffer.alloc(21 * 1024 * 1024)
    const oversizedReferences = {...sourceRequest, modelImages: Array.from({length: 4}, (_, index) => `/images/reference/${index}.png`)}
    await assert.rejects(gateway.generateAnyImage(oversizedReferences, undefined, onProviderStart), /100 MB/)
    assert.equal(paidStarts, 2, 'aggregate reference byte limits happen before paid accounting')
    assert.equal(calls, 2)
})
