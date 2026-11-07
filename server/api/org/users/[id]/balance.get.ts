import {createError, getRouterParam, setHeader} from 'h3'
import {z} from 'zod'
import {createAccountBilling} from '../../../../utils/accountBilling'
import {accountRequestError} from '../../../../utils/accountRequests'

export default defineEventHandler(async event => {
    const actor = await useAuth(event)
    if (actor.role !== 'owner') throw createError({statusCode: 403, statusMessage: 'Organization owner access required'})
    const id = z.uuid().safeParse(getRouterParam(event, 'id'))
    if (!id.success) throw createError({statusCode: 400, statusMessage: 'Invalid account'})
    setHeader(event, 'cache-control', 'no-store')
    try { return await createAccountBilling().organizationUserBalance(actor, id.data) }
    catch (error) { return accountRequestError(error) }
})
