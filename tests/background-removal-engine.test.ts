import assert from 'node:assert/strict'
import test from 'node:test'
import {EventEmitter} from 'node:events'
import type {ChildProcess} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
import {mkdtemp, readFile, rm, writeFile, access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import sharp from 'sharp'
import {createBackgroundRemovalEngine, BackgroundRemovalEngineError} from '../server/utils/backgroundRemovalEngine.ts'
import {BACKGROUND_REMOVAL_MODELS, getBackgroundRemovalModel} from '../schemas/background-removal-models.ts'
import {applyExistingAlpha, maskFromLogits, normalizedRgbTensor, prepareBackgroundRemovalInput, encodeBackgroundRemovalOutput, MASK_SIZE} from '../scripts/background-removal-inference.ts'
import {downloadModel, verifyModelFile} from '../scripts/build-background-removal.mjs'
import {assertNodeRuntimeLibraries} from '../scripts/check-background-removal-runtime.ts'

class FakeChild extends EventEmitter {
    pid = 42
    exitCode: number | null = null
    signalCode: string | null = null
    requests: Array<{id: number; buffer: Buffer}> = []
    signals: Array<string | undefined> = []
    autoExit = true
    channel = {ref() {}, unref() {}}
    ref() {}
    unref() {}
    send(message: {id: number; buffer: Buffer}, callback: (error: Error | null) => void) {
        this.requests.push(message)
        callback(null)
        return true
    }
    kill(signal?: string) {
        this.signals.push(signal)
        if (this.autoExit) queueMicrotask(() => this.exit())
        return true
    }
    exit() { this.exitCode = 0; this.emit('exit', 0) }
    result(model = 'birefnet-lite', overrides: Record<string, unknown> = {}) {
        const buffer = Buffer.from('89504e470d0a1a0a01', 'hex')
        this.emit('message', {id: this.requests.at(-1)!.id, result: {
            buffer, mimeType: 'image/png', width: 1, height: 1, byteSize: buffer.length,
            modelVersion: getBackgroundRemovalModel(model).version, ...overrides,
        }})
    }
}

function fixture(options: Parameters<typeof createBackgroundRemovalEngine>[0] = {}) {
    const children: FakeChild[] = []
    const models: string[] = []
    const engine = createBackgroundRemovalEngine({availableMemory: () => 32 * 1024 ** 3, ...options, createChild(model, threads) {
        assert.ok(threads >= 1 && threads <= 2)
        models.push(model)
        const child = new FakeChild()
        children.push(child)
        return child as unknown as ChildProcess
    }})
    return {engine, children, models, input: {buffer: Buffer.from('test-image'), model: 'birefnet-lite' as const}}
}

test('local model profiles select exact pinned CPU graphs and reject arbitrary IDs', () => {
    assert.deepEqual(BACKGROUND_REMOVAL_MODELS.map(model => model.id), ['birefnet-lite', 'birefnet'])
    assert.ok(BACKGROUND_REMOVAL_MODELS.every(model => model.license === 'MIT' && /^[0-9a-f]{64}$/.test(model.sha256)))
    assert.equal(getBackgroundRemovalModel('birefnet-lite').bytes, 224005088)
    assert.equal(getBackgroundRemovalModel('birefnet').version, 'rembg-birefnet-general-244')
    for (const invalid of ['BiRefNet', '../model.onnx', 'https://example.com/model.onnx', 'birefnet-matting']) {
        assert.throws(() => getBackgroundRemovalModel(invalid), /Unsupported background removal model/)
    }
})

test('final-runtime diagnostic rejects a missing native library or missing Node libatomic', () => {
    assert.doesNotThrow(() => assertNodeRuntimeLibraries('libatomic.so.1 => /lib/libatomic.so.1 (0x1234)\nlibc.so.6 => /lib/libc.so.6'))
    assert.throws(() => assertNodeRuntimeLibraries('libatomic.so.1 => /lib/libatomic.so.1\nlibstdc++.so.6 => not found'), /libraries are incomplete/)
    assert.throws(() => assertNodeRuntimeLibraries('libc.so.6 => /lib/libc.so.6'), /libraries are incomplete/)
})

test('CPU preprocessing writes channel-first ImageNet normalized float32 values', () => {
    const data = normalizedRgbTensor(Uint8Array.from([255, 0, 128, 0, 255, 64, 32, 64, 96, 128, 192, 255]), 2)
    assert.equal(data.length, 12)
    assert.ok(Math.abs(data[0]! - (1 - 0.485) / 0.229) < 1e-6)
    assert.ok(Math.abs(data[4]! - (0 - 0.456) / 0.224) < 1e-6)
    assert.ok(Math.abs(data[8]! - (128 / 255 - 0.406) / 0.225) < 1e-6)
    assert.throws(() => normalizedRgbTensor(new Uint8Array(4), 2), /Invalid image tensor/)
})

test('mask conversion normalizes valid logits, preserves flat masks and rejects NaNs or bad dimensions', () => {
    assert.deepEqual([...maskFromLogits(Float32Array.from([-1000, 0, 1000]), 3)], [0, 127, 255])
    assert.deepEqual([...maskFromLogits(Float32Array.from([0, 0]), 2)], [127, 127])
    assert.deepEqual([...maskFromLogits(Float32Array.from([1000, 1000]), 2)], [255, 255])
    assert.deepEqual([...maskFromLogits(Float32Array.from([-1000, -1000]), 2)], [0, 0])
    assert.throws(() => maskFromLogits(Float32Array.from([NaN]), 1), /Invalid model output/)
    assert.throws(() => maskFromLogits(Float32Array.from([Infinity]), 1), /Invalid model output/)
    assert.throws(() => maskFromLogits(Float32Array.from([0]), 2), /Invalid model output/)
})

test('cutout masks multiply existing transparency instead of resurrecting invisible pixels', () => {
    const rgba = Uint8Array.from([1, 2, 3, 0, 4, 5, 6, 128, 7, 8, 9, 255])
    applyExistingAlpha(rgba, Uint8Array.from([255, 128, 64]))
    assert.deepEqual([...rgba], [1, 2, 3, 0, 4, 5, 6, 64, 7, 8, 9, 64])
    assert.throws(() => applyExistingAlpha(rgba, new Uint8Array(2)), /Invalid alpha dimensions/)
})

test('decoded images are oriented and transparent outputs keep actual dimensions and decoded MIME', async () => {
    const source = await sharp({create: {width: 2, height: 3, channels: 4, background: {r: 10, g: 20, b: 30, alpha: 0.5}}})
        .png().toBuffer()
    const input = await prepareBackgroundRemovalInput(source)
    assert.equal(input.width, 2)
    assert.equal(input.height, 3)
    assert.equal(input.tensor.length, MASK_SIZE * MASK_SIZE * 3)
    const result = await encodeBackgroundRemovalOutput(input, new Uint8Array(MASK_SIZE * MASK_SIZE).fill(128))
    assert.equal(result.mimeType, 'image/png')
    assert.equal(result.byteSize, result.buffer.length)
    assert.deepEqual([result.width, result.height], [2, 3])
    const decoded = await sharp(result.buffer).raw().toBuffer()
    assert.equal(decoded[3], 64)
    const rotated = await sharp({create: {width: 2, height: 3, channels: 3, background: '#ffffff'}})
        .jpeg().withMetadata({orientation: 6}).toBuffer()
    const oriented = await prepareBackgroundRemovalInput(rotated)
    assert.deepEqual([oriented.width, oriented.height], [3, 2])
    await assert.rejects(prepareBackgroundRemovalInput(Buffer.from('not an image')), {statusCode: 415})
    await assert.rejects(prepareBackgroundRemovalInput(source.subarray(0, 25)), {statusCode: 415})
})

test('engine reuses only the selected model and refuses simultaneous in-memory work', async () => {
    const {engine, children, models, input} = fixture()
    try {
        const first = engine.remove(input)
        await assert.rejects(engine.remove(input), {code: 'BUSY', retryable: true})
        children[0]!.result()
        assert.equal((await first).modelVersion, getBackgroundRemovalModel(input.model).version)
        const next = engine.remove(input)
        children[0]!.result()
        await next
        assert.equal(children.length, 1)
        const full = engine.remove({...input, model: 'birefnet'})
        await delay(0)
        assert.deepEqual(children[0]!.signals, ['SIGKILL'])
        assert.deepEqual(models, ['birefnet-lite', 'birefnet'])
        children[1]!.result('birefnet')
        await full
    } finally { await engine.close() }
})

test('engine deadline kills native work and immediate retry waits for process exit', async () => {
    const {engine, children, input} = fixture({timeoutMs: 15})
    try {
        const first = engine.remove(input)
        children[0]!.autoExit = false
        await assert.rejects(first, {code: 'TIMED_OUT', retryable: true})
        assert.deepEqual(children[0]!.signals, ['SIGKILL'])
        const retry = engine.remove(input)
        assert.equal(children.length, 1)
        await assert.rejects(engine.remove(input), {code: 'BUSY'})
        children[0]!.exit()
        await delay(0)
        assert.equal(children.length, 2)
        children[1]!.result()
        await retry
        assert.equal(engine.busy(), false)
    } finally { await engine.close() }
})

test('engine abort and close kill native work and stop a new child starting during shutdown', async () => {
    const {engine, children, input} = fixture()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(engine.remove({...input, signal: controller.signal}), {code: 'CANCELLED'})
    assert.equal(children.length, 0)
    const activeController = new AbortController()
    const active = engine.remove({...input, signal: activeController.signal})
    activeController.abort()
    await assert.rejects(active, {code: 'CANCELLED'})
    await delay(0)
    const reused = engine.remove(input)
    children[1]!.result()
    await reused
    children[1]!.autoExit = false
    const switching = engine.remove({...input, model: 'birefnet'})
    const cancelled = assert.rejects(switching, {code: 'CANCELLED'})
    const closing = engine.close()
    children[1]!.exit()
    await closing
    await cancelled
    assert.equal(children.length, 2)
})

test('engine releases model memory when idle and does not expose native paths or error details', async () => {
    const {engine, children, input} = fixture({idleMs: 10})
    try {
        const first = engine.remove(input)
        children[0]!.result()
        await first
        await delay(20)
        assert.deepEqual(children[0]!.signals, ['SIGKILL'])
        const failing = engine.remove(input)
        const redacted = assert.rejects(failing, error => error instanceof BackgroundRemovalEngineError
            && error.code === 'UNAVAILABLE' && !error.message.includes('private') && !error.message.includes('token'))
        children[1]!.emit('error', new Error('private /absolute/model/path token=secret'))
        await redacted
    } finally { await engine.close() }
})

test('engine rejects invalid inputs, mismatched model versions and stale reply IDs', async () => {
    const {engine, children, input} = fixture()
    try {
        await assert.rejects(engine.remove({...input, buffer: Buffer.alloc(0)}), {code: 'INVALID_IMAGE', retryable: false})
        await assert.rejects(engine.remove({...input, model: 'bad-model' as 'birefnet'}), {code: 'UNSUPPORTED_MODEL'})
        assert.equal(children.length, 0)
        const pending = engine.remove(input)
        children[0]!.emit('message', {id: -1, error: {code: 'INVALID_IMAGE'}})
        assert.equal(engine.busy(), true)
        const rejected = assert.rejects(pending, {code: 'PROCESSING_FAILED'})
        children[0]!.result('birefnet')
        await rejected
    } finally { await engine.close() }
})

test('engine blocks low-memory CPUs before creating a child and rechecks after switching models', async () => {
    let free = 4 * 1024 ** 3
    const {engine, children, input} = fixture({availableMemory: () => free})
    try {
        await assert.rejects(engine.remove(input), {code: 'INSUFFICIENT_MEMORY', retryable: false})
        assert.equal(children.length, 0)
        assert.equal(engine.busy(), false)
        free = getBackgroundRemovalModel('birefnet-lite').minimumAvailableMemoryBytes
        const lite = engine.remove(input)
        children[0]!.result()
        await lite
        await assert.rejects(engine.remove({...input, model: 'birefnet'}), {code: 'INSUFFICIENT_MEMORY'})
        assert.deepEqual(children[0]!.signals, ['SIGKILL'])
        assert.equal(children.length, 1)
        free = getBackgroundRemovalModel('birefnet').minimumAvailableMemoryBytes
        const full = engine.remove({...input, model: 'birefnet'})
        children[1]!.result('birefnet')
        await full
    } finally { await engine.close() }
})

test('Git build streams only approved HTTPS assets and requires exact byte count and SHA-256', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'background-model-build-'))
    const path = join(folder, 'model.onnx')
    const bytes = Buffer.from('small model fixture')
    const model = {url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/test.onnx', bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')}
    try {
        const calls: string[] = []
        await downloadModel(model, path, {fetch: async (url: URL) => {
            calls.push(url.hostname)
            return calls.length === 1
                ? new Response(null, {status: 302, headers: {location: 'https://release-assets.githubusercontent.com/fixture'}})
                : new Response(bytes, {headers: {'content-length': String(bytes.length)}})
        }})
        assert.deepEqual(calls, ['github.com', 'release-assets.githubusercontent.com'])
        assert.deepEqual(await readFile(path), bytes)
        assert.equal(await verifyModelFile(path, model), true)
        await writeFile(path, Buffer.alloc(bytes.length))
        assert.equal(await verifyModelFile(path, model), false)
        await rm(path)
        await assert.rejects(downloadModel(model, path, {fetch: async () => new Response(null, {status: 302,
            headers: {location: 'http://127.0.0.1/private-model'}})}), /approved HTTPS/)
        await assert.rejects(downloadModel(model, path, {fetch: async () => new Response(Buffer.alloc(bytes.length))}), /SHA-256/)
        await assert.rejects(downloadModel(model, path, {fetch: async () => new Response(Buffer.alloc(bytes.length + 1))}), /byte limit/)
        await assert.rejects(access(path))
    } finally { await rm(folder, {recursive: true, force: true}) }
})
