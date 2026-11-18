import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { createDefaultSettings, ImageGenerationRequestSchema } from '../schemas/image-generation.ts'
import { convertSourceToPng } from '../server/utils/generatedImageFormat.ts'
import { useGateway } from '../server/utils/useGateway.ts'

// Stored outputs default to WebP. Models that cannot take WebP, and GPT Image
// masked edits (which need every image in the mask's PNG format), receive an
// in-memory PNG; the stored object is never changed. No paid call is made.
const isPng = (data: string) => Buffer.from(data, 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const isWebp = (data: string) => Buffer.from(data, 'base64').subarray(8, 12).toString('ascii') === 'WEBP'

test('stored WebP sources are converted to PNG for masked GPT edits and for models without WebP input', async (t) => {
  const webp = await sharp({create: {width: 16, height: 16, channels: 4, background: {r: 1, g: 2, b: 3, alpha: 0.5}}}).webp().toBuffer()
  const mask = await sharp({create: {width: 16, height: 16, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}}}).png().toBuffer()
  const pngReply = mask.toString('base64')
  const stubs = {
    useRuntimeConfig: () => ({AiGatewayApiKey: 'test-only-key'}),
    useFS: async () => ({
      getImageFile: async (path: string) => path.endsWith('.png') ? {buffer: mask, mimeType: 'image/png'} : {buffer: webp, mimeType: 'image/webp'},
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
  const bodies: Array<Record<string, any>> = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/config')) return Response.json({models: []})
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    return Response.json({images: Array.from({length: body.n}, () => pngReply), warnings: [], usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2}})
  })
  const gateway = await useGateway()
  const request = (model: 'openai/gpt-image-2' | 'bfl/flux-2-pro', mask?: string) => ImageGenerationRequestSchema.parse({
    prompt: 'Change the background', model, settings: createDefaultSettings(model),
    inputImages: ['/images/output/source.webp'], modelImages: ['/images/output/style.webp'], ...(mask ? {maskImage: mask} : {}),
  })

  await gateway.generateAnyImage(request('openai/gpt-image-2', '/images/mask/edit.png'))
  let sent = bodies.at(-1)!
  assert.equal(sent.files.length, 2)
  assert.ok(sent.files.every((file: {data: string}) => isPng(file.data)), 'masked GPT sources must be PNG')
  assert.ok(isPng(sent.mask.data))

  await gateway.generateAnyImage(request('openai/gpt-image-2'))
  sent = bodies.at(-1)!
  assert.ok(sent.files.every((file: {data: string}) => isWebp(file.data)), 'unmasked GPT edits accept the stored WebP as-is')

  await gateway.generateAnyImage(request('bfl/flux-2-pro'))
  sent = bodies.at(-1)!
  assert.ok(sent.files.length > 0)
  assert.ok(sent.files.every((file: {data: string}) => isPng(file.data)), 'FLUX does not accept WebP, so sources become PNG')
})

test('source conversion keeps the pixel grid for masks and rejects non-convertible types', async () => {
  const webp = await sharp({create: {width: 20, height: 12, channels: 4, background: {r: 9, g: 9, b: 9, alpha: 0.25}}}).webp().toBuffer()
  const png = await convertSourceToPng(webp, 'image/webp', {preserveGeometry: true})
  assert.ok(png)
  const metadata = await sharp(png).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.width, 20)
  assert.equal(metadata.height, 12)
  assert.equal(metadata.hasAlpha, true)
  assert.equal(await convertSourceToPng(webp, 'image/avif', {preserveGeometry: true}), undefined)
  assert.equal(await convertSourceToPng(Buffer.from('broken'), 'image/webp', {preserveGeometry: false}), undefined)
})
