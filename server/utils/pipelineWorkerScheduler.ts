export type PipelineWorkerSchedulerDependencies = {
    drain(): Promise<void>
    pending(): Promise<boolean>
    connect(): Promise<unknown>
    disconnect(): Promise<unknown>
    error(): void
    serverless: boolean
    schedule?: (work: () => void, ms: number) => unknown
    cancel?: (timer: unknown) => void
}

/** Poll only while durable work exists; an authenticated HTTP request restarts an idle runner. */
export function createPipelineWorkerScheduler(deps: PipelineWorkerSchedulerDependencies) {
    const schedule = deps.schedule ?? ((work, ms) => setTimeout(work, ms))
    const cancel = deps.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
    let closed = false, revision = 0, drainedRevision = 0, work: Promise<void> | undefined, timer: unknown, dormant = true
    const clear = () => {if (timer !== undefined) {cancel(timer); timer = undefined}}
    async function drain() {
        while (!closed) {
            const seen = revision
            let pending = true
            dormant = false
            try {
                await deps.connect()
                if (closed) return
                await deps.drain()
                if (closed) return
                pending = await deps.pending()
                if (closed) return
                if (deps.serverless && !pending) {
                    // Destroy the LISTEN connection and leave the min=0 pool
                    // to expire other clients. No database wake remains.
                    await deps.disconnect()
                    dormant = true
                }
            } catch {deps.error(); pending = true}
            if (closed) return
            // A wake can arrive during the final database check, LISTEN
            // release or engine shutdown. It must receive another full drain.
            if (seen !== revision) continue
            if (!deps.serverless || pending) {
                dormant = false
                timer = schedule(() => {timer = undefined; void wake()}, pending ? 5000 : 60_000)
            }
            drainedRevision = seen
            return
        }
    }
    function wake(): Promise<void> {
        revision++
        if (closed) return Promise.resolve()
        clear()
        if (work) return work
        work = drain().catch(() => deps.error()).finally(() => {
            work = undefined
            // Protect the microtask window after drain returns but before this
            // promise settles. A wake in that window still starts fresh work.
            if (!closed && drainedRevision !== revision) return wake()
        })
        return work
    }
    async function close() {closed = true; clear(); await work; await deps.disconnect()}
    return {wake, close, get dormant() {return dormant}, get busy() {return Boolean(work)}}
}
