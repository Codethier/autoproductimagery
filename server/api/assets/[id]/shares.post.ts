import {ShareAssetSchema} from '../../../../schemas/image-storage'
import {installBoundedRawBody} from '../../../utils/boundedRequestBody'

export default defineEventHandler(async event => {
    const actor = await useAuth(event)
    assertMethod(event, 'POST')
    await installBoundedRawBody(event, 16 * 1024)
    const parsed = ShareAssetSchema.safeParse(await readBody(event))
    if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid sharing request'})
    await (await useUserFS(actor)).share(getRouterParam(event, 'id') ?? '', parsed.data.recipientUserId, parsed.data.permission)
    return {ok: true}
})
