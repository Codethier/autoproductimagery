import {createError, getHeader, getRequestURL, readBody, setHeader, type H3Event} from 'h3'
import {assertRequestOrigin} from './requestOrigin'
import {installBoundedRawBody} from './boundedRequestBody'
export function privatePipelineResponse(event: H3Event) {
    setHeader(event, 'cache-control', 'private, no-store')
    setHeader(event, 'vary', 'Cookie')
}
export function assertPipelineMutationOrigin(event: H3Event) {
    assertRequestOrigin(getHeader(event, 'origin'), getRequestURL(event, {xForwardedHost: false, xForwardedProto: true}).origin, getHeader(event, 'sec-fetch-site'))
}
export async function readPipelineBody(event: H3Event) {
    assertPipelineMutationOrigin(event)
    if (getHeader(event, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw createError({statusCode: 415, statusMessage: 'JSON request required'})
    await installBoundedRawBody(event, 512 * 1024)
    try {return await readBody(event)} catch {throw createError({statusCode: 400, statusMessage: 'Invalid pipeline request'})}
}
