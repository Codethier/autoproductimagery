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
        const parsed = PipelineListQuerySchema.safeParse(getQuery(event)); if(!parsed.success) throw createError({statusCode:400,statusMessage:'Invalid pipeline run listing request'}); return await repository.listRuns(parsed.data)
    } catch (error) {return pipelineRequestError(error)}
})
