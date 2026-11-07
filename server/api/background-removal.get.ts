import {assertMethod, createError, defineEventHandler, getQuery, setHeader} from 'h3'
import {BackgroundRemovalListQuerySchema} from '../../schemas/background-removal'
import {useAuth} from '../utils/useAuth'
import {backgroundRemovalRequestError, createBackgroundRemovalRepository} from '../utils/backgroundRemovalJobs'
import {kickBackgroundRemovalQueue} from '../utils/backgroundRemovalRunner'

export default defineEventHandler(async event => {
    assertMethod(event, 'GET')
    setHeader(event, 'cache-control', 'private, no-store')
    setHeader(event, 'vary', 'Cookie')
    try {
        const actor = await useAuth(event)
        const parsed = BackgroundRemovalListQuerySchema.safeParse(getQuery(event))
        if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid background removal listing request'})
        const jobs = await createBackgroundRemovalRepository().list(actor, parsed.data)
        void kickBackgroundRemovalQueue()
        return {jobs}
    } catch (error) {return backgroundRemovalRequestError(error)}
})
