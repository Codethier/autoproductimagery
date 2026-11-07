import {createError, getRouterParam, setHeader} from 'h3'
import {z} from 'zod'
import {UpdateOrganizationUserSchema} from '../../../../schemas/accounts'
import {createAccountRepository} from '../../../utils/accountRepository'
import {accountRequestError, readAccountBody} from '../../../utils/accountRequests'

export default defineEventHandler(async event => {
    const context = await useAuth(event)
    if (context.role !== 'owner') throw createError({statusCode: 403, statusMessage: 'Organization owner access required'})
    setHeader(event, 'cache-control', 'no-store')
    const id = z.uuid().safeParse(getRouterParam(event, 'id'))
    const body = UpdateOrganizationUserSchema.safeParse(await readAccountBody(event))
    if (!id.success || !body.success) throw createError({statusCode: 400, statusMessage: 'Invalid account changes'})
    try { return await createAccountRepository().updateUser(context, id.data, body.data) }
    catch (error) { return accountRequestError(error) }
})
