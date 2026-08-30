import { createHash } from "node:crypto"

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
