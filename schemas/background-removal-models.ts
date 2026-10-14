/** Pinned, local CPU processors. These are separate from paid Gateway generators. */
export const BACKGROUND_REMOVAL_MODELS = [
    {
        id: 'birefnet-lite',
        label: 'BiRefNet Lite',
        supportsTransparentBackground: true,
        description: 'Faster CPU cutouts for product photos and clothing.',
        version: 'rembg-birefnet-general-lite-232',
        filename: 'birefnet-lite.onnx',
        url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx',
        sha256: '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333',
        bytes: 224005088,
        // Measured Linux CPU high-water RSS was 6.84 GiB; reserve headroom before loading.
        minimumAvailableMemoryBytes: 8 * 1024 ** 3,
        license: 'MIT',
        licenseUrl: 'https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE',
    },
    {
        id: 'birefnet',
        label: 'BiRefNet (Full)',
        supportsTransparentBackground: true,
        description: 'More detail for complex edges; slower and uses more memory.',
        version: 'rembg-birefnet-general-244',
        filename: 'birefnet.onnx',
        url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-epoch_244.onnx',
        sha256: '58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c',
        bytes: 972666916,
        // Measured Linux CPU high-water RSS was 8.22 GiB; reserve headroom before loading.
        minimumAvailableMemoryBytes: 10 * 1024 ** 3,
        license: 'MIT',
        licenseUrl: 'https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE',
    },
] as const

export type BackgroundRemovalModelId = typeof BACKGROUND_REMOVAL_MODELS[number]['id']
export type BackgroundRemovalModel = typeof BACKGROUND_REMOVAL_MODELS[number]

export function getBackgroundRemovalModel(id: string): BackgroundRemovalModel {
    const model = BACKGROUND_REMOVAL_MODELS.find(profile => profile.id === id)
    if (!model) throw new Error('Unsupported background removal model')
    return model
}
