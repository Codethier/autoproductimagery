import assert from 'node:assert/strict'
import test from 'node:test'
import { buildComposerRequest, composerSources, imageName } from '../app/utils/generationComposer.ts'
import { IMAGE_MODEL_PROFILES, SUPPORTED_IMAGE_MODEL_IDS, createDefaultSettings } from '../schemas/image-generation.ts'

const base = {
  mode: 'edit' as const,
  editSource: '/images/Products/product.png',
  batchInputs: ['/images/Products/first.png', '/images/Products/second.png'],
  prompt: '  Place the product on a marble table  ',
  model: 'google/gemini-3.1-flash-image' as const,
  settings: createDefaultSettings('google/gemini-3.1-flash-image'),
  sharedReferences: ['/images/References/lighting.png'],
  maskImage: null,
}

test('Edit submits exactly its own source while the batch selection remains intact', () => {
  const inputs = [...base.batchInputs]
  const request = buildComposerRequest({ ...base, batchInputs: inputs })
  assert.deepEqual(request.inputImages, [base.editSource])
  assert.deepEqual(request.modelImages, base.sharedReferences)
  assert.equal(request.prompt, 'Place the product on a marble table')
  assert.equal(request.storeInputImages, true)
  assert.deepEqual(inputs, base.batchInputs)
  request.inputImages.splice(0)
  request.modelImages.splice(0)
  assert.deepEqual(inputs, base.batchInputs)
  assert.equal(base.sharedReferences.length, 1)
})

test('Same-origin batch sends each input once with one shared prompt and reference list', () => {
  const request = buildComposerRequest({ ...base, mode: 'batch' })
  assert.deepEqual(request.inputImages, base.batchInputs)
  assert.deepEqual(request.modelImages, base.sharedReferences)
  assert.equal(request.inputImages.length, 2, 'references never multiply the input jobs')
  assert.equal(request.prompt, 'Place the product on a marble table')
  assert.deepEqual(composerSources('edit', base.editSource, base.batchInputs), [base.editSource])
  assert.deepEqual(composerSources('batch', null, base.batchInputs), base.batchInputs)
})

test('Same-origin batch accepts fifty independent one-output inputs, enforcing total outputs and reference limits', () => {
  const batchInputs = Array.from({length: 50}, (_, index) => `/images/product-${index}.png`)
  const request = buildComposerRequest({...base, mode: 'batch', batchInputs})
  assert.deepEqual(request.inputImages, batchInputs)
  assert.throws(() => buildComposerRequest({...base, mode: 'batch', batchInputs: [...batchInputs, '/images/extra.png']}))
  assert.throws(() => buildComposerRequest({...base, mode: 'batch', batchInputs, model: 'openai/gpt-image-2', settings: {...createDefaultSettings('openai/gpt-image-2'), numberOfImages: 2}}))
  assert.throws(() => buildComposerRequest({...base, mode: 'batch', batchInputs, sharedReferences: Array.from({length: 16}, (_, index) => `/images/ref-${index}.png`)}), /reference images/)
})

test('both workspaces require a source and never borrow the other workspace selection', () => {
  assert.throws(() => buildComposerRequest({ ...base, editSource: null }), /Choose an image to edit/)
  assert.throws(() => buildComposerRequest({ ...base, mode: 'batch', batchInputs: [] }), /Choose at least one input/)
})

test('all current exact-ID model profiles keep normalized settings in both workspaces', () => {
  for (const model of SUPPORTED_IMAGE_MODEL_IDS) {
    const profile = IMAGE_MODEL_PROFILES[model]
    for (const mode of ['edit', 'batch'] as const) {
      const request = buildComposerRequest({ ...base, mode, model, settings: createDefaultSettings(model),
        sharedReferences: profile.maxReferenceImages > 1 ? base.sharedReferences : [],
        maskImage: profile.requiresMask ? '/images/Masks/edit.png' : null })
      assert.equal(request.model, model)
      assert.equal(request.settings.kind, profile.settingsKind)
      assert.deepEqual(request.settings, createDefaultSettings(model))
      assert.equal(request.maskImage, profile.requiresMask ? '/images/Masks/edit.png' : undefined)
    }
  }
})

test('the composer blocks stale settings, too many references, and masks unsupported by a model', () => {
  assert.throws(() => buildComposerRequest({ ...base, model: 'openai/gpt-image-2' }), /does not belong/)
  assert.throws(() => buildComposerRequest({ ...base, sharedReferences: Array.from({ length: 16 }, (_, i) => `/images/reference-${i}.png`) }), /at most 14 reference/)
  const model = SUPPORTED_IMAGE_MODEL_IDS.find(id => !IMAGE_MODEL_PROFILES[id].supportsMask)!
  assert.throws(() => buildComposerRequest({ ...base, model, settings: createDefaultSettings(model), maskImage: '/images/mask.png' }), /does not support masks/)
})

test('PNG mask preflight covers all batch sources while Edit validates only its own source', () => {
  const masked = { ...base, model: 'openai/gpt-image-2' as const, settings: createDefaultSettings('openai/gpt-image-2'),
    maskImage: '/images/mask.png', batchInputs: ['/images/first.png', '/images/second.jpg'] }
  assert.deepEqual(buildComposerRequest(masked).inputImages, [base.editSource])
  assert.throws(() => buildComposerRequest({ ...masked, mode: 'batch' }), /PNG/)
  assert.throws(() => buildComposerRequest({ ...masked, maskImage: '/images/mask.jpg' }), /PNG/)
})

test('image names decode escaped characters without exposing malformed URL exceptions', () => {
  assert.equal(imageName('/images/Product%20%23one.png'), 'Product #one.png')
  assert.equal(imageName('/images/%broken.png'), '%broken.png')
})
