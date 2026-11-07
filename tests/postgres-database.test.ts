import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import { aiGatewayLog, runtimeLease, systemPrompt } from '../server/db/schema.ts'
import { getDatabasePoolConfig } from '../server/utils/lib/db.ts'
import { useDB } from '../server/utils/useDB.ts'
import type { StoredGenerationConfig } from '../schemas/image-generation.ts'
import { createDefaultSettings } from '../schemas/image-generation.ts'
import { inspectLegacySqlite, importLegacySqlite } from '../scripts/lib/sqliteImport.ts'

const migrationsFolder = fileURLToPath(new URL('../drizzle/postgres', import.meta.url))

test('PostgreSQL pools initialize lazily, require PostgreSQL, bound warm-instance capacity and preserve TLS verification', () => {
  assert.throws(() => getDatabasePoolConfig({}), /DATABASE_URL must be configured/)
  assert.throws(() => getDatabasePoolConfig({DATABASE_URL: 'file:./prisma.db'}), /PostgreSQL/)
  assert.throws(() => getDatabasePoolConfig({DATABASE_URL: 'postgres://example.invalid/db?sslmode=no-verify'}), /verification/)
  const defaults = getDatabasePoolConfig({DATABASE_URL: 'postgres://localhost/imagery'})
  assert.equal(defaults.max, 3)
  assert.equal(defaults.min, 0)
  assert.equal(defaults.connectionTimeoutMillis, 10_000)
  assert.equal(defaults.idleTimeoutMillis, 5_000)
  assert.equal(defaults.statement_timeout, 30_000)
  assert.equal(defaults.allowExitOnIdle, true)
  assert.equal(getDatabasePoolConfig({DATABASE_URL: 'postgres://localhost/imagery', DATABASE_POOL_MAX: '1000'}).max, 10)
  assert.equal(getDatabasePoolConfig({DATABASE_URL: 'postgres://localhost/imagery', DATABASE_POOL_MAX: '-1'}).max, 1)
  const secure = getDatabasePoolConfig({DATABASE_URL: 'postgres://example.invalid/db?sslmode=disable', DATABASE_SSL: 'true', DATABASE_CA_CERT: 'line1\\nline2'})
  assert.deepEqual(secure.ssl, {rejectUnauthorized: true, ca: 'line1\nline2'})
  assert.equal(new URL(secure.connectionString!).searchParams.has('sslmode'), false)
  const compatible = getDatabasePoolConfig({DATABASE_URL: 'postgres://example.invalid/db?sslmode=require&uselibpqcompat=true'})
  assert.equal(new URL(compatible.connectionString!).searchParams.get('sslmode'), 'verify-full')
  assert.equal(new URL(compatible.connectionString!).searchParams.has('uselibpqcompat'), false)
})

test('explicit legacy import preserves SQLite ids, UTC timestamps, JSON replay/billing/logs and resets PostgreSQL sequences transactionally', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async () => {
  const connectionString = process.env.TEST_DATABASE_URL!
  const schema = `imagery_import_${randomUUID().replaceAll('-', '')}`
  const directory = await mkdtemp(join(tmpdir(), 'imagery-sqlite-import-'))
  const sqlitePath = join(directory, 'legacy.db')
  const administrator = new Pool({connectionString, max: 1, connectionTimeoutMillis: 5_000})
  const pool = new Pool({...getDatabasePoolConfig({DATABASE_URL: connectionString}), max: 1, options: `-c search_path=${schema} -c timezone=UTC`})
  try {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/drizzle-v0.json', import.meta.url), 'utf8')) as {sql: string}[]
    const sqlite = new DatabaseSync(sqlitePath)
    const replay = {schemaVersion: 1, profileVersion: 1, requestedModel: 'google/gemini-3-pro-image', effectiveModel: 'google/gemini-3-pro-image', settings: createDefaultSettings('google/gemini-3-pro-image'), storeInputImages: true}
    try {
      for (const migration of fixture) sqlite.exec(migration.sql)
      sqlite.prepare(`INSERT INTO systemPrompt (id, TextPrompt, serverImages, modelImages, outputImage, status, createdAt, updatedAt, generationConfig, usageJson, inputTokens, priceUsd, gatewayGenerationId)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(37, 'Preserve this exact product', '["/images/input/product.png"]', '["/images/reference/style.png"]', '/images/output/product.png', 'succeeded', '2026-06-01 10:20:30', '2026-06-01T12:20:30+02:00', JSON.stringify(replay), '{"billable":true}', 7, '0.012345', 'gateway-history-1')
      sqlite.prepare(`INSERT INTO aiGatewayLog (id, systemPromptId, status, model, prompt, requestJson, inputImages, priceUsd, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(81, 37, 'success', 'google/gemini-3-pro-image', 'Preserve this exact product', JSON.stringify(replay), '["/images/input/product.png"]', '0.012345', '2026-06-01 10:20:30')
    } finally { sqlite.close() }
    const original = readFileSync(sqlitePath)
    assert.deepEqual(inspectLegacySqlite(sqlitePath), {generations: 1, gatewayLogs: 1})
    await administrator.query(`CREATE SCHEMA "${schema}"`)
    const db = drizzle({client: pool})
    await migrate(db, {migrationsFolder, migrationsSchema: schema})
    assert.deepEqual(await importLegacySqlite(sqlitePath, db), {generations: 1, gatewayLogs: 1})
    assert.deepEqual(readFileSync(sqlitePath), original)
    const database = await useDB(db)
    const row = (await database.getSystemPrompt(37))!
    assert.equal(row.id, 37)
    assert.equal(row.createdAt, '2026-06-01T10:20:30.000Z')
    assert.equal(row.updatedAt, '2026-06-01T10:20:30.000Z')
    assert.deepEqual(row.serverImages, ['/images/input/product.png'])
    assert.deepEqual(row.modelImages, ['/images/reference/style.png'])
    assert.deepEqual(row.generationConfig, replay)
    assert.deepEqual(row.usageJson, {billable: true})
    assert.equal(row.inputTokens, 7)
    assert.equal(row.priceUsd, '0.012345')
    const [log] = await database.getAiGatewayLogs()
    assert.equal(log!.id, 81)
    assert.equal(log!.systemPromptId, 37)
    assert.deepEqual(log!.requestJson, replay)
    assert.equal((await db.insert(systemPrompt).values({TextPrompt: 'New', outputImage: ''}).returning())[0]!.id, 38)
    assert.equal((await database.createAiGatewayLog({status: 'success', model: 'test', prompt: 'New'})).id, 82)
    await assert.rejects(importLegacySqlite(sqlitePath, db), /empty generation/)
    await db.delete(aiGatewayLog)
    await db.delete(systemPrompt)
    const invalidSource = new DatabaseSync(sqlitePath)
    try { invalidSource.prepare('UPDATE aiGatewayLog SET requestJson = ? WHERE id = ?').run('invalid-json', 81) } finally { invalidSource.close() }
    await assert.rejects(importLegacySqlite(sqlitePath, db), /requestJson JSON is invalid/)
    assert.equal(await database.countSystemPrompts(), 0)
    assert.equal((await database.getAiGatewayLogs()).length, 0)
    // A failed import must not reset the previously advanced sequences.
    assert.equal((await db.insert(systemPrompt).values({TextPrompt: 'After failed import', outputImage: ''}).returning())[0]!.id, 39)
  } finally {
    await pool.end()
    await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await administrator.end()
    await rm(directory, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})
  }
})

test('PostgreSQL history is generated independently and uses native JSONB/timestamptz with distributed coordination tables', () => {
  const folders = readdirSync(migrationsFolder).filter(name => /^\d{14}_/.test(name)).sort()
  assert.ok(folders.length >= 1)
  const sql = folders.map(folder => readFileSync(`${migrationsFolder}/${folder}/migration.sql`, 'utf8')).join('\n')
  assert.match(sql, /CREATE TABLE "systemPrompt"/)
  assert.match(sql, /"generationConfig" jsonb/)
  assert.match(sql, /"updatedAt" timestamp with time zone/)
  assert.match(sql, /CREATE TABLE "runtime_lease"/)
  assert.match(sql, /CREATE TABLE "login_attempt"/)
  assert.doesNotMatch(sql, /AUTOINCREMENT|PRAGMA/)
})

test('PostgreSQL migrations rerun safely, generation state/log transactions remain atomic and live leases block stale recovery', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async () => {
  // TEST_DATABASE_URL must point to an explicitly disposable database. Each
  // test owns a fresh isolated schema and leaves all other schemas untouched.
  const connectionString = process.env.TEST_DATABASE_URL!
  const schema = `imagery_test_${randomUUID().replaceAll('-', '')}`
  const administrator = new Pool({connectionString, max: 1, connectionTimeoutMillis: 5_000})
  const pool = new Pool({...getDatabasePoolConfig({DATABASE_URL: connectionString}), max: 3, options: `-c search_path=${schema} -c timezone=UTC`})
  try {
    await administrator.query(`CREATE SCHEMA "${schema}"`)
    const db = drizzle({client: pool})
    const migrationConfig = {migrationsFolder, migrationsSchema: schema}
    await migrate(db, migrationConfig)
    await migrate(db, migrationConfig)
    const database = await useDB(db)
    const config: StoredGenerationConfig = {
      schemaVersion: 1,
      profileVersion: 1,
      requestedModel: 'google/gemini-3-pro-image',
      effectiveModel: 'google/gemini-3-pro-image',
      settings: createDefaultSettings('google/gemini-3-pro-image'),
      storeInputImages: true,
    }
    const batchId = randomUUID()
    const pending = await database.createPendingGenerations([0, 1, 2].map(index => ({
      prompt: `Product ${index}`, inputImages: [`input/${index}.png`], modelImages: [],
      requestedModel: config.requestedModel, effectiveModel: config.effectiveModel,
      batchId, generationConfig: config,
    })))
    assert.equal(new Set(pending.map(row => row.id)).size, 3)
    assert.match(pending[0]!.createdAt, /Z$/)
    assert.deepEqual(pending[0]!.generationConfig, config)
    const log = {status: 'success', model: config.effectiveModel, prompt: 'Product', attemptNumber: 1}
    const completed = await database.completeGeneration(pending[0]!.id, {
      outputImage: 'output/complete.png', outputMetadata: {mimeType: 'image/png', bytes: 42, width: 2, height: 3, warnings: []}, billing: {}, log,
    })
    assert.equal(completed.transitioned, true)
    const failedSibling = await database.failGeneration(pending[0]!.id, {
      error: {name: 'Error', message: 'Late failure', code: 'TEST_ERROR', retryable: true}, log: {...log, status: 'error'},
    })
    assert.equal(failedSibling.transitioned, false)
    assert.equal(failedSibling.row.outputImage, 'output/complete.png')
    assert.equal((await db.select().from(aiGatewayLog).where(eq(aiGatewayLog.systemPromptId, pending[0]!.id))).length, 1)
    // A failing log insert must roll back the terminal generation update too.
    await pool.query(`CREATE FUNCTION "${schema}".reject_test_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.prompt = 'reject-log' THEN RAISE EXCEPTION 'test log rejection'; END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER reject_test_log BEFORE INSERT ON "aiGatewayLog" FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_test_log()`)
    await assert.rejects(database.failGeneration(pending[1]!.id, {
      error: {name: 'Error', message: 'Failure', code: 'TEST_ERROR', retryable: false}, log: {...log, status: 'error', prompt: 'reject-log'},
    }))
    assert.equal((await database.getSystemPrompt(pending[1]!.id))?.status, 'pending')
    await db.update(systemPrompt).set({updatedAt: new Date(Date.now() - 600_000).toISOString()}).where(eq(systemPrompt.batchId, batchId))
    const leaseId = randomUUID()
    await db.insert(runtimeLease).values({id: leaseId, owner: batchId, scope: 'image-generation', state: 'running', expiresAt: new Date(Date.now() + 60_000).toISOString()})
    assert.equal(await database.reconcileStalePendingGenerations(60_000), 0)
    await db.delete(runtimeLease).where(eq(runtimeLease.id, leaseId))
    assert.equal(await database.reconcileStalePendingGenerations(60_000), 2)
    assert.equal(await database.reconcileStalePendingGenerations(60_000), 0)
    assert.equal((await database.getSystemPrompt(pending[0]!.id))?.status, 'succeeded')
    assert.equal(await database.touchPendingGenerations(pending.map(row => row.id)), 0)
    const history = await database.getSystemPrompts(1, 1)
    assert.equal(history.length, 1)
    assert.equal('usageJson' in history[0]!, false)
    assert.equal(await database.countSystemPrompts(), 3)
  } finally {
    await pool.end()
    await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await administrator.end()
  }
})
