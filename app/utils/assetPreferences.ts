import type {AssetFile} from '../../schemas/image-storage'

export const ASSET_FAVOURITES_KEY = 'autoproductimagery.asset-favourites.v1'
export const MAX_ASSET_FAVOURITES = 200
const SUPPORTED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic'])
const INVALID_SEGMENT = /[\\/:*?"<>|%\x00-\x1f\x7f]/

// Browser preferences may be edited manually. Never turn them into remote URLs
// or accept a second encoding layer that the authenticated server rejects.
export function assetFromImageUrl(url: unknown): AssetFile | undefined {
    if (typeof url !== 'string' || url.length > 4096 || !url.startsWith('/images/') || /[?#\\\x00-\x1f\x7f]/.test(url)) return undefined
    try {
        const encoded = url.slice('/images/'.length).split('/')
        if (!encoded.length || encoded.length > 64) return undefined
        const parts = encoded.map(segment => decodeURIComponent(segment))
        if (parts.some(segment => !segment || segment.length > 255 || segment !== segment.trim() || segment.endsWith('.')
            || segment === '.' || segment === '..' || INVALID_SEGMENT.test(segment)
            || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(segment)
            || ['__proto__', 'prototype', 'constructor'].includes(segment.toLowerCase()))) return undefined
        if (`/images/${parts.map(encodeURIComponent).join('/')}` !== url) return undefined
        const name = parts.at(-1)!
        if (!SUPPORTED_EXTENSIONS.has(name.split('.').at(-1)!.toLowerCase())) return undefined
        return {name, url, folder: parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/', selectedImage: false, selectedModel: false, selectedMask: false}
    } catch { return undefined }
}

export function parseAssetFavourites(raw: string | null): string[] {
    if (!raw || raw.length > 1_048_576) return []
    try {
        const value: unknown = JSON.parse(raw)
        if (!Array.isArray(value)) return []
        const urls = new Set<string>()
        for (const item of value) {
            const asset = assetFromImageUrl(item)
            if (asset) urls.add(asset.url)
            if (urls.size >= MAX_ASSET_FAVOURITES) break
        }
        return [...urls]
    } catch { return [] }
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>
export function createAssetFavourites(getStorage: () => PreferenceStorage, getKey: () => string = () => ASSET_FAVOURITES_KEY) {
    function save(urls: string[]) {
        try { getStorage().setItem(getKey(), JSON.stringify(urls)); return {urls, persistent: true} }
        catch { return {urls, persistent: false} }
    }
    return {
        load() {
            try { return {urls: parseAssetFavourites(getStorage().getItem(getKey())), persistent: true} }
            catch { return {urls: [] as string[], persistent: false} }
        },
        toggle(current: readonly string[], url: string) {
            const valid = parseAssetFavourites(JSON.stringify(current))
            if (!assetFromImageUrl(url)) return {urls: valid, persistent: true}
            return save(valid.includes(url) ? valid.filter(item => item !== url)
                : valid.length < MAX_ASSET_FAVOURITES ? [...valid, url] : valid)
        },
        remove(current: readonly string[], urlOrPrefix: string, directory = false) {
            return save(current.filter(url => directory ? !url.startsWith(urlOrPrefix) : url !== urlOrPrefix))
        },
    }
}

export function toggleAssetSelection(current: readonly string[], url: string, mode: 'single' | 'multiple'): string[] {
    const valid = [...new Set(current.filter(item => assetFromImageUrl(item)))]
    if (!assetFromImageUrl(url)) return valid
    if (valid.includes(url)) return valid.filter(item => item !== url)
    return mode === 'single' ? [url] : [...valid, url]
}

export function assetSelectionLimit(mode?: 'single' | 'multiple', requested?: number): number {
    const maximum = mode === 'single' ? 1 : 20
    if (requested === undefined) return maximum
    // An explicitly zero limit is how model profiles prohibit extra sources.
    return Number.isInteger(requested) && requested >= 0 ? Math.min(maximum, requested) : 0
}

export function validateAssetUploads(files: readonly Pick<File, 'name' | 'size' | 'type'>[]): string | undefined {
    if (!files.length) return 'Choose at least one image.'
    if (files.length > 20) return 'Upload up to 20 images at a time.'
    if (files.reduce((total, file) => total + file.size, 0) > 100 * 1024 * 1024) return 'The selected images exceed the 100 MB upload limit.'
    for (const file of files) {
        if (file.size > 25 * 1024 * 1024) return `“${file.name}” exceeds the 25 MB image limit.`
        if (!file.size) return `“${file.name}” is empty.`
        const extension = file.name.split('.').at(-1)?.toLowerCase() ?? ''
        if (!SUPPORTED_EXTENSIONS.has(extension) || (file.type && !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-ms-bmp', 'image/tiff', 'image/heic', 'image/heif'].includes(file.type))) {
            return `“${file.name}” is not a supported raster image. Use JPG, PNG, WebP, GIF, BMP, TIFF, or HEIC.`
        }
    }
}
