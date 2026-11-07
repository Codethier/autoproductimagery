import {createError, getHeader, getRequestIP, getRequestProtocol, getRequestURL, readBody, setHeader, type H3Event} from 'h3'
import {installBoundedRawBody} from './boundedRequestBody'
import {getDurableLoginThrottle, loginThrottle} from './loginThrottle'
import {PasswordCapacityError} from './passwords'

export function accountCookieSecure(event: H3Event): boolean {
    return process.env.NODE_ENV === 'production'
        || getHeader(event, 'x-forwarded-proto')?.split(',', 1)[0]?.trim().toLowerCase() === 'https'
        || getRequestProtocol(event) === 'https'
}
export async function readAccountBody(event: H3Event): Promise<unknown> {
    const origin = getHeader(event, 'origin')
    if (origin) {
        let host: string
        try { host = new URL(origin).host } catch { throw createError({statusCode: 403, statusMessage: 'Request origin is not allowed'}) }
        if (host !== getRequestURL(event).host) throw createError({statusCode: 403, statusMessage: 'Request origin is not allowed'})
    }
    if (getHeader(event, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw createError({statusCode: 415, statusMessage: 'JSON request required'})
    await installBoundedRawBody(event, 4 * 1024)
    try { return await readBody(event) }
    catch { throw createError({statusCode: 400, statusMessage: 'Invalid JSON request'}) }
}
export async function consumeCredentialAttempt(event: H3Event, username: string) {
    const ip = getRequestIP(event, {xForwardedFor: true})
    let decision = loginThrottle.consume(ip, username)
    if (!decision.allowed) {
        setHeader(event, 'retry-after', decision.retryAfterSeconds)
        throw createError({statusCode: 429, statusMessage: 'Too many login attempts; retry later'})
    }
    let throttle: Awaited<ReturnType<typeof getDurableLoginThrottle>>
    try { throttle = await getDurableLoginThrottle(); decision = await throttle.consume(ip, username) }
    catch { throw createError({statusCode: 503, statusMessage: 'Login is temporarily unavailable'}) }
    if (!decision.allowed) {
        setHeader(event, 'retry-after', decision.retryAfterSeconds)
        throw createError({statusCode: 429, statusMessage: 'Too many login attempts; retry later'})
    }
    return throttle
}
export function accountRequestError(error: unknown): never {
    if (error instanceof PasswordCapacityError) throw createError({statusCode: 429, statusMessage: error.message})
    const code = (error as {statusCode?: number})?.statusCode
    if (code && [400, 401, 403, 404, 409, 415, 429, 503].includes(code)) throw error
    throw createError({statusCode: 503, statusMessage: 'Account service is temporarily unavailable'})
}
