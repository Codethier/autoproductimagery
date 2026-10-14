import {createError, getRouterParam} from 'h3'
import {z} from 'zod'
import {createAccountPayments, privatePaymentResponse, readPaymentBody} from '../../../../utils/accountPayments'
import {accountRequestError} from '../../../../utils/accountRequests'

export default defineEventHandler(async event => {
    privatePaymentResponse(event)
    const actor = await useAuth(event)
    if (actor.role !== 'owner') throw createError({statusCode: 403, statusMessage: 'Organization owner access required'})
    const id = z.uuid().safeParse(getRouterParam(event, 'id'))
    if (!id.success) throw createError({statusCode: 400, statusMessage: 'Invalid account'})
    const body = await readPaymentBody(event)
    try {return await createAccountPayments().recordOrganizationUserPayment(actor, id.data, body)}
    catch (error) {return accountRequestError(error)}
})
