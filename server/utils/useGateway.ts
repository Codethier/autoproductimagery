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
    pricingDetails?: ImageModelPricingDetails
    capabilities?: ImageModelCapabilities
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
    priceSource?: 'gateway' | 'estimate' | 'unknown'
    gatewayGenerationId?: string
    usageJson?: Record<string, unknown>
}

export type ImagePricingComponent = {
    kind: 'token' | 'fixed-image' | 'megapixel' | 'unknown'
    label: string
    amountUsd?: number
    unit?: 'token' | 'image' | 'megapixel'
    source: 'gateway-config' | 'vercel-catalog' | 'inferred'
    note?: string
}

export type ImageModelPricingDetails = {
    method: 'token' | 'fixed-image' | 'megapixel' | 'mixed' | 'unknown'
    summary: string
    components: ImagePricingComponent[]
    estimateNote: string
}

export type ImageModelCapabilities = {
    output: Array<'image' | 'text'>
    input: Array<'text' | 'image' | 'multiple-images'>
    operations: Array<'text-to-image' | 'image-edit' | 'image-to-image' | 'multi-reference'>
    warnings: string[]
}

export type GeneratedImage = {
    buffer: Buffer
    mimeType: string
    billing: ImageGenerationBilling
}

let _gateway: ReturnType<typeof createGateway> | null = null
let _modelCache: { at: number; items: GatewayModelInfo[] } | null = null
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000

const IMAGE_PRICE_OVERRIDES: Record<string, { kind: 'fixed-image' | 'megapixel'; amountUsd: number; label: string; note?: string }> = {
    // The AI SDK Gateway config currently exposes these image-only models as
    // zero token price, while the Vercel catalog shows image-metered pricing.
    'google/imagen-4.0-fast-generate-001': {
        kind: 'fixed-image',
        amountUsd: 0.02,
        label: '$0.02 / image',
        note: 'Text-to-image only in the Vercel model page.',
    },
    'xai/grok-imagine-image': {
        kind: 'fixed-image',
        amountUsd: 0.02,
        label: '$0.02 / image',
    },
    'bfl/flux-2-pro': {
        kind: 'megapixel',
        amountUsd: 0.03,
        label: '$0.03 / output MP',
        note: 'Depends on output megapixels.',
    },
}

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

// well, APi doesn't show shit in terms of which is image to image so it is manual.. https://vercel.com/ai-gateway/models
export function supportsImageInput(model: GatewayModelInfo): boolean {
    const id = model.id.toLowerCase()
    if (isImageOutputLanguageModel(model)) return true
    if (/gpt-image/.test(id)) return true
    if (/flux-(?:2|kontext)/.test(id)) return true
    return false
}

export function supportsMultipleImageInputs(model: GatewayModelInfo): boolean {
    const id = model.id.toLowerCase()
    if (isImageOutputLanguageModel(model)) return true
    if (/flux-(?:2|kontext)/.test(id)) return true
    return false
}

function usdPerMillion(perTokenUsd?: string) {
    if (!perTokenUsd) return undefined
    const value = Number(perTokenUsd) * 1_000_000
    if (!Number.isFinite(value) || value <= 0) return undefined
    return value
}

function formatUsd(value: number, fractionDigits = value < 1 ? 3 : 2) {
    return `$${value.toFixed(fractionDigits)}`
}

function tokenPricingLabel(pricing: NonNullable<GatewayModelInfo['pricing']>) {
    const input = usdPerMillion(pricing.input)
    const output = usdPerMillion(pricing.output)
    const cached = usdPerMillion(pricing.cachedInputTokens)
    const parts: string[] = []
    if (input != null) parts.push(`${formatUsd(input)} input / 1M tokens`)
    if (output != null) parts.push(`${formatUsd(output)} output / 1M tokens`)
    if (cached != null) parts.push(`${formatUsd(cached)} cached input / 1M tokens`)
    return parts.join('; ')
}

export function getImageModelPricingDetails(model: GatewayModelInfo): ImageModelPricingDetails {
    const components: ImagePricingComponent[] = []
    const tokenLabel = model.pricing ? tokenPricingLabel(model.pricing) : ''
    if (tokenLabel) {
        components.push({
            kind: 'token',
            label: tokenLabel,
            unit: 'token',
            source: 'gateway-config',
        })
    }

    const override = IMAGE_PRICE_OVERRIDES[model.id]
    if (override) {
        components.push({
            kind: override.kind,
            amountUsd: override.amountUsd,
            unit: override.kind === 'fixed-image' ? 'image' : 'megapixel',
            label: override.label,
            source: 'vercel-catalog',
            note: override.note,
        })
    }

    const hasPositiveTokenPricing = !!tokenLabel
    if (model.modelType === 'image' && !hasPositiveTokenPricing && !override) {
        components.push({
            kind: 'unknown',
            label: 'Image-metered pricing',
            source: 'inferred',
            note: 'The Gateway config does not expose a token price for this image-only model. Exact cost is queried from the generation record after the request.',
        })
    }

    const pricedKinds = new Set(components.map(c => c.kind).filter(k => k !== 'unknown'))
    const method = pricedKinds.size > 1
        ? 'mixed'
        : pricedKinds.has('token')
            ? 'token'
            : pricedKinds.has('fixed-image')
                ? 'fixed-image'
                : pricedKinds.has('megapixel')
                    ? 'megapixel'
                    : 'unknown'

    const summary = components.map(c => c.label).join('; ') || 'Pricing not exposed by Gateway config'
    const estimateNote = method === 'fixed-image'
        ? 'Pre-run estimates can be calculated from the number of output images.'
        : method === 'megapixel'
            ? 'Pre-run estimates need the final output dimensions.'
            : method === 'token'
                ? 'Pre-run estimates need token usage, so the app records the post-run Gateway cost when available.'
                : 'The app will query the Gateway generation record after each request.'

    return {method, summary, components, estimateNote}
}

export function getImageModelCapabilities(model: GatewayModelInfo): ImageModelCapabilities {
    const id = model.id.toLowerCase()
    const name = model.name.toLowerCase()
    const output: ImageModelCapabilities['output'] = ['image']
    const input: ImageModelCapabilities['input'] = ['text']
    const operations: ImageModelCapabilities['operations'] = ['text-to-image']
    const warnings: string[] = []

    if (isImageOutputLanguageModel(model)) {
        output.push('text')
        input.push('image', 'multiple-images')
        operations.push('image-edit', 'image-to-image', 'multi-reference')
    } else if (supportsImageInput(model)) {
        input.push('image')
        operations.push('image-edit', 'image-to-image')
        if (supportsMultipleImageInputs(model)) {
            input.push('multiple-images')
            operations.push('multi-reference')
        }
    }

    if (/imagen/.test(id) || /grok-imagine-image/.test(id) || /flux-fast-schnell/.test(id) || /recraft/.test(id) || /seedream/.test(id) || /bytedance/.test(id)) {
        warnings.push('This model is treated as text-to-image only; selected input/model images may be ignored or rejected.')
    }

    if (model.modelType === 'image' && !model.pricingDetails?.components.some(c => c.kind !== 'unknown')) {
        warnings.push('Exact image price is not exposed by the AI SDK model config; use post-generation cost refresh for the final charge.')
    }

    return {
        output: [...new Set(output)],
        input: [...new Set(input)],
        operations: [...new Set(operations)],
        warnings,
    }
}

export function enrichImageModelInfo(model: GatewayModelInfo): GatewayModelInfo {
    const pricingDetails = getImageModelPricingDetails(model)
    const withPricing = {...model, pricingDetails}
    return {
        ...withPricing,
        capabilities: getImageModelCapabilities(withPricing),
    }
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
        const direct = providerMetadata?.gateway?.generationId ?? providerMetadata?.gateway?.generation_id
        if (typeof direct === 'string' && direct.length > 0) return direct
        const seen = new Set<object>()
        const visit = (value: unknown): string | undefined => {
            if (!value || typeof value !== 'object') return undefined
            if (seen.has(value)) return undefined
            seen.add(value)
            for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
                if ((key === 'generationId' || key === 'generation_id' || key === 'id') && typeof nested === 'string' && nested.startsWith('gen_')) {
                    return nested
                }
                const found = visit(nested)
                if (found) return found
            }
            return undefined
        }
        return visit(providerMetadata)
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

    function estimateImageMeteredPriceUsd(info: GatewayModelInfo | undefined, outputImages = 1): string | undefined {
        const component = info?.pricingDetails?.components.find(c => c.kind === 'fixed-image' && c.amountUsd != null)
        if (!component?.amountUsd) return undefined
        return (component.amountUsd * Math.max(1, outputImages)).toFixed(8)
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

    async function getGenerationBilling(generationId: string | undefined, fallbackModel?: string): Promise<ImageGenerationBilling | undefined> {
        const gatewayBilling = await getActualGatewayBilling(generationId)
        if (!gatewayBilling) return undefined
        return {
            model: typeof gatewayBilling.model === 'string' ? gatewayBilling.model : fallbackModel,
            inputTokens: asNumber(gatewayBilling.promptTokens),
            outputTokens: asNumber(gatewayBilling.completionTokens),
            cachedInputTokens: asNumber(gatewayBilling.cachedTokens),
            reasoningTokens: asNumber(gatewayBilling.reasoningTokens),
            totalTokens: (
                asNumber(gatewayBilling.promptTokens) != null ||
                asNumber(gatewayBilling.completionTokens) != null ||
                asNumber(gatewayBilling.reasoningTokens) != null
            )
                ? (asNumber(gatewayBilling.promptTokens) ?? 0) +
                  (asNumber(gatewayBilling.completionTokens) ?? 0) +
                  (asNumber(gatewayBilling.reasoningTokens) ?? 0)
                : undefined,
            priceUsd: asNumber(gatewayBilling.totalCost)?.toFixed(8),
            priceSource: 'gateway',
            gatewayGenerationId: generationId,
            usageJson: {gatewayBilling},
        }
    }

    async function buildBilling(modelId: string, usageSource: any, providerMetadata: any): Promise<ImageGenerationBilling> {
        const usage = normalizeUsage(usageSource)
        const generationId = getGatewayGenerationId(providerMetadata)
        const gatewayBilling = await getActualGatewayBilling(generationId)
        const info = await getModelInfo(modelId)
        const enrichedInfo = info ? enrichImageModelInfo(info) : undefined

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
        }, enrichedInfo?.pricing)
        const imageMeteredEstimate = estimateImageMeteredPriceUsd(enrichedInfo)
        const gatewayPrice = asNumber(gatewayBilling?.totalCost)?.toFixed(8)

        return {
            model: typeof gatewayBilling?.model === 'string' ? gatewayBilling.model : modelId,
            inputTokens,
            outputTokens,
            totalTokens,
            cachedInputTokens,
            reasoningTokens,
            priceUsd: gatewayPrice ?? estimatedPrice ?? imageMeteredEstimate,
            priceSource: gatewayPrice ? 'gateway' : (estimatedPrice || imageMeteredEstimate ? 'estimate' : 'unknown'),
            gatewayGenerationId: generationId,
            usageJson: {
                usage,
                ...(enrichedInfo?.pricingDetails ? {pricingDetails: enrichedInfo.pricingDetails} : {}),
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
        const hasFiles = files.length > 0

        const safetySettings = [
            {category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF'},
            {category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF'},
            {category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF'},
            {category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF'},
        ]

        const responseModalities = opts.responseModalities?.includes('IMAGE')
            ? ['TEXT', 'IMAGE']
            : ['TEXT', 'IMAGE']
        const googleImageConfig = opts.imageConfig
            ? {
                aspectRatio: opts.imageConfig.aspectRatio,
                imageSize: opts.imageConfig.imageSize,
            }
            : undefined
        const hasGoogleImageConfig = !!googleImageConfig && Object.values(googleImageConfig).some(Boolean)

        const buildImagePrompt = (retry = false) => {
            const prompt = opts.prompt.trim()
            if (hasFiles) return prompt

            return [
                'Generate exactly one image from the user prompt below.',
                'Return an actual image file in the response. Do not answer with text only, and do not merely describe the image.',
                retry ? 'The previous attempt did not include an image file; this attempt must include an image file.' : '',
                '',
                'User prompt:',
                prompt,
            ].filter(Boolean).join('\n')
        }

        const callGeminiImageModel = (prompt: string) => generateText({
                model,
                providerOptions: {
                    google: {
                        responseModalities,
                        safetySettings,
                        ...(hasGoogleImageConfig ? {imageConfig: googleImageConfig} : {}),
                    } as any,
                },
                ...(hasFiles
                    ? {
                        messages: [
                            {
                                role: 'user' as const,
                                content: [
                                    {type: 'text' as const, text: prompt},
                                    ...files.map(f => ({type: 'file' as const, data: f.buffer, mediaType: f.mediaType})),
                                ],
                            },
                        ],
                    }
                    : {prompt}),
            })

        let response: Awaited<ReturnType<typeof generateText>>
        try {
            response = await callGeminiImageModel(buildImagePrompt())
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
        if (!hasFiles && typeof text === 'string' && text.length > 0) {
            try {
                response = await callGeminiImageModel(buildImagePrompt(true))
                const retryImageFile = (response.files || []).find(f => f.mediaType?.startsWith('image/'))
                if (retryImageFile) {
                    return {
                        buffer: Buffer.from(retryImageFile.uint8Array),
                        mimeType: retryImageFile.mediaType || 'image/png',
                        billing: await buildBilling(response.response?.modelId || opts.model, (response as any).totalUsage ?? response.usage, response.providerMetadata),
                    }
                }
            } catch (e: any) {
                throw createError({
                    statusCode: 502,
                    statusMessage: `Gateway retry failed after text-only response: ${e?.message || e}`,
                    data: {refusedImages: opts.inputImages, reason: e?.message || 'unknown', prompt: opts.prompt},
                })
            }
        }

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
                size: opts.imageConfig?.size as any,
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
        const hasImageInputs = opts.inputImages.length > 0 || (opts.modelImages || []).length > 0
        if (hasImageInputs && !supportsImageInput(info)) {
            throw createError({
                statusCode: 400,
                statusMessage: `Model ${opts.model} does not support input images through AI Gateway. Remove selected input/model images or choose an image-edit model such as GPT Image, Gemini image, or FLUX Kontext/FLUX.2.`,
                data: {
                    refusedImages: [...opts.inputImages, ...(opts.modelImages || [])],
                    reason: 'Model does not support input images',
                    prompt: opts.prompt,
                },
            })
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
        getGenerationBilling,
        generateImageViaLanguageModel,
        generateImageViaImageModel,
        generateAnyImage,
    }
}
