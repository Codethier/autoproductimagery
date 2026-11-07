import {defineEventHandler, getQuery, getRouterParam} from 'h3'
import {useAuth} from '../../utils/useAuth'
import {createPeopleRepository, peopleRequestError} from '../../utils/peopleRepository'
import {privatePeopleResponse} from '../../utils/peopleRequests'
import {refreshPendingAccountBilling} from '../../utils/reconcilePendingAccountBilling'

export default defineEventHandler(async event => {
    privatePeopleResponse(event)
    try {
        const actor = await useAuth(event), repository = createPeopleRepository(actor)
        const id = getRouterParam(event, 'id') ?? ''
        const person = await repository.requirePerson(id)
        if (person.userId === actor.userId) await refreshPendingAccountBilling(actor)
        return await repository.get(id, getQuery(event))
    } catch (error) {return peopleRequestError(error)}
})
