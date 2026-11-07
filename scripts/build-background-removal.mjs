import {build} from 'esbuild'
import {createHash} from 'node:crypto'
import {createReadStream, createWriteStream} from 'node:fs'
import {mkdir, stat, rename, rm, copyFile, readFile, cp} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {basename, dirname, join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Transform, Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {BACKGROUND_REMOVAL_MODELS} from '../schemas/background-removal-models.ts'

const require = createRequire(import.meta.url)
const TRUSTED_MODEL_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const MODEL_DOWNLOAD_TIMEOUT_MS = 10 * 60_000

export async function verifyModelFile(path, model) {
    try {
        const info = await stat(path)
        if (!info.isFile() || info.size !== model.bytes) return false
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(path)) hash.update(chunk)
        return hash.digest('hex') === model.sha256
    } catch { return false }
}

function approvedModelUrl(input) {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !TRUSTED_MODEL_HOSTS.has(url.hostname)) {
        throw new Error('Model download redirected outside the approved HTTPS release hosts')
    }
    return url
}

export async function downloadModel(model, path, {fetch: request = globalThis.fetch, timeoutMs = MODEL_DOWNLOAD_TIMEOUT_MS} = {}) {
    const partial = `${path}.${process.pid}.partial`
    const signal = AbortSignal.timeout(Math.max(1, Math.min(MODEL_DOWNLOAD_TIMEOUT_MS, timeoutMs)))
    try {
        let url = approvedModelUrl(model.url)
        let response
        for (let redirects = 0; redirects <= 5; redirects++) {
            response = await request(url, {redirect: 'manual', signal, headers: {'User-Agent': 'autoproductimagery-background-removal-build'}})
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const next = response.headers.get('location')
                await response.body?.cancel()
                if (!next || redirects === 5) throw new Error('Model download redirect limit exceeded')
                url = approvedModelUrl(new URL(next, url))
                continue
            }
            break
        }
        if (!response?.ok || !response.body) throw new Error('Pinned model download failed')
        const contentLength = response.headers.get('content-length')
        if (contentLength !== null && Number(contentLength) !== model.bytes) {
            await response.body.cancel()
            throw new Error('Pinned model download has an unexpected size')
        }
        let bytes = 0
        const hash = createHash('sha256')
        const validate = new Transform({
            transform(chunk, _encoding, done) {
                bytes += chunk.length
                if (bytes > model.bytes) { done(new Error('Pinned model download exceeded its byte limit')); return }
                hash.update(chunk)
                done(null, chunk)
            },
        })
        await pipeline(Readable.fromWeb(response.body), validate, createWriteStream(partial, {flags: 'wx'}), {signal})
        if (bytes !== model.bytes || hash.digest('hex') !== model.sha256) throw new Error('Pinned model download failed its SHA-256 integrity check')
        await rename(partial, path)
    } finally { await rm(partial, {force: true}) }
}

function packageRoot(name, from = require) {
    // Native packages can export only a binary subpath, with neither a main entry nor package.json export.
    for (const search of from.resolve.paths(name) ?? []) {
        const candidate = join(search, name, 'package.json')
        try { if (require(candidate).name === name) return dirname(candidate) }
        catch { /* Continue through Node's own module search directories. */ }
    }
    let path
    try { path = from.resolve(`${name}/package.json`) }
    catch {
        path = from.resolve(name)
        while (dirname(path) !== path) {
            path = dirname(path)
            try {
                const manifest = require(join(path, 'package.json'))
                if (manifest.name === name) return path
            } catch { /* The exported entry can be below the package root. */ }
        }
        throw new Error(`Cannot resolve the runtime package ${name}`)
    }
    return dirname(path)
}

/** Copy the actual platform's native modules: Nitro's main-server dependency tracing cannot discover an IPC child. */
export async function copyInferenceRuntime(outputDirectory) {
    const destination = join(outputDirectory, 'node_modules')
    const copied = new Map()
    const libc = process.platform === 'linux' && require('detect-libc').familySync() === 'musl' ? 'linuxmusl' : process.platform
    const platform = `${libc}-${process.arch}`
    async function copyPackage(name, from = require) {
        const source = packageRoot(name, from)
        const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
        if (copied.has(name)) {
            if (copied.get(name) !== manifest.version) throw new Error(`Runtime dependency has conflicting versions: ${name}`)
            return
        }
        copied.set(name, manifest.version)
        const target = join(destination, name)
        await mkdir(dirname(target), {recursive: true})
        if (name === 'onnxruntime-node') {
            await mkdir(target, {recursive: true})
            for (const entry of ['package.json', 'dist', 'README.md']) await cp(join(source, entry), join(target, entry), {recursive: true})
            const nativePath = join('bin', 'napi-v6', process.platform, process.arch)
            await cp(join(source, nativePath), join(target, nativePath), {recursive: true, filter: path => {
                // These two Linux files are the complete CPU runtime. Never copy optional CUDA/TensorRT providers.
                if (process.platform !== 'linux' || path === join(source, nativePath)) return true
                return ['onnxruntime_binding.node', 'libonnxruntime.so.1'].includes(basename(path))
            }})
        } else {
            await cp(source, target, {recursive: true, filter: path => !path.includes(`${source}/node_modules/`) && !path.includes(`${source}\\node_modules\\`)})
        }
        const localRequire = createRequire(join(source, 'package.json'))
        const dependencies = name === 'onnxruntime-node' ? ['onnxruntime-common'] : Object.keys(manifest.dependencies ?? {})
        for (const dependency of dependencies) await copyPackage(dependency, localRequire)
        if (name === 'sharp') {
            await copyPackage(`@img/sharp-${platform}`, localRequire)
            const libvips = `@img/sharp-libvips-${platform}`
            if (manifest.optionalDependencies[libvips]) await copyPackage(libvips, localRequire)
        }
        if (name.startsWith('@img/sharp-')) {
            for (const optional of Object.keys(manifest.optionalDependencies ?? {})) {
                if (optional === `@img/sharp-libvips-${platform}`) await copyPackage(optional, localRequire)
            }
        }
    }
    await copyPackage('onnxruntime-node')
    await copyPackage('sharp')
    return Object.fromEntries(copied)
}

export async function buildBackgroundRemoval({models = true} = {}) {
    const output = resolve('.output/background-removal')
    await mkdir(output, {recursive: true})
    await copyFile('docs/background-removal-licenses.txt', join(output, 'LICENSES.txt'))
    await copyFile('docs/background-removal-onnx-third-party-notices.txt', join(output, 'ONNX-THIRD-PARTY-NOTICES.txt'))
    for (const [entry, filename] of [['scripts/background-removal-worker.ts', 'worker.mjs'],
        ['scripts/check-background-removal-runtime.ts', 'check-runtime.mjs']]) {
        await build({
            entryPoints: [entry],
            outfile: join(output, filename),
            bundle: true,
            platform: 'node',
            target: 'node26',
            format: 'esm',
            external: ['onnxruntime-node', 'sharp'],
            sourcemap: false,
        })
    }
    const runtime = await copyInferenceRuntime(output)
    if (models) {
        const cache = resolve(process.env.BACKGROUND_REMOVAL_MODEL_CACHE_DIR || '.cache/background-removal')
        await mkdir(cache, {recursive: true})
        await mkdir(join(output, 'models'), {recursive: true})
        // Sequential downloads bound build RAM, descriptors and bandwidth; files are streamed, never buffered.
        for (const model of BACKGROUND_REMOVAL_MODELS) {
            const cached = join(cache, `${model.sha256}.onnx`)
            if (!(await verifyModelFile(cached, model))) {
                await rm(cached, {force: true})
                console.log(`Downloading pinned ${model.label} CPU model (${model.bytes} bytes)`)
                await downloadModel(model, cached)
            }
            const final = join(output, 'models', model.filename)
            await copyFile(cached, final)
            if (!(await verifyModelFile(final, model))) throw new Error(`Final model integrity check failed: ${model.id}`)
            console.log(`Verified ${model.label}: ${model.sha256}`)
        }
    }
    console.log(`Background removal runtime ready: ${JSON.stringify(runtime)}`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    await buildBackgroundRemoval({models: !process.argv.includes('--worker-only')})
}
