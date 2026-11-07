import {defineEventHandler, getHeader, getMethod, getRequestURL} from 'h3'
import {assertRequestOrigin} from '../utils/requestOrigin'

export default defineEventHandler(event => {
    if (!event.path.startsWith('/api/') || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(getMethod(event))) return
    // Use the request Host, rather than a caller-controlled forwarded host.
    const expected = getRequestURL(event, {xForwardedHost: false, xForwardedProto: true}).origin
    assertRequestOrigin(getHeader(event, 'origin'), expected, getHeader(event, 'sec-fetch-site'))
})
