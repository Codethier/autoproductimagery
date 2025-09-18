export const useDataStore = defineStore('data', () => {

    let models = ref<Array<string>>([])
    let inputImages = ref<Array<string>>([])



    return {
        models,inputImages
    }

})

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useDataStore, import.meta.hot))
}