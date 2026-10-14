import {build} from 'esbuild'

await build({
    entryPoints: ['scripts/run-database-migration.ts'],
    outfile: '.output/migrate-database.mjs',
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'esm',
    packages: 'external',
    sourcemap: false,
})
