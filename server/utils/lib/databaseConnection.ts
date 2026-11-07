import {setTimeout as delay} from 'node:timers/promises'

export const DATABASE_CONNECT_BUDGET_MS = 60_000
export const DATABASE_CONNECT_ATTEMPT_MS = 10_000

/** This error contains no driver diagnostics, connection string or SQL. */
export class DatabaseUnavailableError extends Error {
    readonly code = 'DATABASE_WAKING'
    readonly statusCode = 503
    readonly statusMessage = 'The database is starting or temporarily unavailable. Please try again.'
    constructor() {
        super('The database is starting or temporarily unavailable. Please try again.')
        this.name = 'DatabaseUnavailableError'
    }
}

export function isTransientDatabaseConnectionError(error: unknown): boolean {
    const transient = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', '57P01', '57P02', '57P03'])
    let value = error
    for (let depth = 0; depth < 5 && value && typeof value === 'object'; depth++) {
        const candidate = value as {code?: unknown; message?: unknown; cause?: unknown}
        if (typeof candidate.code === 'string' && transient.has(candidate.code)) return true
        // pg-pool's connection/acquisition deadline errors have no code.
        if (candidate.message === 'Connection terminated due to connection timeout'
            || candidate.message === 'timeout exceeded when trying to connect'
            || candidate.message === 'Connection terminated unexpectedly') return true
        value = candidate.cause
    }
    return false
}

type ConnectionRetryOptions = {
    budgetMs?: number
    attemptTimeoutMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<unknown>
    stopped?: () => boolean
}

/** Retry only obtaining a connection, before any SQL or transaction begins. */
export async function acquireDatabaseConnection<T>(connect: () => Promise<T>, options: ConnectionRetryOptions = {}): Promise<T> {
    const now = options.now ?? Date.now
    const sleep = options.sleep ?? (ms => delay(ms))
    const budget = Math.max(1, Math.min(DATABASE_CONNECT_BUDGET_MS, options.budgetMs ?? DATABASE_CONNECT_BUDGET_MS))
    const attemptTimeout = Math.max(1, options.attemptTimeoutMs ?? DATABASE_CONNECT_ATTEMPT_MS)
    const deadline = now() + budget
    let attempts = 0
    while (true) {
        if (options.stopped?.()) throw new DatabaseUnavailableError()
        attempts++
        try { return await connect() }
        catch (error) {
            if (!isTransientDatabaseConnectionError(error)) throw error
            // Leave enough time for the driver's next bounded acquisition.
            // Never race a timed-out connect and leak a client arriving later.
            const backoff = Math.min(2_000, 500 * 2 ** Math.min(attempts - 1, 2))
            if (options.stopped?.() || attempts >= 32 || deadline - now() < backoff + attemptTimeout)
                throw new DatabaseUnavailableError()
            await sleep(backoff)
        }
    }
}
