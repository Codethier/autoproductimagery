import Busboy, { type BusboyFileStream } from "@fastify/busboy"
import type { H3Event } from "h3"
import { createError, getHeader } from "h3"

export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024
export const MAX_UPLOAD_FILES = 20
export const MAX_UPLOAD_AGGREGATE_BYTES = 100 * 1024 * 1024
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_AGGREGATE_BYTES + 1024 * 1024
export const MAX_UPLOAD_PATH_BYTES = 4096
export const MAX_CONCURRENT_UPLOADS = 2
export const MAX_QUEUED_UPLOADS = 4

export type BufferedUploadFile = {
    name: "files"
    filename: string
    type: string
    data: Buffer
}

export type ParsedUpload = {
    path: string
    files: BufferedUploadFile[]
}

type UploadQueueEntry = {
    start: () => void
}

export class BoundedUploadGate {
    private active = 0
    private readonly queue: UploadQueueEntry[] = []
    private readonly concurrency: number
    private readonly maximumQueue: number

    constructor(
        concurrency = MAX_CONCURRENT_UPLOADS,
        maximumQueue = MAX_QUEUED_UPLOADS,
    ) {
        if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be positive")
        if (!Number.isInteger(maximumQueue) || maximumQueue < 0) throw new TypeError("maximumQueue cannot be negative")
        this.concurrency = concurrency
        this.maximumQueue = maximumQueue
    }

    run<T>(work: () => Promise<T>): Promise<T> {
        if (this.active < this.concurrency) return this.start(work)
        if (this.queue.length >= this.maximumQueue) {
            return Promise.reject(createError({
                statusCode: 429,
                statusMessage: "Upload capacity is full; retry later",
            }))
        }
        return new Promise<void>((resolve) => {
            this.queue.push({ start: resolve })
        }).then(() => this.startReserved(work))
    }

    snapshot() {
        return { active: this.active, queued: this.queue.length }
    }

    private async start<T>(work: () => Promise<T>): Promise<T> {
        this.active += 1
        return this.startReserved(work)
    }

    private async startReserved<T>(work: () => Promise<T>): Promise<T> {
        try {
            return await work()
        } finally {
            const next = this.queue.shift()
            if (next) next.start()
            else this.active -= 1
        }
    }
}

const UPLOAD_GATE_SYMBOL = Symbol.for("autoproductimagery.uploadGate.v1")
const processState = globalThis as typeof globalThis & { [UPLOAD_GATE_SYMBOL]?: BoundedUploadGate }
const uploadGate = processState[UPLOAD_GATE_SYMBOL]
    ?? (processState[UPLOAD_GATE_SYMBOL] = new BoundedUploadGate())

export function withUploadSlot<T>(work: () => Promise<T>): Promise<T> {
    return uploadGate.run(work)
}

function uploadError(statusCode: number, statusMessage: string) {
    return createError({ statusCode, statusMessage })
}

function validateDeclaredBodyLength(event: H3Event) {
    const value = getHeader(event, "content-length")
    if (value === undefined) return
    if (!/^\d+$/.test(value)) throw uploadError(400, "Invalid Content-Length")
    if (Number(value) > MAX_UPLOAD_REQUEST_BYTES) {
        throw uploadError(413, "Upload request is too large")
    }
}

/**
 * Parses multipart uploads directly from the request stream. No H3 raw-body or
 * multipart helper is used, so the complete multipart body is never duplicated
 * in memory. File buffers are retained only up to the aggregate upload cap.
 */
export function parseStreamingUpload(event: H3Event): Promise<ParsedUpload> {
    validateDeclaredBodyLength(event)
    const contentType = getHeader(event, "content-type") || ""
    if (!/^multipart\/form-data\s*;/i.test(contentType)) {
        throw uploadError(415, "multipart/form-data required")
    }

    const request = event.node.req
    const files: BufferedUploadFile[] = []
    let pathValue: string | undefined
    let aggregateBytes = 0
    let requestBytes = 0
    let fatalError: ReturnType<typeof uploadError> | undefined

    const fail = (error: ReturnType<typeof uploadError>) => {
        if (!fatalError) fatalError = error
        files.length = 0
    }

    return new Promise<ParsedUpload>((resolve, reject) => {
        let settled = false
        let parser: InstanceType<typeof Busboy>
        try {
            parser = new Busboy({
                headers: request.headers as ConstructorParameters<typeof Busboy>[0]["headers"],
                preservePath: false,
                limits: {
                    fieldNameSize: 32,
                    fieldSize: MAX_UPLOAD_PATH_BYTES,
                    fields: 1,
                    fileSize: MAX_UPLOAD_FILE_BYTES,
                    files: MAX_UPLOAD_FILES,
                    parts: MAX_UPLOAD_FILES + 1,
                    headerPairs: 50,
                    headerSize: 8 * 1024,
                },
            })
        } catch {
            reject(uploadError(400, "Invalid multipart request"))
            return
        }

        const cleanup = () => request.off("data", countRequestBytes)
        const rejectEarly = (error: ReturnType<typeof uploadError>) => {
            if (settled) return
            settled = true
            cleanup()
            request.unpipe(parser)
            request.resume()
            reject(error)
        }

        function countRequestBytes(chunk: Buffer | Uint8Array | string) {
            requestBytes += Buffer.byteLength(chunk)
            if (requestBytes > MAX_UPLOAD_REQUEST_BYTES) {
                fail(uploadError(413, "Upload request is too large"))
                rejectEarly(fatalError!)
            }
        }
        request.on("data", countRequestBytes)

        parser.on("file", (
            fieldName: string,
            stream: BusboyFileStream,
            filename: string,
            _encoding: string,
            mimeType: string,
        ) => {
            if (fieldName !== "files" || !filename) {
                fail(uploadError(400, "Unexpected multipart file field"))
                stream.resume()
                return
            }

            let fileBytes = 0
            const chunks: Buffer[] = []
            stream.on("limit", () => {
                chunks.length = 0
                fail(uploadError(413, `An image exceeds ${MAX_UPLOAD_FILE_BYTES} bytes`))
            })
            stream.on("data", (value: Buffer | Uint8Array | string) => {
                const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
                fileBytes += chunk.byteLength
                aggregateBytes += chunk.byteLength
                if (aggregateBytes > MAX_UPLOAD_AGGREGATE_BYTES) {
                    chunks.length = 0
                    fail(uploadError(413, "Combined image upload is too large"))
                    return
                }
                if (!fatalError) chunks.push(chunk)
            })
            stream.on("error", () => rejectEarly(uploadError(400, "Invalid multipart file")))
            stream.on("end", () => {
                if (stream.truncated || fileBytes > MAX_UPLOAD_FILE_BYTES || fatalError) {
                    chunks.length = 0
                    return
                }
                files.push({
                    name: "files",
                    filename,
                    type: mimeType || "application/octet-stream",
                    data: Buffer.concat(chunks, fileBytes),
                })
            })
        })

        parser.on("field", (fieldName, value, fieldNameTruncated, valueTruncated) => {
            if (fieldName !== "path") {
                fail(uploadError(400, "Unexpected multipart field"))
                return
            }
            if (pathValue !== undefined) {
                fail(uploadError(400, "Duplicate path"))
                return
            }
            if (fieldNameTruncated || valueTruncated || Buffer.byteLength(value) > MAX_UPLOAD_PATH_BYTES) {
                fail(uploadError(400, "Upload path is too long"))
                return
            }
            pathValue = value
        })
        parser.on("filesLimit", () => fail(uploadError(413, `At most ${MAX_UPLOAD_FILES} images can be uploaded at once`)))
        parser.on("fieldsLimit", () => fail(uploadError(400, "Too many multipart fields")))
        parser.on("partsLimit", () => fail(uploadError(413, "Too many multipart parts")))
        parser.on("error", () => rejectEarly(uploadError(400, "Invalid multipart request")))
        request.on("aborted", () => rejectEarly(uploadError(400, "Upload was interrupted")))
        request.on("error", () => rejectEarly(uploadError(400, "Could not read upload request")))

        parser.on("finish", () => {
            if (settled) return
            settled = true
            cleanup()
            if (fatalError) {
                reject(fatalError)
                return
            }
            if (pathValue === undefined) {
                reject(uploadError(400, "Missing path"))
                return
            }
            if (files.length === 0) {
                reject(uploadError(400, "No files attached"))
                return
            }
            resolve({ path: pathValue, files })
        })

        request.pipe(parser)
    })
}
