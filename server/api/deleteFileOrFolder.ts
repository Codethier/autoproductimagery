import { createError } from "h3"
import { installBoundedRawBody } from "../utils/boundedRequestBody"

export default defineEventHandler(async (event) => {
    useAuth(event)
    assertMethod(event, "DELETE")

    await installBoundedRawBody(event, 16 * 1024)
    const body = await readBody<{ path?: string }>(event)
    if (!body?.path) {
        throw createError({ statusCode: 400, statusMessage: "Missing path" })
    }

    const fs = await useFS()
    await fs.deleteFileOrFolder(body.path)
    return { ok: true }
})
