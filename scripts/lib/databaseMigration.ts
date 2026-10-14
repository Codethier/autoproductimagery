type MigrationDependencies = {
    warmDatabase(): Promise<void>
    migrateOnce(): Promise<void>
    signal?: AbortSignal
}

/** Readiness may retry connections; an actual migration is invoked only once. */
export async function migrateAfterDatabaseWarmup(deps: MigrationDependencies) {
    deps.signal?.throwIfAborted()
    await deps.warmDatabase()
    deps.signal?.throwIfAborted()
    await deps.migrateOnce()
}
