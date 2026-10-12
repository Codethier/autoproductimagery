export type CoordinationQueryResult = {
    rows: Record<string, unknown>[]
    rowCount: number | null
}

export type CoordinationConnection = {
    query(text: string, values?: unknown[]): Promise<CoordinationQueryResult>
    release(): void
}

export type CoordinationPool = {
    query(text: string, values?: unknown[]): Promise<CoordinationQueryResult>
    connect(): Promise<CoordinationConnection>
}

export async function getCoordinationPool(): Promise<CoordinationPool> {
    // Import lazily so source tests/builds never require a live database.
    const { getDatabasePool } = await import('./lib/db')
    return getDatabasePool()
}

export async function coordinationTransaction<T>(
    pool: CoordinationPool,
    lockKey: string,
    work: (connection: CoordinationConnection) => Promise<T>,
): Promise<T> {
    const connection = await pool.connect()
    try {
        await connection.query('BEGIN')
        // The lock lives only inside this short transaction, never during a
        // provider request or upload. All instances use the same namespace.
        await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey])
        const result = await work(connection)
        await connection.query('COMMIT')
        return result
    } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined)
        throw error
    } finally {
        connection.release()
    }
}
