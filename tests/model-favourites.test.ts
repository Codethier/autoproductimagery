import assert from 'node:assert/strict'
import test from 'node:test'
import { createImageModelFavourites, IMAGE_MODEL_FAVOURITES_KEY, parseFavouriteModels } from '../app/utils/imageModelFavourites.ts'
import { IMAGE_MODEL_ADDED_IN_PASS, isNewImageModel, orderImageModels } from '../schemas/image-model-discovery.ts'
import { SUPPORTED_IMAGE_MODEL_IDS, type ImageModelId } from '../schemas/image-generation.ts'

test('the latest addition pass marks only the 22 models added to the application', () => {
  assert.equal(SUPPORTED_IMAGE_MODEL_IDS.filter(isNewImageModel).length, 22)
  assert.equal(isNewImageModel('openai/gpt-image-1'), true, 'an older provider release can be newly added to the app')
  assert.equal(isNewImageModel('google/gemini-3.1-flash-image'), false)
  assert.equal(isNewImageModel('openai/gpt-image-2'), false)
  for (const id of Object.keys(IMAGE_MODEL_ADDED_IN_PASS)) assert.ok(SUPPORTED_IMAGE_MODEL_IDS.includes(id as ImageModelId))
})

test('favourites precede new models and remaining models, with stable order and no duplicates', () => {
  const ids: ImageModelId[] = ['google/gemini-3.1-flash-image', 'openai/gpt-image-2.5-sunburst', 'bfl/flux-2-pro', 'openai/gpt-image-2']
  const original = [...ids]
  assert.deepEqual(orderImageModels(ids, []), ['openai/gpt-image-2.5-sunburst', 'bfl/flux-2-pro', 'google/gemini-3.1-flash-image', 'openai/gpt-image-2'])
  assert.deepEqual(orderImageModels(ids, ['openai/gpt-image-2', 'bfl/flux-2-pro']), ['bfl/flux-2-pro', 'openai/gpt-image-2', 'openai/gpt-image-2.5-sunburst', 'google/gemini-3.1-flash-image'])
  assert.deepEqual(ids, original, 'sorting must not mutate the shared catalog')
  const ordered = orderImageModels(SUPPORTED_IMAGE_MODEL_IDS, ['google/gemini-3.1-flash-image'])
  assert.equal(ordered[0], 'google/gemini-3.1-flash-image')
  assert.equal(new Set(ordered).size, SUPPORTED_IMAGE_MODEL_IDS.length)
})

test('heart toggles persist across reloads and unpinning restores normal priority', () => {
  const saved = new Map<string, string>()
  const storage = {getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) }}
  const firstVisit = createImageModelFavourites(() => storage)
  const favourite: ImageModelId = 'google/gemini-2.5-flash-image'
  const added = firstVisit.toggle(firstVisit.load().ids, favourite)
  assert.deepEqual(added, {ids: [favourite], persistent: true})
  assert.equal(saved.get(IMAGE_MODEL_FAVOURITES_KEY), JSON.stringify([favourite]))
  const reload = createImageModelFavourites(() => storage)
  assert.deepEqual(reload.load().ids, [favourite])
  assert.equal(orderImageModels(SUPPORTED_IMAGE_MODEL_IDS, reload.load().ids)[0], favourite)
  const removed = reload.toggle(reload.load().ids, favourite)
  assert.deepEqual(removed.ids, [])
  assert.deepEqual(firstVisit.load().ids, [])
  assert.ok(isNewImageModel(orderImageModels(SUPPORTED_IMAGE_MODEL_IDS, removed.ids)[0]!))
})

test('invalid storage cannot introduce unknown models, duplicates or unbounded data', () => {
  for (const raw of [null, '', '{', '{}', 'true', 'x'.repeat(16_385)]) assert.deepEqual(parseFavouriteModels(raw), [])
  assert.deepEqual(parseFavouriteModels(JSON.stringify(['bfl/flux-2-pro', 'unknown/model', 'bfl/flux-2-pro', null, {}, 1])), ['bfl/flux-2-pro'])
})

test('blocked browser storage keeps heart toggles usable for the current visit', () => {
  const blocked = createImageModelFavourites(() => { throw new Error('Storage blocked') })
  assert.deepEqual(blocked.load(), {ids: [], persistent: false})
  const added = blocked.toggle([], 'meta/muse-image-1.0')
  assert.deepEqual(added, {ids: ['meta/muse-image-1.0'], persistent: false})
  assert.deepEqual(blocked.toggle(added.ids, 'meta/muse-image-1.0'), {ids: [], persistent: false})
  const quotaExceeded = createImageModelFavourites(() => ({getItem: () => '[]', setItem: () => { throw new Error('Quota exceeded') }}))
  assert.equal(quotaExceeded.toggle([], 'meta/muse-image-1.0').persistent, false)
})
