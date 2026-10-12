import { createError } from "h3"
import { installBoundedRawBody } from "../utils/boundedRequestBody"
import {DeleteImageEntrySchema} from '~~/schemas/image-storage'

export default defineEventHandler(async (event) => {
    const actor = await useAuth(event)
    assertMethod(event, "DELETE")

    await installBoundedRawBody(event, 16 * 1024)
    const parsed = DeleteImageEntrySchema.safeParse(await readBody(event))
    if (!parsed.success) {
        throw createError({ statusCode: 400, statusMessage: "Invalid deletion request" })
    }
    const body = parsed.data

    const fs = await useUserFS(actor)
    await fs.deleteFileOrFolder(body.path, body.entryType)
    return { ok: true }
})
