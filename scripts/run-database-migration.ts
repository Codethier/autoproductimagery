import 'dotenv/config'
import {spawn} from 'node:child_process'
import {resolve} from 'node:path'
import {getDatabasePool, closeDatabasePool} from '../server/utils/lib/db'
import {migrateAfterDatabaseWarmup} from './lib/databaseMigration'

// Railway's existing pre-deploy deadline is 120 seconds. Leave time for a
// graceful failure and never automatically replay an interrupted migration.
const controller = new AbortController()
let migrationStarted = false
const deadline = setTimeout(() => {
    controller.abort(new Error('Database migration command exceeded its deadline'))
    if (!migrationStarted) {
        console.error('PostgreSQL did not become ready within the migration deadline. No migration was started.')
        process.exit(1)
    }
}, 110_000)
try {
    await migrateAfterDatabaseWarmup({signal: controller.signal,
        warmDatabase: async () => {
            await getDatabasePool().query('SELECT 1')
            await closeDatabasePool()
            console.info('PostgreSQL is ready for the explicit migration command.')
        },
        migrateOnce: async () => {
            migrationStarted = true
            await new Promise<void>((resolveMigration, reject) => {
                const child = spawn(process.execPath, [resolve(process.cwd(), 'node_modules/drizzle-kit/bin.cjs'), 'migrate', ...process.argv.slice(2)], {
                    stdio: 'inherit', signal: controller.signal,
                })
                child.once('error', reject)
                child.once('exit', (code, signal) => {
                    if (code === 0 && !signal) resolveMigration()
                    else reject(new Error('The explicit migration command did not complete successfully'))
                })
            })
        },
    })
} catch {
    console.error(migrationStarted
        ? 'The migration command did not complete. Check its state before running it again; it has not been automatically retried.'
        : 'PostgreSQL is temporarily unavailable. No migration was started.')
    process.exitCode = 1
} finally {
    clearTimeout(deadline)
    await closeDatabasePool()
}
