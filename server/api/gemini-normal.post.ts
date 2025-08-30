export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt?: string; model?: string; images?: Array<{ mimeType: string; data?: string; dataBase64?: string }> }>(event)
  if (!body?.prompt) {
    throw createError({ statusCode: 400, statusMessage: 'Missing prompt' })
  }

  const { generateStream } = useGemini()

  const inputImages = (body.images || []).map(i => ({ mimeType: i.mimeType, dataBase64: i.dataBase64 || i.data || '' })).filter(i => i.mimeType && i.dataBase64)

  const iterator = await generateStream({ prompt: body.prompt, model: body.model, inputImages })

  // Collect all text and all image chunks
  let text = ''
  const images: Array<{ mimeType: string; data: string }> = []
  for await (const ch of iterator) {
    if (ch.type === 'text') {
      text += String(ch.data)
    } else if (ch.type === 'image' && ch.data instanceof Buffer) {
      images.push({ mimeType: ch.mimeType || 'image/png', data: ch.data.toString('base64') })
    }
  }

  return { text, images }
})
