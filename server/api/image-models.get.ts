import { z } from 'zod'
import {
    IMAGE_MODEL_PROFILES,
    SUPPORTED_IMAGE_MODEL_IDS,
    type ImageModelProfile,
} from '~~/schemas/image-generation'
import {
    enrichImageModelInfo,
    useGateway,
    type GatewayModelInfo,
} from '~~/server/utils/useGateway'

const QuerySchema = z.object({
    provider: z.enum(['google', 'openai']).optional(),
    search: z.string().min(1).max(200).optional(),
    refresh: z.union([z.literal('1'), z.literal('true')]).optional(),
})

function capabilitiesFor(profile: ImageModelProfile) {
    return {
        referenceInputScope: 'images-only' as const,
        output: profile.supportsTextOutput ? ['image', 'text'] : ['image'],
        input: profile.maxReferenceImages > 1
            ? ['text', 'image', 'multiple-images']
            : ['text', 'image'],
        operations: profile.maxReferenceImages > 1
            ? ['text-to-image', 'image-edit', 'image-to-image', 'multi-reference']
            : ['text-to-image', 'image-edit', 'image-to-image'],
        warnings: [...profile.warnings, ...(profile.lifecycleNote ? [profile.lifecycleNote] : [])],
    }
}

export default defineEventHandler(async (event) => {
    useAuth(event)
    const parsed = QuerySchema.safeParse(getQuery(event))
    if (!parsed.success) {
        throw createError({statusCode: 400, statusMessage: `Invalid query: ${parsed.error.message}`})
    }

    const gateway = await useGateway()
    if (parsed.data.refresh === '1' || parsed.data.refresh === 'true') gateway.invalidateModelCache()

    let catalog = new Map<string, GatewayModelInfo>()
    let catalogError: string | undefined
    try {
        catalog = new Map((await gateway.listModels()).map(model => [model.id, model]))
    } catch (error: any) {
        catalogError = String(error?.message || error)
    }

    let items = SUPPORTED_IMAGE_MODEL_IDS.map(id => {
        const profile = IMAGE_MODEL_PROFILES[id]
        const live = catalog.get(id)
        const enriched = live ? enrichImageModelInfo(live) : undefined
        return {
            id,
            name: profile.name,
            description: live?.description || profile.description,
            provider: profile.provider,
            modelType: profile.adapter === 'gateway-image' ? 'image' as const : 'language' as const,
            available: !!live,
            catalogStatus: catalogError ? 'unknown' as const : (live ? 'available' as const : 'unavailable' as const),
            availabilityNote: live
                ? undefined
                : catalogError
                    ? 'The AI Gateway catalog could not be verified. Refresh after checking the Gateway key and connection.'
                    : 'This exact model ID is not currently listed by AI Gateway.',
            pricing: live?.pricing ?? null,
            pricingDetails: enriched?.pricingDetails,
            capabilities: capabilitiesFor(profile),
            profile,
        }
    })

    if (parsed.data.provider) items = items.filter(item => item.provider === parsed.data.provider)
    if (parsed.data.search) {
        const query = parsed.data.search.toLowerCase()
        items = items.filter(item =>
            item.id.toLowerCase().includes(query)
            || item.name.toLowerCase().includes(query)
            || item.description.toLowerCase().includes(query),
        )
    }

    return {
        ok: !catalogError,
        items,
        total: items.length,
        catalogError,
    }
})
