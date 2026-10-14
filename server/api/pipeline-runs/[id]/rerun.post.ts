import {defineEventHandler, getRouterParam} from 'h3'
import {useAuth} from '../../../utils/useAuth'
import {createPipelineRepository, pipelineRequestError} from '../../../utils/pipelineRepository'
import {privatePipelineResponse, readPipelineBody} from '../../../utils/pipelineRequests'
export default defineEventHandler(async event => {
    privatePipelineResponse(event)
    try {
        const actor = await useAuth(event), repository = createPipelineRepository(actor)
        return await repository.rerun(getRouterParam(event, 'id') ?? '', await readPipelineBody(event))
    } catch (error) {return pipelineRequestError(error)}
})
