import {ASSET_FAVOURITES_KEY, createAssetFavourites} from '../utils/assetPreferences'

export function useAssetFavourites() {
    const urls = useState<string[]>('asset-favourite-urls', () => [])
    const persistent = useState('asset-favourite-persistent', () => true)
    const preferences = createAssetFavourites(() => window.localStorage)
    function load() {
        const result = preferences.load()
        urls.value = result.urls
        persistent.value = result.persistent
    }
    function onStorage(event: StorageEvent) { if (event.key === ASSET_FAVOURITES_KEY || event.key === null) load() }
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
