import {createError, getQuery, setHeader} from 'h3'
import {OrganizationUserListSchema} from '../../../../schemas/accounts'
import {createAccountRepository} from '../../../utils/accountRepository'
import {accountRequestError} from '../../../utils/accountRequests'

export default defineEventHandler(async event => {
    const context = await useAuth(event)
    setHeader(event, 'cache-control', 'no-store')
    const query = OrganizationUserListSchema.safeParse(getQuery(event))
    if (!query.success) throw createError({statusCode: 400, statusMessage: 'Invalid user listing options'})
    try { return await createAccountRepository().listUsers(context, query.data.limit, query.data.offset) }
    catch (error) { return accountRequestError(error) }
})
