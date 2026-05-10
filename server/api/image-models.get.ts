import {z} from 'zod'
import {isImageCapableModel, useGateway, type GatewayModelInfo} from '~~/server/utils/useGateway'

const QuerySchema = z.object({
    provider: z.string().min(1).max(64).optional(),
    search: z.string().min(1).max(200).optional(),
    refresh: z.union([z.literal('1'), z.literal('true')]).optional(),
})

export type ImageModelInfo = {
    id: string
    name: string
    description?: string | null
    provider: string
    modelType: 'language' | 'image'
    pricing?: GatewayModelInfo['pricing']
}

export default defineEventHandler(async (event) => {
    useAuth(event)

    const parsed = QuerySchema.safeParse(getQuery(event))
    if (!parsed.success) {
        throw createError({statusCode: 400, statusMessage: `Invalid query: ${parsed.error.message}`})
    }
    const {provider, search, refresh} = parsed.data
    const force = refresh === '1' || refresh === 'true'

    const gw = await useGateway()
    if (force) gw.invalidateModelCache()

    let all: GatewayModelInfo[]
    try {
        all = await gw.listModels()
    } catch (e: any) {
        throw createError({statusCode: 502, statusMessage: `Failed to list models: ${e?.message || e}`})
    }

    let items: ImageModelInfo[] = all
        .filter(isImageCapableModel)
        .map(m => ({
            id: m.id,
            name: m.name,
            description: m.description,
            provider: m.provider,
            modelType: (m.modelType === 'image' ? 'image' : 'language') as 'language' | 'image',
            pricing: m.pricing,
        }))

    if (provider) items = items.filter(m => m.provider === provider)
    if (search) {
        const q = search.toLowerCase()
        items = items.filter(m =>
            m.id.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q) ||
            (m.description || '').toLowerCase().includes(q),
        )
    }

    return {ok: true, items, total: items.length}
})
