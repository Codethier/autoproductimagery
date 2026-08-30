/**
 * Create a Buffer over the exact Uint8Array window without copying its bytes.
 * The caller must keep the returned Buffer immutable while provider response
 * objects may still reference the same backing storage.
 */
export function toBufferView(bytes: Uint8Array): Buffer {
    if (Buffer.isBuffer(bytes)) return bytes
    return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)
}
