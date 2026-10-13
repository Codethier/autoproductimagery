import {createError, getRouterParam, setHeader} from 'h3'
import {z} from 'zod'
import {SetAccountBalanceSchema} from '../../../../../schemas/account-billing'
import {createAccountBilling} from '../../../../utils/accountBilling'
import {accountRequestError, readAccountBody} from '../../../../utils/accountRequests'

export default defineEventHandler(async event => {
    const actor = await useAuth(event)
    if (actor.role !== 'owner') throw createError({statusCode: 403, statusMessage: 'Organization owner access required'})
    const id = z.uuid().safeParse(getRouterParam(event, 'id'))
    const body = SetAccountBalanceSchema.safeParse(await readAccountBody(event))
    if (!id.success || !body.success) throw createError({statusCode: 400, statusMessage: 'Use a nonnegative USD balance or Unlimited'})
    setHeader(event, 'cache-control', 'no-store')
    try { return await createAccountBilling().setOrganizationUserBalance(actor, id.data, body.data.actualBalanceUsd) }
    catch (error) { return accountRequestError(error) }
})
