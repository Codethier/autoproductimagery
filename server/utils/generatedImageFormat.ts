import sharp from 'sharp'
import type {ImageSaveFormat} from '../../schemas/image-generation'
import {MAX_IMAGE_PIXELS, MAX_STORED_IMAGE_BYTES, detectImageType} from './imageValidation'

export type StoredOutputImage = {
    buffer: Buffer
    mimeType: string
    /** Set when the stored bytes differ from the provider's decoded image. */
    converted?: {providerMimeType: string; providerBytes: number}
    warning?: string
}

const PROVIDER_MIME_BY_TYPE: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tiff: 'image/tiff', heic: 'image/heic',
}
const TARGETS = {
    webp: {type: 'webp', mimeType: 'image/webp', label: 'WebP'},
    png: {type: 'png', mimeType: 'image/png', label: 'PNG'},
} as const
// Visually near-lossless for product photography; alpha is kept losslessly.
export const WEBP_STORAGE_QUALITY = 90

const PNG_CONVERTIBLE_SOURCE_TYPES = new Set(['image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff', 'image/heic'])

/**
 * Convert one validated stored source image to PNG for a provider request,
 * without changing the stored object. `preserveGeometry` keeps the decoded
 * pixel grid exactly (no EXIF auto-orientation) so it still lines up with an
 * edit mask whose dimensions were validated against the same decoded size.
 * Returns undefined when the type is not a convertible raster or decoding fails.
 */
export async function convertSourceToPng(buffer: Buffer, mimeType: string, options: {preserveGeometry: boolean}): Promise<Buffer | undefined> {
    if (!PNG_CONVERTIBLE_SOURCE_TYPES.has(mimeType)) return undefined
    try {
        const image = sharp(buffer, {failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true})
        return await (options.preserveGeometry ? image : image.rotate()).png().toBuffer()
    } catch {
        return undefined
    }
}

/**
 * Prepare one provider output for storage. `webp` (default) and `png` convert
 * any decodable raster of another type, keeping alpha and applying EXIF
 * orientation; an output already in the target format keeps its exact bytes.
 * Unrecognised payloads pass through unchanged so the normal decode validation
 * rejects them. A paid output is never discarded because conversion failed or
 * would exceed the stored-size limit: the original bytes are kept and a
 * warning is recorded instead.
 */
export async function prepareOutputForStorage(buffer: Buffer, declaredMimeType: string, saveFormat: ImageSaveFormat): Promise<StoredOutputImage> {
    if (saveFormat === 'original') return {buffer, mimeType: declaredMimeType}
    const target = TARGETS[saveFormat]
    const detected = detectImageType(buffer)
    if (!detected) return {buffer, mimeType: declaredMimeType}
    const providerMimeType = PROVIDER_MIME_BY_TYPE[detected] ?? declaredMimeType
    if (detected === target.type) return {buffer, mimeType: target.mimeType}
    try {
        const image = sharp(buffer, {failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true}).rotate()
        const converted = await (target.type === 'webp'
            ? image.webp({quality: WEBP_STORAGE_QUALITY, alphaQuality: 100, effort: 4, smartSubsample: true})
            : image.png()).toBuffer()
        if (converted.byteLength > MAX_STORED_IMAGE_BYTES) {
            return {buffer, mimeType: providerMimeType,
                warning: `Kept the original ${providerMimeType} output because its ${target.label} conversion exceeds the stored image size limit.`}
        }
        return {buffer: converted, mimeType: target.mimeType, converted: {providerMimeType, providerBytes: buffer.byteLength}}
    } catch {
        return {buffer, mimeType: providerMimeType,
            warning: `Kept the original ${providerMimeType} output because it could not be converted to ${target.label}.`}
    }
}
