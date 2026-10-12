import {createError} from 'h3'
import {imagePathToUrl, parseImagePath} from './imageStoragePaths'

type GenerationSources = {
    inputImages: readonly string[]
    modelImages: readonly string[]
    maskImage?: string
}

// Normalize logical paths and encoded asset URLs to the same recorded URL.
export function generatedSourcePaths(sources: GenerationSources): string[] {
    return [...new Set([
        ...sources.inputImages, ...sources.modelImages,
        ...(sources.maskImage ? [sources.maskImage] : []),
    ].flatMap(path => {
        const parts = parseImagePath(path)
        return parts[0] === 'output' ? [imagePathToUrl(parts)] : []
    }))]
}

export async function assertGeneratedSourcesAvailable(
    sources: GenerationSources,
    findExpired: (paths: readonly string[]) => Promise<string[]>,
) {
    const paths = generatedSourcePaths(sources)
    if (!paths.length) return
    if ((await findExpired(paths)).length) {
        throw createError({
            statusCode: 410,
            statusMessage: 'A generated source image expired under the retention policy. Exact replay is unavailable; select an available image to generate again.',
            data: {code: 'GENERATED_IMAGE_EXPIRED', retryable: false},
        })
    }
}
