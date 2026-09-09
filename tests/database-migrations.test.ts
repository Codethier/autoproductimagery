import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { and, eq } from 'drizzle-orm'
import { systemPrompt } from '../server/db/schema.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const migrationsFolder = join(root, 'drizzle')
const legacy = JSON.parse(readFileSync(new URL('./fixtures/drizzle-v0.json', import.meta.url), 'utf8')) as {
  tag: string; when: number; sql: string
}[]
const hash = (sql: string) => createHash('sha256').update(sql).digest('hex')
const folders = readdirSync(migrationsFolder).filter(name => /^\d{14}_/.test(name)).sort()

test('v1 migration conversion preserves every original SQL file and timestamp', () => {
  assert.equal(folders.length, legacy.length)
  for (const [i, migration] of legacy.entries()) {
    assert.equal(readFileSync(join(migrationsFolder, folders[i]!, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n'), migration.sql.replace(/\r\n/g, '\n'))
    const timestamp = new Date(migration.when).toISOString().replace(/\D/g, '').slice(0, 14)
    assert.ok(folders[i]!.startsWith(timestamp + '_'))
  }
})

for (const appliedCount of [0, 5, 7]) {
  test(`Drizzle v1 migrates a database with ${appliedCount} legacy migrations and can rerun safely`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'imagery-migrations-test-'))
    const databasePath = join(directory, 'test.db')
    let client: ReturnType<typeof createClient> | undefined
    try {
      const sqlite = new DatabaseSync(databasePath)
      try {
        if (appliedCount) {
          sqlite.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)')
          for (const migration of legacy.slice(0, appliedCount)) {
            sqlite.exec(migration.sql)
            sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(hash(migration.sql), migration.when)
          }
          sqlite.prepare('INSERT INTO systemPrompt (TextPrompt, outputImage, serverImages) VALUES (?, ?, ?)')
            .run('Preserve this product', 'output/original.png', '["input/original.png"]')
        }
      } finally {
        sqlite.close()
      }
      const config = join(directory, 'drizzle.config.cjs')
      writeFileSync(config, 'module.exports = ' + JSON.stringify({
        dialect: 'sqlite', out: migrationsFolder,
        schema: join(root, 'server/db/schema.ts'),
        dbCredentials: { url: pathToFileURL(databasePath).href },
      }))
      const migrate = () => execFileSync(process.execPath, [join(root, 'node_modules/drizzle-kit/bin.cjs'), 'migrate', '--config', config], {
        cwd: directory, encoding: 'utf8', timeout: 60_000,
      })
      migrate()
      migrate()
      const upgraded = new DatabaseSync(databasePath)
      try {
        const history = upgraded.prepare('SELECT hash, name, applied_at FROM __drizzle_migrations ORDER BY created_at').all()
        assert.equal(history.length, legacy.length)
        history.forEach((row, index) => {
          const source = index < appliedCount ? legacy[index]!.sql : readFileSync(join(migrationsFolder, folders[index]!, 'migration.sql'), 'utf8')
          assert.equal(row.hash, hash(source))
          assert.equal(row.name, folders[index])
          if (index < appliedCount) assert.equal(row.applied_at, null)
          else assert.equal(typeof row.applied_at, 'string')
        })
        const columns = upgraded.prepare('PRAGMA table_info(systemPrompt)').all().map(row => row.name)
        assert.ok(columns.includes('generationConfig'))
        assert.ok(columns.includes('status'))
        assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'systemPrompt_status_updatedAt_idx'").get())
        if (appliedCount) {
          assert.equal(upgraded.prepare('SELECT TextPrompt FROM systemPrompt WHERE id = 1').get()?.TextPrompt, 'Preserve this product')
          assert.equal(upgraded.prepare('SELECT serverImages FROM systemPrompt WHERE id = 1').get()?.serverImages, '["input/original.png"]')
        }
      } finally {
        upgraded.close()
      }
      client = createClient({ url: pathToFileURL(databasePath).href })
      const db = drizzle({ client })
      const [created] = await db.insert(systemPrompt).values({
        TextPrompt: 'Round trip', outputImage: '', serverImages: ['input/test.png'], status: 'pending',
      }).returning()
      assert.ok(created)
      assert.deepEqual(created.serverImages, ['input/test.png'])
      assert.ok(created.createdAt)
      assert.equal((await db.update(systemPrompt).set({ status: 'succeeded', outputImage: 'output/test.png' })
        .where(and(eq(systemPrompt.id, created.id), eq(systemPrompt.status, 'pending'))).returning()).length, 1)
      assert.equal((await db.update(systemPrompt).set({ status: 'failed' })
        .where(and(eq(systemPrompt.id, created.id), eq(systemPrompt.status, 'pending'))).returning()).length, 0)
      assert.equal((await db.select().from(systemPrompt).where(eq(systemPrompt.id, created.id)))[0]?.status, 'succeeded')
    } finally {
      client?.close()
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
