import {fork, type ChildProcess, type ForkOptions, type SpawnOptions} from 'node:child_process'
import {availableParallelism} from 'node:os'
import {resolve} from 'node:path'
import {getBackgroundRemovalModel, type BackgroundRemovalModelId} from '../../schemas/background-removal-models'
import {MAX_IMAGE_PIXELS, MAX_STORED_IMAGE_BYTES} from './imageValidation'

export const BACKGROUND_REMOVAL_TIMEOUT_MS = 10 * 60_000
export const BACKGROUND_REMOVAL_IDLE_MS = 60_000

export type BackgroundRemovalErrorCode = 'BUSY' | 'INVALID_IMAGE' | 'UNSUPPORTED_MODEL' | 'TIMED_OUT' | 'CANCELLED' | 'PROCESSING_FAILED' | 'UNAVAILABLE' | 'INSUFFICIENT_MEMORY'
const PUBLIC_MESSAGES: Record<BackgroundRemovalErrorCode, string> = {
    BUSY: 'The background removal worker is busy',
    INVALID_IMAGE: 'A valid, supported image within the upload limits is required',
    UNSUPPORTED_MODEL: 'Unsupported background removal model',
    TIMED_OUT: 'Background removal exceeded its time limit',
    CANCELLED: 'Background removal was cancelled',
    PROCESSING_FAILED: 'Background removal could not process this image',
    UNAVAILABLE: 'The background removal worker is unavailable',
    INSUFFICIENT_MEMORY: 'There is not enough free server memory for this background removal model',
}

export class BackgroundRemovalEngineError extends Error {
    readonly code: BackgroundRemovalErrorCode
    readonly retryable: boolean
    constructor(code: BackgroundRemovalErrorCode, retryable: boolean) {
        super(PUBLIC_MESSAGES[code])
        this.name = 'BackgroundRemovalEngineError'
        this.code = code
        this.retryable = retryable
    }
}

export type BackgroundRemovalResult = {
    buffer: Buffer
    mimeType: 'image/png'
    width: number
    height: number
    byteSize: number
    modelVersion: string
}

export type BackgroundRemovalInput = {buffer: Buffer; model: BackgroundRemovalModelId; signal?: AbortSignal}
type ChildFactory = (model: BackgroundRemovalModelId, threads: number) => ChildProcess
type Pending = {
    id: number
    model: BackgroundRemovalModelId
    resolve: (result: BackgroundRemovalResult) => void
    reject: (error: BackgroundRemovalEngineError) => void
    timer: ReturnType<typeof setTimeout>
    removeAbort?: () => void
}

/** Credentials and application preload hooks are deliberately not inherited by the inference process. */
function childEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {NODE_ENV: 'production'}
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    return env
}

function defaultChildFactory(model: BackgroundRemovalModelId, threads: number): ChildProcess {
    // Node fork forwards options to spawn; @types/node does not include spawn's windowsHide in ForkOptions.
    const options: ForkOptions & Pick<SpawnOptions, 'windowsHide'> = {
        execArgv: [],
        env: childEnvironment(),
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
    }
    return fork(resolve(process.cwd(), '.output/background-removal/worker.mjs'), [model, String(threads)], options)
}

/** No in-memory queue: PostgreSQL owns admission and recovery, and native memory stays bounded to one child. */
export function createBackgroundRemovalEngine(options: {
    createChild?: ChildFactory
    timeoutMs?: number
    idleMs?: number
    threads?: number
    availableMemory?: () => number
} = {}) {
    const createChild = options.createChild ?? defaultChildFactory
    const timeoutMs = Math.max(1, Math.min(BACKGROUND_REMOVAL_TIMEOUT_MS, options.timeoutMs ?? BACKGROUND_REMOVAL_TIMEOUT_MS))
    const idleMs = Math.max(1, Math.min(BACKGROUND_REMOVAL_IDLE_MS, options.idleMs ?? BACKGROUND_REMOVAL_IDLE_MS))
    const threads = Math.max(1, Math.min(2, Math.trunc(options.threads ?? availableParallelism())))
    const availableMemory = options.availableMemory ?? (() => process.availableMemory())
    let child: ChildProcess | undefined
    let loadedModel: BackgroundRemovalModelId | undefined
    let pending: Pending | undefined
    let entering = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let termination: Promise<void> | undefined
    let sequence = 0
    let closeEpoch = 0

    function clearIdle() { if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined }

    function finish(error?: BackgroundRemovalEngineError, result?: BackgroundRemovalResult) {
        const current = pending
        if (!current) return
        pending = undefined
        clearTimeout(current.timer)
        current.removeAbort?.()
        if (error) current.reject(error)
        else current.resolve(result!)
    }

    function stopChild(): Promise<void> {
        clearIdle()
        if (termination) return termination
        const stopping = child
        child = undefined
        loadedModel = undefined
        if (!stopping || stopping.exitCode !== null || stopping.signalCode !== null) return Promise.resolve()
        // Closing an idle, unreferenced child still needs an event-loop handle until exit confirms RAM is released.
        stopping.ref()
        stopping.channel?.ref()
        stopping.removeAllListeners('message')
        termination = new Promise<void>(done => {
            stopping.once('exit', () => done())
            // Keep an error listener until exit: failed IPC must never become an unhandled event.
            stopping.once('error', () => { if (stopping.pid === undefined) done() })
            if (!stopping.kill('SIGKILL') && stopping.pid === undefined) done()
        }).finally(() => { termination = undefined })
        return termination
    }

    function failAndStop(error: BackgroundRemovalEngineError) {
        // Start the termination barrier before rejection can allow a sibling job to enter.
        void stopChild()
        finish(error)
    }

    function scheduleIdle() {
        clearIdle()
        idleTimer = setTimeout(() => { void stopChild() }, idleMs)
        idleTimer.unref()
        child?.unref()
        child?.channel?.unref()
    }

    function startChild(model: BackgroundRemovalModelId) {
        try { child = createChild(model, threads) }
        catch { throw new BackgroundRemovalEngineError('UNAVAILABLE', true) }
        loadedModel = model
        const launched = child
        launched.on('message', (message: unknown) => {
            if (!pending || child !== launched || !message || typeof message !== 'object') return
            const reply = message as {id?: unknown; error?: {code?: unknown}; result?: Partial<BackgroundRemovalResult>}
            if (reply.id !== pending.id) return
            if (reply.error) {
                const code = reply.error.code === 'INVALID_IMAGE' ? 'INVALID_IMAGE' : 'PROCESSING_FAILED'
                failAndStop(new BackgroundRemovalEngineError(code, code !== 'INVALID_IMAGE'))
                return
            }
            const result = reply.result
            if (!result || !Buffer.isBuffer(result.buffer) || result.buffer.byteLength > MAX_STORED_IMAGE_BYTES
                || result.buffer.length < 8 || result.buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
                || result.mimeType !== 'image/png' || result.byteSize !== result.buffer.length
                || !Number.isInteger(result.width) || !Number.isInteger(result.height)
                || result.width! < 1 || result.height! < 1 || result.width! * result.height! > MAX_IMAGE_PIXELS
                || result.modelVersion !== getBackgroundRemovalModel(pending.model).version) {
                failAndStop(new BackgroundRemovalEngineError('PROCESSING_FAILED', true))
                return
            }
            finish(undefined, result as BackgroundRemovalResult)
            scheduleIdle()
        })
        launched.on('error', () => {
            if (child !== launched) return
            failAndStop(new BackgroundRemovalEngineError('UNAVAILABLE', true))
        })
        launched.on('exit', () => {
            if (child !== launched) return
            child = undefined
            loadedModel = undefined
            clearIdle()
            finish(new BackgroundRemovalEngineError('PROCESSING_FAILED', true))
        })
    }

    async function remove(input: BackgroundRemovalInput): Promise<BackgroundRemovalResult> {
        if (pending || entering) throw new BackgroundRemovalEngineError('BUSY', true)
        if (!Buffer.isBuffer(input.buffer) || input.buffer.length === 0 || input.buffer.byteLength > MAX_STORED_IMAGE_BYTES) {
            throw new BackgroundRemovalEngineError('INVALID_IMAGE', false)
        }
        try { getBackgroundRemovalModel(input.model) }
        catch { throw new BackgroundRemovalEngineError('UNSUPPORTED_MODEL', false) }
        if (input.signal?.aborted) throw new BackgroundRemovalEngineError('CANCELLED', true)
        entering = true
        const epoch = closeEpoch
        clearIdle()
        try {
            if (termination) await termination
            if (child && loadedModel !== input.model) await stopChild()
            if (input.signal?.aborted || epoch !== closeEpoch) throw new BackgroundRemovalEngineError('CANCELLED', true)
            if (!child) {
                const free = availableMemory()
                if (!Number.isFinite(free) || free < getBackgroundRemovalModel(input.model).minimumAvailableMemoryBytes) {
                    throw new BackgroundRemovalEngineError('INSUFFICIENT_MEMORY', false)
                }
                startChild(input.model)
            }
            child!.ref()
            child!.channel?.ref()
            return await new Promise<BackgroundRemovalResult>((done, reject) => {
                const id = ++sequence
                const timer = setTimeout(() => failAndStop(new BackgroundRemovalEngineError('TIMED_OUT', true)), timeoutMs)
                pending = {id, model: input.model, resolve: done, reject, timer}
                const onAbort = () => failAndStop(new BackgroundRemovalEngineError('CANCELLED', true))
                input.signal?.addEventListener('abort', onAbort, {once: true})
                pending.removeAbort = () => input.signal?.removeEventListener('abort', onAbort)
                try {
                    child!.send({id, buffer: input.buffer}, error => {
                        if (error && pending?.id === id) failAndStop(new BackgroundRemovalEngineError('UNAVAILABLE', true))
                    })
                } catch { failAndStop(new BackgroundRemovalEngineError('UNAVAILABLE', true)) }
            })
        } finally { entering = false }
    }

    async function close() {
        closeEpoch += 1
        const stopped = stopChild()
        finish(new BackgroundRemovalEngineError('CANCELLED', true))
        await stopped
    }

    return {remove, close, busy: () => Boolean(pending || entering || termination)}
}

const engine = createBackgroundRemovalEngine()
export const removeImageBackground = (input: BackgroundRemovalInput) => engine.remove(input)
export const closeBackgroundRemovalEngine = () => engine.close()
