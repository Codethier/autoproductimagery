export const useDataStore = defineStore('data', () => {

    let models = ref<Array<string>>([])
    let isModelSelection = ref<boolean>(false)
    let inputImages = ref<Array<string>>([])
    let isInputImageSelection = ref<boolean>(false)



    return {
        models,isModelSelection,inputImages,isInputImageSelection
    }

})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useDataStore, import.meta.hot))
}