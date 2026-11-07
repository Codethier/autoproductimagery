import {assertMethod, createError, defineEventHandler, getRouterParam, setHeader} from 'h3'
import {useAuth} from '../../utils/useAuth'
import {backgroundRemovalRequestError, createBackgroundRemovalRepository} from '../../utils/backgroundRemovalJobs'
import {kickBackgroundRemovalQueue} from '../../utils/backgroundRemovalRunner'

export default defineEventHandler(async event => {
    assertMethod(event, 'GET')
    setHeader(event, 'cache-control', 'private, no-store')
    setHeader(event, 'vary', 'Cookie')
    try {
        const actor = await useAuth(event)
        const id = getRouterParam(event, 'id')
        if (!id) throw createError({statusCode: 404, statusMessage: 'Background removal not found'})
        const job = await createBackgroundRemovalRepository().get(actor, id)
        void kickBackgroundRemovalQueue()
        return {job}
    } catch (error) {return backgroundRemovalRequestError(error)}
})
