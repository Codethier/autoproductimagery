import {createHash} from 'node:crypto'
import {createError} from 'h3'
import type {AssetActor, AssetRecord} from './assetAccess'

export const IMAGE_PREVIEW_SIZES = [160, 480, 960, 1600] as const
export type ImagePreviewSize = typeof IMAGE_PREVIEW_SIZES[number]

/** A fixed set prevents arbitrary transform dimensions and cache-key amplification. */
export function parseImagePreviewSize(query: Record<string, unknown>): ImagePreviewSize | undefined {
    if (Object.keys(query).some(key => key !== 'preview')) {
        throw createError({statusCode: 400, statusMessage: 'Invalid image preview request'})
    }
    if (query.preview === undefined) return undefined
    if (typeof query.preview !== 'string' || !IMAGE_PREVIEW_SIZES.some(size => String(size) === query.preview)) {
        throw createError({statusCode: 400, statusMessage: 'Invalid image preview size'})
    }
    return Number(query.preview) as ImagePreviewSize
}

/** Registry URLs are immutable. Scope the validator to the current account and representation.
 * Weak validators describe equivalent pixels; encoder upgrades may change WebP bytes. */
export function imageDeliveryEtag(actor: AssetActor, row: AssetRecord, preview?: ImagePreviewSize): string {
    const revision = imageDeliveryRevision(row, preview)
    return `W/"${createHash('sha256').update(JSON.stringify([actor.organizationId, actor.userId, revision])).digest('base64url')}"`
}

export function imageDeliveryRevision(row: AssetRecord, preview?: ImagePreviewSize): string {
    return createHash('sha256').update(JSON.stringify(['image-delivery-v1', row.id, row.url,
        row.byteSize, row.mimeType, row.width, row.height, new Date(row.updatedAt).toISOString(), preview ?? 'original'])).digest('base64url')
}

export function matchesImageEtag(header: string | undefined, etag: string): boolean {
    if (!header || header.length > 4096) return false
    const value = etag.replace(/^W\//, '')
    return header.split(',').some(part => {
        const candidate = part.trim()
        return candidate === '*' || candidate.replace(/^W\//, '') === value
    })
}
