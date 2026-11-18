import { DEFAULT_IMAGE_SAVE_FORMAT, ImageSaveFormatSchema, type ImageSaveFormat } from '../../schemas/image-generation'

export const IMAGE_SAVE_FORMAT_KEY = 'autoproductimagery.image-save-format.v1'
type SaveFormatStorage = Pick<Storage, 'getItem' | 'setItem'>

export function parseImageSaveFormat(raw: string | null | undefined): ImageSaveFormat {
  const parsed = ImageSaveFormatSchema.safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_IMAGE_SAVE_FORMAT
}

/** Generations stored before PNG storage existed kept the provider bytes. */
export function replaySaveFormat(stored: ImageSaveFormat | undefined): ImageSaveFormat {
  return stored ?? 'original'
}

export function createImageSaveFormatPreference(getStorage: () => SaveFormatStorage, getKey: () => string = () => IMAGE_SAVE_FORMAT_KEY) {
  return {
    load(): ImageSaveFormat {
      try { return parseImageSaveFormat(getStorage().getItem(getKey())) } catch { return DEFAULT_IMAGE_SAVE_FORMAT }
    },
    save(value: ImageSaveFormat): boolean {
      try { getStorage().setItem(getKey(), parseImageSaveFormat(value)); return true } catch { return false }
    },
  }
}
