type Dependencies = {
    configured(): boolean
    pending(): Promise<boolean>
    wake(): Promise<unknown>
    unavailable(): void
}

/** One startup check closes mixed Git rollout gaps; it never runs paid work. */
export async function recoverPipelineWorkerAtStartup(deps: Dependencies) {
    try {
        if (deps.configured() && await deps.pending()) await deps.wake()
    } catch {deps.unavailable()}
}
