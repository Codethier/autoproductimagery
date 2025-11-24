export const useDataStore = defineStore('data', () => {

    let models = ref<Array<string>>([])
    let inputImages = ref<Array<string>>([])
    // Selected Gemini model id (e.g. "gemini-2.5-flash-image-preview")
    let selectedModel = ref<string | null>(null)
    // Additional image generation config for specific models (e.g., nanoBananaPro)
    let imageConfig = reactive<{ aspectRatio?: string; imageSize?: '1K' | '2K' | '4K' }>({})



    return {
        models,
        inputImages,
        selectedModel,
        imageConfig
    }

})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useDataStore, import.meta.hot))
}