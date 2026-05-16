import {z} from 'zod'
import {useDB} from '~~/server/utils/useDB'

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
})

export default defineEventHandler(async (event) => {
    useAuth(event)

    const parsed = QuerySchema.safeParse(getQuery(event))
    if (!parsed.success) {
        throw createError({statusCode: 400, statusMessage: `Invalid query: ${parsed.error.message}`})
    }

    const db = await useDB()
    const items = await db.getAiGatewayLogs(parsed.data.limit ?? 50)
    return {ok: true, items}
})
