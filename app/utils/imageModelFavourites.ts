import { ImageModelIdSchema, type ImageModelId } from '../../schemas/image-generation'

export const IMAGE_MODEL_FAVOURITES_KEY = 'autoproductimagery.image-model-favourites.v1'
type FavouriteStorage = Pick<Storage, 'getItem' | 'setItem'>

export function parseFavouriteModels(raw: string | null): ImageModelId[] {
  if (!raw || raw.length > 16_384) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.flatMap(id => {
      const model = ImageModelIdSchema.safeParse(id)
      return model.success ? [model.data] : []
    }))]
  } catch {
    return []
  }
}

export function createImageModelFavourites(getStorage: () => FavouriteStorage) {
  return {
    load(): {ids: ImageModelId[]; persistent: boolean} {
      try {
        return {ids: parseFavouriteModels(getStorage().getItem(IMAGE_MODEL_FAVOURITES_KEY)), persistent: true}
      } catch {
        return {ids: [], persistent: false}
      }
    },
    toggle(ids: readonly ImageModelId[], id: ImageModelId): {ids: ImageModelId[]; persistent: boolean} {
      const next = ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]
      try {
        getStorage().setItem(IMAGE_MODEL_FAVOURITES_KEY, JSON.stringify(next))
        return {ids: next, persistent: true}
      } catch {
        return {ids: next, persistent: false}
      }
    },
  }
}
