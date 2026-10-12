import { createError } from "h3"
import sharp from "sharp"

export const MAX_IMAGE_PIXELS = 40_000_000
export const MAX_STORED_IMAGE_BYTES = 25 * 1024 * 1024
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"])

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    bmp: "image/bmp", tiff: "image/tiff", heic: "image/heic",
}
const SHARP_FORMAT_BY_EXTENSION: Record<string, string> = {
    png: "png", jpg: "jpeg", gif: "gif", webp: "webp", bmp: "magick", tiff: "tiff", heic: "heif",
}

export type ImageInspection = {
    extension: string
    mimeType: string
    width: number
    height: number
    hasAlpha?: boolean
}

function isHeicBmff(data: Buffer): boolean {
    if (data.length < 16 || data.subarray(4, 8).toString("ascii") !== "ftyp") return false
    const boxSize = data.readUInt32BE(0)
    if (boxSize < 16 || boxSize > data.length) return false
    if (HEIC_BRANDS.has(data.subarray(8, 12).toString("ascii"))) return true
    for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
        if (HEIC_BRANDS.has(data.subarray(offset, offset + 4).toString("ascii"))) return true
    }
    return false
}

const IMAGE_MAGIC_SIGNATURES: Array<{ ext: string; check: (buffer: Buffer) => boolean }> = [
    { ext: "png", check: buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { ext: "jpg", check: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
    { ext: "gif", check: buffer => buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii")) },
    { ext: "webp", check: buffer => buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP" },
    { ext: "bmp", check: buffer => buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d },
    { ext: "tiff", check: buffer => buffer.length >= 4 && ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) || (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)) },
    { ext: "heic", check: isHeicBmff },
]

// Magic bytes only nominate a decoder. No caller may trust this before decoding.
export function detectImageType(data: Buffer): string | null {
    return IMAGE_MAGIC_SIGNATURES.find(signature => signature.check(data))?.ext ?? null
}

export function canonicalImageExtension(name: string): string | null {
    const extensionIndex = name.lastIndexOf(".")
    if (extensionIndex < 0) return null
    const extension = name.slice(extensionIndex + 1).toLowerCase()
    const canonical = extension === "jpeg" ? "jpg" : extension === "tif" ? "tiff" : extension
    return Object.hasOwn(IMAGE_MIME_BY_EXTENSION, canonical) ? canonical : null
}

export function hasSupportedImageExtension(name: string): boolean {
    return canonicalImageExtension(name) !== null
}

export async function inspectDecodedImage(data: Buffer, providerPayload = false): Promise<ImageInspection> {
    const badPayload = (message: string, statusCode = providerPayload ? 502 : 415): never => {
        throw createError({ statusCode, statusMessage: message })
    }
    if (data.byteLength > MAX_STORED_IMAGE_BYTES) {
        return badPayload(providerPayload ? "Provider returned an image that is too large" : "Image is too large", providerPayload ? 502 : 413)
    }
    const extension = detectImageType(data)
    if (!extension) return badPayload(providerPayload
        ? "Provider returned an unsupported image payload"
        : "Unsupported file type; image required")
    try {
        const image = sharp(data, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true })
        const metadata = await image.metadata()
        if (!metadata.width || !metadata.height || !metadata.format) {
            return badPayload(providerPayload ? "Provider returned an invalid image" : "Invalid image")
        }
        if ((metadata.pages ?? 1) !== 1) return badPayload("Animated or multi-page images are not supported")
        if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) return badPayload("Image dimensions are too large", 413)
        if (metadata.format !== SHARP_FORMAT_BY_EXTENSION[extension]) {
            return badPayload(providerPayload ? "Provider returned an invalid image" : "Image content does not match its format")
        }
        // Walk every decoded pixel without allocating an additional raw pixel buffer.
        const decodedStats = await image.clone().stats()
        if (!decodedStats.channels.length) return badPayload(providerPayload ? "Provider returned an invalid image" : "Invalid image")
        return {
            extension,
            mimeType: IMAGE_MIME_BY_EXTENSION[extension]!,
            width: metadata.width,
            height: metadata.height,
            hasAlpha: metadata.hasAlpha,
        }
    } catch (error: unknown) {
        if (error && typeof error === "object" && "statusCode" in error) throw error
        const message = error instanceof Error ? error.message : ""
        const tooLarge = /pixel limit|too large|exceeds/i.test(message)
        return badPayload(tooLarge ? "Image dimensions are too large" : (providerPayload ? "Provider returned an invalid image" : "Invalid or corrupt image"), tooLarge ? 413 : undefined)
    }
}
