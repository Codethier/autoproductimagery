import { GoogleGenAI } from '@google/genai'
import * as mainSchema from '../../schemas/main.dto'


export function useGemini() {
  const runtimeConfig = useRuntimeConfig()
  const apiKey = runtimeConfig.GeminiApiKey
  if (!apiKey) {
    throw createError({ statusCode: 500, statusMessage: 'Gemini API key is missing in runtimeConfig.GeminiApiKey' })
  }
  const defaultModel = runtimeConfig.public.GeminiModel || 'models/gemini-2.0-flash-exp'

  const ai = new GoogleGenAI({ apiKey })

  async function generateStream(opts: mainSchema.GenerateOptions) {
    const model = opts.model || defaultModel
    const config = {
      responseModalities: opts.responseModalities || ['IMAGE','TEXT'],
    } as any

      const userPromptPart = {text: opts.prompt}
      const imagesParts = (opts.inputImages || []).map(image => ({
          inlineData: {
              mimeType: image.mimeType,
              data: image.dataBase64
          }
      }))

      const contents = [
          {
              role: 'user',
              parts: [
                  userPromptPart,
                  ...imagesParts
              ],
          },
      ]

    const response = await ai.models.generateContentStream({ model, config, contents })

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
