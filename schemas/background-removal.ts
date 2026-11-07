import {z} from 'zod'

export const BackgroundRemovalModelSchema = z.enum(['birefnet-lite', 'birefnet'])
export type BackgroundRemovalModel = z.infer<typeof BackgroundRemovalModelSchema>
export type BackgroundRemovalStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type BackgroundRemovalError = {
    code: 'PROCESSING_INTERRUPTED' | 'SOURCE_UNAVAILABLE' | 'PROCESSING_TIMEOUT' | 'PROCESSING_FAILED' | 'MODEL_UNAVAILABLE' | 'INSUFFICIENT_MEMORY'
    message: string
    retryable: boolean
}
export const CreateBackgroundRemovalSchema = z.object({
    sourceUrl: z.string().min(1).max(4096),
    model: BackgroundRemovalModelSchema,
    idempotencyKey: z.uuid(),
}).strict()
export type CreateBackgroundRemoval = z.infer<typeof CreateBackgroundRemovalSchema>

export const BackgroundRemovalListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
}).strict()

export type BackgroundRemovalJob = {
    id: string
    sourceUrl: string
    model: BackgroundRemovalModel
    modelVersion: string
    status: BackgroundRemovalStatus
    attempts: number
    outputAssetId: string | null
    outputUrl: string | null
    outputExpired?: boolean
    providerPriceUsd: '0'
    priceSource: 'local-processing'
    error: BackgroundRemovalError | null
    createdAt: string
    updatedAt: string
    startedAt: string | null
    completedAt: string | null
}
