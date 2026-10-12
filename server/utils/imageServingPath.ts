import {createError} from 'h3'

// Router parameters may already be decoded. Keep the original URL encoding so
// storage validates each segment exactly once, including %23 and UTF-8 names.
export function imagePathFromRequestUrl(requestUrl: string): string {
    const pathname = requestUrl.split('?', 1)[0] ?? ''
    const routePrefix = '/api/data/'
    if (!pathname.startsWith(routePrefix) || pathname.length === routePrefix.length) {
        throw createError({statusCode: 400, statusMessage: 'Missing image path'})
    }
    return pathname.slice('/api/data'.length)
}
