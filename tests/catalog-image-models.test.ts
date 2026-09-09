import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IMAGE_MODEL_PROFILES, SUPPORTED_IMAGE_MODEL_IDS, ImageGenerationRequestSchema,
  createDefaultSettings, StoredGenerationConfigSchema,
} from '../schemas/image-generation.ts'
import { CATALOG_IMAGE_DEFINITIONS, CATALOG_IMAGE_MODEL_IDS, CatalogImageSettingsSchema } from '../schemas/catalog-image-models.ts'
import { validateBflFillMaskPair, validateGptImageMaskPair } from '../server/utils/gptImageMask.ts'
import { sanitizeProviderMetadata } from '../server/utils/gatewayMetadata.ts'
import { reactive } from 'vue'
import { watchImageModelSelection } from '../app/utils/watchImageModelSelection.ts'
import { getImageModelCapabilities } from '../server/utils/useGateway.ts'

test('switching any pair of models resets settings synchronously and clears incompatible masks', () => {
  for (const from of SUPPORTED_IMAGE_MODEL_IDS) {
    for (const to of SUPPORTED_IMAGE_MODEL_IDS.filter(id => id !== from)) {
      const state = reactive({selectedModel: from, generationSettings: createDefaultSettings(from), maskImage: '/images/mask.png' as string | null})
      const stop = watchImageModelSelection(state)
      state.selectedModel = to
      assert.deepEqual(state.generationSettings, createDefaultSettings(to), `${from} -> ${to}`)
      const preserveMask = IMAGE_MODEL_PROFILES[to].supportsMask
        && IMAGE_MODEL_PROFILES[to].maskMode === IMAGE_MODEL_PROFILES[from].maskMode
      assert.equal(state.maskImage, preserveMask ? '/images/mask.png' : null)
      stop()
    }
  }
})

test('capabilities come from exact profiles, including providers with incomplete catalog metadata', () => {
  for (const id of SUPPORTED_IMAGE_MODEL_IDS) {
    const profile = IMAGE_MODEL_PROFILES[id]
    const capabilities = getImageModelCapabilities({id, name: 'Misleading text-only name', provider: profile.provider, modelType: 'image'})
    assert.ok(capabilities.input.includes('image'))
    assert.ok(capabilities.output.includes('image'))
    assert.equal(capabilities.input.includes('multiple-images'), profile.maxReferenceImages > 1)
    assert.ok(!capabilities.warnings.some(warning => warning.includes('ignored or rejected')))
  }
  assert.deepEqual(getImageModelCapabilities({id: 'unknown/image-edit-gemini', name: 'Image generation', provider: 'unknown'}).input, [])
})

test('each profile enforces its reference boundary, mask rules, and exact stored replay', () => {
  for (const model of SUPPORTED_IMAGE_MODEL_IDS) {
    const profile = IMAGE_MODEL_PROFILES[model]
    const request = {
      model, prompt: 'Keep the product label', settings: createDefaultSettings(model),
      inputImages: ['/images/product.png'],
      modelImages: Array.from({length: profile.maxReferenceImages - 1}, (_, i) => `/images/ref-${i}.png`),
      ...(profile.requiresMask ? {maskImage: '/images/mask.png'} : {}),
    }
    assert.ok(ImageGenerationRequestSchema.safeParse(request).success, model)
    assert.equal(ImageGenerationRequestSchema.safeParse({...request, modelImages: [...request.modelImages, '/images/extra.png']}).success, false, model)
    assert.equal(ImageGenerationRequestSchema.safeParse({...request, maskImage: '/images/mask.png'}).success, profile.supportsMask, model)
    assert.equal(ImageGenerationRequestSchema.safeParse({...request, maskImage: undefined}).success, !profile.requiresMask, model)
    assert.equal(ImageGenerationRequestSchema.safeParse({...request, inputImages: [], modelImages: [], maskImage: '/images/mask.png'}).success, false)
    const stored = {
      schemaVersion: 1, profileVersion: profile.profileVersion, requestedModel: model, effectiveModel: model,
      settings: request.settings, storeInputImages: true, ...(request.maskImage ? {maskImage: request.maskImage} : {}),
    }
    assert.deepEqual(StoredGenerationConfigSchema.parse(JSON.parse(JSON.stringify(stored))), stored)
  }
})

test('catalog controls expose valid model-specific choices and reject stale or out-of-range values', () => {
  for (const model of CATALOG_IMAGE_MODEL_IDS) {
    const defaults = createDefaultSettings(model)
    for (const control of CATALOG_IMAGE_DEFINITIONS[model].controls) {
      const values = control.type === 'select' ? control.options! : control.type === 'checkbox' ? [true, false] : [control.min, control.max]
      for (const value of values) {
        assert.ok(CatalogImageSettingsSchema.safeParse({...defaults, [control.key]: value}).success, `${model} ${control.key} ${value}`)
      }
      const invalid = control.type === 'select' ? 'invalid' : control.type === 'checkbox' ? 'true' : control.max! + 1
      assert.equal(CatalogImageSettingsSchema.safeParse({...defaults, [control.key]: invalid}).success, false)
    }
    assert.equal(CatalogImageSettingsSchema.safeParse({...defaults, quality: 'max'}).success, false)
  }
})

test('legacy OpenAI models retain fixed sizes and reject newer quality levels', () => {
  for (const model of ['openai/gpt-image-1', 'openai/gpt-image-1-mini', 'openai/gpt-image-1.5'] as const) {
    const request = {model, prompt: 'Edit product', inputImages: ['/images/product.png'], settings: createDefaultSettings(model)}
    for (const size of ['1024x1024', '1536x1024', '1024x1536']) {
      assert.ok(ImageGenerationRequestSchema.safeParse({...request, settings: {...request.settings, size, background: 'transparent'}}).success)
    }
    for (const invalid of [{size: '2048x2048'}, {quality: 'max'}, {background: 'transparent', outputFormat: 'jpeg'}]) {
      assert.equal(ImageGenerationRequestSchema.safeParse({...request, settings: {...request.settings, ...invalid}}).success, false)
    }
  }
})

test('Grok multi-output requests use the same total output cap as OpenAI', () => {
  for (const model of ['spacexai/grok-imagine-image', 'spacexai/grok-imagine-image-2.0'] as const) {
    const request = {model, prompt: 'Edit product', inputImages: Array(5).fill('/images/product.png'), settings: {...createDefaultSettings(model), numberOfImages: 10}}
    assert.ok(ImageGenerationRequestSchema.safeParse(request).success)
    assert.equal(ImageGenerationRequestSchema.safeParse({...request, inputImages: Array(6).fill('/images/product.png')}).success, false)
  }
})

test('FLUX Fill accepts luminance masks and JPEG sources; GPT requires PNG alpha masks', () => {
  const mask = {mimeType: 'image/png', bytes: 100, width: 1024, height: 1024, hasAlpha: false}
  const source = {...mask, mimeType: 'image/jpeg'}
  assert.equal(validateBflFillMaskPair(mask, source), undefined)
  assert.match(validateGptImageMaskPair(mask, source)!, /alpha/)
  assert.match(validateBflFillMaskPair(mask, {...source, width: 512})!, /dimensions/)
  assert.match(validateBflFillMaskPair({...mask, mimeType: 'image/jpeg'}, source)!, /PNG/)
  assert.match(validateBflFillMaskPair({...mask, bytes: 21 * 1024 * 1024}, source)!, /20 MB/)
  assert.match(validateBflFillMaskPair(mask)!, /source/)
})

test('BFL base64 image prompts and echoed request bodies are redacted from diagnostics', () => {
  const metadata = sanitizeProviderMetadata({imagePrompt: 'private-image-bytes', requestBodyValues: {files: [{data: 'private-image-bytes'}]}})
  assert.deepEqual(metadata, {imagePrompt: '[REDACTED]', requestBodyValues: '[REDACTED]'})
})
