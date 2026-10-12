import {createError} from 'h3'
import {getDatabasePool} from '../utils/lib/db'

// Readiness probes work without a session and never disclose configuration.
export default defineEventHandler(async () => {
    try {
        await getDatabasePool().query('SELECT 1')
        return {ok: true}
    } catch {
        throw createError({statusCode: 503, statusMessage: 'Service is not ready'})
    }
})
