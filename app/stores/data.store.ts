import {
    DEFAULT_IMAGE_MODEL_ID,
    createDefaultSettings,
    type ImageGenerationSettings,
    type ImageModelId,
} from '~~/schemas/image-generation'

export const useDataStore = defineStore('data', () => {

    let models = ref<Array<string>>([])
    let inputImages = ref<Array<string>>([])
    let selectedModel = ref<ImageModelId>(DEFAULT_IMAGE_MODEL_ID)
    let generationSettings = ref<ImageGenerationSettings>(createDefaultSettings(DEFAULT_IMAGE_MODEL_ID))
    let maskImage = ref<string | null>(null)

    return {
        models,
        inputImages,
        selectedModel,
        generationSettings,
        maskImage,
    }

})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useDataStore, import.meta.hot))
}
