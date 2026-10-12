import { createError } from "h3"

const INVALID_SEGMENT = /[\\/:*?"<>|%\x00-\x1f\x7f]/
const RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i
const UNSAFE_OBJECT_NAMES = new Set(["__proto__", "prototype", "constructor"])

export function validateImagePathSegment(segment: string): string {
    if (!segment || segment === "." || segment === ".." || segment.length > 255
        || segment !== segment.trim() || segment.endsWith(".") || INVALID_SEGMENT.test(segment)
        || RESERVED_NAME.test(segment) || UNSAFE_OBJECT_NAMES.has(segment.toLowerCase())) {
        throw createError({ statusCode: 400, statusMessage: "Invalid image path" })
    }
    return segment
}

// The single leading slash denotes an application path, never an OS path.
// Decode once per segment; reject encoded separators and nested encodings.
export function parseImagePath(value: string, logicalDirectory = false): string[] {
    if (typeof value !== "string" || value.length > 4096 || /[\\\x00-\x1f\x7f]/.test(value)
        || value.includes("?") || (!logicalDirectory && value.includes("#")) || value.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(value)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid image path" })
    }
    let relative = value
    if (relative === "/" || relative === "" || (!logicalDirectory && (relative === "/images" || relative === "/images/"))) return []
    if (!logicalDirectory && relative.startsWith("/images/")) relative = relative.slice("/images/".length)
    else if (relative.startsWith("/")) relative = relative.slice(1)
    const parts = relative.split("/")
    if (parts.length > 64) throw createError({ statusCode: 400, statusMessage: "Invalid image path" })
    return parts.map(part => {
        let decoded: string
        try { decoded = decodeURIComponent(part) }
        catch { throw createError({ statusCode: 400, statusMessage: "Invalid image path encoding" }) }
        return validateImagePathSegment(decoded)
    })
}

export function imagePathToUrl(segments: readonly string[]): string {
    return `/images/${segments.map(validateImagePathSegment).map(encodeURIComponent).join("/")}`
}

export function normalizeImageStoragePrefix(prefix: string): string {
    const value = prefix.replace(/\/$/, "")
    if (!value || value.startsWith("/") || value.includes("%")) {
        throw createError({ statusCode: 500, statusMessage: "Image storage configuration is invalid" })
    }
    try { return value.split("/").map(validateImagePathSegment).join("/") + "/" }
    catch { throw createError({ statusCode: 500, statusMessage: "Image storage configuration is invalid" }) }
}
