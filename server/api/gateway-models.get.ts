import {z} from 'zod'
import {type GatewayModelInfo, useGateway} from '~~/server/utils/useGateway'
import {SUPPORTED_IMAGE_MODEL_IDS} from '~~/schemas/image-generation'

const QuerySchema = z.object({
    type: z.enum(['language', 'image']).optional(),
    search: z.string().min(1).max(200).optional(),
    refresh: z.union([z.literal('1'), z.literal('true')]).optional(),
})

let cache: { at: number; items: GatewayModelInfo[] } | null = null
const CACHE_TTL_MS = 10 * 60 * 1000
const CURATED_IMAGE_MODELS = new Set<string>(SUPPORTED_IMAGE_MODEL_IDS)

export default defineEventHandler(async (event) => {
    useAuth(event)

    const parsed = QuerySchema.safeParse(getQuery(event))
    if (!parsed.success) {
        throw createError({statusCode: 400, statusMessage: `Invalid query: ${parsed.error.message}`})
    }
    const {type, search, refresh} = parsed.data
    const force = refresh === '1' || refresh === 'true'

    let items: GatewayModelInfo[]
    let cached = false
    if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
        items = cache.items
        cached = true
    } else {
        const gw = await useGateway()
        items = (await gw.listModels()).filter(model => CURATED_IMAGE_MODELS.has(model.id))
        cache = {at: Date.now(), items}
    }

    let filtered = items
    if (type) filtered = filtered.filter(m => m.modelType === type)
    if (search) {
        const q = search.toLowerCase()
        filtered = filtered.filter(m =>
            m.id.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q) ||
            (m.description || '').toLowerCase().includes(q),
        )
    }

    return {ok: true, items: filtered, cached, total: items.length}
})
