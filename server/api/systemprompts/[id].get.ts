import {createError, getRouterParam, setHeader} from 'h3'
import {useDB} from '~~/server/utils/useDB'
import {publicGeneration} from '../../utils/generationVisibility'

export default defineEventHandler(async event => {
    const account = await useAuth(event)
    setHeader(event, 'cache-control', 'no-store')
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isSafeInteger(id) || id < 1) {
        throw createError({statusCode: 400, statusMessage: 'Invalid generation id'})
    }

    const db = await useDB(undefined, account)
    const row = await db.getSystemPrompt(id)
    if (!row) throw createError({statusCode: 404, statusMessage: 'Generation not found'})
    return {
        ok: true,
        item: publicGeneration({
            ...row,
            outputImage: row.outputImage || null,
            status: row.status ?? (row.errors ? 'failed' : 'succeeded'),
        }),
    }
})
