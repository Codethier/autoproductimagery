import type { ImageModelId } from './image-generation'

export const LATEST_IMAGE_MODEL_ADDITION_PASS = '2026-09-09'

// Explicit application additions, independent of provider release dates and lifecycle.
// On the next pass, retain this history and update the latest pass and its new IDs.
export const IMAGE_MODEL_ADDED_IN_PASS: Partial<Record<ImageModelId, string>> = {
  'openai/gpt-image-2.5-sunburst': '2026-09-09',
  'openai/gpt-image-2.5-flare': '2026-09-09',
  'openai/gpt-image-1': '2026-09-09',
  'openai/gpt-image-1-mini': '2026-09-09',
  'openai/gpt-image-1.5': '2026-09-09',
  'bfl/flux-2-flex': '2026-09-09',
  'bfl/flux-2-klein-4b': '2026-09-09',
  'bfl/flux-2-klein-9b': '2026-09-09',
  'bfl/flux-2-max': '2026-09-09',
  'bfl/flux-2-pro': '2026-09-09',
  'bfl/flux-kontext-max': '2026-09-09',
  'bfl/flux-kontext-pro': '2026-09-09',
  'bfl/flux-pro-1.0-fill': '2026-09-09',
  'bfl/flux-pro-1.1': '2026-09-09',
  'bfl/flux-pro-1.1-ultra': '2026-09-09',
  'bytedance/seedream-4.0': '2026-09-09',
  'bytedance/seedream-4.5': '2026-09-09',
  'bytedance/seedream-5.0-lite': '2026-09-09',
  'bytedance/seedream-5.0-pro': '2026-09-09',
  'meta/muse-image-1.0': '2026-09-09',
  'spacexai/grok-imagine-image': '2026-09-09',
  'spacexai/grok-imagine-image-2.0': '2026-09-09',
}

export function isNewImageModel(id: ImageModelId): boolean {
  return IMAGE_MODEL_ADDED_IN_PASS[id] === LATEST_IMAGE_MODEL_ADDITION_PASS
}

export function orderImageModels(ids: readonly ImageModelId[], favourites: readonly ImageModelId[]): ImageModelId[] {
  const favouriteSet = new Set(favourites)
  // Stable sorting preserves curated order within each group, including favourites.
  const priority = (id: ImageModelId) => favouriteSet.has(id) ? 0 : isNewImageModel(id) ? 1 : 2
  return [...ids].sort((left, right) => priority(left) - priority(right))
}
