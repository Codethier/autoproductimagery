import assert from 'node:assert/strict'
import test from 'node:test'
import {CreateImageFolderSchema, DeleteImageEntrySchema, DirectoryListingQuerySchema} from '../schemas/image-storage.ts'
import {ImageGenerationRequestSchema, StoredGenerationConfigSchema, createDefaultSettings} from '../schemas/image-generation.ts'
import {imagePathToUrl, parseImagePath} from '../server/utils/imageStoragePaths.ts'
import {imagePathFromRequestUrl} from '../server/utils/imageServingPath.ts'

test('file listing requests enforce bounded pages and singular query values', () => {
    assert.deepEqual(DirectoryListingQuerySchema.parse({}), {path: '/', limit: 100})
    assert.equal(DirectoryListingQuerySchema.parse({path: '/foo#bar', limit: '1'}).limit, 1)
    for (const request of [
        {limit: '201'}, {limit: '0'}, {limit: '1.5'}, {limit: 'NaN'},
        {path: ['/a', '/b']}, {cursor: ['a', 'b']}, {cursor: '../other'},
        {cursor: 'a'.repeat(8193)}, {path: '/'.repeat(4097)}, {unexpected: 'value'},
    ]) assert.equal(DirectoryListingQuerySchema.safeParse(request).success, false)
})

test('file mutations reject malformed bodies and preserve explicit entry identity', () => {
    assert.deepEqual(CreateImageFolderSchema.parse({name: 'foo#bar'}), {path: '/', name: 'foo#bar'})
    assert.deepEqual(DeleteImageEntrySchema.parse({path: '/foo.png', entryType: 'directory'}), {path: '/foo.png', entryType: 'directory'})
    assert.equal(DeleteImageEntrySchema.parse({path: '/foo.png', entryType: 'file'}).entryType, 'file')
    for (const request of [null, {name: []}, {name: ''}, {name: 'a'.repeat(256)}, {name: 'fine', path: {}}, {name: 'fine', extra: true}]) {
        assert.equal(CreateImageFolderSchema.safeParse(request).success, false)
    }
    for (const request of [null, {path: ''}, {path: []}, {path: '/foo', entryType: 'prefix'}, {path: '/foo', extra: true}]) {
        assert.equal(DeleteImageEntrySchema.safeParse(request).success, false)
    }
})

test('canonical Unicode image URLs remain usable for generation and exact mask replay', () => {
    const filename = '漢'.repeat(120) + '.png'
    const url = imagePathToUrl([filename])
    assert.ok(url.length > 1024)
    assert.ok(Buffer.byteLength(`images/${filename}`, 'utf8') < 1024)
    assert.deepEqual(parseImagePath(url), [filename])
    const model = 'openai/gpt-image-1' as const
    const settings = createDefaultSettings(model)
    const request = ImageGenerationRequestSchema.parse({prompt: 'Refine the product', model, settings, inputImages: [url], maskImage: url})
    assert.equal(request.inputImages[0], url)
    assert.equal(StoredGenerationConfigSchema.parse({
        schemaVersion: 1, profileVersion: 1, requestedModel: model, effectiveModel: model,
        settings, maskImage: url, storeInputImages: true,
    }).maskImage, url)
})

test('image serving retains original encoding and validates URL segments once', () => {
    const encoded = '/images/folder/product%23sample%20(1).png'
    assert.equal(imagePathFromRequestUrl(`/api/data${encoded}?download=1`), encoded)
    assert.deepEqual(parseImagePath(encoded), ['folder', 'product#sample (1).png'])
    for (const path of ['/api/data/images/%2e%2e/secret.png', '/api/data/images/x%2fy.png', '/api/data/images/%252e%252e/secret.png']) {
        assert.throws(() => parseImagePath(imagePathFromRequestUrl(path)))
    }
    assert.throws(() => imagePathFromRequestUrl('/api/database/images/fine.png'))
})
