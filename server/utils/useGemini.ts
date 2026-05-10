import {createGoogleGenerativeAI} from '@ai-sdk/google'
import {generateText} from 'ai'
import * as mainSchema from '../../schemas/main.dto'
import mime from 'mime'

export async function useGemini() {
    const runtimeConfig = useRuntimeConfig()
    const apiKey = runtimeConfig.GeminiApiKey
    if (!apiKey) {
        throw createError({statusCode: 500, statusMessage: 'Gemini API key is missing in runtimeConfig.GeminiApiKey'})
    }
    // Client always sends a selected model; this is a last-resort fallback.
    const defaultModel = 'gemini-2.5-flash-image-preview'

    const google = createGoogleGenerativeAI({apiKey})
    const fs = await useFS()

    async function generateStream(opts: mainSchema.GenerateOptions) {
        const modelId = opts.model || defaultModel

        let allImages = [...opts.inputImages]
        if (opts.modelImages) {
            allImages = [...allImages, ...opts.modelImages]
        }

        const fileParts: Array<{ type: 'file'; data: Buffer; mediaType: string }> = []
        for (const i of allImages) {
            const fileBuf = await fs.getFile(i)
            fileParts.push({
                type: 'file',
                data: Buffer.from(fileBuf),
                mediaType: mime.getType(i) || 'application/octet-stream',
            })
        }

        const safetySettings = [
            {category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF'},
            {category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF'},
            {category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF'},
            {category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF'},
        ]

        let response: Awaited<ReturnType<typeof generateText>>
        try {
            response = await generateText({
                model: google(modelId),
                providerOptions: {
                    google: {
                        responseModalities: ['IMAGE', 'TEXT'],
                        safetySettings,
                        ...(opts.imageConfig ? {imageConfig: opts.imageConfig} : {}),
                    } as any,
                },
                messages: [
                    {
                        role: 'user',
                        content: [
                            {type: 'text', text: opts.prompt},
                            ...fileParts,
                        ],
                    },
                ],
            })
        } catch (e: any) {
            throw createError({
                statusCode: 502,
                statusMessage: `Gemini request failed: ${e?.message || e}`,
                data: {refusedImages: opts.inputImages, reason: e?.message || 'unknown', prompt: opts.prompt},
            })
        }

        const imageFile = (response.files || []).find(f => f.mediaType?.startsWith('image/'))
        if (imageFile) {
            const buf = Buffer.from(imageFile.uint8Array)
            return {buffer: buf, mimeType: imageFile.mediaType || 'image/png'}
        }

        const text = response.text
        if (typeof text === 'string' && text.length > 0) {
            throw createError({
                statusCode: 500,
                statusMessage: `Expected image output but got text: ${text.slice(0, 200)}`,
            })
        }

        const finishReason = response.finishReason
        throw createError({
            statusCode: 422,
            statusMessage: 'GEMINI API refused these images' + (finishReason ? ': ' + finishReason : ''),
            data: {
                refusedImages: opts.inputImages,
                reason: finishReason || 'unknown',
                prompt: opts.prompt,
            },
        })
    }

    return {generateStream}
}
