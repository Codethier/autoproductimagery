import {z} from 'zod'
import {createError, setHeader} from 'h3'
import {useDB} from '~~/server/utils/useDB'
import {hasConfirmedGenerationPrice} from '~~/schemas/generation-billing'
import {publicGeneration} from '../../../utils/generationVisibility'
import {reconcilePendingAccountBilling} from '../../../utils/reconcilePendingAccountBilling'

const ParamsSchema = z.object({
    id: z.coerce.number().int().positive(),
})

export default defineEventHandler(async (event) => {
    const account = await useAuth(event)
    setHeader(event, 'cache-control', 'no-store')

    const parsed = ParamsSchema.safeParse(event.context.params)
    if (!parsed.success) {
        throw createError({statusCode: 400, statusMessage: `Invalid id: ${parsed.error.message}`})
    }

    const db = await useDB(undefined, account)
    const row = await db.getSystemPrompt(parsed.data.id)
    if (!row) {
        throw createError({statusCode: 404, statusMessage: 'Generated image record not found'})
    }
    // Repeated clicks never reprice a settled generation or debit it again.
    if (hasConfirmedGenerationPrice(row)) return {ok: true, item: publicGeneration(row)}
    if (!row.gatewayGenerationId) {
        throw createError({statusCode: 409, statusMessage: 'No Gateway generation id is stored for this image'})
    }

    await reconcilePendingAccountBilling(account, {generationId: row.id, limit: 1, lookupTimeoutMs: 10_000})
    const updated = await db.getSystemPrompt(row.id)
    if (!updated || !hasConfirmedGenerationPrice(updated)) {
        throw createError({
            statusCode: 425,
            statusMessage: 'Gateway billing is not available yet. Try again shortly.',
        })
    }

    return {ok: true, item: publicGeneration(updated)}
})
