import { createError } from "h3"

export default defineEventHandler(async (event) => {
    useAuth(event)
    assertMethod(event, "DELETE")

    const body = await readBody<{ path?: string }>(event)
    if (!body?.path) {
        throw createError({ statusCode: 400, statusMessage: "Missing path" })
    }

    const fs = await useFS()
    await fs.deleteFileOrFolder(body.path)
    return { ok: true }
})
