import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {Pool} from 'pg'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {eq, sql} from 'drizzle-orm'
import {accountGenerationCharges, accountPayments, organizations, systemPrompt, users} from '../server/db/schema.ts'
import {createAccountPayments} from '../server/utils/accountPayments.ts'
import {createAccountBilling, recordGenerationCharge} from '../server/utils/accountBilling.ts'
import {AccountPaymentListQuerySchema, RecordAccountPaymentSchema} from '../schemas/account-payments.ts'
import {parseUsdUnits} from '../schemas/account-billing.ts'
import type {AuthContext} from '../server/utils/accountSession.ts'

test('payment request amounts use positive bounded cents, normalize without floating point, and survive request round trips', () => {
    for (const [input, normalized] of [['5', '5.00'], ['5.0', '5.00'], ['0.01', '0.01'], ['1000000', '1000000.00']]) {
        const parsed = RecordAccountPaymentSchema.parse({amountUsd: input, note: ' received ', idempotencyKey: randomUUID()})
        assert.equal(parsed.amountUsd, normalized)
        assert.equal(parsed.note, 'received')
        assert.deepEqual(RecordAccountPaymentSchema.parse(parsed), parsed)
    }
    for (const amountUsd of [0, null, '', '0', '0.00', '-1', '.50', '1.', '01', ' 1', '1e3', '1.001', '1000000.01', 'Infinity', '1.000000000000'])
        assert.equal(RecordAccountPaymentSchema.safeParse({amountUsd, idempotencyKey: randomUUID()}).success, false)
    assert.equal(RecordAccountPaymentSchema.safeParse({amountUsd: '1', idempotencyKey: 'not-uuid'}).success, false)
    assert.equal(RecordAccountPaymentSchema.safeParse({amountUsd: '1', idempotencyKey: randomUUID(), note: 'x'.repeat(501)}).success, false)
    assert.equal(RecordAccountPaymentSchema.safeParse({amountUsd: '1', idempotencyKey: randomUUID(), note: '\0'}).success, false)
    assert.equal(RecordAccountPaymentSchema.safeParse({amountUsd: '1', idempotencyKey: randomUUID(), createdAt: new Date().toISOString()}).success, false)
    for (const invalid of [{limit: 101}, {limit: 0}, {limit: 1.2}, {cursor: ''}, {cursor: 'x'.repeat(1025)}, {userId: randomUUID()}])
        assert.equal(AccountPaymentListQuerySchema.safeParse(invalid).success, false)
})

const integration = {skip: !process.env.TEST_DATABASE_URL, timeout: 60_000}
const status = (code: number) => (error: unknown) => (error as {statusCode?: number}).statusCode === code
async function fixture(work: (f: {db: ReturnType<typeof drizzle>; pool: Pool; schema: string; owner: AuthContext; secondOwner: AuthContext; alice: AuthContext; bob: AuthContext; outsider: AuthContext}) => Promise<void>) {
    const connectionString = process.env.TEST_DATABASE_URL!
    const url = new URL(connectionString)
    assert.equal(url.hostname, '127.0.0.1', 'payment tests only use explicitly loopback disposable PostgreSQL')
    const schema = `payment_test_${randomUUID().replaceAll('-', '')}`
    const administrator = new Pool({connectionString, max: 1})
    const pool = new Pool({connectionString, max: 8, application_name: schema, options: `-c search_path=${schema} -c timezone=UTC`, statement_timeout: 20_000})
    try {
        await administrator.query(`CREATE SCHEMA "${schema}"`)
        const db = drizzle({client: pool})
        await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle/postgres', import.meta.url)), migrationsSchema: schema})
        await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle/postgres', import.meta.url)), migrationsSchema: schema})
        const organizationId = randomUUID(), otherOrg = randomUUID()
        await db.insert(organizations).values([{id: organizationId, name: 'Studio'}, {id: otherOrg, name: 'Other'}])
        const actors = ['owner', 'second-owner', 'alice', 'bob', 'outsider'].map((name, index): AuthContext => ({userId: randomUUID(), organizationId: index === 4 ? otherOrg : organizationId,
            role: [0, 1, 4].includes(index) ? 'owner' : 'user', displayName: name, username: name, organizationName: 'Studio', isBootstrapOwner: false, authVersion: 1}))
        await db.insert(users).values(actors.map(actor => ({id: actor.userId, organizationId: actor.organizationId, role: actor.role,
            displayName: actor.displayName, username: actor.username, normalizedUsername: actor.username, passwordHash: 'unused-test-password-hash'})))
        await work({db, pool, schema, owner: actors[0]!, secondOwner: actors[1]!, alice: actors[2]!, bob: actors[3]!, outsider: actors[4]!})
    } finally {await pool.end(); await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await administrator.end()}
}
const payment = (amountUsd = '5', note = 'Received payment') => ({amountUsd, note, idempotencyKey: randomUUID()})
async function generation(db: ReturnType<typeof drizzle>, actor: AuthContext, values: Partial<typeof systemPrompt.$inferInsert>) {
    const [row] = await db.insert(systemPrompt).values({organizationId: actor.organizationId, userId: actor.userId, TextPrompt: 'Local accounting fixture', outputImage: '', status: 'succeeded', ...values}).returning()
    return row!
}

test('a $5 received payment against $10 confirmed spend leaves $5 unpaid, preserves prices and unlimited generation credit', integration, async () => fixture(async f => {
    const payments = createAccountPayments(f.db), billing = createAccountBilling(f.db)
    const confirmed = await generation(f.db, f.alice, {billingState: 'confirmed', priceSource: 'gateway', priceUsd: '10'})
    await f.db.transaction(tx => recordGenerationCharge(tx, confirmed))
    await generation(f.db, f.alice, {billingState: null, priceSource: 'estimate', priceUsd: '7', gatewayGenerationId: 'gen_local_estimate'})
    const before = (await f.db.select().from(users).where(eq(users.id, f.alice.userId)))[0]!
    const recorded = await payments.recordOrganizationUserPayment(f.owner, f.alice.userId, payment())
    assert.equal(recorded.created, true)
    assert.equal(recorded.event.amountUsd, '5.000000000000')
    assert.deepEqual(recorded.event.recordedBy, {id: f.owner.userId, displayName: f.owner.displayName, username: f.owner.username})
    assert.match(recorded.event.createdAt, /^\d{4}-\d{2}-\d{2}T.*\.\d{6}Z$/)
    assert.equal(recorded.balance.confirmedSpendUsd, '10.000000000000')
    assert.equal(recorded.balance.totalPaidUsd, '5.000000000000')
    assert.equal(recorded.balance.unpaidUsd, '5.000000000000')
    assert.equal(recorded.balance.overpaidUsd, '0.000000000000')
    assert.equal(recorded.balance.outstandingEstimateUsd, '7.000000000000')
    assert.equal(recorded.balance.actualBalanceUsd, null)
    assert.deepEqual((await f.db.select().from(users).where(eq(users.id, f.alice.userId)))[0], before)
    assert.equal((await f.db.select().from(systemPrompt).where(eq(systemPrompt.id, confirmed.id)))[0]!.priceUsd, '10')
    assert.deepEqual(await payments.listOwnPayments(f.alice), await payments.listOrganizationUserPayments(f.owner, f.alice.userId))
    await payments.recordOrganizationUserPayment(f.owner, f.alice.userId, payment('7.50'))
    const overpaid = await billing.balanceFor(f.alice)
    assert.equal(overpaid.totalPaidUsd, '12.500000000000')
    assert.equal(overpaid.unpaidUsd, '0.000000000000')
    assert.equal(overpaid.overpaidUsd, '2.500000000000')
}))

test('payments include confirmed legacy costs but never count estimates or unknown charges as paid bills', integration, async () => fixture(async f => {
    const payments = createAccountPayments(f.db)
    await generation(f.db, f.alice, {billingState: null, priceSource: 'gateway', priceUsd: '3.200000000001'})
    await generation(f.db, f.alice, {billingState: null, priceSource: 'estimate', priceUsd: '8.25'})
    await generation(f.db, f.alice, {billingState: null, priceSource: 'unknown'})
    const {balance} = await payments.recordOrganizationUserPayment(f.owner, f.alice.userId, payment('1.20'))
    assert.equal(balance.confirmedSpendUsd, '3.200000000001')
    assert.equal(balance.unpaidUsd, '2.000000000001')
    assert.equal(balance.outstandingEstimateUsd, '8.250000000000')
    assert.equal(balance.outstandingCount, 2)
    assert.equal(balance.outstandingUnknownCount, 1)
}))

test('duplicate concurrent requests record once, conflicting reuse is rejected, and finite changes retain replay and history', integration, async () => fixture(async f => {
    const payments = createAccountPayments(f.db), billing = createAccountBilling(f.db), input = payment('0.10')
    const results = await Promise.all(Array.from({length: 5}, () => payments.recordOrganizationUserPayment(f.owner, f.alice.userId, input)))
    assert.equal(results.filter(result => result.created).length, 1)
    assert.equal(new Set(results.map(result => result.event.id)).size, 1)
    for (const changed of [{...input, amountUsd: '0.11'}, {...input, note: 'Different'}])
        await assert.rejects(payments.recordOrganizationUserPayment(f.owner, f.alice.userId, changed), status(409))
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, '8')
    await assert.rejects(payments.recordOrganizationUserPayment(f.owner, f.alice.userId, payment()), status(409))
    const replay = await payments.recordOrganizationUserPayment(f.secondOwner, f.alice.userId, input)
    assert.equal(replay.created, false)
    assert.equal(replay.event.recordedBy.id, f.owner.userId)
    assert.equal(replay.balance.actualBalanceUsd, '8.000000000000')
    assert.equal((await payments.listOwnPayments(f.alice)).events.length, 1)
    assert.equal((await payments.listOrganizationUserPayments(f.owner, f.alice.userId)).events.length, 1)
    assert.equal((await f.db.select().from(accountPayments)).length, 1)
}))

test('only fresh enabled owners record or inspect other same-organization users; users see only their own history', integration, async () => fixture(async f => {
    const payments = createAccountPayments(f.db)
    await payments.recordOrganizationUserPayment(f.owner, f.alice.userId, payment())
    await assert.rejects(payments.recordOrganizationUserPayment(f.alice, f.alice.userId, payment()), status(403))
    await assert.rejects(payments.listOrganizationUserPayments(f.alice, f.alice.userId), status(403))
    await assert.rejects(payments.listOrganizationUserPayments(f.owner, f.outsider.userId), status(404))
    await assert.rejects(payments.recordOrganizationUserPayment(f.owner, f.outsider.userId, payment()), status(404))
    assert.equal((await payments.listOwnPayments(f.bob)).events.length, 0)
    await assert.rejects(payments.listOrganizationUserPayments(f.outsider, f.alice.userId), status(404))
    await assert.rejects(payments.recordOrganizationUserPayment({...f.owner, authVersion: 2}, f.alice.userId, payment()), status(401))
    await f.db.update(users).set({role: 'user'}).where(eq(users.id, f.owner.userId))
    await assert.rejects(payments.recordOrganizationUserPayment(f.owner, f.alice.userId, payment()), status(403))
    await f.db.update(users).set({disabledAt: new Date().toISOString()}).where(eq(users.id, f.secondOwner.userId))
    await assert.rejects(payments.listOrganizationUserPayments(f.secondOwner, f.alice.userId), status(401))
    await f.db.update(users).set({authVersion: 2}).where(eq(users.id, f.alice.userId))
    await assert.rejects(payments.listOwnPayments(f.alice), status(401))
}))

test('recorded owner identity and note remain historical snapshots after display-name changes or disablement', integration, async () => fixture(async f => {
    const payments = createAccountPayments(f.db)
    const {event} = await payments.recordOrganizationUserPayment(f.owner, f.alice.userId, payment('2', 'Bank receipt 42'))
    await f.db.update(users).set({displayName: 'Renamed', username: 'renamed-owner', disabledAt: new Date().toISOString()}).where(eq(users.id, f.owner.userId))
    assert.deepEqual((await payments.listOwnPayments(f.alice)).events[0], event)
    assert.deepEqual((await payments.listOrganizationUserPayments(f.secondOwner, f.alice.userId)).events[0], event)
}))

for (const scenario of ['owner demotion under organization lock', 'password reset without organization lock']) {
    test(`payment creation rechecks revoked authorization after concurrent ${scenario}`, integration, async () => fixture(async f => {
        const holder = await f.pool.connect()
        let attempt: Promise<{status: number | undefined}> | undefined, settled = false
        try {
            await holder.query('BEGIN')
            if (scenario.startsWith('owner')) await holder.query('SELECT id FROM organization WHERE id=$1 FOR UPDATE', [f.owner.organizationId])
            await holder.query('UPDATE app_user SET auth_version=2, role=$2 WHERE id=$1', [f.owner.userId, scenario.startsWith('owner') ? 'user' : 'owner'])
            attempt = createAccountPayments(f.db).recordOrganizationUserPayment(f.owner, f.alice.userId, payment())
                .then(() => ({status: 200}), error => ({status: error.statusCode as number | undefined})).finally(() => {settled = true})
            const deadline = Date.now() + 5000
            let blocked = false
            while (Date.now() < deadline) {
                const result = await f.pool.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type=$2', [f.schema, 'Lock'])
                if (result.rows[0].count > 0) {blocked = true; break}
                await new Promise(resolve => setTimeout(resolve, 10))
            }
            assert.equal(blocked, true, 'payment must wait for the real PostgreSQL authorization lock')
            assert.equal(settled, false)
            await holder.query('COMMIT')
            assert.equal((await attempt).status, 401)
            assert.equal((await f.db.select().from(accountPayments)).length, 0)
        } finally {
            await holder.query('ROLLBACK')
            holder.release()
            await attempt
        }
    }))
}

test('SQL keyset pagination preserves microseconds and equal-time UUID order, with scoped bounded cursors', integration, async () => fixture(async f => {
    const payments = createAccountPayments(f.db)
    for (let i = 0; i < 5; i++) {
        const {event} = await payments.recordOrganizationUserPayment(f.owner, f.alice.userId, payment('1'))
        await f.db.update(accountPayments).set({createdAt: `2026-01-02T03:04:05.123${i < 3 ? '456' : '457'}Z`}).where(eq(accountPayments.id, event.id))
    }
    const collected: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 5; i++) {
        const page = await payments.listOwnPayments(f.alice, {limit: 2, ...(cursor ? {cursor} : {})})
        collected.push(...page.events.map(event => event.id))
        if (!page.nextCursor) break
        cursor = page.nextCursor
    }
    assert.equal(collected.length, 5)
    assert.equal(new Set(collected).size, 5)
    const full = await payments.listOwnPayments(f.alice)
    assert.deepEqual(collected, full.events.map(event => event.id))
    const first = await payments.listOwnPayments(f.alice, {limit: 1})
    assert.ok(first.nextCursor)
    await assert.rejects(payments.listOwnPayments(f.bob, {cursor: first.nextCursor}), status(400))
    await assert.rejects(payments.listOrganizationUserPayments(f.outsider, f.outsider.userId, {cursor: first.nextCursor}), status(400))
    for (const cursor of ['invalid!', 'AA', first.nextCursor + '=', Buffer.from(JSON.stringify({version: 1})).toString('base64url')])
        await assert.rejects(payments.listOwnPayments(f.alice, {cursor}), status(400))
    await payments.recordOrganizationUserPayment(f.owner, f.alice.userId, payment('1'))
    const continued = await payments.listOwnPayments(f.alice, {cursor: first.nextCursor})
    assert.deepEqual(continued.events.map(event => event.id), full.events.slice(1).map(event => event.id), 'new entries do not shift a historical keyset page')
}))

test('reciprocal owner payments and concurrent exact charge settlement preserve ledger totals without FK deadlocks', integration, async () => fixture(async f => {
    const payments = createAccountPayments(f.db), billing = createAccountBilling(f.db)
    const rows = await Promise.all(Array.from({length: 6}, (_, i) => generation(f.db, i % 2 ? f.owner : f.secondOwner,
        {billingState: 'awaiting', priceSource: 'estimate', priceUsd: '0.10'})))
    await Promise.all([
        ...rows.map(row => f.db.transaction(tx => recordGenerationCharge(tx, {...row, billingState: 'confirmed', priceSource: 'gateway', priceUsd: '0.10'}))),
        ...Array.from({length: 6}, (_, i) => payments.recordOrganizationUserPayment(i % 2 ? f.owner : f.secondOwner, i % 2 ? f.secondOwner.userId : f.owner.userId, payment('0.01'))),
    ])
    for (const actor of [f.owner, f.secondOwner]) {
        const balance = await billing.balanceFor(actor)
        assert.equal(balance.confirmedSpendUsd, '0.300000000000')
        assert.equal(balance.totalPaidUsd, '0.030000000000')
        assert.equal(balance.unpaidUsd, '0.270000000000')
        assert.equal(balance.actualBalanceUsd, null)
    }
}))

test('independent charge postings retain compatible FK locks before serializing the same account', integration, async () => fixture(async f => {
    const rows = await Promise.all(Array.from({length: 2}, () => generation(f.db, f.alice, {billingState: 'confirmed', priceSource: 'gateway', priceUsd: '0.10'})))
    let arrivals = 0, release!: () => void
    const insertedBoth = new Promise<void>(resolve => {release = resolve})
    await Promise.all(rows.map(row => f.db.transaction(async tx => {
        await tx.insert(accountGenerationCharges).values({generationId: row.id, organizationId: f.alice.organizationId, userId: f.alice.userId})
        if (++arrivals === 2) release()
        await insertedBoth
        await recordGenerationCharge(tx, row)
    })))
    assert.equal((await createAccountBilling(f.db).balanceFor(f.alice)).confirmedSpendUsd, '0.200000000000')
}))

test('payment creation and finite-credit changes serialize, and reads use a consistent confirmed/paid SQL snapshot', integration, async () => fixture(async f => {
    const payments = createAccountPayments(f.db), billing = createAccountBilling(f.db)
    const outcomes = await Promise.allSettled([payments.recordOrganizationUserPayment(f.owner, f.alice.userId, payment('1')), billing.setOrganizationUserBalance(f.owner, f.alice.userId, '4')])
    assert.equal(outcomes[1]!.status, 'fulfilled')
    assert.ok(outcomes[0]!.status === 'fulfilled' || (outcomes[0]!.status === 'rejected' && status(409)(outcomes[0]!.reason)))
    const stored = await payments.listOwnPayments(f.alice)
    assert.equal(stored.balance.actualBalanceUsd, '4.000000000000')
    assert.equal(stored.balance.totalPaidUsd, stored.events.length ? '1.000000000000' : '0.000000000000')
    await billing.setOrganizationUserBalance(f.owner, f.alice.userId, null)
    await Promise.all([
        ...Array.from({length: 8}, () => payments.recordOrganizationUserPayment(f.owner, f.alice.userId, payment('0.01'))),
        (async () => {for (let i = 0; i < 16; i++) {
            const balance = await billing.balanceFor(f.alice)
            const confirmed = parseUsdUnits(balance.confirmedSpendUsd)!, paid = parseUsdUnits(balance.totalPaidUsd)!
            assert.equal(parseUsdUnits(balance.unpaidUsd), confirmed > paid ? confirmed - paid : 0n)
            assert.equal(parseUsdUnits(balance.overpaidUsd), paid > confirmed ? paid - confirmed : 0n)
        }})(),
    ])
}))

test('database checks protect positive whole-cent bounded immutable event amounts and bounded notes', integration, async () => fixture(async f => {
    const base = {organizationId: f.alice.organizationId, userId: f.alice.userId, recordedByUserId: f.owner.userId,
        recordedByDisplayName: f.owner.displayName, recordedByUsername: f.owner.username, idempotencyKey: randomUUID()}
    for (const amountUnits of ['0', '-1', '1', '1000000000000000001'])
        await assert.rejects(f.db.insert(accountPayments).values({...base, id: randomUUID(), amountUnits}), error => (error as {cause?: {code?: string}}).cause?.code === '23514')
    await assert.rejects(f.db.insert(accountPayments).values({...base, id: randomUUID(), amountUnits: '10000000000', note: 'x'.repeat(501)}), error => (error as {cause?: {code?: string}}).cause?.code === '23514')
    assert.equal((await f.db.execute(sql`SELECT count(*)::int AS count FROM ${accountPayments}`)).rows[0]!.count, 0)
}))
