import {deleteCookie, getCookie, setHeader} from 'h3'
import {AUTH_COOKIE_NAME} from '../utils/authSession'
import {accountCookieSecure, accountRequestError} from '../utils/accountRequests'
import {createAccountRepository} from '../utils/accountRepository'

export default defineEventHandler(async event => {
    assertMethod(event, 'POST')
    setHeader(event, 'cache-control', 'no-store')
    const token = getCookie(event, AUTH_COOKIE_NAME) || ''
    try { await createAccountRepository().revokeSession(token) }
    catch (error) { return accountRequestError(error) }
    deleteCookie(event, AUTH_COOKIE_NAME, {httpOnly: true, secure: accountCookieSecure(event), sameSite: 'lax', path: '/'})
    return true
})
