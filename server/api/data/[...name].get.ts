import { createError, send, setHeader } from "h3"

export default defineEventHandler(async (event) => {
    useAuth(event)
    assertMethod(event, "GET")

    const params = event.context.params as { name?: string | string[] } | undefined
    if (!params || params.name == null) {
        throw createError({ statusCode: 400, statusMessage: "Missing image path" })
    }
    const rawSegments = Array.isArray(params.name) ? params.name : [params.name]
    const imagePath = `/${rawSegments.join("/")}`
    const imageFs = await useFS()
    const image = await imageFs.getImageFile(imagePath)
    setHeader(event, "content-type", image.mimeType)
    setHeader(event, "content-length", image.buffer.byteLength)
    setHeader(event, "x-content-type-options", "nosniff")
    await send(event, image.buffer)
})
