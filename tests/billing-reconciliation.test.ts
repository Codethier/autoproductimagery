import assert from 'node:assert/strict'
import test from 'node:test'
import {reconcileAccountBilling, type BillingReconciliationLedger} from '../server/utils/billingReconciliation.ts'
import type {OutstandingChargeClaim} from '../server/utils/accountBilling.ts'

const actor = {organizationId: 'org-local', userId: 'user-local'}
const claim = (id: string, rows = 1): OutstandingChargeClaim => ({gatewayGenerationId: id, tokenUUID: `token-${id}`,
    expiresAt: '2026-10-13T18:00:00Z', rows: Array.from({length: rows}, (_, index) => ({generationId: index + 1,
        allocation: rows === 1 ? undefined : {outputIndex: index, outputCount: rows}}))})

test('one reconciliation lookup settles every sibling and respects account-scoped lease contracts', async () => {
    const groups = [claim('gen_multi', 3), claim('gen_zero')]
    const lookedUp: string[] = []
    const settled: string[] = []
    const ledger: BillingReconciliationLedger<{id: number}> = {
        claimOutstandingCharges: async (identity, options) => {
            assert.equal(identity, actor)
            assert.equal(options.limit, 4)
            assert.equal(options.leaseMs, 45_000)
            assert.equal(options.generationId, 99)
            return groups
        },
        settleClaim: async (identity, group, billing) => {
            assert.equal(identity, actor)
            assert.equal(billing.gatewayGenerationId, group.gatewayGenerationId)
            assert.equal(billing.priceUsd, group.gatewayGenerationId === 'gen_zero' ? '0.000000000000' : '0.100000000000')
            settled.push(group.gatewayGenerationId)
            return group.rows.map(row => ({id: row.generationId}))
        },
        releaseClaim: async () => assert.fail('Final Gateway prices should settle'),
    }
    const result = await reconcileAccountBilling(actor, ledger, {getGenerationBilling: async id => {
        lookedUp.push(id)
        return {priceSource: 'gateway', gatewayGenerationId: id, priceUsd: id === 'gen_zero' ? '0.000000000000' : '0.100000000000'}
    }}, {generationId: 99})
    assert.deepEqual(lookedUp.sort(), ['gen_multi', 'gen_zero'])
    assert.deepEqual(settled.sort(), ['gen_multi', 'gen_zero'])
    assert.equal(result.confirmedCount, 4)
    assert.equal(result.pendingGroups, 0)
    assert.equal(result.retryErrors, 0)
})

test('missing, provisional, mismatched, timed-out and failed settlement records back off without unlocking', async () => {
    for (const kind of ['missing', 'estimate', 'mismatched', 'timeout', 'settlement-failed', 'lease-lost']) {
        const group = claim('gen_pending')
        let released = 0
        let settled = 0
        const ledger: BillingReconciliationLedger<{id: number}> = {
            claimOutstandingCharges: async () => [group],
            settleClaim: async () => {
                settled += 1
                if (kind === 'settlement-failed') throw new Error('Disposable database unavailable')
                return []
            },
            releaseClaim: async (identity, given) => {
                assert.equal(identity, actor)
                assert.equal(given.tokenUUID, group.tokenUUID)
                released += 1
            },
        }
        const result = await reconcileAccountBilling(actor, ledger, {getGenerationBilling: async id => {
            if (kind === 'missing') return undefined
            if (kind === 'timeout') return new Promise(() => undefined)
            return {priceSource: kind === 'estimate' ? 'estimate' : 'gateway', priceUsd: '0.100000000000',
                gatewayGenerationId: kind === 'mismatched' ? 'gen_other' : id}
        }}, {lookupTimeoutMs: 10})
        assert.equal(result.confirmedCount, 0, kind)
        assert.equal(result.pendingGroups, 1, kind)
        assert.equal(released, 1, kind)
        assert.equal(settled, kind === 'settlement-failed' || kind === 'lease-lost' ? 1 : 0, kind)
    }
})

test('reconciliation is capped at four simultaneous metadata lookups and releases every timeout', async () => {
    const groups = Array.from({length: 4}, (_, index) => claim(`gen_${index}`))
    let active = 0, peak = 0, released = 0
    const ledger: BillingReconciliationLedger<never> = {
        claimOutstandingCharges: async (_actor, options) => {assert.equal(options.limit, 4); return groups},
        settleClaim: async () => assert.fail('Timeouts cannot settle'),
        releaseClaim: async () => {released += 1},
    }
    const result = await reconcileAccountBilling(actor, ledger, {getGenerationBilling: async () => {
        active += 1; peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 30))
        active -= 1
        return undefined
    }}, {limit: 999, lookupTimeoutMs: 5})
    assert.equal(peak, 4)
    assert.equal(released, 4)
    assert.equal(result.pendingGroups, 4)
    assert.equal(result.checkedGroups, 4)
})
