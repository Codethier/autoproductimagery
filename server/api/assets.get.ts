import {AssetListingQuerySchema} from '~~/schemas/image-storage'

export default defineEventHandler(async event => {
    const actor = await useAuth(event)
    assertMethod(event, 'GET')
    const parsed = AssetListingQuerySchema.safeParse(getQuery(event))
    if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid asset listing request'})
    const storage = await useUserFS(actor)
    return storage.listAssets(parsed.data)
})
