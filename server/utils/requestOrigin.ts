import {createError} from 'h3'

/** Reject browser cross-origin mutations while retaining non-browser API clients. */
export function assertRequestOrigin(origin: string | undefined, requestOrigin: string, fetchSite?: string): void {
    if (fetchSite === 'cross-site' || origin === 'null') {
        throw createError({statusCode: 403, statusMessage: 'Cross-origin requests are not allowed'})
    }
    if (origin === undefined) return
    try {
        if (new URL(origin).origin === origin && origin === requestOrigin) return
    } catch { /* Malformed origins fail closed. */ }
    throw createError({statusCode: 403, statusMessage: 'Cross-origin requests are not allowed'})
}
