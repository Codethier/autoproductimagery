import { createError, getHeader, getRequestIP, getRequestProtocol, readBody, setCookie, setHeader } from "h3"
import {
    AUTH_COOKIE_NAME,
    AUTH_SESSION_TTL_SECONDS,
    createAuthSessionToken,
    credentialsMatch,
    getAuthSessionSecret,
} from "../utils/authSession"
import { installBoundedRawBody } from "../utils/boundedRequestBody"
import { getDurableLoginThrottle, loginThrottle } from "../utils/loginThrottle"

const MAX_CREDENTIAL_LENGTH = 1024
const MAX_LOGIN_BODY_BYTES = 4 * 1024

export default defineEventHandler(async (event) => {
    assertMethod(event, "POST")
    await installBoundedRawBody(event, MAX_LOGIN_BODY_BYTES)
    const body = await readBody<Record<string, unknown>>(event)
    const username = typeof body?.username === "string" ? body.username : ""
    const password = typeof body?.password === "string" ? body.password : ""
    const ip = getRequestIP(event, { xForwardedFor: true })
    let decision = loginThrottle.consume(ip, username)
    if (!decision.allowed) {
        setHeader(event, "retry-after", decision.retryAfterSeconds)
        throw createError({ statusCode: 429, statusMessage: "Too many login attempts; retry later" })
    }
    let durableThrottle: Awaited<ReturnType<typeof getDurableLoginThrottle>>
    try {
        durableThrottle = await getDurableLoginThrottle()
        decision = await durableThrottle.consume(ip, username)
    } catch {
        throw createError({ statusCode: 503, statusMessage: 'Login is temporarily unavailable' })
    }
    if (!decision.allowed) {
        setHeader(event, 'retry-after', decision.retryAfterSeconds)
        throw createError({ statusCode: 429, statusMessage: 'Too many login attempts; retry later' })
    }
    if (!username || !password
        || username.length > MAX_CREDENTIAL_LENGTH
        || password.length > MAX_CREDENTIAL_LENGTH) {
        throw createError({ statusCode: 401, statusMessage: "Invalid credentials" })
    }

    const runtimeConfig = useRuntimeConfig()
    const { authUser, authPassword } = runtimeConfig
    const expectedUser = String(authUser || "")
    const expectedPassword = String(authPassword || "")
    if (!expectedUser || !expectedPassword) {
        throw createError({ statusCode: 500, statusMessage: "Server auth not configured" })
    }
    if (!credentialsMatch(username, password, expectedUser, expectedPassword)) {
        throw createError({ statusCode: 401, statusMessage: "Invalid credentials" })
    }
    loginThrottle.clearSuccessfulAccount(username)
    await durableThrottle.clearSuccessfulAccount(username).catch(() => undefined)
    let sessionSecret: string
    try {
        sessionSecret = getAuthSessionSecret(runtimeConfig as unknown as Record<string, unknown>)
    } catch {
        throw createError({ statusCode: 500, statusMessage: 'Server auth not configured' })
    }

    const forwardedProtocol = getHeader(event, "x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase()
    const secure = process.env.NODE_ENV === "production"
        || forwardedProtocol === "https"
        || getRequestProtocol(event) === "https"
    setCookie(event, AUTH_COOKIE_NAME, createAuthSessionToken(expectedUser, expectedPassword, Date.now(), sessionSecret), {
        httpOnly: true,
        secure,
        sameSite: "lax",
        path: "/",
        maxAge: AUTH_SESSION_TTL_SECONDS,
    })

    return true
})
