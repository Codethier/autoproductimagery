import {defineEventHandler, getRouterParam} from 'h3'
import {useAuth} from '../../../utils/useAuth'
import {createPeopleRepository, peopleRequestError} from '../../../utils/peopleRepository'
import {privatePeopleResponse, readPeopleBody} from '../../../utils/peopleRequests'

export default defineEventHandler(async event => {
    privatePeopleResponse(event)
    try {const actor = await useAuth(event); return await createPeopleRepository(actor).share(getRouterParam(event, 'id') ?? '', await readPeopleBody(event))}
    catch (error) {return peopleRequestError(error)}
})
