import {defineEventHandler, getRouterParam} from 'h3'
import {useAuth} from '../../../utils/useAuth'
import {createPeopleRepository, peopleRequestError} from '../../../utils/peopleRepository'
import {privatePeopleResponse} from '../../../utils/peopleRequests'

export default defineEventHandler(async event => {
    privatePeopleResponse(event)
    try {const actor = await useAuth(event); return {shares: await createPeopleRepository(actor).sharesFor(getRouterParam(event, 'id') ?? '')}}
    catch (error) {return peopleRequestError(error)}
})
