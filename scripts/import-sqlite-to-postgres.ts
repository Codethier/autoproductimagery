import 'dotenv/config'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inspectLegacySqlite, importLegacySqlite, LegacyImportError } from './lib/sqliteImport.ts'
import { getDatabasePoolConfig } from '../server/utils/lib/db.ts'

const args = process.argv.slice(2)
let sqlitePath: string | undefined
let apply = false
let environment: string | undefined
let explicitDryRun = false
let pool: Pool | undefined

try {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        if (arg === '--sqlite') sqlitePath = args[++index]
        else if (arg.startsWith('--sqlite=')) sqlitePath = arg.slice('--sqlite='.length)
        else if (arg === '--apply') apply = true
        else if (arg === '--dry-run') explicitDryRun = true
        else if (arg.startsWith('--environment=')) environment = arg.slice('--environment='.length)
        else throw new LegacyImportError('Unknown import option.')
    }
    if (!sqlitePath) throw new LegacyImportError('Provide --sqlite=<source SQLite file>.')
    if (apply && explicitDryRun) throw new LegacyImportError('Choose either --apply or --dry-run.')
    const summary = inspectLegacySqlite(sqlitePath)
    if (!apply) {
        console.log(JSON.stringify({mode: 'dry-run', ...summary, nextStep: 'Import local images first, then set IMPORT_DATABASE_URL for an empty development database and pass --apply --environment=development.'}))
    } else {
        if (environment !== 'development') throw new LegacyImportError('Apply requires the explicit --environment=development target.')
        if (!process.env.IMPORT_DATABASE_URL) throw new LegacyImportError('IMPORT_DATABASE_URL must explicitly name the empty development PostgreSQL target.')
        pool = new Pool(getDatabasePoolConfig({...process.env, DATABASE_URL: process.env.IMPORT_DATABASE_URL}))
        const imported = await importLegacySqlite(sqlitePath, drizzle({client: pool}))
        console.log(JSON.stringify({mode: 'imported', ...imported}))
    }
} catch (error) {
    console.error(error instanceof LegacyImportError ? error.message : 'SQLite import failed. Check the source format and development database configuration; no source data was changed.')
    process.exitCode = 1
} finally {
    await pool?.end()
}
