import type {GenerationBilling, GenerationOwner} from './useDB'
import type {ImageGenerationBilling} from './useGateway'
import type {OutstandingChargeClaim} from './accountBilling'
import {hasConfirmedGenerationPrice} from '../../schemas/generation-billing'
import {settleWithinMs} from './gatewayTimeout'

export type BillingReconciliationLedger<Row> = {
    claimOutstandingCharges(actor: GenerationOwner, options: {limit: number; leaseMs: number; generationId?: number}): Promise<OutstandingChargeClaim[]>
    settleClaim(actor: GenerationOwner, claim: OutstandingChargeClaim, billing: GenerationBilling): Promise<Row[]>
    releaseClaim(actor: GenerationOwner, claim: OutstandingChargeClaim): Promise<void>
}

export type BillingLookup = {
    getGenerationBilling(generationId: string, fallbackModel?: string): Promise<ImageGenerationBilling | undefined>
}

/** Reconcile a small number of provider calls, rather than charging/querying
 * once for every output. PostgreSQL owns leases, fencing and retry backoff;
 * Gateway owns authoritative prices. This work is awaited by the request and
 * never launches a detached polling task in a serverless process. */
export async function reconcileAccountBilling<Row>(
    actor: GenerationOwner,
    ledger: BillingReconciliationLedger<Row>,
    gateway: BillingLookup,
    options: {limit?: number; generationId?: number; lookupTimeoutMs?: number} = {},
) {
    const limit = Math.max(1, Math.min(4, Number.isSafeInteger(options.limit) ? options.limit! : 4))
    const timeoutMs = Math.max(1, Math.min(10_000, Number.isSafeInteger(options.lookupTimeoutMs) ? options.lookupTimeoutMs! : 10_000))
    const claims = await ledger.claimOutstandingCharges(actor, {limit, leaseMs: 45_000, generationId: options.generationId})
    if (claims.length > limit) throw new Error('Billing reconciliation claim limit exceeded')
    const confirmedRows: Row[] = []
    let pendingGroups = 0
    const outcomes = await Promise.allSettled(claims.map(async claim => {
        let rows: Row[] = []
        try {
            const billing = await settleWithinMs(gateway.getGenerationBilling(claim.gatewayGenerationId), timeoutMs, 'Gateway billing reconciliation')
            if (hasConfirmedGenerationPrice(billing) && billing?.gatewayGenerationId === claim.gatewayGenerationId) {
                rows = await ledger.settleClaim(actor, claim, billing)
            }
        } catch {
            // releaseClaim is token-fenced, so even an ambiguous transaction
            // response cannot undo an already confirmed charge.
        }
        if (rows.length) confirmedRows.push(...rows)
        else {
            pendingGroups += 1
            await ledger.releaseClaim(actor, claim)
        }
    }))
    return {
        checkedGroups: claims.length,
        confirmedRows,
        confirmedCount: confirmedRows.length,
        pendingGroups,
        retryErrors: outcomes.filter(outcome => outcome.status === 'rejected').length,
    }
}
