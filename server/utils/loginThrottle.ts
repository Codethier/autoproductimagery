import { createHash } from "node:crypto"
import { coordinationTransaction, getCoordinationPool, type CoordinationPool } from './databaseCoordination'

export const LOGIN_THROTTLE_WINDOW_MS = 15 * 60 * 1000
export const LOGIN_IP_ATTEMPT_LIMIT = 30
export const LOGIN_ACCOUNT_ATTEMPT_LIMIT = 8
const MAX_TRACKED_LOGIN_KEYS = 10_000

type AttemptBucket = {
    count: number
    resetAt: number
    lastSeen: number
}

export type LoginThrottleDecision = {
    allowed: boolean
    retryAfterSeconds: number
}

function accountKey(username: string) {
    return createHash("sha256").update(username.trim().toLocaleLowerCase("en-US")).digest("base64url")
}

function normalizeIp(ip: string | undefined) {
    return (ip || "unknown").trim().slice(0, 128) || "unknown"
}

export class LoginThrottle {
    private readonly ipAttempts = new Map<string, AttemptBucket>()
    private readonly accountAttempts = new Map<string, AttemptBucket>()
    private operations = 0

    consume(ip: string | undefined, username: string, now = Date.now()): LoginThrottleDecision {
        this.operations += 1
        if (this.operations % 64 === 0) this.prune(now)

        const ipKey = normalizeIp(ip)
        const userKey = accountKey(username)
        const ipBucket = this.current(this.ipAttempts, ipKey, now)
        const accountBucket = this.current(this.accountAttempts, userKey, now)
        const blockedUntil = Math.max(
            ipBucket.count >= LOGIN_IP_ATTEMPT_LIMIT ? ipBucket.resetAt : 0,
            accountBucket.count >= LOGIN_ACCOUNT_ATTEMPT_LIMIT ? accountBucket.resetAt : 0,
        )
        if (blockedUntil > now) {
            return {
                allowed: false,
                retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
            }
        }

        ipBucket.count += 1
        ipBucket.lastSeen = now
        accountBucket.count += 1
        accountBucket.lastSeen = now
        this.enforceBound()
        return { allowed: true, retryAfterSeconds: 0 }
    }

    clearSuccessfulAccount(username: string) {
        this.accountAttempts.delete(accountKey(username))
    }

    sizes() {
        return { ips: this.ipAttempts.size, accounts: this.accountAttempts.size }
    }

    private current(map: Map<string, AttemptBucket>, key: string, now: number) {
        const existing = map.get(key)
        if (existing && existing.resetAt > now) return existing
        const created = { count: 0, resetAt: now + LOGIN_THROTTLE_WINDOW_MS, lastSeen: now }
        map.set(key, created)
        return created
    }

    private prune(now: number) {
        for (const map of [this.ipAttempts, this.accountAttempts]) {
            for (const [key, bucket] of map) {
                if (bucket.resetAt <= now) map.delete(key)
            }
        }
    }

    private enforceBound() {
        const perMapLimit = Math.floor(MAX_TRACKED_LOGIN_KEYS / 2)
        for (const map of [this.ipAttempts, this.accountAttempts]) {
            while (map.size > perMapLimit) {
                const oldestKey = map.keys().next().value as string | undefined
                if (oldestKey === undefined) break
                map.delete(oldestKey)
            }
        }
    }
}

const LOGIN_THROTTLE_SYMBOL = Symbol.for("autoproductimagery.loginThrottle.v1")
const processState = globalThis as typeof globalThis & { [LOGIN_THROTTLE_SYMBOL]?: LoginThrottle }
export const loginThrottle = processState[LOGIN_THROTTLE_SYMBOL]
    ?? (processState[LOGIN_THROTTLE_SYMBOL] = new LoginThrottle())

/** Shared attempt accounting survives cold starts and multiple app instances. */
export class DurableLoginThrottle {
    private readonly pool: CoordinationPool
    private readonly namespace: string
    constructor(pool: CoordinationPool, namespace = 'login') {
        this.pool = pool
        this.namespace = namespace
    }

    async consume(ip: string | undefined, username: string): Promise<LoginThrottleDecision> {
        const ipKey = `${this.namespace}:ip:${createHash('sha256').update(normalizeIp(ip)).digest('base64url')}`
        const userKey = `${this.namespace}:account:${accountKey(username)}`
        return coordinationTransaction(this.pool, `autoproductimagery:${this.namespace}:throttle:v1`, async connection => {
            await connection.query('DELETE FROM login_attempt WHERE reset_at <= CURRENT_TIMESTAMP')
            const buckets = await connection.query(
                'SELECT key, attempts, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (reset_at - CURRENT_TIMESTAMP)))) AS retry_after FROM login_attempt WHERE key = ANY($1::text[])',
                [[ipKey, userKey]],
            )
            let retryAfterSeconds = 0
            for (const bucket of buckets.rows) {
                const limit = bucket.key === ipKey ? LOGIN_IP_ATTEMPT_LIMIT : LOGIN_ACCOUNT_ATTEMPT_LIMIT
                if (Number(bucket.attempts) >= limit) retryAfterSeconds = Math.max(retryAfterSeconds, Number(bucket.retry_after))
            }
            if (retryAfterSeconds) return { allowed: false, retryAfterSeconds }
            const count = await connection.query('SELECT COUNT(*) AS count FROM login_attempt')
            if (Number(count.rows[0]?.count) + 2 - buckets.rows.length > MAX_TRACKED_LOGIN_KEYS) {
                // Reject new keys when bounded capacity is exhausted. Evicting
                // live keys would allow a credential attack to reset its limit.
                return { allowed: false, retryAfterSeconds: Math.ceil(LOGIN_THROTTLE_WINDOW_MS / 1000) }
            }
            await connection.query(
                `INSERT INTO login_attempt (key, attempts, reset_at, updated_at)
                 SELECT key, 1, CURRENT_TIMESTAMP + ($2 * INTERVAL '1 millisecond'), CURRENT_TIMESTAMP
                 FROM unnest($1::text[]) AS key
                 ON CONFLICT (key) DO UPDATE SET attempts = login_attempt.attempts + 1, updated_at = CURRENT_TIMESTAMP`,
                [[ipKey, userKey], LOGIN_THROTTLE_WINDOW_MS],
            )
            return { allowed: true, retryAfterSeconds: 0 }
        })
    }

    async clearSuccessfulAccount(username: string) {
        const key = `${this.namespace}:account:${accountKey(username)}`
        await this.pool.query('DELETE FROM login_attempt WHERE key = $1', [key])
    }
}

export async function getDurableLoginThrottle() {
    return new DurableLoginThrottle(await getCoordinationPool())
}
