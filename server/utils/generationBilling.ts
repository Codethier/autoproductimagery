import type { GenerationBilling } from '~~/server/utils/useDB'

export function resolveGenerationTotalTokens(
    reportedTotal: number | undefined,
    inputTokens: number | undefined,
    outputTokens: number | undefined,
) {
    if (reportedTotal != null) return reportedTotal
    if (inputTokens == null && outputTokens == null) return undefined
    // Reasoning and cached counts are normally details/subsets of output and
    // input respectively, not additional top-level token categories.
    return (inputTokens ?? 0) + (outputTokens ?? 0)
}

function splitInteger(value: number | undefined, index: number, count: number) {
    if (value == null) return undefined
    const base = Math.floor(value / count)
    return base + (index < value % count ? 1 : 0)
}

function splitPrice(value: string | undefined, index: number, count: number) {
    if (value == null) return undefined
    const price = Number(value)
    if (!Number.isFinite(price)) return value
    const fixedUnits = Math.round(price * 100_000_000)
    const allocatedUnits = splitInteger(fixedUnits, index, count)
    return allocatedUnits == null ? value : (allocatedUnits / 100_000_000).toFixed(8)
}

function allocateCoupledTotal(
    billing: GenerationBilling,
    index: number,
    count: number,
    allocatedInput: number | undefined,
    allocatedOutput: number | undefined,
    allocatedReasoning: number | undefined,
) {
    if (billing.totalTokens == null) return undefined

    const hasPrimaryComponents = billing.inputTokens != null || billing.outputTokens != null
    if (hasPrimaryComponents) {
        const primaryBatchTotal = (billing.inputTokens ?? 0) + (billing.outputTokens ?? 0)
        const primaryRowTotal = (allocatedInput ?? 0) + (allocatedOutput ?? 0)

        // AI SDK reasoning tokens are normally a detail/subset of output
        // tokens, so do not double-count them when input + output already
        // matches the reported total.
        if (billing.totalTokens === primaryBatchTotal) return primaryRowTotal

        // Some Gateway records report completion and reasoning separately. We
        // treat reasoning as additive only when the batch-level arithmetic
        // explicitly proves that semantic.
        if (billing.reasoningTokens != null
            && billing.totalTokens === primaryBatchTotal + billing.reasoningTokens) {
            return primaryRowTotal + (allocatedReasoning ?? 0)
        }
    }

    // Preserve an authoritative but otherwise non-decomposable total rather
    // than inventing a relationship between incompatible provider counters.
    return splitInteger(billing.totalTokens, index, count)
}

export function allocateGenerationBilling(
    billing: GenerationBilling,
    index: number,
    count: number,
): GenerationBilling {
    if (count <= 1) return billing
    const inputTokens = splitInteger(billing.inputTokens, index, count)
    const outputTokens = splitInteger(billing.outputTokens, index, count)
    const reasoningTokens = splitInteger(billing.reasoningTokens, index, count)
    return {
        ...billing,
        inputTokens,
        outputTokens,
        totalTokens: allocateCoupledTotal(
            billing,
            index,
            count,
            inputTokens,
            outputTokens,
            reasoningTokens,
        ),
        cachedInputTokens: splitInteger(billing.cachedInputTokens, index, count),
        reasoningTokens,
        // Allocate integer 1e-8 USD units so the row values always add back
        // to the exact stored batch total.
        priceUsd: splitPrice(billing.priceUsd, index, count),
        usageJson: {
            ...(billing.usageJson ?? {}),
            allocation: {outputIndex: index, outputCount: count, method: 'equal-share'},
        },
    }
}

export function readGenerationAllocation(value: unknown) {
    if (!value || typeof value !== 'object') return undefined
    const allocation = (value as Record<string, unknown>).allocation
    if (!allocation || typeof allocation !== 'object') return undefined
    const record = allocation as Record<string, unknown>
    const outputIndex = Number(record.outputIndex)
    const outputCount = Number(record.outputCount)
    if (!Number.isInteger(outputIndex) || !Number.isInteger(outputCount)
        || outputIndex < 0 || outputCount <= 1 || outputIndex >= outputCount) {
        return undefined
    }
    return {outputIndex, outputCount}
}
