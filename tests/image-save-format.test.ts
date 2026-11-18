import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import {
  DEFAULT_IMAGE_SAVE_FORMAT,
  ImageGenerationRequestSchema,
  StoredGenerationConfigSchema,
  createDefaultSettings,
} from '../schemas/image-generation.ts'
import {PipelineNodeSchema, createPipelineNode} from '../schemas/pipelines.ts'
import {prepareOutputForStorage} from '../server/utils/generatedImageFormat.ts'
import {inspectDecodedImage} from '../server/utils/imageValidation.ts'
import {createImageSaveFormatPreference, parseImageSaveFormat, replaySaveFormat} from '../app/utils/imageSaveFormat.ts'
import {buildComposerRequest} from '../app/utils/generationComposer.ts'

const raster = (format: 'jpeg' | 'webp' | 'png', alpha = false) => sharp({create: {width: 24, height: 16, channels: alpha ? 4 : 3,
  background: alpha ? {r: 200, g: 30, b: 30, alpha: 0.5} : {r: 200, g: 30, b: 30}}})[format]().toBuffer()

test('generation requests default to WebP storage and accept PNG or keep-original overrides', () => {
  const base = {prompt: 'Product photo', model: 'openai/gpt-image-2' as const, settings: createDefaultSettings('openai/gpt-image-2')}
  assert.equal(DEFAULT_IMAGE_SAVE_FORMAT, 'webp')
  assert.equal(ImageGenerationRequestSchema.parse(base).saveFormat, 'webp')
  assert.equal(ImageGenerationRequestSchema.parse({...base, saveFormat: 'png'}).saveFormat, 'png')
  assert.equal(ImageGenerationRequestSchema.parse({...base, saveFormat: 'original'}).saveFormat, 'original')
  assert.equal(ImageGenerationRequestSchema.safeParse({...base, saveFormat: 'jpeg'}).success, false)
})

test('stored configs keep the save format, and legacy configs without it replay as original', () => {
  const config = {schemaVersion: 1, profileVersion: 1, requestedModel: 'openai/gpt-image-2', effectiveModel: 'openai/gpt-image-2',
    settings: createDefaultSettings('openai/gpt-image-2'), storeInputImages: true}
  const legacy = StoredGenerationConfigSchema.parse(config)
  assert.equal(legacy.saveFormat, undefined)
  assert.equal(replaySaveFormat(legacy.saveFormat), 'original')
  assert.equal(replaySaveFormat(StoredGenerationConfigSchema.parse({...config, saveFormat: 'png'}).saveFormat), 'png')
  assert.equal(StoredGenerationConfigSchema.safeParse({...config, saveFormat: 'jpeg'}).success, false)
})

test('JPEG and WebP provider outputs are stored as decodable PNG with their dimensions and alpha', async () => {
  for (const [format, mimeType] of [['jpeg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
    const source = await raster(format, format === 'webp')
    const stored = await prepareOutputForStorage(source, mimeType, 'png')
    assert.equal(stored.mimeType, 'image/png')
    assert.deepEqual(stored.converted, {providerMimeType: mimeType, providerBytes: source.byteLength})
    assert.equal(stored.warning, undefined)
    const inspection = await inspectDecodedImage(stored.buffer, true)
    assert.equal(inspection.mimeType, 'image/png')
    assert.equal(inspection.width, 24)
    assert.equal(inspection.height, 16)
    if (format === 'webp') assert.equal((await sharp(stored.buffer).metadata()).hasAlpha, true)
  }
})

test('PNG and JPEG provider outputs are stored as WebP by default, keeping dimensions and alpha', async () => {
  for (const [format, mimeType, alpha] of [['png', 'image/png', true], ['jpeg', 'image/jpeg', false]] as const) {
    const source = await raster(format, alpha)
    const stored = await prepareOutputForStorage(source, mimeType, DEFAULT_IMAGE_SAVE_FORMAT)
    assert.equal(stored.mimeType, 'image/webp')
    assert.deepEqual(stored.converted, {providerMimeType: mimeType, providerBytes: source.byteLength})
    const inspection = await inspectDecodedImage(stored.buffer, true)
    assert.equal(inspection.mimeType, 'image/webp')
    assert.equal(inspection.width, 24)
    assert.equal(inspection.height, 16)
    assert.equal((await sharp(stored.buffer).metadata()).hasAlpha, alpha)
  }
  const webp = await raster('webp', true)
  const unchanged = await prepareOutputForStorage(webp, 'image/png', 'webp')
  assert.equal(unchanged.buffer, webp)
  assert.equal(unchanged.mimeType, 'image/webp')
  assert.equal(unchanged.converted, undefined)
})

test('PNG outputs, the keep-original override and unrecognised payloads keep the exact provider bytes', async () => {
  const png = await raster('png', true)
  const pngStored = await prepareOutputForStorage(png, 'image/webp', 'png')
  assert.equal(pngStored.buffer, png)
  assert.equal(pngStored.mimeType, 'image/png')
  assert.equal(pngStored.converted, undefined)
  const jpeg = await raster('jpeg')
  const original = await prepareOutputForStorage(jpeg, 'image/jpeg', 'original')
  assert.equal(original.buffer, jpeg)
  assert.equal(original.mimeType, 'image/jpeg')
  assert.equal(original.converted, undefined)
  const unknown = Buffer.from('not an image')
  for (const target of ['webp', 'png'] as const) {
    const passthrough = await prepareOutputForStorage(unknown, 'image/png', target)
    assert.equal(passthrough.buffer, unknown)
    assert.equal(passthrough.converted, undefined)
  }
})

test('a corrupt non-PNG output is kept with a warning instead of discarding the paid image', async () => {
  const truncated = (await raster('jpeg')).subarray(0, 40)
  for (const [target, label] of [['webp', 'WebP'], ['png', 'PNG']] as const) {
    const stored = await prepareOutputForStorage(truncated, 'image/jpeg', target)
    assert.equal(stored.buffer, truncated)
    assert.equal(stored.mimeType, 'image/jpeg')
    assert.ok((stored.warning ?? '').includes('could not be converted to ' + label))
  }
})

test('pipeline generative nodes default to WebP storage and validate the override', () => {
  for (const type of ['generate-image', 'upscale', 'expand', 'translate'] as const) {
    const node = createPipelineNode(type, `node-${type}`)
    assert.equal((node.config as {saveFormat: string}).saveFormat, 'webp')
    const {saveFormat: _omitted, ...legacyConfig} = node.config as Record<string, unknown>
    assert.equal((PipelineNodeSchema.parse({...node, config: legacyConfig}).config as {saveFormat: string}).saveFormat, 'webp')
    assert.equal((PipelineNodeSchema.parse({...node, config: {...node.config, saveFormat: 'original'}}).config as {saveFormat: string}).saveFormat, 'original')
    assert.equal((PipelineNodeSchema.parse({...node, config: {...node.config, saveFormat: 'png'}}).config as {saveFormat: string}).saveFormat, 'png')
    assert.equal(PipelineNodeSchema.safeParse({...node, config: {...node.config, saveFormat: 'jpeg'}}).success, false)
  }
})

test('composer requests carry the chosen save format and default to WebP', () => {
  const options = {mode: 'edit' as const, editSource: '/images/input/a.png', batchInputs: [], prompt: 'Edit', model: 'openai/gpt-image-2' as const,
    settings: createDefaultSettings('openai/gpt-image-2'), sharedReferences: [], maskImage: null}
  assert.equal(buildComposerRequest(options).saveFormat, 'webp')
  assert.equal(buildComposerRequest({...options, saveFormat: 'original'}).saveFormat, 'original')
})

test('the save-format preference is per key, validated and safe when storage fails', () => {
  const values = new Map<string, string>()
  const storage = {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }}
  const alice = createImageSaveFormatPreference(() => storage, () => 'pref.alice')
  const bob = createImageSaveFormatPreference(() => storage, () => 'pref.bob')
  assert.equal(alice.load(), 'webp')
  assert.equal(alice.save('original'), true)
  assert.equal(alice.load(), 'original')
  assert.equal(bob.load(), 'webp')
  assert.equal(bob.save('png'), true)
  assert.equal(bob.load(), 'png')
  values.set('pref.bob', 'jpeg')
  assert.equal(bob.load(), 'webp')
  assert.equal(parseImageSaveFormat(null), 'webp')
  const broken = createImageSaveFormatPreference(() => { throw new Error('blocked') })
  assert.equal(broken.load(), 'webp')
  assert.equal(broken.save('original'), false)
})
