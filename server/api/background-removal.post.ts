import {assertMethod, createError, defineEventHandler, getHeader, getRequestURL, readBody, setHeader, setResponseStatus} from 'h3'
import {CreateBackgroundRemovalSchema} from '../../schemas/background-removal'
import {getBackgroundRemovalModel} from '../../schemas/background-removal-models'
import {installBoundedRawBody} from '../utils/boundedRequestBody'
import {assertRequestOrigin} from '../utils/requestOrigin'
import {useAuth} from '../utils/useAuth'
import {useUserFS} from '../utils/useUserFS'
import {backgroundRemovalRequestError, createBackgroundRemovalRepository} from '../utils/backgroundRemovalJobs'
import {kickBackgroundRemovalQueue} from '../utils/backgroundRemovalRunner'

export default defineEventHandler(async event => {
    assertMethod(event, 'POST')
    setHeader(event, 'cache-control', 'private, no-store')
    setHeader(event, 'vary', 'Cookie')
    try {
        const actor = await useAuth(event)
        assertRequestOrigin(getHeader(event, 'origin'), getRequestURL(event, {xForwardedHost: false, xForwardedProto: true}).origin, getHeader(event, 'sec-fetch-site'))
        if (getHeader(event, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
            throw createError({statusCode: 415, statusMessage: 'JSON request required'})
        }
        await installBoundedRawBody(event, 8 * 1024)
        let body: unknown
        try {body = await readBody(event)} catch {throw createError({statusCode: 400, statusMessage: 'Invalid background removal request'})}
        const parsed = CreateBackgroundRemovalSchema.safeParse(body)
        if (!parsed.success) throw createError({statusCode: 400, statusMessage: 'Invalid background removal request'})
        const storage = await useUserFS(actor)
        const source = await storage.assetByUrl(parsed.data.sourceUrl)
        if (source.kind !== 'file' || !source.id) throw createError({statusCode: 404, statusMessage: 'Image not found'})
        const profile = getBackgroundRemovalModel(parsed.data.model)
        const job = await createBackgroundRemovalRepository().enqueue(actor, {...parsed.data, sourceAssetId: source.id, modelVersion: profile.version})
        void kickBackgroundRemovalQueue()
        setResponseStatus(event, 202)
        return {job}
    } catch (error) {return backgroundRemovalRequestError(error)}
})
