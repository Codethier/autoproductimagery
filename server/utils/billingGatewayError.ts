import type {ImageGenerationBilling} from './useGateway'
import {normalizeUsd} from '../../schemas/generation-billing'
import {sanitizeProviderMetadata} from './gatewayMetadata'

/** GatewayError exposes generationId directly, including on paid failures.
 * RetryError can wrap that error in lastError. Do not scan arbitrary text or
 * confuse a provider request ID with the Gateway accounting identity. */
export function extractGatewayErrorGenerationId(error: unknown): string | undefined {
    const seen = new Set<object>()
    const visit = (value: unknown, depth = 0): string | undefined => {
        if (!value || typeof value !== 'object' || depth > 6 || seen.size >= 32 || seen.has(value)) return undefined
        seen.add(value)
        const record = value as Record<string, unknown>
        if (typeof record.generationId === 'string' && /^gen_[A-Za-z0-9_-]{1,120}$/.test(record.generationId)) return record.generationId
        for (const nested of [record.lastError, record.cause, ...(Array.isArray(record.errors) ? record.errors.slice(0, 8) : [])]) {
            const id = visit(nested, depth + 1)
            if (id) return id
        }
        return undefined
    }
    return visit(error)
}

/** Read the explicit server-created billing attachment, not arbitrary nested
 * provider error fields. The returned object contains bounded diagnostics and
 * can be allocated once across failed sibling rows just like image outputs. */
export function extractGatewayErrorBilling(error: unknown): ImageGenerationBilling | undefined {
    if (!error || typeof error !== 'object') return undefined
    const data = (error as {data?: unknown}).data
    if (!data || typeof data !== 'object') return undefined
    const details = (data as {details?: unknown}).details
    if (!details || typeof details !== 'object') return undefined
    const value = (details as {billing?: unknown}).billing
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    const source = record.priceSource
    if (source !== 'gateway' && source !== 'estimate' && source !== 'unknown') return undefined
    const id = typeof record.gatewayGenerationId === 'string' && /^gen_[A-Za-z0-9_-]{1,120}$/.test(record.gatewayGenerationId)
        ? record.gatewayGenerationId : undefined
    const priceUsd = normalizeUsd(record.priceUsd)
    if (!id && priceUsd === undefined) return undefined
    const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
    const metadata = sanitizeProviderMetadata(record.usageJson)
    return {
        model: typeof record.model === 'string' && record.model.length <= 200 ? record.model : undefined,
        priceSource: source === 'gateway' && priceUsd === undefined ? 'unknown' : source,
        priceUsd,
        gatewayGenerationId: id,
        inputTokens: count(record.inputTokens),
        outputTokens: count(record.outputTokens),
        totalTokens: count(record.totalTokens),
        cachedInputTokens: count(record.cachedInputTokens),
        reasoningTokens: count(record.reasoningTokens),
        usageJson: metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? metadata as Record<string, unknown> : undefined,
    }
}
