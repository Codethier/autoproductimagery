import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createServer, connect as connectTcp, type Socket} from 'node:net'
import test from 'node:test'
import {Pool} from 'pg'
import {acquireDatabaseConnection, DatabaseUnavailableError, isTransientDatabaseConnectionError} from '../server/utils/lib/databaseConnection.ts'
import {getDatabasePoolConfig, ServerlessPostgresPool} from '../server/utils/lib/db.ts'

const transient = () => Object.assign(new Error('private driver diagnostic'), {code: 'ECONNREFUSED'})

test('connection acquisition tolerates initial cold failures with bounded backoff before yielding a client', async () => {
    let now = 0, attempts = 0
    const sleeps: number[] = [], client = {id: 'ready'}
    const result = await acquireDatabaseConnection(async () => {
        attempts++; now += 10_000
        if (attempts < 3) throw transient()
        return client
    }, {now: () => now, sleep: async ms => {sleeps.push(ms); now += ms}})
    assert.equal(result, client)
    assert.equal(attempts, 3)
    assert.deepEqual(sleeps, [500, 1000])
})

test('persistent cold acquisition fails within its total deadline with redacted retryable 503', async () => {
    let now = 0, attempts = 0
    await assert.rejects(acquireDatabaseConnection(async () => {
        attempts++; now += 10_000
        throw new Error('Connection terminated due to connection timeout', {cause: transient()})
    }, {now: () => now, sleep: async ms => {now += ms}}), error => {
        assert.ok(error instanceof DatabaseUnavailableError)
        assert.equal(error.statusCode, 503)
        assert.equal(error.code, 'DATABASE_WAKING')
        assert.doesNotMatch(JSON.stringify(error) + error.message, /private driver|ECONNREFUSED|cause|postgres:\/\//)
        return true
    })
    assert.equal(attempts, 5)
    assert.ok(now <= 60_000)
})

test('fast connection refusals retain enough wake time instead of exhausting a short retry count', async () => {
    let now = 0, attempts = 0
    await assert.rejects(acquireDatabaseConnection(async () => {attempts++; throw transient()}, {
        now: () => now, sleep: async ms => {now += ms},
    }), DatabaseUnavailableError)
    assert.ok(attempts > 20)
    assert.ok(now >= 45_000 && now <= 60_000)
})

test('credentials, TLS validation and SQL errors are never classified as cold acquisition failures', async () => {
    for (const code of ['28P01', '28000', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', '23505', '40001', '57014']) {
        let attempts = 0
        const error = Object.assign(new Error('fatal'), {code})
        assert.equal(isTransientDatabaseConnectionError(error), false)
        await assert.rejects(acquireDatabaseConnection(async () => {attempts++; throw error}), candidate => candidate === error)
        assert.equal(attempts, 1)
    }
    assert.equal(isTransientDatabaseConnectionError(new Error('wrapper', {cause: transient()})), true)
    assert.equal(isTransientDatabaseConnectionError(new Error('timeout exceeded when trying to connect')), true)
})

test('shutdown stops acquisition retries before acquiring another client', async () => {
    let stopped = false, attempts = 0
    await assert.rejects(acquireDatabaseConnection(async () => {attempts++; throw transient()}, {
        stopped: () => stopped, sleep: async () => {stopped = true},
    }), DatabaseUnavailableError)
    assert.equal(attempts, 1)
    attempts = 0
    await assert.rejects(acquireDatabaseConnection(async () => {attempts++; return {}}, {stopped: () => true}), DatabaseUnavailableError)
    assert.equal(attempts, 0)
})

test('both callback pool.query and promise transactions recover pre-SQL disconnects and never replay dispatched SQL', {
    skip: !process.env.TEST_DATABASE_URL, timeout: 30_000,
}, async () => {
    const original = new URL(process.env.TEST_DATABASE_URL!)
    assert.equal(original.hostname, '127.0.0.1', 'this fault injection is restricted to the disposable loopback test database')
    const administrator = new Pool({connectionString: original.toString(), max: 1})
    const schema = `cold_start_${randomUUID().replaceAll('-', '')}`
    const sockets = new Set<Socket>()
    let connections = 0
    const proxy = createServer(socket => {
        sockets.add(socket); socket.once('close', () => sockets.delete(socket))
        connections++
        if (connections <= 2) {socket.destroy(); return}
        const upstream = connectTcp({host: original.hostname, port: Number(original.port || 5432)})
        sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream))
        upstream.once('error', () => socket.destroy())
        socket.once('error', () => upstream.destroy())
        socket.pipe(upstream); upstream.pipe(socket)
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const address = proxy.address(); assert.ok(address && typeof address !== 'string')
    const proxied = new URL(original); proxied.port = String(address.port)
    const pool = new ServerlessPostgresPool({...getDatabasePoolConfig({DATABASE_URL: proxied.toString()}), max: 1, options: `-c search_path=${schema}`})
    pool.on('error', () => undefined)
    try {
        await administrator.query(`CREATE SCHEMA "${schema}"`)
        await administrator.query(`CREATE TABLE "${schema}".attempts (id integer PRIMARY KEY)`)
        await pool.query('INSERT INTO attempts VALUES (1)')
        assert.equal(connections, 3, 'only connection establishment was repeated')
        await assert.rejects(pool.query('INSERT INTO attempts VALUES (1)'), error => (error as {code?: string}).code === '23505')
        assert.equal((await administrator.query(`SELECT count(*) FROM "${schema}".attempts`)).rows[0].count, '1')
        const client = await pool.connect()
        try {await client.query('BEGIN'); await client.query('INSERT INTO attempts VALUES (2)'); await client.query('COMMIT')}
        finally {client.release()}
        assert.equal((await administrator.query(`SELECT count(*) FROM "${schema}".attempts`)).rows[0].count, '2')
    } finally {
        await pool.end()
        for (const socket of sockets) socket.destroy()
        await new Promise<void>(resolve => proxy.close(() => resolve()))
        await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await administrator.end()
    }
})
