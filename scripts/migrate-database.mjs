import {access} from 'node:fs/promises'

const compiled = new URL('../.output/migrate-database.mjs', import.meta.url)
try { await access(compiled) }
catch {
    // Fresh local checkouts can migrate before Nuxt is built. Production app
    // builds already contain this bundle and need no compiler at runtime.
    await import('./build-database-migration.mjs')
}
await import(compiled.href)
