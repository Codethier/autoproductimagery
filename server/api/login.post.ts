import {createError, setCookie, setHeader} from 'h3'
import {AUTH_COOKIE_NAME} from '../utils/authSession'
import {ACCOUNT_SESSION_TTL_SECONDS} from '../utils/accountSession'
import {createAccountRepository} from '../utils/accountRepository'
import {accountCookieSecure, accountRequestError, consumeCredentialAttempt, readAccountBody} from '../utils/accountRequests'
import {loginThrottle} from '../utils/loginThrottle'

export default defineEventHandler(async event => {
    assertMethod(event, 'POST')
    setHeader(event, 'cache-control', 'no-store')
    const body = await readAccountBody(event) as Record<string, unknown> | undefined
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const throttle = await consumeCredentialAttempt(event, username)
    if (!username || !password || username.length > 1024 || password.length > 1024) throw createError({statusCode: 401, statusMessage: 'Invalid credentials'})
    try {
        const runtime = useRuntimeConfig()
        const accounts = createAccountRepository()
        const context = await accounts.authenticate(username, password, {username: String(runtime.authUser || ''), password: String(runtime.authPassword || '')})
        const token = await accounts.issueSession(context)
        loginThrottle.clearSuccessfulAccount(username)
        await throttle.clearSuccessfulAccount(username).catch(() => undefined)
        setCookie(event, AUTH_COOKIE_NAME, token, {httpOnly: true, secure: accountCookieSecure(event), sameSite: 'lax', path: '/', maxAge: ACCOUNT_SESSION_TTL_SECONDS})
        return true
    } catch (error) { return accountRequestError(error) }
})
