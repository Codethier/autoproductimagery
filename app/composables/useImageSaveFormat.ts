import { computed, inject, onMounted, onUnmounted, ref, watch, type ComputedRef } from 'vue'
import { DEFAULT_IMAGE_SAVE_FORMAT, type ImageSaveFormat } from '../../schemas/image-generation'
import { createImageSaveFormatPreference, IMAGE_SAVE_FORMAT_KEY } from '../utils/imageSaveFormat'

/** Per-account browser preference; WebP unless the user chose PNG or the original format. */
export function useImageSaveFormat() {
  const saveFormat = ref<ImageSaveFormat>(DEFAULT_IMAGE_SAVE_FORMAT)
  const ready = ref(false)
  const identity = inject<ComputedRef<string> | undefined>('workspace-account-identity', undefined)
  const storageKey = computed(() => `${IMAGE_SAVE_FORMAT_KEY}.${identity?.value || 'signed-out'}`)
  const preference = createImageSaveFormatPreference(() => window.localStorage, () => storageKey.value)
  function load() { saveFormat.value = preference.load() }
  function onStorage(event: StorageEvent) { if (event.key === storageKey.value || event.key === null) load() }
  watch(storageKey, () => { saveFormat.value = DEFAULT_IMAGE_SAVE_FORMAT; if (ready.value) load() })
  onMounted(() => { load(); ready.value = true; window.addEventListener('storage', onStorage) })
  onUnmounted(() => { if (ready.value) window.removeEventListener('storage', onStorage) })
  function setSaveFormat(value: ImageSaveFormat) {
    saveFormat.value = value
    if (ready.value) preference.save(value)
  }
  return {saveFormat, setSaveFormat}
}
