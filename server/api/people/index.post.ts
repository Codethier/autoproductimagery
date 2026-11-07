import {defineEventHandler, setResponseStatus} from 'h3'
import {useAuth} from '../../utils/useAuth'
import {createPeopleRepository, peopleRequestError} from '../../utils/peopleRepository'
import {privatePeopleResponse, readPeopleBody} from '../../utils/peopleRequests'

export default defineEventHandler(async event => {
    privatePeopleResponse(event)
    try {
        const actor = await useAuth(event)
        const result = await createPeopleRepository(actor).create(await readPeopleBody(event))
        setResponseStatus(event, 201)
        return result
    } catch (error) {return peopleRequestError(error)}
})
