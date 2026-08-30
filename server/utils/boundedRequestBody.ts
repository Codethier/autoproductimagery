import type { H3Event } from 'h3'
import { createError, getHeader } from 'h3'

const RAW_BODY_SYMBOL = Symbol.for('h3RawBody')

type RequestWithRawBody = NodeJS.ReadableStream & {
    headers: Record<string, string | string[] | undefined>
    [RAW_BODY_SYMBOL]?: Promise<Buffer> | Buffer
}

function requestTooLarge(): never {
    throw createError({statusCode: 413, statusMessage: 'Request body too large'})
}

/**
 * Installs the bounded raw-body promise consumed by h3's body parsers.
 * This enforces the limit while reading chunked bodies, not after buffering.
 */
export function installBoundedRawBody(event: H3Event, maximumBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
        throw new TypeError('maximumBytes must be a positive safe integer')
    }

    const request = event.node.req as unknown as RequestWithRawBody
    const existing = request[RAW_BODY_SYMBOL]
    if (existing) {
        const bounded = Promise.resolve(existing).then(value => {
            const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
            if (buffer.byteLength > maximumBytes) requestTooLarge()
            return buffer
        })
        request[RAW_BODY_SYMBOL] = bounded
        return bounded
    }

    const rawLength = getHeader(event, 'content-length')
    if (rawLength !== undefined) {
        if (!/^\d+$/.test(rawLength)) {
            throw createError({statusCode: 400, statusMessage: 'Invalid Content-Length'})
        }
        if (Number(rawLength) > maximumBytes) requestTooLarge()
    }
    const transferEncoding = getHeader(event, 'transfer-encoding') || ''
    if (rawLength === '0'
        || (rawLength === undefined && !/\bchunked\b/i.test(transferEncoding))
        || (request as NodeJS.ReadableStream & {readableEnded?: boolean}).readableEnded === true) {
        const empty = Promise.resolve(Buffer.alloc(0))
        request[RAW_BODY_SYMBOL] = empty
        return empty
    }

    let totalBytes = 0
    let exceeded = false
    const chunks: Buffer[] = []
    const bodyPromise = new Promise<Buffer>((resolve, reject) => {
        request.on('error', reject)
        request.on('data', (value: Buffer | Uint8Array | string) => {
            if (exceeded) return
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
            totalBytes += chunk.byteLength
            if (totalBytes > maximumBytes) {
                exceeded = true
                chunks.length = 0
                reject(createError({statusCode: 413, statusMessage: 'Request body too large'}))
                return
            }
            chunks.push(chunk)
        })
        request.on('end', () => {
            if (!exceeded) resolve(Buffer.concat(chunks, totalBytes))
        })
    })
    request[RAW_BODY_SYMBOL] = bodyPromise
    return bodyPromise
}
