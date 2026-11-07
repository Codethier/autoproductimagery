import assert from 'node:assert/strict'
import test from 'node:test'
import {assertRequestOrigin} from '../server/utils/requestOrigin.ts'

test('browser mutations require the exact app origin, including scheme and port', () => {
    const app = 'https://studio.example.test'
    assert.doesNotThrow(() => assertRequestOrigin(app, app, 'same-origin'))
    for (const origin of ['https://evil.test', 'https://other.example.test', 'http://studio.example.test',
        'https://studio.example.test:8080', app + '/path', 'null', 'not an origin']) {
        assert.throws(() => assertRequestOrigin(origin, app, 'same-site'),
            (error: unknown) => (error as {statusCode: number}).statusCode === 403)
    }
    assert.throws(() => assertRequestOrigin(undefined, app, 'cross-site'))
    assert.throws(() => assertRequestOrigin(app, app, 'cross-site'))
    assert.doesNotThrow(() => assertRequestOrigin(undefined, app))
})
