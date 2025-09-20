import {GoogleGenAI} from '@google/genai'
import * as mainSchema from '../../schemas/main.dto'
import mime from 'mime'

export async function useGemini() {
    const runtimeConfig = useRuntimeConfig()
    const apiKey = runtimeConfig.GeminiApiKey
    if (!apiKey) {
        throw createError({statusCode: 500, statusMessage: 'Gemini API key is missing in runtimeConfig.GeminiApiKey'})
    }
    const defaultModel = runtimeConfig.public.GeminiModels.gemini25FlashIOImagePreview || 'models/gemini-2.0-flash-exp'

    const ai = new GoogleGenAI({apiKey})
    const fs = await useFS()

    async function generateStream(opts: mainSchema.GenerateOptions) {
        const model = opts.model || defaultModel
        const config = {
            responseModalities: ['IMAGE', 'TEXT'],
            safetySettings: [
                {
                    category: 'HARM_CATEGORY_HATE_SPEECH',
                    threshold: 'OFF',
                },
                {
                    category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                    threshold: 'OFF',
                },
                {
                    category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                    threshold: 'OFF',
                },
                {
                    category: 'HARM_CATEGORY_HARASSMENT',
                    threshold: 'OFF',
                }
            ],
        } as any

        const userPromptPart = {text: opts.prompt}
        let allImages = [...opts.inputImages]
        if (opts.modelImages) {
            allImages = [...allImages, ...opts.modelImages]
        }

        const inlineParts: any[] = []
        for (const i of allImages) {
            const fileBuf = await fs.getFile(i)
            const inlineData = {
                inlineData: {
                    mimeType: mime.getType(i) || 'application/octet-stream',
                    data: Buffer.from(fileBuf).toString('base64'),
                },
            }
            inlineParts.push(inlineData)
        }

        const contents = [
            {
                role: 'user',
                parts: [userPromptPart, ...inlineParts],
            },
        ]

        // Use non-streaming response since we only care about images and will
        // return the first image buffer directly.
        const response = await ai.models.generateContent({model, config, contents})

        // Try to extract the first inlineData part (image) and return it as a Buffer
        const parts = response?.candidates?.[0]?.content?.parts as any[] | undefined
        if (parts && parts.length > 0) {
            const p0 = parts.find(p => p?.inlineData) || parts[0]
            if (p0?.inlineData) {
                const mt = p0.inlineData.mimeType || ''
                const buf = Buffer.from(p0.inlineData.data || response.data || '', 'base64')
                return {buffer: buf, mimeType: mt}
            }
        }

        // If image part not found, but response has inline data via helper, try that.
        const base64 = (response as any)?.data
        if (typeof base64 === 'string' && base64.length > 0) {
            return {buffer: Buffer.from(base64, 'base64'), mimeType: 'image/png'}
        }

        // Fallback: if there is text only, return it as an error-like result.
        const text = (response as any)?.text
        if (typeof text === 'string' && text.length > 0) {
            throw createError({
                statusCode: 500,
                statusMessage: `Expected image output but got text: ${text.slice(0, 200)}`
            })
        }

        throw createError({
            statusCode: 500,
            statusMessage: 'No image returned from Gemini ' + response.promptFeedback?.blockReason + ' | ' + opts.inputImages
        })
    }

    return {generateStream}
}
