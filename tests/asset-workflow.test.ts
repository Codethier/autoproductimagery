import assert from 'node:assert/strict'
import test from 'node:test'
import {AssetListingQuerySchema} from '../schemas/image-storage.ts'
import {assetFromImageUrl, assetSelectionLimit, createAssetFavourites, MAX_ASSET_FAVOURITES, parseAssetFavourites, toggleAssetSelection, validateAssetUploads} from '../app/utils/assetPreferences.ts'
import {MAX_UPLOAD_FILES, MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_AGGREGATE_BYTES} from '../server/utils/uploadPolicy.ts'

test('asset queries reject unknown fields, multi-value parameters and unbounded scans', () => {
    assert.deepEqual(AssetListingQuerySchema.parse({}), {scope: 'all', path: '/', query: '', limit: 60})
    for (const value of [{scope: 'video'}, {query: ['first', 'second']}, {query: 'a'.repeat(201)}, {limit: '101'}, {limit: '0'}, {cursor: '../other'}, {path: ['/one', '/two']}, {unexpected: true}]) {
        assert.equal(AssetListingQuerySchema.safeParse(value).success, false)
    }
})

test('favorite preferences only contain bounded canonical image URLs', () => {
    const valid = '/images/catalog/product%23sample%20(1).png'
    assert.equal(assetFromImageUrl(valid)?.name, 'product#sample (1).png')
    assert.equal(assetFromImageUrl(valid)?.folder, '/catalog')
    for (const value of ['https://example.com/a.png', '//evil/a.png', '/api/data/images/a.png', '/images/../a.png', '/images/%2e%2e/a.png', '/images/a%2fb.png', '/images/a%2523b.png', '/images/a.png?secret=1', '/images/a.svg', '/images/__proto__/a.png', '/images/a.png#fragment']) {
        assert.equal(assetFromImageUrl(value), undefined)
    }
    assert.deepEqual(parseAssetFavourites(JSON.stringify([valid, valid, 'https://evil/a.png', 1, null])), [valid])
    assert.deepEqual(parseAssetFavourites('{'), [])
    assert.equal(parseAssetFavourites(JSON.stringify(Array.from({length: 300}, (_, index) => `/images/a-${index}.png`))).length, MAX_ASSET_FAVOURITES)
})

test('favorite toggles persist and typed folder deletion removes only that prefix', () => {
    const data = new Map<string, string>()
    const preferences = createAssetFavourites(() => ({getItem: key => data.get(key) ?? null, setItem: (key, value) => {data.set(key, value)}}))
    const first = preferences.toggle([], '/images/catalog/a.png')
    const second = preferences.toggle(first.urls, '/images/catalogue/a.png')
    assert.deepEqual(preferences.load().urls, second.urls)
    assert.deepEqual(preferences.remove(second.urls, '/images/catalog/', true).urls, ['/images/catalogue/a.png'])
    assert.deepEqual(preferences.toggle(preferences.load().urls, '/images/catalogue/a.png').urls, [])
    const blocked = createAssetFavourites(() => {throw new Error('blocked')})
    assert.deepEqual(blocked.toggle([], '/images/a.png'), {urls: ['/images/a.png'], persistent: false})
})

test('single-image picker selections replace a source without changing original multi-image selection', () => {
    const batch = ['/images/first.png', '/images/second.png']
    assert.deepEqual(toggleAssetSelection(batch, '/images/third.png', 'single'), ['/images/third.png'])
    assert.deepEqual(batch, ['/images/first.png', '/images/second.png'])
    assert.deepEqual(toggleAssetSelection(batch, '/images/first.png', 'multiple'), ['/images/second.png'])
    assert.deepEqual(toggleAssetSelection(batch, '/images/third.png', 'multiple'), [...batch, '/images/third.png'])
})

test('asset pickers respect profiles that prohibit references and clamp single selection to one', () => {
    assert.equal(assetSelectionLimit('single', 0), 0)
    assert.equal(assetSelectionLimit('multiple', 0), 0)
    assert.equal(assetSelectionLimit('single', 5), 1)
    assert.equal(assetSelectionLimit('multiple', 16), 16)
    assert.equal(assetSelectionLimit('multiple', 100), 20)
    assert.equal(assetSelectionLimit('single'), 1)
    for (const invalid of [-1, NaN, Infinity, 1.5]) assert.equal(assetSelectionLimit('multiple', invalid), 0)
})
test('pipeline batch selection opts into fifty pictures without increasing default references or upload bounds', () => {
    assert.equal(assetSelectionLimit('multiple', 50, 50), 50)
    assert.equal(assetSelectionLimit('multiple', 100, 100), 50)
    assert.equal(assetSelectionLimit('multiple', 50), 20)
    assert.equal(assetSelectionLimit('single', 50, 50), 1)
    for (const invalid of [NaN, Infinity, -1, 1.5]) assert.equal(assetSelectionLimit('multiple', 50, invalid), 0)
    assert.match(validateAssetUploads(Array(21).fill({name: 'photo.png', type: 'image/png', size: 100}))!, /20/)
})

test('client upload preflight matches streaming limits and rejects non-image uploads', () => {
    const image = {name: 'product.png', type: 'image/png', size: 100}
    assert.equal(validateAssetUploads([image]), undefined)
    assert.match(validateAssetUploads(Array(MAX_UPLOAD_FILES + 1).fill(image))!, /20/)
    assert.match(validateAssetUploads([{...image, size: MAX_UPLOAD_FILE_BYTES + 1}])!, /25 MB/)
    assert.match(validateAssetUploads(Array(5).fill({...image, size: MAX_UPLOAD_AGGREGATE_BYTES / 5 + 1}))!, /100 MB/)
    for (const file of [{...image, name: 'image.svg', type: 'image/svg+xml'}, {...image, name: 'movie.mp4', type: 'video/mp4'}, {...image, type: 'application/pdf'}, {...image, size: 0}]) assert.ok(validateAssetUploads([file]))
})
