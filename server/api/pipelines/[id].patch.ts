import {createError, defineEventHandler, getRouterParam, setResponseStatus} from 'h3'
import {useAuth} from '../../utils/useAuth'
import {createPipelineRepository, pipelineRequestError} from '../../utils/pipelineRepository'
import {privatePipelineResponse, readPipelineBody, assertPipelineMutationOrigin} from '../../utils/pipelineRequests'
export default defineEventHandler(async event => {
    privatePipelineResponse(event)
    try {
        const actor = await useAuth(event), repository = createPipelineRepository(actor)
        return await repository.update(getRouterParam(event, 'id') ?? '', await readPipelineBody(event))
    } catch (error) {return pipelineRequestError(error)}
})
