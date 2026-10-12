import {z} from 'zod'
import {installBoundedRawBody} from '../../utils/boundedRequestBody'

const schema = z.object({urls: z.array(z.string().min(1).max(4096)).max(200)}).strict()
export default defineEventHandler(async event => {
    const actor = await useAuth(event)
    assertMethod(event, 'POST')
    await installBoundedRawBody(event, 1024 * 1024)
    const parsed = schema.safeParse(await readBody(event))
    if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid asset selection'})
    return {files: await (await useUserFS(actor)).resolveAssets(parsed.data.urls)}
})
