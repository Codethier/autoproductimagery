import { build } from 'esbuild'

await build({
    entryPoints: ['scripts/cleanup-generated-images.ts'],
    outfile: '.output/cleanup-generated-images.mjs',
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'esm',
    packages: 'external',
    sourcemap: false,
})
