import {randomBytes, scrypt, timingSafeEqual} from 'node:crypto'

// OWASP's scrypt profile for a ~16 MiB memory budget; CPU work is increased
// instead of multiplying memory across concurrent serverless logins.
const SCRYPT_PARAMETERS = {N: 16_384, r: 8, p: 5, maxmem: 64 * 1024 * 1024}
const HASH_PREFIX = 'scrypt-v2$16384$8$5'
const KEY_BYTES = 64
const MAX_PASSWORD_BYTES = 4096
const MAX_HASH_OPERATIONS = 4
const MAX_QUEUED_HASH_OPERATIONS = 16
const MAX_HASH_WAIT_MS = 10_000
const HASH_STATE_KEY = Symbol.for('autoproductimagery.password-hashing.v1')
type HashState = {active: number; queue: Array<{start: () => void; timer: ReturnType<typeof setTimeout>}>}
const processState = globalThis as typeof globalThis & {[HASH_STATE_KEY]?: HashState}
const hashState = processState[HASH_STATE_KEY] ?? (processState[HASH_STATE_KEY] = {active: 0, queue: []})

export class PasswordCapacityError extends Error {
    constructor() { super('Password verification is busy; retry later'); this.name = 'PasswordCapacityError' }
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) throw new Error('Invalid password length')
    return new Promise((resolve, reject) => {
        const start = () => {
            hashState.active += 1
            scrypt(password, salt, KEY_BYTES, SCRYPT_PARAMETERS, (error, key) => {
                hashState.active -= 1
                const next = hashState.queue.shift()
                if (next) { clearTimeout(next.timer); next.start() }
                if (error) reject(new Error('Password verification failed'))
                else resolve(key)
            })
        }
        if (hashState.active < MAX_HASH_OPERATIONS) { start(); return }
        if (hashState.queue.length >= MAX_QUEUED_HASH_OPERATIONS) { reject(new PasswordCapacityError()); return }
        const pending = {start, timer: setTimeout(() => {
            const index = hashState.queue.indexOf(pending)
            if (index >= 0) hashState.queue.splice(index, 1)
            reject(new PasswordCapacityError())
        }, MAX_HASH_WAIT_MS)}
        pending.timer.unref?.()
        hashState.queue.push(pending)
    })
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16)
    const key = await derive(password, salt)
    return `${HASH_PREFIX}$${salt.toString('hex')}$${key.toString('hex')}`
}

// Unknown usernames perform the same expensive work as known usernames.
const DUMMY_HASH = `${HASH_PREFIX}$${'9f'.repeat(16)}$${'a7'.repeat(KEY_BYTES)}`
export async function verifyPassword(password: string, encodedHash: string | undefined): Promise<boolean> {
    const candidate = encodedHash || DUMMY_HASH
    // Do not derive with arbitrary work factors from an untrusted hash string.
    const match = /^scrypt-v2\$16384\$8\$5\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(candidate)
    const salt = Buffer.from(match?.[1] ?? '9f'.repeat(16), 'hex')
    const expected = Buffer.from(match?.[2] ?? 'a7'.repeat(KEY_BYTES), 'hex')
    const actual = await derive(password, salt)
    return timingSafeEqual(actual, expected) && Boolean(encodedHash && match)
}
