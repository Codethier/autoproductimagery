import {defineEventHandler} from 'h3'
import {useAuth} from '../../utils/useAuth'
import {createPeopleRepository, peopleRequestError} from '../../utils/peopleRepository'
import {privatePeopleResponse} from '../../utils/peopleRequests'

export default defineEventHandler(async event => {
    privatePeopleResponse(event)
    try {const actor = await useAuth(event); return {users: await createPeopleRepository(actor).shareTargets()}}
    catch (error) {return peopleRequestError(error)}
})
