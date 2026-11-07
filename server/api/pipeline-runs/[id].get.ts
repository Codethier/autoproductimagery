import {createError, defineEventHandler, getRouterParam, getQuery} from 'h3'
import {PipelineListQuerySchema} from '../../../schemas/pipelines'
import {useAuth} from '../../utils/useAuth'
import {createPipelineRepository, pipelineRequestError} from '../../utils/pipelineRepository'
import {createPipelineExecutor} from '../../utils/pipelineRunner'
import {privatePipelineResponse} from '../../utils/pipelineRequests'
export default defineEventHandler(async event => {
    privatePipelineResponse(event)
    try {
        const actor = await useAuth(event), repository = createPipelineRepository(actor)
        return await createPipelineExecutor(actor, repository).get(getRouterParam(event, 'id') ?? '')
    } catch (error) {return pipelineRequestError(error)}
})
