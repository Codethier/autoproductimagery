import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {Pool} from 'pg'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {eq} from 'drizzle-orm'
import {allocateUsdUnits, formatUsdUnits, MAX_USD_UNITS, parseUsdUnits, UsdAmountSchema} from '../schemas/account-billing.ts'
import {accountBalanceAdjustments, accountGenerationCharges, organizations, systemPrompt, users} from '../server/db/schema.ts'
import {assertGenerationCredit, createAccountBilling, recordGenerationCharge} from '../server/utils/accountBilling.ts'
import type {AuthContext} from '../server/utils/accountSession.ts'
import {useDB} from '../server/utils/useDB.ts'
import {createDefaultSettings, type StoredGenerationConfig} from '../schemas/image-generation.ts'

test('USD accounting parses decimal strings exactly, including zero and integer-unit rounding boundaries', () => {
    assert.equal(parseUsdUnits('0'), 0n)
    assert.equal(parseUsdUnits('0.000000000001'), 1n)
    assert.equal(parseUsdUnits('0.1')! + parseUsdUnits('0.2')!, 300_000_000_000n)
    assert.equal(formatUsdUnits(parseUsdUnits('0.1')! + parseUsdUnits('0.2')!), '0.300000000000')
    assert.equal(formatUsdUnits(-1n), '-0.000000000001')
    assert.equal(parseUsdUnits('999999999999.999999999999'), MAX_USD_UNITS)
    assert.equal(parseUsdUnits('1000000000000'), undefined)
    assert.equal(UsdAmountSchema.parse('2.50'), '2.500000000000')
    for (const invalid of [-1, 1, null, '', '00', '01', '-0', '-1', '1.', '.5', ' 1', '1 ', '1e-8', 'NaN', 'Infinity', '1.0000000000001', '999999999999999999999999']) assert.equal(parseUsdUnits(invalid), undefined)
})

test('multiple image charges allocate exact integer units once while preserving the authoritative total', () => {
    const total = parseUsdUnits('0.100000000001')!
    const shares = Array.from({length: 3}, (_, index) => allocateUsdUnits(total, index, 3))
    assert.equal(shares.reduce((sum, share) => sum + share, 0n), total)
    assert.deepEqual(shares, [33_333_333_334n, 33_333_333_334n, 33_333_333_333n])
    assert.equal(allocateUsdUnits(0n, 0, 1), 0n)
    for (const args of [[-1n, 0, 1], [1n, -1, 1], [1n, 1, 1], [1n, 0, 0], [1n, 0, 1.5]] as const) assert.throws(() => allocateUsdUnits(args[0], args[1], args[2]))
})

const integration = {skip: !process.env.TEST_DATABASE_URL, timeout: 60_000}
const status = (code: number) => (error: unknown) => (error as {statusCode?: number}).statusCode === code
async function fixture(work: (f: {db: ReturnType<typeof drizzle>; owner: AuthContext; alice: AuthContext; bob: AuthContext; outsider: AuthContext}) => Promise<void>) {
    const connectionString = process.env.TEST_DATABASE_URL!
    const schema = `charge_test_${randomUUID().replaceAll('-', '')}`
    const administrator = new Pool({connectionString, max: 1})
    const pool = new Pool({connectionString, max: 4, options: `-c search_path=${schema} -c timezone=UTC`})
    try {
        await administrator.query(`CREATE SCHEMA "${schema}"`)
        const db = drizzle({client: pool})
        await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle/postgres', import.meta.url)), migrationsSchema: schema})
        await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle/postgres', import.meta.url)), migrationsSchema: schema})
        const organizationId = randomUUID(), otherOrg = randomUUID()
        await db.insert(organizations).values([{id: organizationId, name: 'Studio'}, {id: otherOrg, name: 'Other'}])
        const identities = ['owner', 'alice', 'bob', 'outsider'].map((name, index): AuthContext => ({userId: randomUUID(), organizationId: index === 3 ? otherOrg : organizationId,
            role: index === 0 || index === 3 ? 'owner' : 'user', displayName: name, username: name, organizationName: 'Studio', isBootstrapOwner: false, authVersion: 1}))
        await db.insert(users).values(identities.map(actor => ({id: actor.userId, organizationId: actor.organizationId, role: actor.role,
            displayName: actor.displayName, username: actor.username, normalizedUsername: actor.username, passwordHash: 'unused-test-password-hash'})))
        await work({db, owner: identities[0]!, alice: identities[1]!, bob: identities[2]!, outsider: identities[3]!})
    } finally {await pool.end(); await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await administrator.end()}
}
async function generation(db: ReturnType<typeof drizzle>, actor: AuthContext, values: Partial<typeof systemPrompt.$inferInsert> = {}) {
    const [row] = await db.insert(systemPrompt).values({organizationId: actor.organizationId, userId: actor.userId, TextPrompt: 'Local fixture', outputImage: '',
        status: 'pending', billingState: 'pending', ...values}).returning()
    return row!
}
async function post(db: ReturnType<typeof drizzle>, row: typeof systemPrompt.$inferSelect, release = false) {
    await db.transaction(tx => recordGenerationCharge(tx, row, {release}))
}

test('each user has an exact private balance, separating estimates and unknown outstanding jobs from confirmed costs', integration, async () => fixture(async f => {
    const billing = createAccountBilling(f.db)
    assert.deepEqual(await billing.balanceFor(f.alice), {currency: 'USD', confirmedSpendUsd: '0.000000000000', totalPaidUsd: '0.000000000000', unpaidUsd: '0.000000000000', overpaidUsd: '0.000000000000', outstandingEstimateUsd: '0.000000000000', outstandingCount: 0,
        outstandingUnknownCount: 0, actualBalanceUsd: null, unlimited: true, generationBlockedByOutstanding: false})
    const pending = await generation(f.db, f.alice)
    const estimated = await generation(f.db, f.alice, {status: 'succeeded', billingState: 'awaiting', priceSource: 'estimate', priceUsd: '0.12', gatewayGenerationId: 'gen_local_estimate'})
    const tiny = await generation(f.db, f.alice, {status: 'succeeded', billingState: 'confirmed', priceSource: 'gateway', priceUsd: '0.000000000001'})
    for (const row of [pending, estimated, tiny]) await post(f.db, row)
    await generation(f.db, f.alice, {status: 'succeeded', billingState: null, priceSource: 'gateway', priceUsd: '0.1'})
    await generation(f.db, f.alice, {status: 'succeeded', billingState: null, priceSource: 'gateway', priceUsd: 'invalid'})
    const released = await generation(f.db, f.alice, {status: 'failed', billingState: 'released'})
    await post(f.db, released, true)
    const balance = await billing.balanceFor(f.alice)
    assert.equal(balance.confirmedSpendUsd, '0.100000000001')
    assert.equal(balance.outstandingEstimateUsd, '0.120000000000')
    assert.equal(balance.outstandingCount, 3)
    assert.equal(balance.outstandingUnknownCount, 2)
    assert.equal((await billing.balanceFor(f.owner)).confirmedSpendUsd, '0.000000000000')
    assert.equal((await billing.balanceFor(f.bob)).outstandingCount, 0)
    await assert.rejects(billing.balanceFor({...f.alice, organizationId: f.outsider.organizationId}), status(404))
    assert.equal((await f.db.select().from(accountGenerationCharges)).length, 4, 'legacy fallback does not write a ledger row during reads')
}))

test('confirmed per-output charges debit current credit once across concurrent postings and do not overwrite confirmed accounting', integration, async () => fixture(async f => {
    const billing = createAccountBilling(f.db)
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, '1')
    const paid = await generation(f.db, f.alice, {status: 'succeeded', billingState: 'confirmed', priceSource: 'gateway', priceUsd: '0.3', gatewayGenerationId: 'gen_local_paid'})
    await Promise.all([post(f.db, paid), post(f.db, paid), post(f.db, paid)])
    await post(f.db, {...paid, priceUsd: '0.4'})
    await post(f.db, {...paid, billingState: 'awaiting', priceSource: 'estimate', priceUsd: '10'})
    assert.equal((await billing.balanceFor(f.alice)).confirmedSpendUsd, '0.300000000000')
    assert.equal((await billing.balanceFor(f.alice)).actualBalanceUsd, '0.700000000000')
    const zero = await generation(f.db, f.alice, {status: 'succeeded', billingState: 'confirmed', priceSource: 'gateway', priceUsd: '0'})
    await post(f.db, zero)
    assert.equal((await billing.balanceFor(f.alice)).actualBalanceUsd, '0.700000000000')
    const failedButPaid = await generation(f.db, f.alice, {status: 'failed', billingState: 'confirmed', priceSource: 'gateway', priceUsd: '0.9'})
    await post(f.db, failedButPaid)
    assert.equal((await billing.balanceFor(f.alice)).actualBalanceUsd, '-0.200000000000')
    assert.equal((await billing.balanceFor(f.alice)).confirmedSpendUsd, '1.200000000000')
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, null)
    assert.equal((await billing.balanceFor(f.alice)).unlimited, true)
}))

test('only a current enabled organization owner can inspect or set another user current balance, with durable adjustments', integration, async () => fixture(async f => {
    const billing = createAccountBilling(f.db)
    await assert.rejects(billing.organizationUserBalance(f.alice, f.bob.userId), status(403))
    await assert.rejects(billing.setOrganizationUserBalance(f.alice, f.alice.userId, '4'), status(403))
    await assert.rejects(billing.setOrganizationUserBalance(f.owner, f.outsider.userId, '4'), status(404))
    await assert.rejects(billing.setOrganizationUserBalance(f.outsider, f.alice.userId, '4'), status(404))
    await assert.rejects(billing.setOrganizationUserBalance(f.owner, f.alice.userId, '-1'), status(400))
    const changed = await billing.setOrganizationUserBalance(f.owner, f.alice.userId, '5.01')
    assert.equal(changed.balance.actualBalanceUsd, '5.010000000000')
    assert.equal((await billing.organizationUserBalance(f.owner, f.alice.userId)).balance.actualBalanceUsd, '5.010000000000')
    const [adjustment] = await f.db.select().from(accountBalanceAdjustments)
    assert.equal(adjustment!.previousUnits, null)
    assert.equal(adjustment!.actualUnits, parseUsdUnits('5.01')!.toString())
    assert.equal(adjustment!.adjustedByUserId, f.owner.userId)
    await f.db.update(users).set({role: 'user'}).where(eq(users.id, f.owner.userId))
    await assert.rejects(billing.setOrganizationUserBalance(f.owner, f.alice.userId, null), status(403))
}))

test('balance snapshots keep available credit and confirmed spend consistent during concurrent postings', integration, async () => fixture(async f => {
    const billing = createAccountBilling(f.db)
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, '10')
    const rows = await Promise.all(Array.from({length: 16}, () => generation(f.db, f.alice,
        {status: 'succeeded', billingState: 'confirmed', priceSource: 'gateway', priceUsd: '0.1'})))
    // Register outstanding entries before posting so the legacy projection
    // does not count these synthetic pre-confirmed test rows independently.
    for (const row of rows) await post(f.db, {...row, billingState: 'awaiting', priceSource: 'unknown'})
    await Promise.all([
        Promise.all(rows.map(row => post(f.db, row))),
        (async () => {
            for (let i = 0; i < 32; i++) {
                const balance = await billing.balanceFor(f.alice)
                assert.equal(parseUsdUnits(balance.actualBalanceUsd)! + parseUsdUnits(balance.confirmedSpendUsd)!, parseUsdUnits('10'))
            }
        })(),
    ])
    const final = await billing.balanceFor(f.alice)
    assert.equal(final.actualBalanceUsd, '8.400000000000')
    assert.equal(final.confirmedSpendUsd, '1.600000000000')
}))

test('Gateway charge claims coordinate instances, retry with backoff, and fence stale workers before exact multioutput settlement', integration, async () => fixture(async f => {
    const billing = createAccountBilling(f.db), otherInstance = createAccountBilling(f.db)
    const now = Date.now() + 1000
    for (let index = 0; index < 3; index++) await post(f.db, await generation(f.db, f.alice, {status: 'succeeded', billingState: 'awaiting', priceSource: 'estimate', priceUsd: '0.04',
        gatewayGenerationId: 'gen_three_outputs', usageJson: {allocation: {outputIndex: index, outputCount: 3, method: 'equal-share'}}}))
    const attempts = await Promise.all([billing.claimOutstandingCharges(f.alice, {nowMs: now}), otherInstance.claimOutstandingCharges(f.alice, {nowMs: now})])
    assert.equal(attempts.flat().length, 1)
    const first = attempts.flat()[0]!
    assert.equal(first.rows.length, 3)
    await billing.releaseClaim(f.alice, first, now)
    assert.equal((await billing.claimOutstandingCharges(f.alice, {nowMs: now + 4000})).length, 0)
    const [second] = await billing.claimOutstandingCharges(f.alice, {nowMs: now + 6000, leaseMs: 30_000})
    assert.ok(second)
    await billing.releaseClaim(f.alice, first, now + 7000)
    const actual = {priceSource: 'gateway' as const, priceUsd: '0.100000000001', gatewayGenerationId: 'gen_three_outputs'}
    assert.deepEqual(await billing.settleClaim(f.alice, first, actual, now + 7000), [])
    assert.deepEqual(await billing.settleClaim(f.bob, second!, actual, now + 7000), [])
    const expired = now + 40_000
    assert.deepEqual(await billing.settleClaim(f.alice, second!, actual, expired), [])
    const [fresh] = await billing.claimOutstandingCharges(f.alice, {nowMs: expired})
    assert.ok(fresh)
    await assert.rejects(billing.settleClaim(f.alice, fresh!, {...actual, priceSource: 'estimate'}, expired), /Unconfirmed/)
    const settled = await billing.settleClaim(f.alice, fresh!, actual, expired)
    assert.equal(settled.length, 3)
    assert.equal(settled.reduce((total, row) => total + parseUsdUnits(row.priceUsd)!, 0n), parseUsdUnits(actual.priceUsd))
    assert.deepEqual(await billing.settleClaim(f.alice, fresh!, actual, expired), [])
    assert.equal((await billing.balanceFor(f.alice)).confirmedSpendUsd, actual.priceUsd)
    assert.equal((await billing.balanceFor(f.alice)).outstandingCount, 0)
}))

test('finite credit admission serializes new batches while allowing the current batch and unlimited accounts', integration, async () => fixture(async f => {
    const billing = createAccountBilling(f.db)
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, '0')
    await assert.rejects(f.db.transaction(tx => assertGenerationCredit(tx, f.alice, randomUUID())), status(402))
    await f.db.transaction(tx => assertGenerationCredit(tx, f.bob, randomUUID()))
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, '0.01')
    const batchId = randomUUID()
    await f.db.transaction(async tx => {
        await assertGenerationCredit(tx, f.alice, batchId)
        const [row] = await tx.insert(systemPrompt).values({organizationId: f.alice.organizationId, userId: f.alice.userId, TextPrompt: 'Pending batch', outputImage: '', status: 'pending', billingState: 'pending', batchId}).returning()
        await recordGenerationCharge(tx, row!)
    })
    await f.db.transaction(tx => assertGenerationCredit(tx, f.alice, batchId))
    await assert.rejects(f.db.transaction(tx => assertGenerationCredit(tx, f.alice, randomUUID())), status(409))
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, null)
    await f.db.transaction(tx => assertGenerationCredit(tx, f.alice, randomUUID()))
}))

test('registering a previously confirmed legacy charge preserves newly assigned current credit', integration, async () => fixture(async f => {
    const billing = createAccountBilling(f.db)
    const old = await generation(f.db, f.alice, {status: 'succeeded', billingState: null, priceUsd: '3.25', priceSource: 'gateway'})
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, '10')
    assert.equal((await billing.balanceFor(f.alice)).confirmedSpendUsd, '3.250000000000')
    await f.db.transaction(tx => recordGenerationCharge(tx, {...old, billingState: 'confirmed'}, {skipDebit: true}))
    assert.equal((await billing.balanceFor(f.alice)).confirmedSpendUsd, '3.250000000000')
    assert.equal((await billing.balanceFor(f.alice)).actualBalanceUsd, '10.000000000000')
}))

test('incomplete, pending and duplicated multioutput provider allocations cannot be claimed or charged', integration, async () => fixture(async f => {
    const billing = createAccountBilling(f.db), now = Date.now() + 1000
    const incomplete = await generation(f.db, f.alice, {status: 'succeeded', billingState: 'awaiting', gatewayGenerationId: 'gen_incomplete',
        usageJson: {allocation: {outputIndex: 0, outputCount: 2}}})
    await post(f.db, incomplete)
    assert.deepEqual(await billing.claimOutstandingCharges(f.alice, {nowMs: now}), [])
    const pending = await generation(f.db, f.alice, {gatewayGenerationId: 'gen_incomplete', usageJson: {allocation: {outputIndex: 1, outputCount: 2}}})
    await post(f.db, pending)
    assert.deepEqual(await billing.claimOutstandingCharges(f.alice, {nowMs: now}), [])
    for (let index = 0; index < 2; index++) await post(f.db, await generation(f.db, f.alice, {status: 'succeeded', billingState: 'awaiting', gatewayGenerationId: 'gen_duplicate',
        usageJson: {allocation: {outputIndex: 0, outputCount: 2}}}))
    assert.deepEqual(await billing.claimOutstandingCharges(f.alice, {nowMs: now}), [])
    assert.equal((await billing.balanceFor(f.alice)).confirmedSpendUsd, '0.000000000000')
}))

test('parallel finite-account batches cannot both pass admission, and unpriced jobs do not starve priced reconciliation', integration, async () => fixture(async f => {
    const billing = createAccountBilling(f.db)
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, '0.1')
    const attempts = await Promise.allSettled(Array.from({length: 2}, () => f.db.transaction(async tx => {
        const batchId = randomUUID()
        await assertGenerationCredit(tx, f.alice, batchId)
        const [row] = await tx.insert(systemPrompt).values({organizationId: f.alice.organizationId, userId: f.alice.userId, TextPrompt: 'Concurrent batch', outputImage: '', status: 'pending', billingState: 'pending', batchId}).returning()
        await recordGenerationCharge(tx, row!)
    })))
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(attempts.filter(result => result.status === 'rejected' && status(409)(result.reason)).length, 1)
    for (let index = 0; index < 70; index++) await post(f.db, await generation(f.db, f.bob, {status: 'succeeded', billingState: 'awaiting'}))
    const priced = await generation(f.db, f.bob, {status: 'succeeded', billingState: 'awaiting', gatewayGenerationId: 'gen_after_unknown_jobs'})
    await post(f.db, priced)
    const claims = await billing.claimOutstandingCharges(f.bob, {nowMs: Date.now() + 1000})
    assert.equal(claims.length, 1)
    assert.equal(claims[0]!.gatewayGenerationId, priced.gatewayGenerationId)
}))

test('legacy reconciliation registers a complete scoped provider group, excludes BYOK from confirmed totals, and preserves preassigned credit', integration, async () => fixture(async f => {
    const billing = createAccountBilling(f.db)
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, '5')
    const first = await generation(f.db, f.alice, {status: null, billingState: null, priceSource: 'estimate', priceUsd: '0.1', gatewayGenerationId: 'gen_legacy_pair', usageJson: {allocation: {outputIndex: 0, outputCount: 2}}})
    await generation(f.db, f.alice, {status: 'succeeded', billingState: null, priceSource: 'gateway', priceUsd: '0.1', gatewayGenerationId: 'gen_legacy_pair', usageJson: {allocation: {outputIndex: 1, outputCount: 2}}})
    await generation(f.db, f.bob, {status: 'succeeded', billingState: null, gatewayGenerationId: 'gen_bob_legacy'})
    const byok = await generation(f.db, f.alice, {status: 'succeeded', billingState: null, gatewayGenerationId: 'gen_legacy_byok', priceSource: 'gateway', priceUsd: '0', usageJson: {gatewayBilling: {isByok: true}}})
    assert.equal((await billing.balanceFor(f.alice)).outstandingCount, 2)
    assert.equal(await billing.registerLegacyOutstanding(f.alice, first.id), 2)
    assert.equal(await billing.registerLegacyOutstanding(f.alice, first.id), 0)
    assert.equal((await billing.balanceFor(f.alice)).actualBalanceUsd, '5.000000000000')
    assert.equal((await billing.balanceFor(f.bob)).outstandingCount, 1)
    const [claim] = await billing.claimOutstandingCharges(f.alice, {generationId: first.id, nowMs: Date.now() + 1000})
    assert.ok(claim)
    await billing.settleClaim(f.alice, claim!, {priceSource: 'gateway', priceUsd: '0.2', gatewayGenerationId: 'gen_legacy_pair'}, Date.now() + 1000)
    assert.equal((await billing.balanceFor(f.alice)).confirmedSpendUsd, '0.200000000000')
    assert.equal((await billing.balanceFor(f.alice)).actualBalanceUsd, '4.900000000000', 'previously confirmed sibling is not charged again')
    assert.equal(await billing.registerLegacyOutstanding(f.alice, byok.id), 1)
    const [byokLedger] = await f.db.select().from(accountGenerationCharges).where(eq(accountGenerationCharges.generationId, byok.id))
    assert.equal(byokLedger!.state, 'outstanding')
    assert.equal(byokLedger!.confirmedUnits, null)
}))

test('useDB generation hooks atomically admit, post, preserve confirmed prices, and persist extra outputs for an overdrawn batch', integration, async () => fixture(async f => {
    const billing = createAccountBilling(f.db), generationDB = await useDB(f.db, f.alice), bobDB = await useDB(f.db, f.bob)
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, '0')
    const config: StoredGenerationConfig = {schemaVersion: 1, profileVersion: 1, requestedModel: 'google/gemini-3-pro-image', effectiveModel: 'google/gemini-3-pro-image', settings: createDefaultSettings('google/gemini-3-pro-image'), storeInputImages: true}
    const pending = (batchId: string) => ({prompt: 'Image fixture', inputImages: [], modelImages: [], requestedModel: config.requestedModel, effectiveModel: config.effectiveModel, batchId, generationConfig: config})
    await assert.rejects(generationDB.createPendingGeneration(pending(randomUUID())), status(402))
    assert.equal(await generationDB.countSystemPrompts(), 0)
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, '0.1')
    const batchId = randomUUID(), first = await generationDB.createPendingGeneration(pending(batchId))
    await assert.rejects(generationDB.createPendingGeneration(pending(randomUUID())), status(409))
    const completion = {outputImage: '/images/fixture.png', outputMetadata: {mimeType: 'image/png', bytes: 42, width: 3, height: 2, warnings: []},
        billing: {priceSource: 'gateway' as const, priceUsd: '0.2', gatewayGenerationId: 'gen_hook'}, log: {status: 'success', model: config.effectiveModel, prompt: 'Image fixture'}}
    await generationDB.completeGeneration(first.id, completion)
    assert.equal((await billing.balanceFor(f.alice)).actualBalanceUsd, '-0.100000000000')
    const extra = await generationDB.createPendingGeneration(pending(batchId))
    assert.ok(extra.id > first.id)
    await assert.rejects(generationDB.createPendingGeneration(pending(randomUUID())), status(402))
    const repeated = await generationDB.updateSystemPromptBilling(first.id, {...completion.billing, priceUsd: '999'})
    assert.equal(repeated!.priceUsd, '0.2')
    assert.equal((await billing.balanceFor(f.alice)).actualBalanceUsd, '-0.100000000000')
    assert.equal(await bobDB.updateSystemPromptBilling(first.id, completion.billing), undefined)
    const legacy = await generation(f.db, f.alice, {status: 'succeeded', billingState: null, priceSource: 'gateway', priceUsd: '1.25'})
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, '10')
    const registered = await generationDB.updateSystemPromptBilling(legacy.id, {...completion.billing, priceUsd: '999'})
    assert.equal(registered!.priceUsd, '1.25')
    assert.equal((await billing.balanceFor(f.alice)).actualBalanceUsd, '10.000000000000')
}))
