import assert from 'node:assert/strict'
import test from 'node:test'
import { createDefaultSettings, ImageGenerationRequestSchema, IMAGE_MODEL_PROFILES, SUPPORTED_IMAGE_MODEL_IDS, isOpenAiImageSettings } from '../schemas/image-generation.ts'

import { useGateway } from '../server/utils/useGateway.ts'

test('every native image profile sends text, pictures and exact settings through Gateway', async (t) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  const reads: string[] = []
  let inputMimeType = 'image/png'
  const stubs = {
    useRuntimeConfig: () => ({AiGatewayApiKey: 'test-only-key'}),
    useFS: async () => ({
      getImageFile: async (path: string) => {
        reads.push(path)
        return {buffer: png, mimeType: inputMimeType}
      },
    }),
    createError: (data: {statusMessage: string}) => Object.assign(new Error(data.statusMessage), data),
  }
  for (const [name, value] of Object.entries(stubs)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, {configurable: true, value})
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
  const requests: Array<{model: string | null; body: Record<string, any>}> = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/config')) return Response.json({models: []})
    assert.ok(String(url).endsWith('/image-model'), `Unexpected HTTP request: ${url}`)
    assert.ok(init?.signal instanceof AbortSignal, 'provider calls must have a bounded abort signal')
    const body = JSON.parse(String(init?.body))
    requests.push({model: new Headers(init?.headers).get('ai-model-id'), body})
    return Response.json({
      images: Array.from({length: body.n}, () => png.toString('base64')),
      warnings: [],
      usage: {inputTokens: 100, outputTokens: 200, totalTokens: 300},
    })
  })
  const gateway = await useGateway()
  for (const model of ['openai/gpt-image-2.5-sunburst', 'openai/gpt-image-2.5-flare'] as const) {
    reads.length = 0
    const request = ImageGenerationRequestSchema.parse({
      prompt: 'Keep the label on this product and change the background',
      model,
      inputImages: ['/images/input/product.png'],
      modelImages: ['/images/reference/style.png'],
      maskImage: '/images/mask/edit.png',
      settings: {
        ...createDefaultSettings(model),
        quality: 'max', background: 'transparent', size: '1536x1024', numberOfImages: 2,
      },
    })
    const outputs = await gateway.generateAnyImage(request)
    assert.equal(outputs.length, 2)
    assert.deepEqual(reads, [...request.inputImages, ...request.modelImages, request.maskImage])
    const sent = requests.at(-1)!
    assert.equal(sent.model, model)
    assert.equal(sent.body.prompt, request.prompt)
    assert.equal(sent.body.n, 2)
    assert.equal(sent.body.size, '1536x1024')
    assert.equal(sent.body.files.length, 2)
    assert.equal(sent.body.files[0].data, png.toString('base64'))
    assert.equal(sent.body.files[1].data, png.toString('base64'))
    assert.equal(sent.body.mask.data, png.toString('base64'))
    assert.deepEqual(sent.body.providerOptions.openai, {
      quality: 'max', background: 'transparent', outputFormat: 'png', moderation: 'auto',
    })
    assert.equal(sent.body.aspectRatio, undefined)
    assert.equal(sent.body.seed, undefined)
    assert.equal(outputs[0]!.billing.model, model)
    assert.equal(outputs[0]!.mimeType, 'image/png')
    assert.deepEqual(outputs[0]!.buffer, png)

    const callCount = requests.length
    inputMimeType = 'image/heic'
    await assert.rejects(gateway.generateAnyImage(request), /does not accept image\/heic/)
    inputMimeType = 'image/png'
    await assert.rejects(gateway.generateImageViaLanguageModel(request), /does not match the selected model profile/)
    assert.equal(requests.length, callCount, 'invalid input must be rejected before paid work')
  }
  for (const model of SUPPORTED_IMAGE_MODEL_IDS.filter(id => IMAGE_MODEL_PROFILES[id].adapter === 'gateway-image')) {
    const profile = IMAGE_MODEL_PROFILES[model]
    let settings = createDefaultSettings(model)
    const raw = {...settings,
      ...('size' in settings || profile.imageSizes.includes('1536x1024') ? {size: '1536x1024'} : {}),
      ...(profile.aspectRatios.length ? {aspectRatio: '16:9'} : {}),
    }
    // Optional properties are absent from default objects; exercise explicit BFL seed/size controls.
    if (profile.provider === 'bfl') Object.assign(raw, {seed: 42})
    if (model === 'bfl/flux-pro-1.1') Object.assign(raw, {size: '1440x1024'})
    if (model === 'spacexai/grok-imagine-image-2.0') Object.assign(raw, {resolution: '2k', numberOfImages: 2})
    const request = ImageGenerationRequestSchema.parse({
      prompt: 'Keep the product and change the background', model, settings: raw,
      inputImages: ['/images/input/product.png'],
      modelImages: Array.from({length: profile.maxReferenceImages - 1}, (_, i) => `/images/reference/${i}.png`),
      ...(profile.supportsMask ? {maskImage: '/images/mask/edit.png'} : {}),
    })
    settings = request.settings
    reads.length = 0
    const outputs = await gateway.generateAnyImage(request)
    const sent = requests.at(-1)!
    assert.equal(sent.model, model)
    assert.equal(sent.body.prompt, request.prompt)
    assert.equal(sent.body.n, 'numberOfImages' in settings ? settings.numberOfImages : 1)
    assert.equal(outputs.length, sent.body.n)
    assert.deepEqual(reads, [...request.inputImages, ...request.modelImages, ...(request.maskImage ? [request.maskImage] : [])])
    const conditioning = model === 'bfl/flux-pro-1.1' || model === 'bfl/flux-pro-1.1-ultra'
    if (conditioning) {
      assert.equal(sent.body.files, undefined)
      assert.equal(sent.body.providerOptions.blackForestLabs.imagePrompt, png.toString('base64'))
    } else {
      assert.equal(sent.body.files.length, profile.maxReferenceImages, model)
      assert.ok(sent.body.files.every((file: {data: string}) => file.data === png.toString('base64')))
    }
    assert.equal(sent.body.mask?.data, request.maskImage ? png.toString('base64') : undefined)
    if (isOpenAiImageSettings(settings)) {
      assert.deepEqual(sent.body.providerOptions.openai, {quality: 'auto', background: 'auto', outputFormat: 'png', moderation: 'auto'})
    } else if (profile.provider === 'bfl') {
      assert.equal(sent.body.providerOptions.blackForestLabs.outputFormat, 'png')
      assert.equal(sent.body.seed, 42)
      assert.equal(sent.body.providerOptions.openai, undefined)
    } else if ('watermark' in settings) {
      assert.deepEqual(sent.body.providerOptions.bytedance, {
        size: '2K', watermark: true, sequentialImageGeneration: 'disabled',
        ...(model === 'bytedance/seedream-5.0-lite' || model === 'bytedance/seedream-5.0-pro' ? {outputFormat: 'png'} : {}),
      })
      assert.equal(sent.body.size, undefined, 'Seedream uses a provider resolution tier')
    } else if (profile.provider === 'spacexai') {
      assert.deepEqual(sent.body.providerOptions.xai, model === 'spacexai/grok-imagine-image-2.0' ? {resolution: '2k'} : {})
      assert.equal(sent.body.size, undefined, 'Grok does not accept size')
      assert.equal(sent.body.aspectRatio, '16:9')
    } else {
      assert.deepEqual(sent.body.providerOptions, {})
      assert.equal(sent.body.size, undefined)
    }
    const callCount = requests.length
    await assert.rejects(gateway.generateAnyImage({...request, modelImages: [...request.modelImages, '/images/extra.png']}), /does not match/)
    await assert.rejects(gateway.generateImageViaLanguageModel(request), /does not match/)
    assert.equal(requests.length, callCount, 'invalid requests must fail before inference')
  }

})
