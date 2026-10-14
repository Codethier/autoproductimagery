import {Agent as HttpAgent, type ClientRequest} from 'node:http'
import {Agent as HttpsAgent} from 'node:https'
import type {Socket} from 'node:net'

export const STORAGE_IDLE_SOCKET_MS = 5_000

/** Reuse sockets during image bursts, then close them so idle TCP keepalives stop. */
export function createStorageHttpAgents(idleMs = STORAGE_IDLE_SOCKET_MS) {
    const timeout = Math.max(10, Math.min(STORAGE_IDLE_SOCKET_MS, idleMs))
    const options = {keepAlive: true, maxSockets: 24, maxFreeSockets: 8}
    function keepAlive(agent: HttpAgent, socket: Socket) {
        // Node returns false for a connection it cannot safely retain; the
        // current Node type definitions still declare this hook as void.
        const retained: unknown = HttpAgent.prototype.keepSocketAlive.call(agent, socket)
        if (retained === false) return false
        // Honor a shorter server keep-alive hint. This timeout is only set
        // while free; it must not become a deadline for the next image stream.
        socket.setTimeout(Math.min(socket.timeout || timeout, timeout))
        return true
    }
    class ImageHttpAgent extends HttpAgent {
        override keepSocketAlive(socket: Socket) {return keepAlive(this, socket)}
        override reuseSocket(socket: Socket, request: ClientRequest) {socket.setTimeout(0); super.reuseSocket(socket, request)}
    }
    class ImageHttpsAgent extends HttpsAgent {
        override keepSocketAlive(socket: Socket) {return keepAlive(this, socket)}
        override reuseSocket(socket: Socket, request: ClientRequest) {socket.setTimeout(0); super.reuseSocket(socket, request)}
    }
    return {httpAgent: new ImageHttpAgent(options), httpsAgent: new ImageHttpsAgent(options)}
}
