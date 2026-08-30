import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IMAGE_MODEL_PROFILES,
  ImageGenerationRequestSchema,
  SUPPORTED_IMAGE_MODEL_IDS,
  createDefaultSettings,
  isValidGptImage2Size,
} from '../schemas/image-generation.ts'
import {
  allocateGenerationBilling,
  readGenerationAllocation,
  resolveGenerationTotalTokens,
} from '../server/utils/generationBilling.ts'
import { validateGptImageMaskPair } from '../server/utils/gptImageMask.ts'
import { toBufferView } from '../server/utils/imageBuffer.ts'

test('every curated model has defaults that validate against its own profile', () => {
  for (const model of SUPPORTED_IMAGE_MODEL_IDS) {
    const settings = createDefaultSettings(model)
    const parsed = ImageGenerationRequestSchema.safeParse({
      prompt: 'Create a product photograph',
      model,
      inputImages: [],
      modelImages: [],
      settings,
    })
    assert.equal(parsed.success, true, parsed.success ? undefined : parsed.error.message)
    assert.equal(IMAGE_MODEL_PROFILES[model].id, model)
  }
})

test('settings cannot be reused across model families', () => {
  const parsed = ImageGenerationRequestSchema.safeParse({
    prompt: 'Create a product photograph',
    model: 'openai/gpt-image-2',
    inputImages: [],
    modelImages: [],
    settings: createDefaultSettings('google/gemini-3.1-flash-image'),
  })
  assert.equal(parsed.success, false)
})

test('GPT Image 2 custom dimensions follow the documented constraints', () => {
  assert.equal(isValidGptImage2Size('1024x1024'), true)
  assert.equal(isValidGptImage2Size('1536x1024'), true)
  assert.equal(isValidGptImage2Size('3840x2160'), true)
  assert.equal(isValidGptImage2Size('512x512'), false)
  assert.equal(isValidGptImage2Size('1000x1000'), false)
  assert.equal(isValidGptImage2Size('3840x1000'), false)
})

test('Gemini Lite rejects tiers and token ceilings it does not support', () => {
  const settings = createDefaultSettings('google/gemini-3.1-flash-lite-image') as any
  settings.imageSize = '2K'
  settings.sampling.maxOutputTokens = 4097
  const parsed = ImageGenerationRequestSchema.safeParse({
    prompt: 'Create a product photograph',
    model: 'google/gemini-3.1-flash-lite-image',
    inputImages: [],
    modelImages: [],
    settings,
  })
  assert.equal(parsed.success, false)
})

test('request output fan-out is capped', () => {
  const settings = createDefaultSettings('openai/gpt-image-2') as any
  settings.numberOfImages = 10
  const parsed = ImageGenerationRequestSchema.safeParse({
    prompt: 'Create a product photograph',
    model: 'openai/gpt-image-2',
    inputImages: Array.from({length: 6}, (_, i) => `/images/input/${i}.png`),
    modelImages: [],
    settings,
  })
  assert.equal(parsed.success, false)
})

test('Gemini 2.5 keeps the three-reference recommendation as guidance, not a hard cap', () => {
  const parsed = ImageGenerationRequestSchema.safeParse({
    prompt: 'Create a product photograph',
    model: 'google/gemini-2.5-flash-image',
    inputImages: ['/images/input/product.png'],
    modelImages: [
      '/images/reference/one.png',
      '/images/reference/two.png',
      '/images/reference/three.png',
    ],
    settings: createDefaultSettings('google/gemini-2.5-flash-image'),
  })
  assert.equal(parsed.success, true, parsed.success ? undefined : parsed.error.message)

  const tooMany = ImageGenerationRequestSchema.safeParse({
    prompt: 'Create a product photograph',
    model: 'google/gemini-2.5-flash-image',
    inputImages: ['/images/input/product.png'],
    modelImages: Array.from({length: 16}, (_, index) => `/images/reference/${index}.png`),
    settings: createDefaultSettings('google/gemini-2.5-flash-image'),
  })
  assert.equal(tooMany.success, false)
})

test('paths stay inside the image root', () => {
  const traversal = ImageGenerationRequestSchema.safeParse({
    prompt: 'Create a product photograph',
    model: 'google/gemini-3.1-flash-image',
    inputImages: ['/images/../database.sqlite'],
    modelImages: [],
    settings: createDefaultSettings('google/gemini-3.1-flash-image'),
  })
  assert.equal(traversal.success, false)
})

test('Gemini output-token limits cannot be lower than the selected image tier', () => {
  const settings = createDefaultSettings('google/gemini-3.1-flash-image') as any
  settings.imageSize = '4K'
  settings.sampling.maxOutputTokens = 2519
  const parsed = ImageGenerationRequestSchema.safeParse({
    prompt: 'Create a product photograph',
    model: 'google/gemini-3.1-flash-image',
    inputImages: [],
    modelImages: [],
    settings,
  })
  assert.equal(parsed.success, false)
})

test('billing refresh can preserve a multi-output row allocation', () => {
  const allocated = allocateGenerationBilling({
    inputTokens: 5,
    outputTokens: 11,
    totalTokens: 16,
    priceUsd: '0.10000000',
  }, 1, 3)
  assert.equal(allocated.inputTokens, 2)
  assert.equal(allocated.outputTokens, 4)
  assert.equal(allocated.totalTokens, 6)
  assert.equal(allocated.priceUsd, '0.03333333')
  assert.deepEqual(readGenerationAllocation(allocated.usageJson), {
    outputIndex: 1,
    outputCount: 3,
  })
})

test('multi-output token allocation keeps every row and aggregate internally consistent', () => {
  const source = {
    inputTokens: 5,
    outputTokens: 11,
    totalTokens: 16,
    cachedInputTokens: 2,
    reasoningTokens: 5,
  }
  const rows = Array.from({length: 3}, (_, index) => allocateGenerationBilling(source, index, 3))

  for (const row of rows) {
    assert.equal(row.totalTokens, (row.inputTokens ?? 0) + (row.outputTokens ?? 0))
    assert.ok((row.cachedInputTokens ?? 0) <= (row.inputTokens ?? 0))
    assert.ok((row.reasoningTokens ?? 0) <= (row.outputTokens ?? 0))
  }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens'] as const) {
    assert.equal(
      rows.reduce((sum, row) => sum + (row[key] ?? 0), 0),
      source[key],
      `${key} aggregate must be preserved`,
    )
  }
})

test('reasoning is additive only when the reported batch total proves it', () => {
  const source = {
    inputTokens: 5,
    outputTokens: 11,
    reasoningTokens: 5,
    totalTokens: 21,
  }
  const rows = Array.from({length: 3}, (_, index) => allocateGenerationBilling(source, index, 3))
  for (const row of rows) {
    assert.equal(
      row.totalTokens,
      (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + (row.reasoningTokens ?? 0),
    )
  }
  assert.equal(rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0), source.totalTokens)
})

test('generation totals prefer reported values and never double-count reasoning details', () => {
  assert.equal(resolveGenerationTotalTokens(20, 5, 11), 20)
  assert.equal(resolveGenerationTotalTokens(undefined, 5, 11), 16)
  assert.equal(resolveGenerationTotalTokens(undefined, undefined, 11), 11)
  assert.equal(resolveGenerationTotalTokens(undefined, undefined, undefined), undefined)
})

test('output Uint8Arrays become exact zero-copy Buffer views', () => {
  const backing = new Uint8Array([10, 20, 30, 40, 50])
  const window = backing.subarray(1, 4)
  const view = toBufferView(window)
  assert.deepEqual([...view], [20, 30, 40])
  window[0] = 99
  assert.equal(view[0], 99)
  view[2] = 77
  assert.equal(backing[3], 77)
})

test('multi-output price allocation preserves exact fixed-unit total', () => {
  const rows = Array.from({length: 3}, (_, index) => allocateGenerationBilling({
    priceUsd: '0.10000000',
  }, index, 3))
  assert.deepEqual(rows.map(row => row.priceUsd), [
    '0.03333334',
    '0.03333333',
    '0.03333333',
  ])
  const totalUnits = rows.reduce(
    (sum, row) => sum + Math.round(Number(row.priceUsd) * 100_000_000),
    0,
  )
  assert.equal(totalUnits, 10_000_000)
})

test('GPT mask validation applies the same PNG dimensions to every source', () => {
  const mask = {
    mimeType: 'image/png',
    bytes: 1_024,
    width: 1024,
    height: 1024,
    hasAlpha: true,
  }
  assert.equal(validateGptImageMaskPair(mask, {
    mimeType: 'image/png',
    bytes: 2_048,
    width: 1024,
    height: 1024,
  }), undefined)
  assert.match(validateGptImageMaskPair(mask, {
    mimeType: 'image/png',
    bytes: 2_048,
    width: 1536,
    height: 1024,
  }) ?? '', /every source image/)
  assert.match(validateGptImageMaskPair(mask, {
    mimeType: 'image\/jpeg',
    bytes: 2_048,
    width: 1024,
    height: 1024,
  }) ?? '', /every source image/)
})
