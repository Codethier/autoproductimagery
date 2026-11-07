import type {H3Event} from 'h3'
import {createError, getCookie} from 'h3'
import {AUTH_COOKIE_NAME} from './authSession'
import {createAccountRepository} from './accountRepository'
import type {AuthContext} from './accountSession'

/** Each request resolves its revocable database session and current account. */
export async function useAuth(event: H3Event): Promise<AuthContext> {
    if (event.context.accountAuth) return event.context.accountAuth as AuthContext
    const token = getCookie(event, AUTH_COOKIE_NAME) || ''
    let context: AuthContext | undefined
    try { context = await createAccountRepository().sessionContext(token) }
    catch { throw createError({statusCode: 503, statusMessage: 'Authentication is temporarily unavailable'}) }
    if (!context) throw createError({statusCode: 401, statusMessage: 'Unauthorized'})
    event.context.accountAuth = context
    return context
}
