import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {Pool} from 'pg'
import {drizzle} from 'drizzle-orm/node-postgres'
import {migrate} from 'drizzle-orm/node-postgres/migrator'
import {eq} from 'drizzle-orm'
import {organizations, users, systemPrompt, aiGatewayLog, runtimeLease} from '../server/db/schema.ts'
import {useDB, type GenerationOwner} from '../server/utils/useDB.ts'
import {getDatabasePoolConfig} from '../server/utils/lib/db.ts'
import {createDefaultSettings, type StoredGenerationConfig} from '../schemas/image-generation.ts'

const integration = {skip: !process.env.TEST_DATABASE_URL, timeout: 60_000}
const config: StoredGenerationConfig = {schemaVersion: 1, profileVersion: 1, requestedModel: 'google/gemini-3-pro-image',
    effectiveModel: 'google/gemini-3-pro-image', settings: createDefaultSettings('google/gemini-3-pro-image'), storeInputImages: true}
const pending = (prompt: string, parentSystemPromptId?: number) => ({prompt, inputImages: ['/images/input.png'], modelImages: [],
    requestedModel: config.requestedModel, effectiveModel: config.effectiveModel, batchId: randomUUID(), generationConfig: config, parentSystemPromptId})
const log = (prompt = 'Generation') => ({status: 'success', model: config.effectiveModel, prompt, attemptNumber: 1})
const completion = (url: string) => ({outputImage: url, outputMetadata: {mimeType: 'image/png', bytes: 42, width: 4, height: 3, warnings: []},
    billing: {priceUsd: '0.02'}, log: log()})
const failure = () => ({error: {name: 'Error', message: 'Synthetic failure', code: 'LOCAL_FAILURE', retryable: true}, log: {...log(), status: 'error'}})
async function fixture(work: (f: {db: ReturnType<typeof drizzle>; alice: GenerationOwner; bob: GenerationOwner; owner: GenerationOwner; outsider: GenerationOwner}) => Promise<void>) {
    const connectionString = process.env.TEST_DATABASE_URL!
    const schema = `imagery_generation_acl_${randomUUID().replaceAll('-', '')}`
    const administrator = new Pool({connectionString, max: 1})
    const pool = new Pool({...getDatabasePoolConfig({DATABASE_URL: connectionString}), options: `-c search_path=${schema} -c timezone=UTC`})
    try {
        await administrator.query(`CREATE SCHEMA "${schema}"`)
        const db = drizzle({client: pool})
        await migrate(db, {migrationsFolder: fileURLToPath(new URL('../drizzle/postgres', import.meta.url)), migrationsSchema: schema})
        const orgId = randomUUID(), otherOrgId = randomUUID()
        await db.insert(organizations).values([{id: orgId, name: 'Studio'}, {id: otherOrgId, name: 'Other studio'}])
        const alice = {organizationId: orgId, userId: randomUUID()}, bob = {organizationId: orgId, userId: randomUUID()},
            owner = {organizationId: orgId, userId: randomUUID()}, outsider = {organizationId: otherOrgId, userId: randomUUID()}
        await db.insert(users).values([alice, bob, owner, outsider].map((actor, index) => ({id: actor.userId, organizationId: actor.organizationId,
            username: `local-user-${index}`, normalizedUsername: `local-user-${index}`, displayName: `Local user ${index}`,
            passwordHash: 'unused-local-test-hash', role: index >= 2 ? 'owner' as const : 'user' as const})))
        await work({db, alice, bob, owner, outsider})
    } finally {
        await pool.end()
        await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await administrator.end()
    }
}

test('generation history, count, details, billing and Gateway logs are private to the requesting account, including organization owners', integration, async () => fixture(async f => {
    const aliceDB = await useDB(f.db, f.alice), bobDB = await useDB(f.db, f.bob), ownerDB = await useDB(f.db, f.owner), outsiderDB = await useDB(f.db, f.outsider)
    const aliceRow = await aliceDB.createPendingGeneration(pending('Alice private'))
    const bobRow = await bobDB.createPendingGeneration(pending('Bob private'))
    const outsideRow = await outsiderDB.createPendingGeneration(pending('Other org'))
    await f.db.insert(systemPrompt).values({TextPrompt: 'Unclaimed legacy', outputImage: '', status: 'failed'})
    await aliceDB.completeGeneration(aliceRow.id, completion('/images/alice-output.png'))
    await bobDB.completeGeneration(bobRow.id, completion('/images/bob-output.png'))
    for (const viewer of [bobDB, ownerDB, outsiderDB]) {
        assert.equal(await viewer.getSystemPrompt(aliceRow.id), undefined)
        assert.equal(await viewer.updateSystemPromptBilling(aliceRow.id, {priceUsd: '99'}), undefined)
    }
    assert.equal((await aliceDB.getSystemPrompt(aliceRow.id))?.priceUsd, '0.02')
    assert.deepEqual((await aliceDB.getSystemPrompts()).map(row => row.id), [aliceRow.id])
    assert.equal(await aliceDB.countSystemPrompts(), 1)
    assert.equal(await ownerDB.countSystemPrompts(), 0)
    assert.equal(await outsiderDB.countSystemPrompts(), 1)
    assert.deepEqual((await bobDB.getAiGatewayLogs()).map(row => row.systemPromptId), [bobRow.id])
    assert.deepEqual(await ownerDB.getAiGatewayLogs(), [])
    assert.equal(await aliceDB.getSystemPrompt(outsideRow.id), undefined)
    const forced = await aliceDB.createAiGatewayLog({...log('Actor-owned diagnostic'), organizationId: f.outsider.organizationId, userId: f.outsider.userId})
    assert.equal(forced.organizationId, f.alice.organizationId)
    assert.equal(forced.userId, f.alice.userId)
    assert.equal((await outsiderDB.getAiGatewayLogs()).length, 0)
    const history = await aliceDB.getSystemPrompts(1, 0)
    assert.equal('usageJson' in history[0]!, false)
    assert.equal('outputMetadata' in history[0]!, false)
    assert.equal((await aliceDB.getSystemPrompts(1, 1)).length, 0)
}))

test('tenant-scoped terminal updates, heartbeats and generation parents cannot target another account', integration, async () => fixture(async f => {
    const aliceDB = await useDB(f.db, f.alice), bobDB = await useDB(f.db, f.bob)
    const aliceRow = await aliceDB.createPendingGeneration(pending('Alice pending'))
    const bobRow = await bobDB.createPendingGeneration(pending('Bob pending'))
    const before = (await bobDB.getSystemPrompt(bobRow.id))!
    await assert.rejects(aliceDB.completeGeneration(bobRow.id, completion('/images/forged.png')), /not found/)
    await assert.rejects(aliceDB.failGeneration(bobRow.id, failure()), /not found/)
    assert.deepEqual(await bobDB.getSystemPrompt(bobRow.id), before)
    assert.equal((await f.db.select().from(aiGatewayLog)).length, 0)
    assert.equal(await aliceDB.touchPendingGenerations([aliceRow.id, bobRow.id]), 1)
    assert.equal((await bobDB.getSystemPrompt(bobRow.id))?.updatedAt, before.updatedAt)
    await assert.rejects(aliceDB.createPendingGenerations([pending('Would otherwise insert'), pending('Foreign parent', bobRow.id)]), /parent is unavailable/)
    assert.equal(await aliceDB.countSystemPrompts(), 1, 'foreign parent rejects the entire pending batch')
    const child = await aliceDB.createPendingGeneration(pending('Own replay', aliceRow.id))
    assert.equal(child.parentSystemPromptId, aliceRow.id)
    const succeeded = await aliceDB.completeGeneration(aliceRow.id, completion('/images/original.png'))
    assert.equal(succeeded.transitioned, true)
    const lateFailure = await aliceDB.failGeneration(aliceRow.id, failure())
    assert.equal(lateFailure.transitioned, false)
    assert.equal(lateFailure.row.outputImage, '/images/original.png')
    assert.equal((await aliceDB.getAiGatewayLogs()).length, 1)
}))

test('stale recovery and expired image checks remain scoped, while active distributed leases protect live work', integration, async () => fixture(async f => {
    const aliceDB = await useDB(f.db, f.alice), bobDB = await useDB(f.db, f.bob), ownerDB = await useDB(f.db, f.owner)
    const stale = await aliceDB.createPendingGeneration(pending('Alice abandoned'))
    const live = await aliceDB.createPendingGeneration(pending('Alice live lease'))
    const bob = await bobDB.createPendingGeneration(pending('Bob abandoned'))
    const old = new Date(Date.now() - 600_000).toISOString()
    for (const row of [stale, live, bob]) await f.db.update(systemPrompt).set({updatedAt: old}).where(eq(systemPrompt.id, row.id))
    const leaseId = randomUUID()
    await f.db.insert(runtimeLease).values({id: leaseId, owner: live.batchId!, scope: 'image-generation', state: 'running', expiresAt: new Date(Date.now() + 60_000).toISOString()})
    assert.equal(await ownerDB.reconcileStalePendingGenerations(60_000), 0)
    assert.equal(await aliceDB.reconcileStalePendingGenerations(60_000), 1)
    assert.equal((await aliceDB.getSystemPrompt(stale.id))?.status, 'failed')
    assert.equal((await aliceDB.getSystemPrompt(live.id))?.status, 'pending')
    assert.equal((await bobDB.getSystemPrompt(bob.id))?.status, 'pending')
    assert.deepEqual((await aliceDB.getAiGatewayLogs()).map(row => row.systemPromptId), [stale.id])
    assert.deepEqual(await bobDB.getAiGatewayLogs(), [])
    await f.db.delete(runtimeLease).where(eq(runtimeLease.id, leaseId))
    assert.equal(await aliceDB.reconcileStalePendingGenerations(60_000), 1)
    assert.equal(await bobDB.reconcileStalePendingGenerations(60_000), 1)
    await f.db.update(systemPrompt).set({outputImage: '/images/alice-expired.png', outputImageDeletedAt: new Date().toISOString()}).where(eq(systemPrompt.id, stale.id))
    await f.db.update(systemPrompt).set({outputImage: '/images/bob-expired.png', outputImageDeletedAt: new Date().toISOString()}).where(eq(systemPrompt.id, bob.id))
    const candidates = ['/images/alice-expired.png', '/images/bob-expired.png']
    assert.deepEqual(await aliceDB.getExpiredGeneratedImagePaths(candidates), [candidates[0]])
    assert.deepEqual(await bobDB.getExpiredGeneratedImagePaths(candidates), [candidates[1]])
    assert.deepEqual(await ownerDB.getExpiredGeneratedImagePaths(candidates), [])
}))
