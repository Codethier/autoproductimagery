import {createError, defineEventHandler, getRouterParam, setResponseStatus} from 'h3'
import {useAuth} from '../../../utils/useAuth'
import {createPipelineRepository, pipelineRequestError} from '../../../utils/pipelineRepository'
import {privatePipelineResponse, readPipelineBody, assertPipelineMutationOrigin} from '../../../utils/pipelineRequests'
export default defineEventHandler(async event => {
    privatePipelineResponse(event)
    try {
        const actor = await useAuth(event), repository = createPipelineRepository(actor)
        const body = await readPipelineBody(event); if (!body || typeof body !== 'object' || Object.keys(body).length) throw createError({statusCode:400,statusMessage:'Invalid cancellation request'}); return await repository.cancel(getRouterParam(event, 'id') ?? '')
    } catch (error) {return pipelineRequestError(error)}
})
