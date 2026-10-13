import type {GenerationOwner} from './useDB'
import {createAccountBilling} from './accountBilling'
import {reconcileAccountBilling} from './billingReconciliation'
import {useGateway} from './useGateway'

/** Account reads make a small, awaited price refresh. Leases and backoff in
 * PostgreSQL prevent parallel tabs or instances from repeating each lookup. */
export async function reconcilePendingAccountBilling(actor: GenerationOwner, options: {generationId?: number; limit?: number; lookupTimeoutMs?: number} = {}) {
    const ledger = createAccountBilling()
    await ledger.registerLegacyOutstanding(actor, options.generationId)
    let gateway: ReturnType<typeof useGateway> | undefined
    return reconcileAccountBilling(actor, ledger, {getGenerationBilling: async id => {
        gateway ??= useGateway()
        return (await gateway).getGenerationBilling(id)
    }}, {limit: options.limit ?? 2, lookupTimeoutMs: options.lookupTimeoutMs ?? 5_000, generationId: options.generationId})
}

export async function refreshPendingAccountBilling(actor: GenerationOwner) {
    try { await reconcilePendingAccountBilling(actor) }
    catch {
        // A temporarily unavailable quote must keep the image locked while
        // existing history/balances stay readable. Do not log provider data.
        console.warn('[billing] Price confirmation is temporarily unavailable')
    }
}
