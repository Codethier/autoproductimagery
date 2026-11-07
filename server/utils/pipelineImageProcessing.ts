import sharp from 'sharp'
import {createError} from 'h3'
import {GenerationLimiter, GenerationQueueFullError} from './generationLimiter'
import {inspectDecodedImage, MAX_IMAGE_PIXELS, MAX_STORED_IMAGE_BYTES} from './imageValidation'

export const PIPELINE_LOCAL_IMAGE_TIMEOUT_SECONDS = 30
export const PIPELINE_MAX_IMAGE_DIMENSION = 8192
export const PIPELINE_LOCAL_IMAGE_CONCURRENCY = 2
export const PIPELINE_LOCAL_IMAGE_QUEUE = 8

type ImagePosition = 'centre' | 'north' | 'south' | 'east' | 'west'
type ImageFit = 'contain' | 'cover' | 'inside' | 'outside' | 'fill'
export type LocalPipelineImageOperation =
    | {type: 'crop'; config: {width: number; height: number; position: ImagePosition}}
    | {type: 'resize'; config: {width: number; height: number; fit: ImageFit; background?: string; position?: ImagePosition}}
    | {type: 'upscale'; config: {scale: 2 | 4}}
    | {type: 'convert'; config: {format: 'png' | 'jpeg' | 'webp'; quality: number}}

export type LocalPipelineImageResult = {
    buffer: Buffer
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
    width: number
    height: number
    byteSize: number
    providerPriceUsd: '0'
    priceSource: 'local-processing'
    method: 'crop' | 'resize' | 'standard-resampling' | 'convert'
}

// The pipeline's database leases bound work across instances. This additional
// native-memory gate is shared by all local transform callers in this process.
const localImageLimiter = new GenerationLimiter(PIPELINE_LOCAL_IMAGE_CONCURRENCY, PIPELINE_LOCAL_IMAGE_QUEUE)
const positions = new Set<ImagePosition>(['centre', 'north', 'south', 'east', 'west'])
const fits = new Set<ImageFit>(['contain', 'cover', 'inside', 'outside', 'fill'])
function invalidConfiguration(): never {
    throw createError({statusCode: 400, statusMessage: 'Invalid pipeline image settings'})
}
function validateDimensions(width: number, height: number) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        width > PIPELINE_MAX_IMAGE_DIMENSION || height > PIPELINE_MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
        throw createError({statusCode: 413, statusMessage: 'Pipeline image dimensions are too large'})
    }
}
function backgroundColor(value: string | undefined) {
    if (value === undefined || value === 'transparent') return {r: 0, g: 0, b: 0, alpha: 0}
    if (!/^#[a-f\d]{6}$/i.test(value)) invalidConfiguration()
    return value
}
function safeProcessingFailure(error: unknown): never {
    if (error && typeof error === 'object' && 'statusCode' in error &&
        [400, 413, 415, 429, 499, 503, 504].includes(Number(error.statusCode))) throw error
    // libvips diagnostics may contain an internal path or native metadata.
    throw createError({statusCode: 503, statusMessage: 'Pipeline image processing could not finish'})
}
function checkAbort(signal: AbortSignal | undefined) {
    if (signal?.aborted) throw createError({statusCode: 499, statusMessage: 'Pipeline image processing was cancelled'})
}

/** Deterministic CPU transforms only. Upscale is Lanczos resampling, not an AI model. */
export async function processLocalPipelineImage(
    data: Buffer, operation: LocalPipelineImageOperation, signal?: AbortSignal,
): Promise<LocalPipelineImageResult> {
    checkAbort(signal)
    if (!Buffer.isBuffer(data) || data.byteLength === 0 || data.byteLength > MAX_STORED_IMAGE_BYTES) {
        throw createError({statusCode: 413, statusMessage: 'Pipeline image is too large or empty'})
    }
    if (!operation || !['crop', 'resize', 'upscale', 'convert'].includes(operation.type) || !operation.config) invalidConfiguration()
    try {
        return await localImageLimiter.run(async () => {
            checkAbort(signal)
            const source = await inspectDecodedImage(data)
            checkAbort(signal)
            const metadata = await sharp(data, {failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS}).metadata()
            const rotated = (metadata.orientation ?? 1) >= 5
            const sourceWidth = rotated ? source.height : source.width
            const sourceHeight = rotated ? source.width : source.height
            let width: number, height: number
            let fit: ImageFit = 'cover'
            let position: ImagePosition = 'centre'
            let background: string | {r: number; g: number; b: number; alpha: number} = backgroundColor(undefined)
            let method: LocalPipelineImageResult['method']
            if (operation.type === 'convert') {
                if (!['png', 'jpeg', 'webp'].includes(operation.config.format) || !Number.isInteger(operation.config.quality) ||
                    operation.config.quality < 1 || operation.config.quality > 100) invalidConfiguration()
                width = sourceWidth
                height = sourceHeight
                fit = 'fill'
                method = 'convert'
            } else if (operation.type === 'upscale') {
                if (operation.config.scale !== 2 && operation.config.scale !== 4) invalidConfiguration()
                if ('mode' in operation.config && operation.config.mode !== 'standard') invalidConfiguration()
                // Use post-orientation dimensions. Portrait JPEG EXIF rotations
                // must not silently turn a two-times upscale into a crop.
                width = sourceWidth * operation.config.scale
                height = sourceHeight * operation.config.scale
                fit = 'fill'
                method = 'standard-resampling'
            } else {
                width = operation.config.width
                height = operation.config.height
                position = operation.config.position ?? 'centre'
                if (!positions.has(position)) invalidConfiguration()
                method = operation.type
                if (operation.type === 'resize') {
                    fit = operation.config.fit
                    if (!fits.has(fit)) invalidConfiguration()
                    background = backgroundColor(operation.config.background)
                }
            }
            validateDimensions(width, height)
            // 'outside' can exceed the requested rectangle. Bound its actual
            // dimensions before invoking native work instead of after allocation.
            if (fit === 'outside') {
                const ratio = Math.max(width / sourceWidth, height / sourceHeight)
                validateDimensions(Math.ceil(sourceWidth * ratio), Math.ceil(sourceHeight * ratio))
            }
            const transform = sharp(data, {failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true})
                .timeout({seconds: PIPELINE_LOCAL_IMAGE_TIMEOUT_SECONDS})
                .rotate().resize(width, height, {fit, position, background, kernel: 'lanczos3'})
            let mimeType: LocalPipelineImageResult['mimeType'] = 'image/png'
            if (operation.type === 'convert' && operation.config.format === 'jpeg') {
                // JPEG has no alpha channel. Use an explicit white canvas.
                transform.flatten({background: '#ffffff'}).jpeg({quality: operation.config.quality})
                mimeType = 'image/jpeg'
            } else if (operation.type === 'convert' && operation.config.format === 'webp') {
                transform.webp({quality: operation.config.quality, effort: 3})
                mimeType = 'image/webp'
            } else transform.png({compressionLevel: 6})
            const onAbort = () => transform.destroy()
            signal?.addEventListener('abort', onAbort, {once: true})
            try {
                checkAbort(signal)
                const {data: output, info} = await transform.toBuffer({resolveWithObject: true})
                checkAbort(signal)
                validateDimensions(info.width, info.height)
                if (output.byteLength > MAX_STORED_IMAGE_BYTES) {
                    throw createError({statusCode: 413, statusMessage: 'Processed pipeline image is too large'})
                }
                return {buffer: output, mimeType, width: info.width, height: info.height, byteSize: output.byteLength,
                    providerPriceUsd: '0', priceSource: 'local-processing', method}
            } finally {
                signal?.removeEventListener('abort', onAbort)
                transform.destroy()
            }
        }, signal)
    } catch (error) {
        checkAbort(signal)
        if (error instanceof GenerationQueueFullError) {
            throw createError({statusCode: 429, statusMessage: 'Pipeline image processing is busy; try again later'})
        }
        return safeProcessingFailure(error)
    }
}

export type ExpansionCanvasConfig = {
    mode: 'pixels' | 'aspect-ratio'
    top: number; bottom: number; left: number; right: number
    aspectRatio: string
}
export type ExpansionCanvasResult = {
    buffer: Buffer
    maskBuffer: Buffer
    luminanceMaskBuffer: Buffer
    mimeType: 'image/png'
    width: number
    height: number
    byteSize: number
    placement: {left: number; top: number; width: number; height: number}
}

/** Prepare exact immutable references for generative outpainting; does not perform AI expansion. */
export async function prepareExpansionCanvas(data: Buffer, config: ExpansionCanvasConfig, signal?: AbortSignal): Promise<ExpansionCanvasResult> {
    checkAbort(signal)
    if (!Buffer.isBuffer(data) || !data.length || data.byteLength > MAX_STORED_IMAGE_BYTES) {
        throw createError({statusCode: 413, statusMessage: 'Pipeline image is too large or empty'})
    }
    if (!config || !['pixels', 'aspect-ratio'].includes(config.mode)) invalidConfiguration()
    try {
        return await localImageLimiter.run(async () => {
            checkAbort(signal)
            const source = await inspectDecodedImage(data)
            const metadata = await sharp(data, {failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS}).metadata()
            const rotated = (metadata.orientation ?? 1) >= 5
            const sourceWidth = rotated ? source.height : source.width, sourceHeight = rotated ? source.width : source.height
            let top: number, bottom: number, left: number, right: number
            if (config.mode === 'pixels') {
                const margins = [config.top, config.bottom, config.left, config.right]
                if (margins.some(value => !Number.isSafeInteger(value) || value < 0 || value > 4096)) invalidConfiguration()
                ;[top, bottom, left, right] = margins as [number, number, number, number]
            } else {
                if (!['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'].includes(config.aspectRatio)) invalidConfiguration()
                const [ratioWidth, ratioHeight] = config.aspectRatio.split(':').map(Number)
                const ratio = ratioWidth! / ratioHeight!
                const width = Math.max(sourceWidth, Math.ceil(sourceHeight * ratio))
                const height = Math.max(sourceHeight, Math.ceil(sourceWidth / ratio))
                left = Math.floor((width - sourceWidth) / 2); right = width - sourceWidth - left
                top = Math.floor((height - sourceHeight) / 2); bottom = height - sourceHeight - top
            }
            const width = sourceWidth + left + right, height = sourceHeight + top + bottom
            validateDimensions(width, height)
            const transforms: sharp.Sharp[] = []
            const bounded = (image: sharp.Sharp) => {
                transforms.push(image)
                return image.timeout({seconds: PIPELINE_LOCAL_IMAGE_TIMEOUT_SECONDS})
            }
            const onAbort = () => {for (const image of transforms) image.destroy()}
            signal?.addEventListener('abort', onAbort, {once: true})
            try {
                checkAbort(signal)
                const oriented = await bounded(sharp(data, {failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true})).rotate().png().toBuffer()
                checkAbort(signal)
                const buffer = await bounded(sharp({create: {width, height, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}}}))
                    .composite([{input: oriented, left, top}]).png({compressionLevel: 6}).toBuffer()
                checkAbort(signal)
                // OpenAI alpha masks protect the opaque rectangle and edit the
                // transparent margins. BFL luminance masks edit white margins.
                const protectedAlpha = await bounded(sharp({create: {width: sourceWidth, height: sourceHeight, channels: 4,
                    background: {r: 255, g: 255, b: 255, alpha: 1}}})).png().toBuffer()
                const maskBuffer = await bounded(sharp({create: {width, height, channels: 4, background: {r: 255, g: 255, b: 255, alpha: 0}}}))
                    .composite([{input: protectedAlpha, left, top}]).png({compressionLevel: 6}).toBuffer()
                checkAbort(signal)
                const protectedLuminance = await bounded(sharp({create: {width: sourceWidth, height: sourceHeight, channels: 3,
                    background: '#000000'}})).png().toBuffer()
                const luminanceMaskBuffer = await bounded(sharp({create: {width, height, channels: 3, background: '#ffffff'}}))
                    .composite([{input: protectedLuminance, left, top}]).png({compressionLevel: 6}).toBuffer()
                checkAbort(signal)
                if ([buffer, maskBuffer, luminanceMaskBuffer].some(value => value.byteLength > MAX_STORED_IMAGE_BYTES)) {
                    throw createError({statusCode: 413, statusMessage: 'Prepared expansion image is too large'})
                }
                return {buffer, maskBuffer, luminanceMaskBuffer, mimeType: 'image/png', width, height, byteSize: buffer.byteLength,
                    placement: {left, top, width: sourceWidth, height: sourceHeight}}
            } finally {
                signal?.removeEventListener('abort', onAbort)
                for (const image of transforms) image.destroy()
            }
        }, signal)
    } catch (error) {
        checkAbort(signal)
        if (error instanceof GenerationQueueFullError) {
            throw createError({statusCode: 429, statusMessage: 'Pipeline image processing is busy; try again later'})
        }
        return safeProcessingFailure(error)
    }
}
