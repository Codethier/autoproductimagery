import {createError, deleteCookie, setHeader} from 'h3'
import {ChangeAccountPasswordSchema} from '../../../schemas/accounts'
import {AUTH_COOKIE_NAME} from '../../utils/authSession'
import {createAccountRepository} from '../../utils/accountRepository'
import {accountCookieSecure, accountRequestError, consumeCredentialAttempt, readAccountBody} from '../../utils/accountRequests'

export default defineEventHandler(async event => {
    const context = await useAuth(event)
    setHeader(event, 'cache-control', 'no-store')
    const body = ChangeAccountPasswordSchema.safeParse(await readAccountBody(event))
    if (!body.success) throw createError({statusCode: 400, statusMessage: 'Use your current password and a new password of at least 10 characters'})
    await consumeCredentialAttempt(event, context.username)
    try { await createAccountRepository().changePassword(context, body.data.currentPassword, body.data.newPassword) }
    catch (error) { return accountRequestError(error) }
    deleteCookie(event, AUTH_COOKIE_NAME, {httpOnly: true, secure: accountCookieSecure(event), sameSite: 'lax', path: '/'})
    return true
})
