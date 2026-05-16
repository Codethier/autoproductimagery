import {z} from 'zod'
import {useDB} from '~~/server/utils/useDB'
import {useGateway} from '~~/server/utils/useGateway'

const ParamsSchema = z.object({
    id: z.coerce.number().int().positive(),
})

export default defineEventHandler(async (event) => {
    useAuth(event)

    const parsed = ParamsSchema.safeParse(event.context.params)
    if (!parsed.success) {
        throw createError({statusCode: 400, statusMessage: `Invalid id: ${parsed.error.message}`})
    }

    const db = await useDB()
    const row = await db.getSystemPrompt(parsed.data.id)
    if (!row) {
        throw createError({statusCode: 404, statusMessage: 'Generated image record not found'})
    }
    if (!row.gatewayGenerationId) {
        throw createError({statusCode: 409, statusMessage: 'No Gateway generation id is stored for this image'})
    }

    const gw = await useGateway()
    const billing = await gw.getGenerationBilling(row.gatewayGenerationId, row.generationModel || undefined)
    if (!billing?.priceUsd) {
        throw createError({
            statusCode: 425,
            statusMessage: 'Gateway billing is not available yet. Try again shortly.',
        })
    }

    const updated = await db.updateSystemPromptBilling(row.id, billing)
    return {ok: true, item: updated}
})
