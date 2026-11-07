import {createHmac, timingSafeEqual} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'

type Environment = Record<string, string | undefined>
export type PipelineWorkerWakeResult = 'accepted' | 'unavailable' | 'not-configured'
export type PipelineWorkerWakeConfig = {url: string; token: string}

/** A separate bearer credential; the Gateway key itself is never sent to the runner. */
export function pipelineWorkerWakeToken(environment: Environment = process.env): string | undefined {
    const dedicated = environment.PIPELINE_WORKER_WAKE_SECRET
    if (dedicated !== undefined && dedicated.length < 32) throw Error('Pipeline wake credentials are invalid')
    const secret = dedicated ?? environment.NUXT_AI_GATEWAY_API_KEY
    if (!secret) return undefined
    return createHmac('sha256', secret).update('autoproductimagery:pipeline-worker-wake:v1').digest('hex')
}

/** Targets are server configuration, never a run's graph or a caller-provided URL. */
export function getPipelineWorkerWakeConfig(environment: Environment = process.env): PipelineWorkerWakeConfig | undefined {
    const value = environment.PIPELINE_WORKER_URL ?? ((environment.RAILWAY_ENVIRONMENT_ID || environment.RAILWAY_PROJECT_ID)
        ? 'http://pipeline-worker.railway.internal:8080' : undefined)
    if (!value) return undefined
    let url: URL
    try {url = new URL(value)} catch {throw Error('Pipeline worker URL is invalid')}
    const privateHttp = url.protocol === 'http:' && (url.hostname.endsWith('.railway.internal')
        || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    if ((!privateHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash
        || !['', '/', '/wake'].includes(url.pathname)) throw Error('Pipeline worker URL is invalid')
    const token = pipelineWorkerWakeToken(environment)
    if (!token) throw Error('Pipeline wake credentials are missing')
    url.pathname = '/wake'
    return {url: url.toString(), token}
}

export function isPipelineWorkerWakeAuthorized(authorization: string | undefined, token: string | undefined): boolean {
    if (!token || !authorization || !/^Bearer [a-f0-9]{64}$/.test(authorization)) return false
    const candidate = Buffer.from(authorization.slice(7), 'ascii'), expected = Buffer.from(token, 'ascii')
    return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

type Dependencies = {
    config(): PipelineWorkerWakeConfig | undefined
    fetch?: typeof fetch
    now?: () => number
    wait?: (ms: number) => Promise<void>
    unavailable?(): void
}
/** Only idempotent wake requests are retried. This never replays provider work. */
export function createPipelineWorkerWakeDispatcher(deps: Dependencies) {
    const request = deps.fetch ?? fetch, now = deps.now ?? Date.now, wait = deps.wait ?? delay
    let work: {promise: Promise<PipelineWorkerWakeResult>; deadline: number} | undefined
    let revision = 0, acknowledgedRevision = 0
    async function deliver(deadline: number, sentRevision: number): Promise<PipelineWorkerWakeResult> {
        let config: PipelineWorkerWakeConfig | undefined
        try {config = deps.config()} catch {deps.unavailable?.(); return 'unavailable'}
        if (!config) return 'not-configured'
        for (let attempt = 0; attempt < 32; attempt++) {
            const remaining = deadline - now()
            if (remaining <= 0) break
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), Math.min(15_000, remaining))
            try {
                const response = await request(config.url, {method: 'POST', headers: {Authorization: `Bearer ${config.token}`},
                    body: '', redirect: 'error', signal: controller.signal})
                // Do not retain/log service response bodies or proxy diagnostics.
                await response.body?.cancel()
                if (response.status === 202) {acknowledgedRevision = sentRevision; return 'accepted'}
                if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) break
            } catch { /* A cold proxy, service or DNS can time out before the safe wake is acknowledged. */ }
            finally {clearTimeout(timer)}
            const pause = Math.min(5000, 500 * 2 ** Math.min(attempt, 4), deadline - now())
            if (pause <= 0) break
            await wait(pause)
        }
        deps.unavailable?.()
        return 'unavailable'
    }
    async function wake(options: {budgetMs?: number} = {}): Promise<PipelineWorkerWakeResult> {
        const budgetMs = Math.max(100, Math.min(90_000, Math.floor(options.budgetMs ?? 75_000)))
        const requestedRevision = ++revision, deadline = now() + budgetMs
        while (now() < deadline) {
            // An in-flight wake may have begun before this job committed. Its
            // acknowledgment cannot suppress the newer job's own later wake.
            if (!work) {
                const entry = {deadline, promise: Promise.resolve<PipelineWorkerWakeResult>('unavailable')}
                work = entry
                entry.promise = deliver(deadline, revision).finally(() => {if (work === entry) work = undefined})
            }
            const current = work
            let timer: ReturnType<typeof setTimeout> | undefined, result: PipelineWorkerWakeResult
            // When this caller owns the delivery deadline, await its abort and
            // settlement instead of racing a second timer that can fire first.
            // A short status caller may still stop waiting for a longer shared
            // enqueue wake, without canceling that enqueue's HTTP request.
            if (current.deadline <= deadline) result = await current.promise
            else try {result = await Promise.race([current.promise, new Promise<PipelineWorkerWakeResult>(resolve => {
                timer = setTimeout(() => resolve('unavailable'), Math.max(1, deadline - now()))
            })])} finally {if (timer) clearTimeout(timer)}
            if (result === 'not-configured') return result
            if (result === 'accepted' && acknowledgedRevision >= requestedRevision) return result
            if (result === 'unavailable' && current.deadline >= deadline) return result
            // A newer commit or a longer acceptance budget needs a fresh wake
            // after the earlier short/coalesced request has settled.
            if (work === current) return 'unavailable'
        }
        return 'unavailable'
    }
    return {wake}
}

const dispatcher = createPipelineWorkerWakeDispatcher({config: () => getPipelineWorkerWakeConfig(),
    unavailable: () => console.error('Pipeline runner wake is temporarily unavailable; saved work remains queued.')})
export const wakePipelineWorker = (options?: {budgetMs?: number}) => dispatcher.wake(options)
