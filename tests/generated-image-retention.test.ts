import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import {fileURLToPath} from "node:url"
import test from "node:test"
import {Pool} from "pg"
import {drizzle} from "drizzle-orm/node-postgres"
import {migrate} from "drizzle-orm/node-postgres/migrator"
import {eq} from "drizzle-orm"
import {systemPrompt, organizations, users, assets, assetShares, type NewSystemPrompt} from "../server/db/schema.ts"
import {getDatabasePoolConfig} from "../server/utils/lib/db.ts"
import {useDB} from "../server/utils/useDB.ts"
import {
    isRetentionManagedImageUrl,
    parseRetentionDays,
    runGeneratedImageRetention,
} from "../server/utils/generatedImageRetention.ts"
import {createAssetRepository, type AssetActor} from '../server/utils/assetAccess.ts'

const NOW = new Date("2026-10-12T12:00:00.000Z")
const DAY_MS = 86_400_000
const age = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString()
const output = () => `/images/output/img-1780000000000-${randomUUID()}.png`
const migrationsFolder = fileURLToPath(new URL("../drizzle/postgres", import.meta.url))

test("retention defaults to 180 days and rejects malformed destructive configuration", () => {
    assert.equal(parseRetentionDays(undefined), 180)
    assert.equal(parseRetentionDays("0"), 0)
    assert.equal(parseRetentionDays("7"), 7)
    assert.equal(parseRetentionDays("36500"), 36500)
    for (const value of ["", " ", " 30", "30 ", "01", "-1", "+1", "0.5", "180.0", "1e2", "Infinity", "NaN", "36501", "999999999999999999999"]) {
        assert.throws(() => parseRetentionDays(value), /GENERATED_IMAGE_RETENTION_DAYS/)
    }
})

test("retention only recognizes canonical immutable generated output URLs", () => {
    const valid = output()
    assert.equal(isRetentionManagedImageUrl(valid), true)
    for (const path of [valid.replace("/output/", "/uploads/"), valid.replace("/images/", "https://example.test/images/"),
        valid.replace("/images/", ""), valid + "?download=1", valid + "/", valid.replace("img-", "%69mg-"),
        "/images/output/../product.png", "/images/output/product.png", "/images/output/"]) {
        assert.equal(isRetentionManagedImageUrl(path), false, path)
    }
})

test('retention recognizes canonical organization/user output namespaces and rejects ambiguous or uploaded object paths', () => {
    const org = randomUUID(), user = randomUUID()
    const scoped = output().replace('/images/output/', `/images/organizations/${org}/users/${user}/output/`)
    assert.equal(isRetentionManagedImageUrl(scoped), true)
    for (const value of [scoped.replace('/organizations/', '/teams/'), scoped.replace(org, 'wrong-org'), scoped.replace(user, '../other'),
        scoped.replace('/output/', '/objects/'), scoped + '?download=1', scoped.replace('organizations', '%6frganizations')]) {
        assert.equal(isRetentionManagedImageUrl(value), false)
    }
})

test("disabled retention neither connects to PostgreSQL nor touches S3", async () => {
    const result = await runGeneratedImageRetention({
        pool: {connect: async () => { throw new Error("Must not connect") }},
        storage: {removeGeneratedImage: async () => { throw new Error("Must not delete") }},
        retentionDays: 0,
    })
    assert.equal(result.status, "disabled")
    assert.equal(result.cutoff, null)
    assert.equal(result.deleted, 0)
})

async function isolatedDatabase(work: (pool: Pool, db: ReturnType<typeof drizzle>) => Promise<void>) {
    const connectionString = process.env.TEST_DATABASE_URL!
    const schema = `imagery_retention_${randomUUID().replaceAll("-", "")}`
    const administrator = new Pool({connectionString, max: 1, connectionTimeoutMillis: 5_000})
    const pool = new Pool({...getDatabasePoolConfig({DATABASE_URL: connectionString}), max: 3, options: `-c search_path=${schema} -c timezone=UTC`})
    try {
        await administrator.query(`CREATE SCHEMA "${schema}"`)
        const db = drizzle({client: pool})
        await migrate(db, {migrationsFolder, migrationsSchema: schema})
        await work(pool, db)
    } finally {
        await pool.end()
        await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await administrator.end()
    }
}

const integration = {skip: !process.env.TEST_DATABASE_URL, timeout: 60_000}

test("cleanup uses creation age, preserves history and billing, and only removes completed generated images", integration, async () => {
    await isolatedDatabase(async (pool, db) => {
        const oldImage = output()
        const legacyImage = output()
        const newerSharedImage = output()
        const alreadyDeleted = output()
        const entries: NewSystemPrompt[] = [
            {TextPrompt: "Old completed", outputImage: oldImage, createdAt: age(181), updatedAt: NOW.toISOString(), status: "succeeded", serverImages: ["/images/input/product.png"], modelImages: ["/images/reference/style.png"], priceUsd: "0.42", usageJson: {retained: true}, outputMetadata: {mimeType: "image/png", bytes: 10, width: 1, height: 1, warnings: []}},
            {TextPrompt: "Legacy completed", outputImage: legacyImage, createdAt: age(200), status: null},
            {TextPrompt: "Exact boundary", outputImage: output(), createdAt: age(180), status: "succeeded"},
            {TextPrompt: "Recent", outputImage: output(), createdAt: age(179), status: "succeeded"},
            {TextPrompt: "Pending", outputImage: output(), createdAt: age(200), status: "pending"},
            {TextPrompt: "Failed", outputImage: output(), createdAt: age(200), status: "failed"},
            {TextPrompt: "Empty", outputImage: "", createdAt: age(200), status: "succeeded"},
            {TextPrompt: "Uploaded", outputImage: "/images/input/upload.png", createdAt: age(200), status: "succeeded"},
            {TextPrompt: "Unrecognized legacy path", outputImage: "/images/output/old-image.png", createdAt: age(200), status: "succeeded"},
            {TextPrompt: "Already removed", outputImage: alreadyDeleted, createdAt: age(200), status: "succeeded", outputImageDeletedAt: age(1)},
            {TextPrompt: "Old shared", outputImage: newerSharedImage, createdAt: age(200), status: "succeeded"},
            {TextPrompt: "New shared", outputImage: newerSharedImage, createdAt: age(1), status: "succeeded"},
            {TextPrompt: "Old duplicated legacy", outputImage: legacyImage, createdAt: age(201), status: "succeeded"},
        ]
        const rows = await db.insert(systemPrompt).values(entries).returning()
        const removed: string[] = []
        const storage = {removeGeneratedImage: async (url: string) => { removed.push(url) }}
        const dryRun = await runGeneratedImageRetention({pool, storage, retentionDays: 180, now: NOW, dryRun: true})
        assert.equal(dryRun.wouldDelete, 3)
        assert.equal(dryRun.deleted, 0)
        assert.equal(dryRun.skippedInvalid, 0)
        assert.equal(dryRun.skippedShared, 0)
        assert.deepEqual(removed, [])
        const result = await runGeneratedImageRetention({pool, storage, retentionDays: 180, now: NOW})
        assert.equal(result.status, "completed")
        assert.equal(result.deleted, 3)
        assert.equal(result.failed, 0)
        assert.deepEqual(new Set(removed), new Set([oldImage, legacyImage]))
        const database = await useDB(db)
        const expired = (await database.getSystemPrompt(rows[0]!.id))!
        const persisted = (await db.select().from(systemPrompt).where(eq(systemPrompt.id, rows[0]!.id)))[0]!
        assert.deepEqual({...persisted, outputImageDeletedAt: null}, rows[0])
        assert.equal(expired.createdAt, age(181))
        assert.equal(expired.updatedAt, NOW.toISOString())
        assert.equal(expired.outputImageDeletedAt, NOW.toISOString())
        const history = await database.getSystemPrompts(200)
        assert.equal(history.find(row => row.id === expired.id)?.outputImageDeletedAt, NOW.toISOString())
        assert.deepEqual(new Set(await database.getExpiredGeneratedImagePaths([oldImage, oldImage, alreadyDeleted, newerSharedImage])), new Set([oldImage, alreadyDeleted]))
        await assert.rejects(database.getExpiredGeneratedImagePaths(Array(201).fill(oldImage)), /Too many/)
        assert.equal((await runGeneratedImageRetention({pool, storage, retentionDays: 180, now: NOW})).deleted, 0)
    })
})

test("S3 failures and a crash after object deletion stay retryable; missing objects are marked without erasing metadata", integration, async () => {
    await isolatedDatabase(async (pool, db) => {
        const missing = output()
        const deleteFails = output()
        const markerFails = output()
        const rows = await db.insert(systemPrompt).values([
            {TextPrompt: "Missing object", outputImage: missing, status: "succeeded" as const, createdAt: age(200)},
            {TextPrompt: "Delete failure", outputImage: deleteFails, status: "succeeded" as const, createdAt: age(200)},
            {TextPrompt: "Reject marker", outputImage: markerFails, status: "succeeded" as const, createdAt: age(200)},
        ]).returning()
        await pool.query(`CREATE FUNCTION reject_retention_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."TextPrompt" = 'Reject marker' AND NEW."outputImageDeletedAt" IS NOT NULL THEN RAISE EXCEPTION 'synthetic confidential driver detail'; END IF; RETURN NEW; END $$`)
        await pool.query(`CREATE TRIGGER reject_retention_marker BEFORE UPDATE ON "systemPrompt" FOR EACH ROW EXECUTE FUNCTION reject_retention_marker()`)
        const objects = new Set([deleteFails, markerFails])
        const attempts: string[] = []
        let rejectDeletion = true
        const storage = {removeGeneratedImage: async (url: string) => {
            attempts.push(url)
            if (url === deleteFails && rejectDeletion) throw new Error("secret access key must not be logged")
            objects.delete(url)
        }}
        const first = await runGeneratedImageRetention({pool, storage, retentionDays: 180, now: NOW})
        assert.equal(first.deleted, 1)
        assert.equal(first.failed, 2)
        assert.equal(objects.has(markerFails), false)
        assert.equal((await db.select().from(systemPrompt).where(eq(systemPrompt.id, rows[1]!.id)))[0]!.outputImageDeletedAt, null)
        assert.equal((await db.select().from(systemPrompt).where(eq(systemPrompt.id, rows[2]!.id)))[0]!.outputImageDeletedAt, null)
        await pool.query(`DROP TRIGGER reject_retention_marker ON "systemPrompt"`)
        rejectDeletion = false
        const retry = await runGeneratedImageRetention({pool, storage, retentionDays: 180, now: NOW})
        assert.equal(retry.deleted, 2)
        assert.equal(retry.failed, 0)
        assert.equal(attempts.filter(url => url === markerFails).length, 2)
        assert.equal(objects.size, 0)
        const stored = await db.select().from(systemPrompt)
        for (const row of stored) {
            assert.equal(new Date(row.outputImageDeletedAt!).toISOString(), NOW.toISOString())
            assert.equal(row.status, "succeeded")
            assert.ok([missing, deleteFails, markerFails].includes(row.outputImage))
        }
    })
})

test("session advisory locking prevents overlapping cleanup and releases without holding a transaction during S3", integration, async () => {
    await isolatedDatabase(async (pool, db) => {
        await db.insert(systemPrompt).values({TextPrompt: "Lock test", outputImage: output(), createdAt: age(200), status: "succeeded"})
        let release!: () => void
        let started!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const entered = new Promise<void>(resolve => { started = resolve })
        const first = runGeneratedImageRetention({pool, retentionDays: 180, now: NOW, storage: {removeGeneratedImage: async () => { started(); await gate }}})
        await entered
        try {
            const concurrent = await runGeneratedImageRetention({pool, retentionDays: 180, now: NOW, storage: {removeGeneratedImage: async () => { throw new Error("Must not delete while locked") }}})
            assert.equal(concurrent.status, "already_running")
            const states = await pool.query<{state: string}>(`SELECT state FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'SELECT pg_try_advisory_lock%'`)
            assert.equal(states.rows.some(row => row.state === "idle in transaction"), false)
        } finally { release() }
        assert.equal((await first).deleted, 1)
        assert.equal((await runGeneratedImageRetention({pool, retentionDays: 180, now: NOW, storage: {removeGeneratedImage: async () => undefined}})).status, "completed")
    })
})

test("keyset pages filter unsafe and shared paths before the row budget, preserve timestamp precision, and make progress on later runs", integration, async () => {
    await isolatedDatabase(async (pool, db) => {
        const entries = Array.from({length: 101}, (_, index) => ({TextPrompt: `Invalid ${index}`, outputImage: `/images/input/${index}.png`, status: "succeeded" as const, createdAt: "2026-01-01T00:00:00.000123Z"}))
        await db.insert(systemPrompt).values(entries)
        const valid = Array.from({length: 102}, (_, index) => ({TextPrompt: `Valid ${index}`, outputImage: output(), status: "succeeded" as const, createdAt: `2026-01-01T00:00:00.000${index < 101 ? '123' : '124'}Z`}))
        await db.insert(systemPrompt).values(valid)
        const shared = output()
        await db.insert(systemPrompt).values([
            {TextPrompt: "Old shared", outputImage: shared, status: "succeeded", createdAt: age(300)},
            {TextPrompt: "Pending shared", outputImage: shared, status: "pending", createdAt: age(200)},
        ])
        const deleted: string[] = []
        const storage = {removeGeneratedImage: async (url: string) => { deleted.push(url) }}
        const bounded = await runGeneratedImageRetention({pool, storage, retentionDays: 180, now: NOW, maxRows: 1})
        assert.equal(bounded.status, "bounded")
        assert.equal(bounded.scanned, 1)
        assert.equal(bounded.skippedInvalid, 0)
        assert.equal(bounded.deleted, 1)
        assert.deepEqual(deleted, [valid[0]!.outputImage])
        const complete = await runGeneratedImageRetention({pool, storage, retentionDays: 180, now: NOW})
        assert.equal(complete.status, "completed")
        assert.equal(complete.scanned, 101)
        assert.equal(complete.skippedInvalid, 0)
        assert.equal(complete.deleted, 101)
        assert.deepEqual(deleted, valid.map(row => row.outputImage))
        const remaining = await db.select().from(systemPrompt)
        assert.equal(remaining.filter(row => row.outputImageDeletedAt === null).length, 103)
    })
})

test('organization retention requires matching generated registry ownership, preserves uploads and mismatches, and expires shared asset access', integration, async () => {
    await isolatedDatabase(async (pool, db) => {
        const org = randomUUID(), otherOrg = randomUUID(), aliceId = randomUUID(), bobId = randomUUID(), outsiderId = randomUUID()
        await db.insert(organizations).values([{id: org, name: 'Studio'}, {id: otherOrg, name: 'Other studio'}])
        await db.insert(users).values([
            {id: aliceId, organizationId: org, username: 'alice', normalizedUsername: 'alice', displayName: 'Alice', role: 'owner', passwordHash: 'unused-test-hash'},
            {id: bobId, organizationId: org, username: 'bob', normalizedUsername: 'bob', displayName: 'Bob', role: 'user', passwordHash: 'unused-test-hash'},
            {id: outsiderId, organizationId: otherOrg, username: 'outsider', normalizedUsername: 'outsider', displayName: 'Outsider', role: 'owner', passwordHash: 'unused-test-hash'},
        ])
        const scoped = () => output().replace('/images/output/', `/images/organizations/${org}/users/${aliceId}/output/`)
        const entries = [
            {name: 'Shared generated', url: scoped(), category: 'generated' as const, owner: aliceId, organization: org, historyOwner: aliceId},
            {name: 'Upload resembling output', url: scoped(), category: 'uploaded' as const, owner: aliceId, organization: org, historyOwner: aliceId},
            {name: 'Registry owner mismatch', url: scoped(), category: 'generated' as const, owner: bobId, organization: org, historyOwner: aliceId},
            {name: 'History owner mismatch', url: scoped(), category: 'generated' as const, owner: aliceId, organization: org, historyOwner: bobId},
            {name: 'Organization mismatch', url: scoped(), category: 'generated' as const, owner: outsiderId, organization: otherOrg, historyOwner: aliceId},
            {name: 'Scoped but unregistered', url: scoped(), category: 'generated' as const, owner: aliceId, organization: org, historyOwner: aliceId, unregistered: true},
            {name: 'Legacy generated owner mismatch', url: output(), category: 'generated' as const, owner: bobId, organization: org, historyOwner: aliceId},
            {name: 'Legacy registered upload', url: output(), category: 'uploaded' as const, owner: aliceId, organization: org, historyOwner: aliceId},
            {name: 'Legacy registered generation', url: output(), category: 'generated' as const, owner: aliceId, organization: org, historyOwner: aliceId},
            {name: 'Legacy unregistered generation', url: output(), category: 'generated' as const, owner: aliceId, organization: org, historyOwner: aliceId, unregistered: true},
        ]
        const registered = await db.insert(assets).values(entries.filter(entry => !entry.unregistered).map(entry => ({id: randomUUID(),
            organizationId: entry.organization, ownerUserId: entry.owner, createdByUserId: entry.owner, name: entry.name,
            url: entry.url, kind: 'file' as const, category: entry.category, mimeType: 'image/png', byteSize: 42, width: 4, height: 3}))).returning()
        const sharedAsset = registered.find(row => row.url === entries[0]!.url)!
        await db.insert(assetShares).values({id: randomUUID(), assetId: sharedAsset.id, organizationId: org, sharedByUserId: aliceId, recipientUserId: bobId, permission: 'view'})
        const bob: AssetActor = {organizationId: org, userId: bobId, username: 'bob', displayName: 'Bob', role: 'user'}
        const repository = createAssetRepository(bob, db)
        assert.equal((await repository.requireAsset(sharedAsset.url)).permissions.view, true)
        const history = await db.insert(systemPrompt).values(entries.map(entry => ({TextPrompt: entry.name, outputImage: entry.url,
            organizationId: org, userId: entry.historyOwner, createdAt: age(200), status: 'succeeded' as const, priceUsd: '0.02'}))).returning()
        const deleted: string[] = []
        const result = await runGeneratedImageRetention({pool, storage: {removeGeneratedImage: async url => {deleted.push(url)}}, retentionDays: 180, now: NOW})
        assert.equal(result.failed, 0)
        assert.deepEqual(new Set(deleted), new Set([entries[0]!.url, entries[8]!.url, entries[9]!.url]))
        assert.equal(result.deleted, 3)
        const stored = await db.select().from(assets)
        const expired = stored.find(row => row.id === sharedAsset.id)!
        assert.equal(new Date(expired.deletedAt!).toISOString(), NOW.toISOString())
        await assert.rejects(repository.requireAsset(sharedAsset.url), error => Boolean(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404))
        for (const entry of entries.slice(1, 8)) {
            const row = stored.find(row => row.url === entry.url)
            if (row) assert.equal(row.deletedAt, null, entry.name)
            const generation = await db.select().from(systemPrompt).where(eq(systemPrompt.id, history.find(item => item.outputImage === entry.url)!.id))
            assert.equal(generation[0]!.outputImageDeletedAt, null, entry.name)
        }
        const keptHistory = await db.select().from(systemPrompt).where(eq(systemPrompt.id, history[0]!.id))
        assert.equal(keptHistory[0]!.priceUsd, '0.02')
        assert.equal(keptHistory[0]!.outputImage, sharedAsset.url)
    })
})
