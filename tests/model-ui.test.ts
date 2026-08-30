import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  IMAGE_MODEL_PROFILES,
  ImageGenerationRequestSchema,
  SUPPORTED_IMAGE_MODEL_IDS,
  createDefaultSettings,
} from '../schemas/image-generation.ts'
import { settleWithinMs } from '../server/utils/gatewayTimeout.ts'
import {
  createGatewayMetadataLookupPool,
  sanitizeProviderMetadata,
} from '../server/utils/gatewayMetadata.ts'

test('Gemini 3.1 Flash accepts image-search-only grounding', () => {
  const settings = {
    ...createDefaultSettings('google/gemini-3.1-flash-image'),
    grounding: 'images' as const,
  }
  const parsed = ImageGenerationRequestSchema.parse({
    prompt: 'Create a clean product photograph',
    model: 'google/gemini-3.1-flash-image',
    settings,
  })

  assert.equal(parsed.settings.kind, 'gemini-3.1-flash-image')
  assert.equal(parsed.settings.grounding, 'images')
})

test('every curated profile explicitly limits references to images', () => {
  for (const id of SUPPORTED_IMAGE_MODEL_IDS) {
    const profile = IMAGE_MODEL_PROFILES[id]
    assert.deepEqual(profile.referenceInputs, ['image'])
    assert.ok(profile.warnings.some(warning => warning.includes('image files only')))
  }
})

test('model defaults keep their model-specific discriminant', () => {
  for (const id of SUPPORTED_IMAGE_MODEL_IDS) {
    const settings = createDefaultSettings(id)
    const expectedKind = id === 'openai/gpt-image-2'
      ? 'openai-gpt-image-2'
      : id.slice('google/'.length)
    assert.equal(settings.kind, expectedKind)
  }
})

test('Gateway metadata lookups cannot hold generation capacity indefinitely', async () => {
  await assert.rejects(
    settleWithinMs(new Promise<never>(() => undefined), 10, 'test lookup'),
    (error: unknown) => error instanceof Error
      && error.name === 'GatewayMetadataTimeoutError'
      && error.message.includes('10 ms'),
  )
})

test('non-abortable Gateway metadata work is deduplicated and concurrency-bounded', () => {
  const pool = createGatewayMetadataLookupPool(1)
  const unresolved = new Promise<never>(() => undefined)
  const first = pool.start('catalog', () => unresolved)
  const duplicate = pool.start('catalog', () => Promise.resolve('should not run'))
  const rejectedByCapacity = pool.start('another-generation', () => Promise.resolve('no'))

  assert.equal(first, duplicate)
  assert.equal(rejectedByCapacity, undefined)
  assert.equal(pool.activeCount(), 1)
  assert.equal(pool.inFlightCount(), 1)
})

test('stored provider metadata is redacted and hard-size-bounded', () => {
  const redacted = sanitizeProviderMetadata({
    apiKey: 'super-secret',
    authorization: 'Bearer secret-token',
    image: Buffer.from('binary'),
  }) as Record<string, unknown>
  assert.equal(redacted.apiKey, '[REDACTED]')
  assert.equal(redacted.authorization, '[REDACTED]')
  assert.equal(redacted.image, '[REDACTED_BINARY]')

  const bounded = sanitizeProviderMetadata({payload: 'x'.repeat(100_000)}, 512) as Record<string, unknown>
  assert.equal(bounded.truncated, true)
  assert.equal(typeof bounded.sanitizedBytes, 'number')
})

test('mask preflight and replay UI preserve every source and stored settings', () => {
  const formSource = readFileSync(new URL('../app/components/GeminiForm.vue', import.meta.url), 'utf8')
  const historyCardSource = readFileSync(new URL('../app/components/systemPromp.vue', import.meta.url), 'utf8')

  assert.match(formSource, /maskSources[\s\S]*data\.inputImages\.length > 0[\s\S]*data\.inputImages/)
  assert.match(historyCardSource, /const replayMask = replayInputs\.length > 0 \|\| modelImages\.length > 0/)
  assert.match(historyCardSource, /settings:\s*config\.settings/)
  assert.match(historyCardSource, /loadOutputDetails/)
})
