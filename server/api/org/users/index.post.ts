import {createError, setHeader} from 'h3'
import {CreateOrganizationUserSchema} from '../../../../schemas/accounts'
import {createAccountRepository} from '../../../utils/accountRepository'
import {accountRequestError, readAccountBody} from '../../../utils/accountRequests'

export default defineEventHandler(async event => {
    const context = await useAuth(event)
    if (context.role !== 'owner') throw createError({statusCode: 403, statusMessage: 'Organization owner access required'})
    setHeader(event, 'cache-control', 'no-store')
    const body = CreateOrganizationUserSchema.safeParse(await readAccountBody(event))
    if (!body.success) throw createError({statusCode: 400, statusMessage: 'Use a valid username, display name, role, and password of at least 10 characters'})
    try { return await createAccountRepository().addUser(context, body.data) }
    catch (error) { return accountRequestError(error) }
})
