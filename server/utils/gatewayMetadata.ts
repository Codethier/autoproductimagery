const SECRET_KEY_PATTERN = /authorization|api[-_]?key|cookie|credential|password|secret|access[-_]?token|refresh[-_]?token/i

export const MAX_STORED_PROVIDER_METADATA_BYTES = 32 * 1024

type MetadataLookupPool = {
    start<T>(key: string, work: () => Promise<T>): Promise<T> | undefined
    activeCount(): number
    inFlightCount(): number
}

/**
 * Gateway catalog/billing helpers currently expose no AbortSignal. This pool
 * puts a hard ceiling on that non-abortable background work and reuses an
 * existing lookup for the same key until it settles.
 */
export function createGatewayMetadataLookupPool(maxConcurrent = 4): MetadataLookupPool {
    const limit = Math.max(1, Math.floor(maxConcurrent))
    const inFlight = new Map<string, Promise<unknown>>()
    let active = 0

    return {
        start<T>(key: string, work: () => Promise<T>) {
            const existing = inFlight.get(key)
            if (existing) return existing as Promise<T>
            if (active >= limit) return undefined

            active += 1
            const tracked = Promise.resolve()
                .then(work)
                .then(
                    value => {
                        inFlight.delete(key)
                        active -= 1
                        return value
                    },
                    error => {
                        inFlight.delete(key)
                        active -= 1
                        throw error
                    },
                )
            inFlight.set(key, tracked)
            return tracked
        },
        activeCount: () => active,
        inFlightCount: () => inFlight.size,
    }
}

const globalMetadataPoolKey = Symbol.for('autoproductimagery.gatewayMetadataPool')

export function getGatewayMetadataLookupPool(): MetadataLookupPool {
    const globalState = globalThis as typeof globalThis & {
        [globalMetadataPoolKey]?: MetadataLookupPool
    }
    globalState[globalMetadataPoolKey] ??= createGatewayMetadataLookupPool(4)
    return globalState[globalMetadataPoolKey]
}

function redactString(value: string) {
    const redacted = value
        .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
        .replace(/([?&](?:key|api_key|apiKey|token)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/gi, '[REDACTED_DATA_URL]')
    return redacted.length > 2_048 ? `${redacted.slice(0, 2_048)}...[truncated]` : redacted
}

function sanitizeSerializable(
    value: unknown,
    depth = 0,
    seen = new WeakSet<object>(),
): unknown {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
    if (typeof value === 'string') return redactString(value)
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'function' || typeof value === 'symbol') return undefined
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
        return '[REDACTED_BINARY]'
    }
    if (depth >= 4) return '[truncated]'
    if (typeof value !== 'object') return redactString(String(value))
    if (seen.has(value)) return '[circular]'
    seen.add(value)

    if (Array.isArray(value)) {
        return value.slice(0, 20).map(item => sanitizeSerializable(item, depth + 1, seen))
    }

    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
        result[key] = SECRET_KEY_PATTERN.test(key)
            ? '[REDACTED]'
            : sanitizeSerializable(nested, depth + 1, seen)
    }
    return result
}

export function sanitizeProviderMetadata(
    value: unknown,
    maxBytes = MAX_STORED_PROVIDER_METADATA_BYTES,
): unknown {
    const sanitized = sanitizeSerializable(value)
    const serialized = JSON.stringify(sanitized)
    const bytes = Buffer.byteLength(serialized ?? '', 'utf8')
    if (bytes <= maxBytes) return sanitized
    return {
        truncated: true,
        reason: 'Provider metadata exceeded the storage limit.',
        sanitizedBytes: bytes,
    }
}
