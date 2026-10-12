import {createError, getRouterParam} from 'h3'
import {useDB} from '~~/server/utils/useDB'

export default defineEventHandler(async event => {
    const account = await useAuth(event)
    const id = Number(getRouterParam(event, 'id'))
    if (!Number.isSafeInteger(id) || id < 1) {
        throw createError({statusCode: 400, statusMessage: 'Invalid generation id'})
    }

    const db = await useDB(undefined, account)
    const row = await db.getSystemPrompt(id)
    if (!row) throw createError({statusCode: 404, statusMessage: 'Generation not found'})
    return {
        ok: true,
        item: {
            ...row,
            outputImage: row.outputImage || null,
            status: row.status ?? (row.errors ? 'failed' : 'succeeded'),
        },
    }
})
