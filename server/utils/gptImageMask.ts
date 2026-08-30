export type ImageDescriptor = {
    mimeType: string
    bytes: number
    width?: number
    height?: number
    hasAlpha?: boolean
}

export function validateGptImageMaskPair(mask: ImageDescriptor, source?: ImageDescriptor): string | undefined {
    if (mask.mimeType !== 'image/png') return 'GPT Image 2 masks must be PNG files.'
    if (mask.bytes > 25 * 1024 * 1024) return 'GPT Image 2 masks must be 25 MB or smaller.'
    if (mask.hasAlpha !== true) return 'GPT Image 2 masks must include an alpha channel.'
    if (!source) return 'A mask requires a source image.'
    if (source.mimeType !== mask.mimeType) {
        return 'The GPT Image 2 mask and every source image must have the same file format. Use PNG sources with a PNG mask.'
    }
    if (!mask.width || !mask.height || !source.width || !source.height) {
        return 'The mask and every source image must have readable dimensions.'
    }
    if (mask.width !== source.width || mask.height !== source.height) {
        return 'The mask dimensions must match every source image.'
    }
    return undefined
}
