import {
    DEFAULT_IMAGE_MODEL_ID,
    createDefaultSettings,
    type ImageGenerationSettings,
    type ImageModelId,
} from '~~/schemas/image-generation'
import type { PendingGeneration } from '../utils/generationComposer'

export const useDataStore = defineStore('data', () => {

    let models = ref<Array<string>>([])
    let inputImages = ref<Array<string>>([])
    // The one-image editor and the batch keep independent source selections.
    let editSource = ref<string | null>(null)
    let composerPrompt = ref('')
    // Route changes must retain the paid request's progress and submit guard.
    let pendingGenerations = ref<PendingGeneration[]>([])
    let selectedModel = ref<ImageModelId>(DEFAULT_IMAGE_MODEL_ID)
    let generationSettings = ref<ImageGenerationSettings>(createDefaultSettings(DEFAULT_IMAGE_MODEL_ID))
    let maskImage = ref<string | null>(null)

    return {
        models,
        inputImages,
        editSource,
        composerPrompt,
        pendingGenerations,
        selectedModel,
        generationSettings,
        maskImage,
    }

})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useDataStore, import.meta.hot))
}
