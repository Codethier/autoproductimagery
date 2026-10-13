import {setHeader} from 'h3'
import {createAccountBilling} from '../../utils/accountBilling'
import {accountRequestError} from '../../utils/accountRequests'
import {refreshPendingAccountBilling} from '../../utils/reconcilePendingAccountBilling'

export default defineEventHandler(async event => {
    const actor = await useAuth(event)
    setHeader(event, 'cache-control', 'no-store')
    try { await refreshPendingAccountBilling(actor); return await createAccountBilling().balanceFor(actor) }
    catch (error) { return accountRequestError(error) }
})
