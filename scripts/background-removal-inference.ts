import sharp from 'sharp'
import { MAX_IMAGE_PIXELS, MAX_STORED_IMAGE_BYTES, inspectDecodedImage } from '../server/utils/imageValidation.ts'

export const MASK_SIZE = 1024
const MEAN = [0.485, 0.456, 0.406] as const
const STD = [0.229, 0.224, 0.225] as const

export function normalizedRgbTensor(rgb: Uint8Array, size = MASK_SIZE): Float32Array {
    const plane = size * size
    if (!Number.isInteger(size) || size < 1 || rgb.length !== plane * 3) throw new Error('Invalid image tensor')
    const tensor = new Float32Array(plane * 3)
    for (let index = 0; index < plane; index++) {
        for (let channel = 0; channel < 3; channel++) {
            tensor[channel * plane + index] = (rgb[index * 3 + channel]! / 255 - MEAN[channel]!) / STD[channel]!
        }
    }
    return tensor
}

/** Matches the upstream BiRefNet sigmoid/min-max mask conversion, without flat-mask NaNs. */
export function maskFromLogits(logits: Float32Array, expectedPixels = MASK_SIZE * MASK_SIZE): Uint8Array {
    if (logits.length !== expectedPixels) throw new Error('Invalid model output')
    const probabilities = new Float32Array(logits.length)
    let minimum = Infinity
    let maximum = -Infinity
    for (let index = 0; index < logits.length; index++) {
        const value = logits[index]!
        if (!Number.isFinite(value)) throw new Error('Invalid model output')
        // Stable sigmoid avoids exponential overflow for very negative logits.
        const probability = value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value))
        probabilities[index] = probability
        minimum = Math.min(minimum, probability)
        maximum = Math.max(maximum, probability)
    }
    const range = maximum - minimum
    const mask = new Uint8Array(logits.length)
    for (let index = 0; index < logits.length; index++) {
        const value = range > 1e-8 ? (probabilities[index]! - minimum) / range : probabilities[index]!
        mask[index] = Math.max(0, Math.min(255, Math.floor(value * 255)))
    }
    return mask
}

export function applyExistingAlpha(rgba: Uint8Array, alpha: Uint8Array): void {
    if (rgba.length !== alpha.length * 4) throw new Error('Invalid alpha dimensions')
    for (let index = 0; index < alpha.length; index++) {
        rgba[index * 4 + 3] = Math.round(rgba[index * 4 + 3]! * alpha[index]! / 255)
    }
}

export async function prepareBackgroundRemovalInput(buffer: Buffer) {
    await inspectDecodedImage(buffer)
    const {data: rgba, info} = await sharp(buffer, {failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true})
        .rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject: true})
    if (info.channels !== 4 || info.width * info.height > MAX_IMAGE_PIXELS) throw new Error('Invalid decoded image')
    const rgb = await sharp(rgba, {raw: {width: info.width, height: info.height, channels: 4}})
        .flatten({background: '#ffffff'}).resize(MASK_SIZE, MASK_SIZE, {fit: 'fill', kernel: 'lanczos3'})
        .removeAlpha().raw().toBuffer()
    return {rgba, width: info.width, height: info.height, tensor: normalizedRgbTensor(rgb)}
}

export async function encodeBackgroundRemovalOutput(input: {rgba: Buffer; width: number; height: number}, mask: Uint8Array) {
    if (mask.length !== MASK_SIZE * MASK_SIZE) throw new Error('Invalid mask dimensions')
    const alpha = await sharp(mask, {raw: {width: MASK_SIZE, height: MASK_SIZE, channels: 1}})
        .resize(input.width, input.height, {fit: 'fill', kernel: 'lanczos3'}).toColourspace('b-w').raw().toBuffer()
    applyExistingAlpha(input.rgba, alpha)
    const buffer = await sharp(input.rgba, {raw: {width: input.width, height: input.height, channels: 4}})
        .png({compressionLevel: 6}).toBuffer()
    if (buffer.byteLength > MAX_STORED_IMAGE_BYTES) throw new Error('Output image is too large')
    const image = await inspectDecodedImage(buffer)
    if (image.mimeType !== 'image/png' || !image.hasAlpha || image.width !== input.width || image.height !== input.height) {
        throw new Error('Invalid output image')
    }
    return {buffer, mimeType: 'image/png' as const, width: image.width, height: image.height, byteSize: buffer.byteLength}
}
