import {formatUsdUnits, parseUsdUnits} from './account-billing'

export {formatUsdUnits, parseUsdUnits} from './account-billing'

export type GenerationPrice = {
    priceUsd?: string | null
    priceSource?: string | null
    billingState?: string | null
    usageJson?: unknown
}

/** Only server-recorded Gateway settlement can unlock a generated image.
 * A legitimate zero-cost generation is confirmed, whereas estimates and
 * missing prices are not. An explicit ledger state always takes precedence. */
export function hasConfirmedGenerationPrice(value: GenerationPrice | null | undefined): boolean {
    if (value?.usageJson && typeof value.usageJson === 'object') {
        const gatewayBilling = (value.usageJson as {gatewayBilling?: unknown}).gatewayBilling
        if (gatewayBilling && typeof gatewayBilling === 'object') {
            const isByok = (gatewayBilling as {isByok?: unknown}).isByok
            if (isByok === true || isByok === 'true') return false
        }
    }
    return !!value
        && value.priceSource === 'gateway'
        && parseUsdUnits(value.priceUsd) !== undefined
        && (value.billingState == null || value.billingState === 'confirmed')
}

export const isConfirmedGenerationBilling = hasConfirmedGenerationPrice

export function normalizeUsd(value: unknown): string | undefined {
    if (typeof value === 'string') {
        const units = parseUsdUnits(value)
        return units === undefined ? undefined : formatUsdUnits(units)
    }
    // Gateway's official SDK exposes totalCost as a number. Normalize that
    // quoted value once, then perform all splits and sums with integer units.
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
    const units = parseUsdUnits(value.toFixed(12))
    if (value > 0 && units === 0n) return undefined
    return units === undefined ? undefined : formatUsdUnits(units)
}

const unfinishedReasons = new Set(['', 'unknown', 'pending', 'queued', 'running', 'in_progress', 'in-progress', 'processing'])

/** Generation lookup returns completed Gateway records after asynchronous
 * usage ingestion. Require that exact record and a final finish reason before
 * accepting totalCost; never substitute catalog math or provider metadata. */
export function extractConfirmedGatewayPrice(value: unknown, requestedGenerationId: string): string | undefined {
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    if (record.id !== requestedGenerationId) return undefined
    // totalCost is the actual debit from Gateway credits. For BYOK it excludes
    // the external provider invoice, while upstreamInferenceCost is only a
    // market-list estimate. That cannot establish the complete image price.
    if (record.isByok !== false) return undefined
    if (typeof record.finishReason !== 'string'
        || record.finishReason.length > 100
        || record.finishReason.trim() !== record.finishReason
        || /[\u0000-\u001f\u007f]/.test(record.finishReason)
        || unfinishedReasons.has(record.finishReason.toLowerCase())) return undefined
    // Numeric strings are not the SDK contract and therefore are not trusted.
    return typeof record.totalCost === 'number' ? normalizeUsd(record.totalCost) : undefined
}
