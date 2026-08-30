import {createGateway, experimental_generateImage as aiGenerateImage, generateText} from 'ai'
import {createProviderToolFactory} from '@ai-sdk/provider-utils'
import {z} from 'zod'
import {
    IMAGE_MODEL_PROFILES,
    ImageGenerationRequestSchema,
    type ImageGenerationRequest,
    type OutputMetadata,
    type StoredGenerationError,
} from '../../schemas/image-generation'
import {settleWithinMs} from './gatewayTimeout'
import {
    getGatewayMetadataLookupPool,
    sanitizeProviderMetadata,
} from './gatewayMetadata'
import { resolveGenerationTotalTokens } from './generationBilling'
import { toBufferView } from './imageBuffer'

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
    responseText?: string
    reasoningText?: string
    warnings: string[]
    grounding?: NonNullable<OutputMetadata['grounding']>
}

const googleSearchInputSchema = z.object({}).strict()
type GoogleSearchArgs = {
    searchTypes: {
        webSearch?: Record<string, never>
        imageSearch?: Record<string, never>
    }
}

const googleSearchTool = createProviderToolFactory<z.infer<typeof googleSearchInputSchema>, GoogleSearchArgs>({
    id: 'google.google_search',
    inputSchema: googleSearchInputSchema,
})

const SECRET_KEY_PATTERN = /authorization|api[-_]?key|cookie|credential|password|secret|access[-_]?token|refresh[-_]?token/i
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429])
export const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 180_000
export const MIN_IMAGE_GENERATION_TIMEOUT_MS = 10_000
export const MAX_IMAGE_GENERATION_TIMEOUT_MS = 600_000
const GATEWAY_METADATA_TIMEOUT_MS = 10_000

export function resolveImageGenerationTimeoutMs(value: unknown): number {
    const parsed = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
            ? Number(value)
            : Number.NaN
    if (!Number.isFinite(parsed)) return DEFAULT_IMAGE_GENERATION_TIMEOUT_MS
    return Math.min(
        MAX_IMAGE_GENERATION_TIMEOUT_MS,
        Math.max(MIN_IMAGE_GENERATION_TIMEOUT_MS, Math.round(parsed)),
    )
}

function getImageGenerationTimeoutMs(): number {
    const runtimeConfig = useRuntimeConfig() as Record<string, unknown>
    return resolveImageGenerationTimeoutMs(
        runtimeConfig.imageGenerationTimeoutMs
        ?? process.env.NUXT_IMAGE_GENERATION_TIMEOUT_MS,
    )
}

function isTimeoutLikeError(error: unknown, seen = new WeakSet<object>()): boolean {
    if (!error || typeof error !== 'object') return false
    if (seen.has(error)) return false
    seen.add(error)
    const record = error as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name : ''
    const code = typeof record.code === 'string' ? record.code : ''
    const message = typeof record.message === 'string' ? record.message : ''
    if (/timeout/i.test(name) || /(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)/i.test(code)) return true
    if (/timed?\s*out|timeout/i.test(message)) return true
    return isTimeoutLikeError(record.lastError, seen) || isTimeoutLikeError(record.cause, seen)
}

function redactString(value: string): string {
    const redacted = value
        .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
        .replace(/([?&](?:key|api_key|apiKey|token)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/gi, '[REDACTED_DATA_URL]')
    return redacted.length > 8_000 ? `${redacted.slice(0, 8_000)}...[truncated]` : redacted
}

function redactSerializable(
    value: unknown,
    depth = 0,
    seen = new WeakSet<object>(),
): unknown {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
    if (typeof value === 'string') return redactString(value)
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'function' || typeof value === 'symbol') return undefined
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
        return '[REDACTED_BINARY]'
    }
    if (depth >= 5) return '[truncated]'
    if (typeof value !== 'object') return redactString(String(value))
    if (seen.has(value)) return '[circular]'
    seen.add(value)

    if (Array.isArray(value)) {
        return value.slice(0, 25).map(item => redactSerializable(item, depth + 1, seen))
    }

    const source = value instanceof Error
        ? {
            ...value as unknown as Record<string, unknown>,
            name: value.name,
            message: value.message,
            ...(value.cause !== undefined ? {cause: value.cause} : {}),
        }
        : value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(source).slice(0, 50)) {
        if (key === 'stack') continue
        result[key] = SECRET_KEY_PATTERN.test(key)
            ? '[REDACTED]'
            : redactSerializable(nested, depth + 1, seen)
    }
    return result
}

function findHeader(headers: unknown, name: string): string | undefined {
    if (headers instanceof Headers) return headers.get(name) ?? undefined
    if (!headers || typeof headers !== 'object') return undefined
    const record = headers as Record<string, unknown>
    const value = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()]
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function serializeGatewayError(error: unknown): StoredGenerationError {
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : {}
    const lastError = record.lastError && typeof record.lastError === 'object'
        ? record.lastError as Record<string, unknown>
        : undefined
    const response = record.response && typeof record.response === 'object'
        ? record.response as Record<string, unknown>
        : undefined
    const statusCandidate = record.statusCode ?? record.status ?? lastError?.statusCode ?? lastError?.status ?? response?.status
    const statusCode = typeof statusCandidate === 'number' && Number.isInteger(statusCandidate)
        ? statusCandidate
        : undefined
    const codeCandidate = record.code ?? lastError?.code
    const code = typeof codeCandidate === 'string' ? redactString(codeCandidate) : undefined
    const messageCandidate = record.message ?? lastError?.message
    const message = redactString(
        typeof messageCandidate === 'string' && messageCandidate.length > 0
            ? messageCandidate
            : String(error || 'Unknown Gateway error'),
    )
    const headers = record.responseHeaders ?? lastError?.responseHeaders ?? response?.headers
    const requestId = [
        record.requestId,
        lastError?.requestId,
        findHeader(headers, 'x-request-id'),
        findHeader(headers, 'x-vercel-id'),
        findHeader(headers, 'request-id'),
    ].find(value => typeof value === 'string' && value.length > 0) as string | undefined
    const explicitRetryable = record.retryable ?? record.isRetryable ?? lastError?.retryable ?? lastError?.isRetryable
    const retryable = typeof explicitRetryable === 'boolean'
        ? explicitRetryable
        : statusCode != null
            ? RETRYABLE_STATUS_CODES.has(statusCode) || statusCode >= 500
            : undefined
    const nameCandidate = record.name ?? lastError?.name

    return {
        name: typeof nameCandidate === 'string' ? redactString(nameCandidate) : undefined,
        message,
        statusCode,
        code,
        retryable,
        requestId: requestId ? redactString(requestId) : undefined,
        details: redactSerializable({
            error: record,
            ...(lastError ? {lastError} : {}),
        }),
    }
}

function formatWarnings(warnings: readonly unknown[] | undefined): string[] {
    if (!warnings) return []
    return warnings.map((warning) => {
        if (typeof warning === 'string') return redactString(warning)
        if (!warning || typeof warning !== 'object') return redactString(String(warning))
        const value = warning as Record<string, unknown>
        if (value.type === 'other' && typeof value.message === 'string') return redactString(value.message)
        const feature = typeof value.feature === 'string' ? value.feature : 'provider setting'
        const details = typeof value.details === 'string' ? `: ${value.details}` : ''
        return redactString(`${String(value.type || 'warning')} ${feature}${details}`)
    })
}

function mergeWarnings(...groups: Array<readonly string[] | undefined>): string[] {
    return [...new Set(groups.flatMap(group => group ?? []).filter(Boolean))]
}

let _gateway: ReturnType<typeof createGateway> | null = null
let _modelCache: { at: number; items: GatewayModelInfo[] } | null = null
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000
const gatewayMetadataPool = getGatewayMetadataLookupPool()

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
            const lookup = gatewayMetadataPool.start(
                'model-catalog',
                () => gateway.getAvailableModels(),
            )
            if (!lookup) {
                const error = new Error('Gateway metadata capacity is temporarily unavailable.')
                error.name = 'GatewayMetadataCapacityError'
                throw error
            }
            const res = await settleWithinMs(
                lookup,
                GATEWAY_METADATA_TIMEOUT_MS,
                'Gateway model catalog lookup',
            )
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
            raw: sanitizeProviderMetadata(usage.raw),
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
            const lookup = gatewayMetadataPool.start(
                `generation:${generationId}`,
                () => (gateway as any).getGenerationInfo({id: generationId}) as Promise<any>,
            )
            if (!lookup) return undefined
            return await settleWithinMs<any>(
                lookup,
                GATEWAY_METADATA_TIMEOUT_MS,
                'Gateway billing lookup',
            )
        } catch (e) {
            // Gateway generation-info can lag or return non-standard errors.
            // Billing still falls back to model pricing + reported token usage.
            return undefined
        }
    }

    async function getGenerationBilling(generationId: string | undefined, fallbackModel?: string): Promise<ImageGenerationBilling | undefined> {
        const gatewayBilling = await getActualGatewayBilling(generationId)
        if (!gatewayBilling) return undefined
        const inputTokens = asNumber(gatewayBilling.promptTokens)
        const outputTokens = asNumber(gatewayBilling.completionTokens)
        return {
            model: typeof gatewayBilling.model === 'string' ? gatewayBilling.model : fallbackModel,
            inputTokens,
            outputTokens,
            cachedInputTokens: asNumber(gatewayBilling.cachedTokens),
            reasoningTokens: asNumber(gatewayBilling.reasoningTokens),
            totalTokens: resolveGenerationTotalTokens(
                asNumber(gatewayBilling.totalTokens ?? gatewayBilling.total_tokens),
                inputTokens,
                outputTokens,
            ),
            priceUsd: asNumber(gatewayBilling.totalCost)?.toFixed(8),
            priceSource: 'gateway',
            gatewayGenerationId: generationId,
            usageJson: {gatewayBilling: sanitizeProviderMetadata(gatewayBilling)},
        }
    }

    async function buildBilling(
        modelId: string,
        usageSource: any,
        providerMetadata: any,
        outputImages = 1,
    ): Promise<ImageGenerationBilling> {
        const usage = normalizeUsage(usageSource)
        const generationId = getGatewayGenerationId(providerMetadata)
        const gatewayBilling = await getActualGatewayBilling(generationId)
        let info: GatewayModelInfo | undefined
        try {
            info = await getModelInfo(modelId)
        } catch {
            // Catalog availability must not turn a completed generation into a failure.
            info = undefined
        }
        const enrichedInfo = info ? enrichImageModelInfo(info) : undefined

        const inputTokens = asNumber(gatewayBilling?.promptTokens) ?? usage.inputTokens
        const outputTokens = asNumber(gatewayBilling?.completionTokens) ?? usage.outputTokens
        const cachedInputTokens = asNumber(gatewayBilling?.cachedTokens) ?? usage.cachedInputTokens
        const reasoningTokens = asNumber(gatewayBilling?.reasoningTokens) ?? usage.reasoningTokens
        const totalTokens = resolveGenerationTotalTokens(
            asNumber(gatewayBilling?.totalTokens ?? gatewayBilling?.total_tokens) ?? usage.totalTokens,
            inputTokens,
            outputTokens,
        )
        const estimatedPrice = estimatePriceUsd({
            inputTokens,
            outputTokens,
            totalTokens,
            cachedInputTokens,
            reasoningTokens,
        }, enrichedInfo?.pricing)
        const imageMeteredEstimate = estimateImageMeteredPriceUsd(enrichedInfo, outputImages)
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
                ...(gatewayBilling ? {gatewayBilling: sanitizeProviderMetadata(gatewayBilling)} : {}),
                ...(providerMetadata ? {providerMetadata: sanitizeProviderMetadata(providerMetadata)} : {}),
            },
        }
    }

    function invalidateModelCache() {
        _modelCache = null
    }

    async function loadInputFiles(opts: ImageGenerationRequest) {
        const paths = [...opts.inputImages, ...opts.modelImages]
        const files: Array<{buffer: Buffer; mediaType: string}> = []
        const allowedMediaTypes = opts.model === 'openai/gpt-image-2'
            ? new Set(['image/png', 'image/jpeg', 'image/webp'])
            : new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic'])
        let totalBytes = 0
        for (const imagePath of paths) {
            const image = await fs.getImageFile(imagePath)
            if (!allowedMediaTypes.has(image.mimeType)) {
                throw createError({
                    statusCode: 415,
                    statusMessage: `${opts.model} does not accept ${image.mimeType} reference images. Use PNG, JPEG, WebP${opts.model === 'openai/gpt-image-2' ? '' : ', or HEIC'}.`,
                })
            }
            totalBytes += image.buffer.length
            if (totalBytes > 100 * 1024 * 1024) {
                throw createError({
                    statusCode: 413,
                    statusMessage: 'Reference images may total at most 100 MB per provider request.',
                })
            }
            files.push({
                buffer: image.buffer,
                mediaType: image.mimeType,
            })
        }
        return files
    }

    async function loadMaskFile(opts: ImageGenerationRequest): Promise<Buffer | undefined> {
        if (!opts.maskImage) return undefined
        const mask = await fs.getImageFile(opts.maskImage)
        return mask.buffer
    }

    function validationError(issues: z.core.$ZodIssue[]): never {
        const errorData: StoredGenerationError = {
            name: 'ValidationError',
            message: 'Image generation request does not match the selected model profile.',
            statusCode: 400,
            code: 'INVALID_IMAGE_GENERATION_REQUEST',
            retryable: false,
            details: {issues: redactSerializable(issues)},
        }
        throw createError({
            statusCode: 400,
            statusMessage: errorData.message,
            data: errorData,
        })
    }

    function validateGenerationRequest(opts: ImageGenerationRequest): ImageGenerationRequest {
        const parsed = ImageGenerationRequestSchema.safeParse(opts)
        if (!parsed.success) validationError(parsed.error.issues)
        return parsed.data
    }

    function throwGatewayError(prefix: string, error: unknown): never {
        const errorData = serializeGatewayError(error)
        const upstreamStatus = errorData.statusCode
        throw createError({
            statusCode: upstreamStatus != null && upstreamStatus >= 400 && upstreamStatus <= 599
                ? upstreamStatus
                : 502,
            statusMessage: `${prefix}: ${errorData.message}`,
            data: errorData,
        })
    }

    function throwGatewayTimeout(prefix: string, timeoutMs: number, error: unknown): never {
        const errorData: StoredGenerationError = {
            name: 'ProviderCallTimeoutError',
            message: `${prefix} timed out after ${timeoutMs} ms.`,
            statusCode: 504,
            code: 'PROVIDER_CALL_TIMEOUT',
            retryable: true,
            details: redactSerializable({timeoutMs, cause: error}),
        }
        throw createError({
            statusCode: 504,
            statusMessage: errorData.message,
            data: errorData,
        })
    }

    function noImageError(model: string, finishReason: unknown, responseText?: string): never {
        const reason = typeof finishReason === 'string' && finishReason.length > 0
            ? finishReason
            : 'unknown'
        const errorData: StoredGenerationError = {
            name: 'NoImageGeneratedError',
            message: `Model ${model} returned no image (${reason}).`,
            statusCode: 422,
            code: 'NO_IMAGE_GENERATED',
            retryable: false,
            details: {
                finishReason: reason,
                ...(responseText ? {responseText: redactString(responseText)} : {}),
            },
        }
        throw createError({
            statusCode: 422,
            statusMessage: errorData.message,
            data: errorData,
        })
    }

    function createGoogleSearch(grounding: 'web' | 'images' | 'web-and-images') {
        return googleSearchTool({
            searchTypes: {
                ...(grounding === 'web' || grounding === 'web-and-images' ? {webSearch: {}} : {}),
                ...(grounding === 'web-and-images' ? {imageSearch: {}} : {}),
                ...(grounding === 'images' ? {imageSearch: {}} : {}),
            },
        })
    }

    function extractGrounding(response: any): NonNullable<OutputMetadata['grounding']> | undefined {
        const seen = new Set<string>()
        const sources: Array<{url: string; title?: string}> = []
        for (const source of Array.isArray(response?.sources) ? response.sources : []) {
            const url = typeof source?.url === 'string' ? source.url : undefined
            if (!url || seen.has(url) || !/^https?:\/\//i.test(url)) continue
            seen.add(url)
            sources.push({
                url,
                ...(typeof source?.title === 'string' && source.title ? {title: source.title} : {}),
            })
            if (sources.length >= 50) break
        }
        const metadata = response?.providerMetadata?.google?.groundingMetadata
        const rawHtml = metadata?.searchEntryPoint?.renderedContent
            ?? metadata?.searchEntryPoint?.rendered_content
            ?? metadata?.searchSuggestions
        const searchEntryPointHtml = typeof rawHtml === 'string' && rawHtml.length > 0
            ? rawHtml.slice(0, 100_000)
            : undefined
        if (!sources.length && !searchEntryPointHtml) return undefined
        return {sources, ...(searchEntryPointHtml ? {searchEntryPointHtml} : {})}
    }

    /**
     * Gemini image models are multimodal language models. Their exact profile,
     * not a Gateway catalog heuristic, determines this generateText path.
     */
    async function generateImageViaLanguageModel(opts: ImageGenerationRequest): Promise<GeneratedImage[]> {
        const request = validateGenerationRequest(opts)
        if (request.settings.kind === 'openai-gpt-image-2') {
            validationError([{
                code: 'custom',
                path: ['model'],
                message: `${request.model} is not a Gateway language image model.`,
                input: request.model,
            }])
        }

        const profile = IMAGE_MODEL_PROFILES[request.model]
        if (profile.adapter !== 'gateway-language-image') {
            validationError([{
                code: 'custom',
                path: ['model'],
                message: `${request.model} does not use the Gateway language-image adapter.`,
                input: request.model,
            }])
        }

        const settings = request.settings
        const files = await loadInputFiles(request)
        const safetySettings = [
            {category: 'HARM_CATEGORY_HATE_SPEECH', threshold: settings.safety.hateSpeech},
            {category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: settings.safety.dangerousContent},
            {category: 'HARM_CATEGORY_HARASSMENT', threshold: settings.safety.harassment},
            {category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: settings.safety.sexuallyExplicit},
        ]
        const imageConfig = {
            ...(settings.aspectRatio ? {aspectRatio: settings.aspectRatio} : {}),
            ...('imageSize' in settings ? {imageSize: settings.imageSize} : {}),
        }
        const thinkingConfig = settings.kind === 'gemini-3.1-flash-image'
            || settings.kind === 'gemini-3.1-flash-lite-image'
            ? {
                thinkingLevel: settings.thinkingLevel,
                includeThoughts: settings.includeThoughts,
            }
            : settings.kind === 'gemini-3-pro-image'
                ? {includeThoughts: settings.includeThoughts}
                : undefined
        const grounding = 'grounding' in settings ? settings.grounding : 'off'
        const searchTool = grounding === 'web' || grounding === 'images' || grounding === 'web-and-images'
            ? createGoogleSearch(grounding)
            : undefined
        const timeoutMs = getImageGenerationTimeoutMs()
        const abortSignal = AbortSignal.timeout(timeoutMs)

        const callGateway = () => generateText({
            model: gateway.languageModel(request.model),
            maxRetries: 0,
            abortSignal,
            timeout: {totalMs: timeoutMs},
            providerOptions: {
                google: {
                    responseModalities: settings.includeText ? ['TEXT', 'IMAGE'] : ['IMAGE'],
                    ...(Object.keys(imageConfig).length > 0 ? {imageConfig} : {}),
                    safetySettings,
                    ...(thinkingConfig ? {thinkingConfig} : {}),
                },
            },
            ...settings.sampling,
            ...(searchTool ? {tools: {google_search: searchTool}} : {}),
            ...(files.length > 0
                ? {
                    messages: [{
                        role: 'user' as const,
                        content: [
                            {type: 'text' as const, text: request.prompt},
                            ...files.map(file => ({
                                type: 'file' as const,
                                data: file.buffer,
                                mediaType: file.mediaType,
                            })),
                        ],
                    }],
                }
                : {prompt: request.prompt}),
        })
        let response: Awaited<ReturnType<typeof callGateway>>
        try {
            response = await callGateway()
        } catch (error) {
            if (abortSignal.aborted || isTimeoutLikeError(error)) {
                throwGatewayTimeout('Gateway Gemini request', timeoutMs, error)
            }
            throwGatewayError('Gateway Gemini request failed', error)
        }

        const images = response.files.filter(file => file.mediaType?.startsWith('image/'))
        if (images.length === 0) noImageError(request.model, response.finishReason, response.text)

        const billing = await buildBilling(
            response.response?.modelId || request.model,
            response.totalUsage,
            response.providerMetadata,
            images.length,
        )
        const warnings = mergeWarnings(profile.warnings, formatWarnings(response.warnings))
        const responseText = settings.includeText && response.text.length > 0
            ? response.text
            : undefined
        const reasoningText = 'includeThoughts' in settings
            && settings.includeThoughts
            && typeof response.reasoningText === 'string'
            && response.reasoningText.length > 0
            ? response.reasoningText
            : undefined
        const groundingMetadata = searchTool ? extractGrounding(response) : undefined

        return images.map(file => ({
            buffer: toBufferView(file.uint8Array),
            mimeType: file.mediaType || 'image/png',
            billing,
            ...(responseText ? {responseText} : {}),
            ...(reasoningText ? {reasoningText} : {}),
            ...(groundingMetadata ? {grounding: groundingMetadata} : {}),
            warnings,
        }))
    }

    /**
     * GPT Image 2 is a Gateway image model. Only schema-backed options are sent;
     * unsupported aspectRatio, seed, inputFidelity, and transparency controls are
     * intentionally absent.
     */
    async function generateImageViaImageModel(opts: ImageGenerationRequest): Promise<GeneratedImage[]> {
        const request = validateGenerationRequest(opts)
        if (request.settings.kind !== 'openai-gpt-image-2') {
            validationError([{
                code: 'custom',
                path: ['model'],
                message: `${request.model} is not the supported Gateway image model.`,
                input: request.model,
            }])
        }

        const profile = IMAGE_MODEL_PROFILES[request.model]
        if (profile.adapter !== 'gateway-image') {
            validationError([{
                code: 'custom',
                path: ['model'],
                message: `${request.model} does not use the Gateway image adapter.`,
                input: request.model,
            }])
        }

        const settings = request.settings
        const files = await loadInputFiles(request)
        const mask = await loadMaskFile(request)
        const prompt = files.length > 0 || mask
            ? {
                text: request.prompt,
                images: files.map(file => file.buffer),
                ...(mask ? {mask} : {}),
            }
            : request.prompt
        const openaiOptions = {
            quality: settings.quality,
            background: settings.background,
            outputFormat: settings.outputFormat,
            moderation: settings.moderation,
            ...(settings.outputCompression != null ? {outputCompression: settings.outputCompression} : {}),
            ...(settings.user ? {user: settings.user} : {}),
        }
        const timeoutMs = getImageGenerationTimeoutMs()
        const abortSignal = AbortSignal.timeout(timeoutMs)

        let response: Awaited<ReturnType<typeof aiGenerateImage>>
        try {
            response = await aiGenerateImage({
                model: gateway.imageModel(request.model),
                maxRetries: 0,
                prompt,
                n: settings.numberOfImages,
                abortSignal,
                ...(settings.size ? {size: settings.size as `${number}x${number}`} : {}),
                providerOptions: {openai: openaiOptions},
            })
        } catch (error) {
            if (abortSignal.aborted || isTimeoutLikeError(error)) {
                throwGatewayTimeout('Gateway GPT Image 2 request', timeoutMs, error)
            }
            throwGatewayError('Gateway GPT Image 2 request failed', error)
        }

        if (response.images.length === 0) noImageError(request.model, 'no image files')
        const responseModelId = response.responses.find(item => item.modelId)?.modelId || request.model
        const billing = await buildBilling(
            responseModelId,
            response.usage,
            response.providerMetadata,
            response.images.length,
        )
        const warnings = mergeWarnings(profile.warnings, formatWarnings(response.warnings))
        const fallbackMimeType = settings.outputFormat === 'jpeg'
            ? 'image/jpeg'
            : `image/${settings.outputFormat}`

        return response.images.map(image => ({
            buffer: toBufferView(image.uint8Array),
            mimeType: image.mediaType || fallbackMimeType,
            billing,
            warnings,
        }))
    }

    async function generateAnyImage(opts: ImageGenerationRequest): Promise<GeneratedImage[]> {
        const request = validateGenerationRequest(opts)
        const profile = IMAGE_MODEL_PROFILES[request.model]
        return profile.adapter === 'gateway-language-image'
            ? generateImageViaLanguageModel(request)
            : generateImageViaImageModel(request)
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
