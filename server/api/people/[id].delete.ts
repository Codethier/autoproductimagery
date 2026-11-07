import {defineEventHandler, getRouterParam} from 'h3'
import {useAuth} from '../../utils/useAuth'
import {createPeopleRepository, peopleRequestError} from '../../utils/peopleRepository'
import {assertPeopleMutationOrigin, privatePeopleResponse} from '../../utils/peopleRequests'

export default defineEventHandler(async event => {
    privatePeopleResponse(event)
    try {const actor = await useAuth(event); assertPeopleMutationOrigin(event); return await createPeopleRepository(actor).remove(getRouterParam(event, 'id') ?? '')}
    catch (error) {return peopleRequestError(error)}
})
