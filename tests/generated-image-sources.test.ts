import assert from 'node:assert/strict'
import test from 'node:test'
import {assertGeneratedSourcesAvailable, generatedSourcePaths} from '../server/utils/generatedImageSources.ts'

test('retention source lookup covers inputs, references and masks with canonical URLs', async () => {
    const paths = generatedSourcePaths({
        inputImages: ['output/example.png', '/images/input/product.png'],
        modelImages: ['/images/output/example.png', '/images/output/a%23b.png'],
        maskImage: '/images/output/mask.png',
    })
    assert.deepEqual(paths, ['/images/output/example.png', '/images/output/a%23b.png', '/images/output/mask.png'])
    let checked: readonly string[] = []
    await assert.rejects(assertGeneratedSourcesAvailable({
        inputImages: [], modelImages: [], maskImage: '/images/output/mask.png',
    }, async paths => { checked = paths; return [...paths] }), (error: unknown) => {
        const expired = error as {statusCode: number; statusMessage: string; data: {code: string; retryable: boolean}}
        assert.equal(expired.statusCode, 410)
        assert.match(expired.statusMessage, /Exact replay is unavailable/)
        assert.equal(expired.data.code, 'GENERATED_IMAGE_EXPIRED')
        assert.equal(expired.data.retryable, false)
        return true
    })
    assert.deepEqual(checked, ['/images/output/mask.png'])
})

test('available generated references and uploaded source images remain usable', async () => {
    await assertGeneratedSourcesAvailable({inputImages: ['/images/output/available.png'], modelImages: []}, async () => [])
    await assertGeneratedSourcesAvailable({inputImages: ['/images/input/product.png'], modelImages: []}, async () => {
        assert.fail('Uploaded images do not require retention lookups')
    })
})
