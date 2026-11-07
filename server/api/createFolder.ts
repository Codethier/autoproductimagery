import { createError } from "h3"
import { installBoundedRawBody } from "../utils/boundedRequestBody"
import {CreateImageFolderSchema} from '~~/schemas/image-storage'

export default defineEventHandler(async (event) => {
    const actor = await useAuth(event)
    assertMethod(event, "POST")

    await installBoundedRawBody(event, 16 * 1024)
    const parsed = CreateImageFolderSchema.safeParse(await readBody(event))
    if (!parsed.success) {
        throw createError({ statusCode: 400, statusMessage: "Invalid folder request" })
    }
    const body = parsed.data

    const fs = await useUserFS(actor)
    const folder = await fs.createFolder(body.path ?? "/", body.name)
    return { ok: true, folder }
})
