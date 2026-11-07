import {z} from 'zod'
import {setHeader} from 'h3'
import {useDB} from '~~/server/utils/useDB'
import {hasConfirmedGenerationPrice} from '~~/schemas/generation-billing'

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
})

export default defineEventHandler(async (event) => {
    const account = await useAuth(event)
    setHeader(event, 'cache-control', 'no-store')

    const parsed = QuerySchema.safeParse(getQuery(event))
    if (!parsed.success) {
        throw createError({statusCode: 400, statusMessage: `Invalid query: ${parsed.error.message}`})
    }

    const db = await useDB(undefined, account)
    const items = await db.getAiGatewayLogs(parsed.data.limit ?? 50)
    const visibility = await db.getGenerationBillingVisibility([...new Set(items.flatMap(item => item.systemPromptId ? [item.systemPromptId] : []))])
    const visibleIds = new Set(visibility.filter(hasConfirmedGenerationPrice).map(row => row.id))
    return {ok: true, items: items.map(item => ({...item,
        outputImage: item.systemPromptId && visibleIds.has(item.systemPromptId) ? item.outputImage : null,
    }))}
})
