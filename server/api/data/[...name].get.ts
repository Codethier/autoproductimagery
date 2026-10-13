import { createError, getHeader, getQuery, send, setHeader, setResponseStatus } from "h3"
import {imagePathFromRequestUrl} from '../../utils/imageServingPath'
import {parseImagePreviewSize} from '../../utils/imageDeliveryPolicy'

export default defineEventHandler(async (event) => {
    // Errors and unauthorized responses must never inherit a reusable private image response.
    setHeader(event, "cache-control", "private, no-store")
    setHeader(event, "vary", "Cookie")
    const actor = await useAuth(event)
    assertMethod(event, "GET")

    const params = event.context.params as { name?: string | string[] } | undefined
    if (!params || params.name == null) {
        throw createError({ statusCode: 400, statusMessage: "Missing image path" })
    }
    const imagePath = imagePathFromRequestUrl(event.node.req.url ?? event.path)
    const preview = parseImagePreviewSize(getQuery(event))
    const imageFs = await useUserFS(actor)
    const image = await imageFs.getImageForDelivery(imagePath, preview, getHeader(event, 'if-none-match'))
    setHeader(event, "cache-control", "private, no-cache, must-revalidate")
    setHeader(event, "etag", image.etag)
    setHeader(event, "x-content-type-options", "nosniff")
    if (image.notModified) {
        setResponseStatus(event, 304)
        return send(event)
    }
    setHeader(event, "content-type", image.mimeType)
    setHeader(event, "content-length", image.buffer.byteLength)
    await send(event, image.buffer)
})
