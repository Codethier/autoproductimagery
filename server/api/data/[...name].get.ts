import { createError, send, setHeader } from "h3"
import {imagePathFromRequestUrl} from '../../utils/imageServingPath'

export default defineEventHandler(async (event) => {
    const actor = await useAuth(event)
    assertMethod(event, "GET")

    const params = event.context.params as { name?: string | string[] } | undefined
    if (!params || params.name == null) {
        throw createError({ statusCode: 400, statusMessage: "Missing image path" })
    }
    const imagePath = imagePathFromRequestUrl(event.node.req.url ?? event.path)
    const imageFs = await useUserFS(actor)
    const image = await imageFs.getImageFile(imagePath)
    setHeader(event, "content-type", image.mimeType)
    setHeader(event, "content-length", image.buffer.byteLength)
    setHeader(event, "x-content-type-options", "nosniff")
    setHeader(event, "cache-control", "private, no-store")
    await send(event, image.buffer)
})
