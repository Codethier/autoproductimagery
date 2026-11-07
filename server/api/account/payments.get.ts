import {getQuery} from 'h3'
import {createAccountPayments, privatePaymentResponse} from '../../utils/accountPayments'
import {accountRequestError} from '../../utils/accountRequests'

export default defineEventHandler(async event => {
    privatePaymentResponse(event)
    const actor = await useAuth(event)
    try {return await createAccountPayments().listOwnPayments(actor, getQuery(event))}
    catch (error) {return accountRequestError(error)}
})
