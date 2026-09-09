import { CATALOG_IMAGE_DEFINITIONS, type CatalogImageSettings } from '../../schemas/catalog-image-models'

// The namespace is the AI SDK provider name, which can differ from the Gateway ID.
export function catalogImageOptions(settings: CatalogImageSettings, firstImage?: Buffer) {
    const providerOptions: Record<string, Record<string, string | number | boolean>> = {}
    const definition = CATALOG_IMAGE_DEFINITIONS[settings.kind]
    switch (definition.provider) {
        case 'bfl': {
            if (!('outputFormat' in settings)) throw new Error('Invalid FLUX settings')
            providerOptions.blackForestLabs = {
                outputFormat: settings.outputFormat,
                ...(definition.referenceMode === 'image-prompt' && firstImage
                    ? {imagePrompt: firstImage.toString('base64')} : {}),
                ...('imagePromptStrength' in settings ? {imagePromptStrength: settings.imagePromptStrength} : {}),
            }
            break
        }
        case 'bytedance': {
            if (!('watermark' in settings)) throw new Error('Invalid Seedream settings')
            providerOptions.bytedance = {
                size: settings.resolution,
                watermark: settings.watermark,
                sequentialImageGeneration: 'disabled',
                ...(settings.kind === 'bytedance/seedream-5.0-lite' || settings.kind === 'bytedance/seedream-5.0-pro'
                    ? {outputFormat: settings.outputFormat} : {}),
            }
            break
        }
        case 'spacexai':
            providerOptions.xai = settings.kind === 'spacexai/grok-imagine-image-2.0'
                ? {resolution: settings.resolution} : {}
            break
        case 'meta':
            break
    }
    return {
        providerOptions,
        referenceMode: definition.referenceMode,
        ...('size' in settings && settings.size ? {size: settings.size as `${number}x${number}`} : {}),
        ...('aspectRatio' in settings && settings.aspectRatio ? {aspectRatio: settings.aspectRatio as `${number}:${number}`} : {}),
        ...('seed' in settings && settings.seed != null ? {seed: settings.seed} : {}),
    }
}
