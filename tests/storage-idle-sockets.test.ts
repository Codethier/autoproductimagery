import assert from 'node:assert/strict'
import {createServer, request} from 'node:http'
import type {Socket} from 'node:net'
import {setTimeout as delay} from 'node:timers/promises'
import test from 'node:test'
import {createStorageHttpAgents} from '../server/utils/lib/storageHttpAgents.ts'

test('storage agent reuses a burst connection, preserves a long active stream and closes it when idle', {timeout: 5_000}, async () => {
    const sockets = new Set<Socket>()
    let connections = 0
    const server = createServer((req, response) => {
        if (req.url === '/slow') setTimeout(() => response.end('image'), 150)
        else response.end('image')
    })
    server.on('connection', socket => {
        connections++; sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const agents = createStorageHttpAgents(40)
    async function get(path: string) {
        return new Promise<string>((resolve, reject) => {
            const req = request({hostname: '127.0.0.1', port: address.port, path, agent: agents.httpAgent}, response => {
                const parts: Buffer[] = []
                response.on('data', part => parts.push(Buffer.from(part)))
                response.once('end', () => resolve(Buffer.concat(parts).toString()))
                response.once('error', reject)
            })
            req.once('error', reject); req.end()
        })
    }
    try {
        assert.equal(await get('/fast'), 'image')
        assert.equal(await get('/slow'), 'image', 'an active transfer can outlive the free-socket deadline')
        assert.equal(connections, 1, 'image bursts retain connection reuse')
        for (let attempt = 0; attempt < 20 && sockets.size; attempt++) await delay(20)
        assert.equal(sockets.size, 0, 'idle agent has no socket capable of emitting keepalives')
        assert.equal(await get('/new-burst'), 'image')
        assert.equal(connections, 2)
    } finally {
        agents.httpAgent.destroy(); agents.httpsAgent.destroy()
        for (const socket of sockets) socket.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
})
