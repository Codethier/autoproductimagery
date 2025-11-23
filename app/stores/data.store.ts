export const useDataStore = defineStore('data', () => {

    let models = ref<Array<string>>([])
    let inputImages = ref<Array<string>>([])
    // Selected Gemini model id (e.g. "gemini-2.5-flash-image-preview")
    let selectedModel = ref<string | null>(null)



    return {
        models,
        inputImages,
        selectedModel
    }

})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useDataStore, import.meta.hot))
}