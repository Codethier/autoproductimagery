import {createGateway, experimental_generateImage as aiGenerateImage, generateText, type LanguageModel} from 'ai'
import mime from 'mime'
import * as mainSchema from '../../schemas/main.dto'

// Supported model types reported by the gateway /config endpoint.
export type GatewayModelType = 'language' | 'image' | 'embedding' | 'reranking' | 'video'

export type GatewayModelInfo = {
    id: string
    name: string
    description?: string | null
    modelType?: GatewayModelType | null
    provider: string
    pricing?: {
        input: string
        output: string
        cachedInputTokens?: string
        cacheCreationInputTokens?: string
    } | null
}

export type ListModelsOpts = {
    type?: GatewayModelType
    search?: string
}

export type ImageGenerationUsage = {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
    reasoningTokens?: number
    raw?: unknown
}

export type ImageGenerationBilling = {
    model?: string
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
    reasoningTokens?: number
    priceUsd?: string
    gatewayGenerationId?: string
    usageJson?: Record<string, unknown>
}

export type GeneratedImage = {
    buffer: Buffer
    mimeType: string
    billing: ImageGenerationBilling
}

let _gateway: ReturnType<typeof createGateway> | null = null
let _modelCache: { at: number; items: GatewayModelInfo[] } | null = null
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000

function getGateway() {
    if (_gateway) return _gateway
    const runtimeConfig = useRuntimeConfig()
    const apiKey = runtimeConfig.AiGatewayApiKey
    if (!apiKey) {
        throw createError({
            statusCode: 500,
            statusMessage: 'AI Gateway API key is missing in runtimeConfig.AiGatewayApiKey (env NUXT_AI_GATEWAY_API_KEY)',
        })
    }
    _gateway = createGateway({apiKey})
    return _gateway
}

/**
 * Heuristic: language-class model that can output images.
 * Gemini image preview, Gemini 3 pro image, etc are all `modelType: 'language'`
 * but support IMAGE response modality via providerOptions.
 */
export function isImageOutputLanguageModel(m: GatewayModelInfo): boolean {
    if (m.modelType !== 'language') return false
    const id = m.id.toLowerCase()
    const name = m.name.toLowerCase()
    const desc = (m.description || '').toLowerCase()
    if (/image/.test(id) && /(preview|gemini|nano|banana)/.test(id)) return true
    if (/imagen/.test(id) || /imagen/.test(name)) return true
    if (/image generation/.test(desc)) return true
    return false
}

export function isImageCapableModel(m: GatewayModelInfo): boolean {
    return m.modelType === 'image' || isImageOutputLanguageModel(m)
}

export async function useGateway() {
    const gateway = getGateway()
    const fs = await useFS()

    async function listModels(opts: ListModelsOpts = {}): Promise<GatewayModelInfo[]> {
        let models: GatewayModelInfo[]
        if (_modelCache && Date.now() - _modelCache.at < MODEL_CACHE_TTL_MS) {
            models = _modelCache.items
        } else {
            const res = await gateway.getAvailableModels()
            models = (res.models || []).map(m => ({
                id: m.id,
                name: m.name,
                description: m.description ?? null,
                modelType: (m.modelType as GatewayModelType | null | undefined) ?? null,
                provider: m.specification?.provider ?? m.id.split('/')[0] ?? 'unknown',
                pricing: m.pricing ?? null,
            }))
            _modelCache = {at: Date.now(), items: models}
        }

        let out = models
        if (opts.type) out = out.filter(m => m.modelType === opts.type)
        if (opts.search) {
            const q = opts.search.toLowerCase()
            out = out.filter(m =>
                m.id.toLowerCase().includes(q) ||
                m.name.toLowerCase().includes(q) ||
                (m.description || '').toLowerCase().includes(q),
            )
        }
        return [...out].sort((a, b) => a.id.localeCompare(b.id))
    }

    async function getModelInfo(id: string): Promise<GatewayModelInfo | undefined> {
        const all = await listModels()
        return all.find(m => m.id === id)
    }

    function asNumber(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }

    function normalizeUsage(usage: any): ImageGenerationUsage {
        if (!usage || typeof usage !== 'object') return {}
        return {
            inputTokens: asNumber(usage.inputTokens),
            outputTokens: asNumber(usage.outputTokens),
            totalTokens: asNumber(usage.totalTokens),
            cachedInputTokens: asNumber(usage.cachedInputTokens ?? usage.inputTokenDetails?.cacheReadTokens),
            reasoningTokens: asNumber(usage.reasoningTokens ?? usage.outputTokenDetails?.reasoningTokens),
            raw: usage.raw,
        }
    }

    function getGatewayGenerationId(providerMetadata: any): string | undefined {
        const id = providerMetadata?.gateway?.generationId
        return typeof id === 'string' && id.length > 0 ? id : undefined
    }

    function priceTokenCount(count: number | undefined, perTokenUsd: string | undefined): number {
        if (count == null || !perTokenUsd) return 0
        const price = Number(perTokenUsd)
        return Number.isFinite(price) ? count * price : 0
    }

    function estimatePriceUsd(usage: ImageGenerationUsage, pricing?: GatewayModelInfo['pricing']): string | undefined {
        if (!pricing) return undefined
        const cached = usage.cachedInputTokens
        const uncachedInputTokens = cached == null
            ? usage.inputTokens
            : Math.max((usage.inputTokens ?? 0) - cached, 0)
        const total =
            priceTokenCount(uncachedInputTokens, pricing.input) +
            priceTokenCount(cached, pricing.cachedInputTokens ?? pricing.input) +
            priceTokenCount(usage.outputTokens, pricing.output)
        return total > 0 ? total.toFixed(8) : undefined
    }

    async function getActualGatewayBilling(generationId: string | undefined) {
        if (!generationId || typeof (gateway as any).getGenerationInfo !== 'function') return undefined
        try {
            return await (gateway as any).getGenerationInfo({id: generationId})
        } catch (e) {
            // Gateway generation-info can lag or return non-standard errors.
            // Billing still falls back to model pricing + reported token usage.
            return undefined
        }
    }

    async function buildBilling(modelId: string, usageSource: any, providerMetadata: any): Promise<ImageGenerationBilling> {
        const usage = normalizeUsage(usageSource)
        const generationId = getGatewayGenerationId(providerMetadata)
        const gatewayBilling = await getActualGatewayBilling(generationId)
        const info = await getModelInfo(modelId)

        const inputTokens = asNumber(gatewayBilling?.promptTokens) ?? usage.inputTokens
        const outputTokens = asNumber(gatewayBilling?.completionTokens) ?? usage.outputTokens
        const cachedInputTokens = asNumber(gatewayBilling?.cachedTokens) ?? usage.cachedInputTokens
        const reasoningTokens = asNumber(gatewayBilling?.reasoningTokens) ?? usage.reasoningTokens
        const totalTokens = usage.totalTokens ?? (
            inputTokens != null || outputTokens != null || reasoningTokens != null
                ? (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0)
                : undefined
        )
        const estimatedPrice = estimatePriceUsd({
            inputTokens,
            outputTokens,
            totalTokens,
            cachedInputTokens,
            reasoningTokens,
        }, info?.pricing)

        return {
            model: typeof gatewayBilling?.model === 'string' ? gatewayBilling.model : modelId,
            inputTokens,
            outputTokens,
            totalTokens,
            cachedInputTokens,
            reasoningTokens,
            priceUsd: asNumber(gatewayBilling?.totalCost)?.toFixed(8) ?? estimatedPrice,
            gatewayGenerationId: generationId,
            usageJson: {
                usage,
                ...(gatewayBilling ? {gatewayBilling} : {}),
                ...(providerMetadata ? {providerMetadata} : {}),
            },
        }
    }

    function invalidateModelCache() {
        _modelCache = null
    }

    async function loadInputFiles(opts: mainSchema.GenerateOptions) {
        const all = [...opts.inputImages, ...(opts.modelImages || [])]
        const out: Array<{ buffer: Buffer; mediaType: string }> = []
        for (const i of all) {
            const buf = await fs.getFile(i)
            out.push({
                buffer: Buffer.from(buf),
                mediaType: mime.getType(i) || 'application/octet-stream',
            })
        }
        return out
    }

    /**
     * Image-out via language-model with IMAGE modality (Gemini family).
     * `providerOptions.google` is forwarded by gateway to Google's backend.
     */
    async function generateImageViaLanguageModel(opts: mainSchema.GenerateOptions & { model: string }): Promise<GeneratedImage> {
        const model: LanguageModel = gateway.languageModel(opts.model)
        const files = await loadInputFiles(opts)

        const safetySettings = [
            {category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF'},
            {category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF'},
            {category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF'},
            {category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF'},
        ]

        let response: Awaited<ReturnType<typeof generateText>>
        try {
            response = await generateText({
                model,
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
                            ...files.map(f => ({type: 'file' as const, data: f.buffer, mediaType: f.mediaType})),
                        ],
                    },
                ],
            })
        } catch (e: any) {
            throw createError({
                statusCode: 502,
                statusMessage: `Gateway request failed: ${e?.message || e}`,
                data: {refusedImages: opts.inputImages, reason: e?.message || 'unknown', prompt: opts.prompt},
            })
        }

        const imageFile = (response.files || []).find(f => f.mediaType?.startsWith('image/'))
        if (imageFile) {
            return {
                buffer: Buffer.from(imageFile.uint8Array),
                mimeType: imageFile.mediaType || 'image/png',
                billing: await buildBilling(response.response?.modelId || opts.model, (response as any).totalUsage ?? response.usage, response.providerMetadata),
            }
        }

        const text = response.text
        if (typeof text === 'string' && text.length > 0) {
            throw createError({
                statusCode: 500,
                statusMessage: `Expected image output but got text: ${text.slice(0, 200)}`,
            })
        }

        throw createError({
            statusCode: 422,
            statusMessage: 'Model refused these images' + (response.finishReason ? ': ' + response.finishReason : ''),
            data: {
                refusedImages: opts.inputImages,
                reason: response.finishReason || 'unknown',
                prompt: opts.prompt,
            },
        })
    }

    /**
     * Pure image model (modelType === 'image'). Uses experimental_generateImage.
     * Supports input images for providers that allow edit/img2img (e.g. openai/gpt-image-1).
     */
    async function generateImageViaImageModel(opts: mainSchema.GenerateOptions & { model: string }): Promise<GeneratedImage> {
        const model = gateway.imageModel(opts.model)
        const files = await loadInputFiles(opts)

        const promptArg: any = files.length > 0
            ? {
                text: opts.prompt,
                images: files.map(f => f.buffer),
            }
            : opts.prompt

        try {
            const res = await aiGenerateImage({
                model,
                prompt: promptArg,
                aspectRatio: opts.imageConfig?.aspectRatio as any,
                providerOptions: {} as any,
            })
            const img = res.image || res.images?.[0]
            if (!img) {
                throw createError({statusCode: 500, statusMessage: 'No image returned'})
            }
            const responseModelId = res.responses?.[0]?.modelId || opts.model
            return {
                buffer: Buffer.from(img.uint8Array),
                mimeType: img.mediaType || 'image/png',
                billing: await buildBilling(responseModelId, res.usage, res.providerMetadata),
            }
        } catch (e: any) {
            throw createError({
                statusCode: 502,
                statusMessage: `Gateway image request failed: ${e?.message || e}`,
                data: {refusedImages: opts.inputImages, reason: e?.message || 'unknown', prompt: opts.prompt},
            })
        }
    }

    /**
     * Routes to the right call based on modelType. Looks up model info from cache.
     */
    async function generateAnyImage(opts: mainSchema.GenerateOptions & { model: string }): Promise<GeneratedImage> {
        const info = await getModelInfo(opts.model)
        if (!info) {
            throw createError({statusCode: 400, statusMessage: `Unknown model: ${opts.model}`})
        }
        if (info.modelType === 'image') {
            return generateImageViaImageModel(opts)
        }
        if (isImageOutputLanguageModel(info)) {
            return generateImageViaLanguageModel(opts)
        }
        throw createError({
            statusCode: 400,
            statusMessage: `Model ${opts.model} does not support image output`,
        })
    }

    return {
        gateway,
        listModels,
        getModelInfo,
        invalidateModelCache,
        generateImageViaLanguageModel,
        generateImageViaImageModel,
        generateAnyImage,
    }
}
