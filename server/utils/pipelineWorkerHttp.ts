import type {IncomingMessage, ServerResponse} from 'node:http'
import {isPipelineWorkerWakeAuthorized} from './pipelineWorkerWake'

export function createPipelineWorkerHttpHandler(deps: {
    ready(): boolean
    token: string | undefined
    wake(): void
}) {
    return (request: IncomingMessage, response: ServerResponse) => {
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        const reply = (status: number, value: Record<string, unknown>) => {
            response.writeHead(status); response.end(JSON.stringify(value))
        }
        if (request.method === 'GET' && request.url === '/health') {
            const ok = deps.ready()
            reply(ok ? 200 : 503, {ok, worker: 'pipelines'})
        } else if (request.method === 'POST' && request.url === '/wake') {
            if (!isPipelineWorkerWakeAuthorized(request.headers.authorization, deps.token)) {
                request.resume(); reply(401, {error: 'Unauthorized'}); return
            }
            // Wakes have no run payload or arbitrary execution parameters.
            // Authorized work was already validated and committed by the app.
            if (request.headers['transfer-encoding'] || !['0', undefined].includes(request.headers['content-length'])) {
                request.resume(); reply(400, {error: 'Invalid wake request'}); return
            }
            if (!deps.ready()) {
                response.setHeader('Retry-After', '1')
                reply(503, {ok: false, worker: 'pipelines'}); return
            }
            deps.wake()
            reply(202, {ok: true, worker: 'pipelines'})
        } else {
            request.resume(); reply(404, {error: 'Not found'})
        }
    }
}
