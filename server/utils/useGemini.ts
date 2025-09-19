import { GoogleGenAI } from '@google/genai'
import * as mainSchema from '../../schemas/main.dto'


export async function useGemini() {
  const runtimeConfig = useRuntimeConfig()
  const apiKey = runtimeConfig.GeminiApiKey
  if (!apiKey) {
    throw createError({ statusCode: 500, statusMessage: 'Gemini API key is missing in runtimeConfig.GeminiApiKey' })
  }
  const defaultModel = runtimeConfig.public.GeminiModels.gemini25FlashIOImagePreview || 'models/gemini-2.0-flash-exp'

  const ai = new GoogleGenAI({ apiKey })
  const fs = await useFS()

  function guessMimeType(path: string): string {
    const ext = (path.split('.').pop() || '').toLowerCase()
    switch (ext) {
      case 'png': return 'image/png'
      case 'jpg':
      case 'jpeg': return 'image/jpeg'
      case 'webp': return 'image/webp'
      case 'gif': return 'image/gif'
      case 'svg':
      case 'svgz': return 'image/svg+xml'
      case 'bmp': return 'image/bmp'
      case 'tif':
      case 'tiff': return 'image/tiff'
      default: return 'application/octet-stream'
    }
  }

  async function generateStream(opts: mainSchema.GenerateOptions) {
    const model = opts.model || defaultModel
    const config = {
      responseModalities: opts.responseModalities || ['IMAGE','TEXT'],
    } as any

    const userPromptPart = { text: opts.prompt }
    let allImages = [...opts.inputImages]
    if (opts.modelImages) {
      allImages = [...allImages, ...opts.modelImages]
    }

    const l: any[] = []
    for (const i of allImages) {
      const fileBuf = await fs.getFile(i)
      const inlineData = {
        inlineData: {
          mimeType: guessMimeType(i),
          data: Buffer.from(fileBuf).toString('base64'),
        },
      }
      l.push(inlineData)
    }

    const contents = [
      {
        role: 'user',
        parts: [
          userPromptPart,
          ...l,
        ],
      },
    ]

    const response = await (ai as any).models.generateContentStream({ model, config, contents })

    async function* iterator(): AsyncGenerator<mainSchema.StreamChunk> {
      for await (const chunk of response as any) {
        const parts = chunk?.candidates?.[0]?.content?.parts
        if (!parts || parts.length === 0) continue
        const p0 = parts[0]
        if (p0?.inlineData) {
          const mt = p0.inlineData.mimeType || ''
          const buf = Buffer.from(p0.inlineData.data || '', 'base64')
          yield { type: 'image', data: buf, mimeType: mt }
        } else if (typeof chunk.text === 'string') {
          yield { type: 'text', data: chunk.text }
        }
      }
    }

    return iterator()
  }

  return { generateStream }
}
