import {ASSET_FAVOURITES_KEY, createAssetFavourites} from '../utils/assetPreferences'

export function useAssetFavourites() {
    const account = useAccount()
    const urls = ref<string[]>([])
    const persistent = useState('asset-favourite-persistent', () => true)
    const storageKey = computed(() => `${ASSET_FAVOURITES_KEY}.${account.identity.value || 'signed-out'}`)
    const preferences = createAssetFavourites(() => window.localStorage, () => storageKey.value)
    function load() {
        const result = preferences.load()
        urls.value = result.urls
        persistent.value = result.persistent
    }
    function onStorage(event: StorageEvent) { if (event.key === storageKey.value || event.key === null) load() }
    watch(account.identity, () => { urls.value = []; if (import.meta.client && account.identity.value) load() })
    onMounted(() => { load(); window.addEventListener('storage', onStorage) })
    onBeforeUnmount(() => window.removeEventListener('storage', onStorage))
    function toggle(url: string) {
        const result = preferences.toggle(urls.value, url)
        urls.value = result.urls
        persistent.value = result.persistent
    }
    function remove(urlOrPrefix: string, directory = false) {
        const result = preferences.remove(urls.value, urlOrPrefix, directory)
        urls.value = result.urls
        persistent.value = result.persistent
    }
    return {urls, persistent, toggle, remove}
}
