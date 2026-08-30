import { createError } from "h3"
import { installBoundedRawBody } from "../utils/boundedRequestBody"

export default defineEventHandler(async (event) => {
    useAuth(event)
    assertMethod(event, "POST")

    await installBoundedRawBody(event, 16 * 1024)
    const body = await readBody<{ path?: string; name?: string }>(event)
    if (!body?.name) {
        throw createError({ statusCode: 400, statusMessage: "Missing folder name" })
    }

    const fs = await useFS()
    await fs.createFolder(body.path ?? "/", body.name)
    return { ok: true }
})
