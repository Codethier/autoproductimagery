import {
    createHash,
    createHmac,
    randomBytes,
    timingSafeEqual,
} from "node:crypto"

export const AUTH_COOKIE_NAME = "auth"
export const AUTH_SESSION_TTL_SECONDS = 12 * 60 * 60

const SESSION_VERSION = 1
const SIGNING_CONTEXT = "autoproductimagery/auth-session/v1"

type SessionPayload = {
    v: number
    iat: number
    exp: number
    nonce: string
}

function digest(value: string): Buffer {
    return createHash("sha256").update(value, "utf8").digest()
}

/** Compares secrets without an early return or length-dependent buffer comparison. */
export function timingSafeStringEqual(actual: string, expected: string): boolean {
    return timingSafeEqual(digest(actual), digest(expected))
}

export function credentialsMatch(
    actualUser: string,
    actualPassword: string,
    expectedUser: string,
    expectedPassword: string,
): boolean {
    // Always perform both comparisons so an invalid username does not skip password work.
    const userMatches = timingSafeStringEqual(actualUser, expectedUser)
    const passwordMatches = timingSafeStringEqual(actualPassword, expectedPassword)
    return userMatches && passwordMatches
}

function signingKey(authUser: string, authPassword: string): Buffer {
    return createHash("sha256")
        .update(SIGNING_CONTEXT, "utf8")
        .update("\0", "utf8")
        .update(authUser, "utf8")
        .update("\0", "utf8")
        .update(authPassword, "utf8")
        .digest()
}

function sign(encodedPayload: string, authUser: string, authPassword: string): Buffer {
    return createHmac("sha256", signingKey(authUser, authPassword))
        .update(encodedPayload, "ascii")
        .digest()
}

export function createAuthSessionToken(
    authUser: string,
    authPassword: string,
    nowMs = Date.now(),
): string {
    const issuedAt = Math.floor(nowMs / 1000)
    const payload: SessionPayload = {
        v: SESSION_VERSION,
        iat: issuedAt,
        exp: issuedAt + AUTH_SESSION_TTL_SECONDS,
        nonce: randomBytes(18).toString("base64url"),
    }
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
    const signature = sign(encodedPayload, authUser, authPassword).toString("base64url")
    return `${encodedPayload}.${signature}`
}

export function verifyAuthSessionToken(
    token: string,
    authUser: string,
    authPassword: string,
    nowMs = Date.now(),
): boolean {
    const separator = token.indexOf(".")
    if (separator <= 0 || token.indexOf(".", separator + 1) !== -1) return false

    const encodedPayload = token.slice(0, separator)
    const encodedSignature = token.slice(separator + 1)
    let suppliedSignature: Buffer
    try {
        suppliedSignature = Buffer.from(encodedSignature, "base64url")
    } catch {
        return false
    }

    const expectedSignature = sign(encodedPayload, authUser, authPassword)
    if (suppliedSignature.length !== expectedSignature.length
        || !timingSafeEqual(suppliedSignature, expectedSignature)) {
        return false
    }

    let payload: unknown
    try {
        payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"))
    } catch {
        return false
    }
    if (!payload || typeof payload !== "object") return false

    const candidate = payload as Partial<SessionPayload>
    const now = Math.floor(nowMs / 1000)
    return candidate.v === SESSION_VERSION
        && Number.isInteger(candidate.iat)
        && Number.isInteger(candidate.exp)
        && typeof candidate.nonce === "string"
        && candidate.nonce.length >= 16
        && (candidate.iat as number) <= now + 60
        && (candidate.exp as number) > now
        && (candidate.exp as number) - (candidate.iat as number) === AUTH_SESSION_TTL_SECONDS
}
