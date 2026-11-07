import {createError, getQuery, getRouterParam} from 'h3'
import {z} from 'zod'
import {createAccountPayments, privatePaymentResponse} from '../../../../utils/accountPayments'
import {accountRequestError} from '../../../../utils/accountRequests'

export default defineEventHandler(async event => {
    privatePaymentResponse(event)
    const actor = await useAuth(event)
    const id = z.uuid().safeParse(getRouterParam(event, 'id'))
    if (!id.success) throw createError({statusCode: 400, statusMessage: 'Invalid account'})
    try {return await createAccountPayments().listOrganizationUserPayments(actor, id.data, getQuery(event))}
    catch (error) {return accountRequestError(error)}
})
