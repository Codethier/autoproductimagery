import { createError } from "h3"

export default defineEventHandler(async (event) => {
    useAuth(event)
    assertMethod(event, "POST")

    const body = await readBody<{ path?: string; name?: string }>(event)
    if (!body?.name) {
        throw createError({ statusCode: 400, statusMessage: "Missing folder name" })
    }

    const fs = await useFS()
    await fs.createFolder(body.path ?? "/", body.name)
    return { ok: true }
})
