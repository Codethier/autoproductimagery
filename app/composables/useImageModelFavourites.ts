import { computed, inject, onMounted, onUnmounted, ref, watch, type ComputedRef } from 'vue'
import type { ImageModelId } from '../../schemas/image-generation'
import { createImageModelFavourites, IMAGE_MODEL_FAVOURITES_KEY } from '../utils/imageModelFavourites'

export function useImageModelFavourites() {
  const favouriteModelIds = ref<ImageModelId[]>([])
  const persistent = ref(true)
  const ready = ref(false)
  // Resolve browser storage only after mount or a user action; SSR never reads it.
  const identity = inject<ComputedRef<string> | undefined>('workspace-account-identity', undefined)
  const storageKey = computed(() => `${IMAGE_MODEL_FAVOURITES_KEY}.${identity?.value || 'signed-out'}`)
  const storage = createImageModelFavourites(() => window.localStorage, () => storageKey.value)
  const favouriteSet = computed(() => new Set(favouriteModelIds.value))

  function load() {
    const result = storage.load()
    favouriteModelIds.value = result.ids
    persistent.value = result.persistent
  }
  function onStorage(event: StorageEvent) {
    if (event.key === storageKey.value || event.key === null) load()
  }
  watch(storageKey, () => { favouriteModelIds.value = []; if (ready.value) load() })
  onMounted(() => {
    load()
    ready.value = true
    window.addEventListener('storage', onStorage)
  })
  onUnmounted(() => {
    if (ready.value) window.removeEventListener('storage', onStorage)
  })

  function toggleFavourite(id: ImageModelId) {
    if (!ready.value) return
    const result = storage.toggle(favouriteModelIds.value, id)
    favouriteModelIds.value = result.ids
    persistent.value = result.persistent
  }
  return {favouriteModelIds, favouriteSet, persistent, ready, toggleFavourite}
}
