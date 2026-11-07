import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import {processLocalPipelineImage, prepareExpansionCanvas, type LocalPipelineImageOperation} from '../server/utils/pipelineImageProcessing.ts'

async function source() {
    return sharp({create: {width: 12, height: 6, channels: 4, background: {r: 255, g: 0, b: 0, alpha: 0.5}}})
        .composite([{input: await sharp({create: {width: 6, height: 6, channels: 4, background: {r: 0, g: 0, b: 255, alpha: 1}}}).png().toBuffer(), left: 6, top: 0}])
        .png().toBuffer()
}
test('crop fills the selected aspect ratio with the chosen anchor, preserves original bytes and records local zero cost', async () => {
    const bytes = await source(), original = Buffer.from(bytes)
    const result = await processLocalPipelineImage(bytes, {type: 'crop', config: {width: 6, height: 6, position: 'east'}})
    assert.deepEqual([result.width, result.height, result.mimeType, result.byteSize], [6, 6, 'image/png', result.buffer.byteLength])
    assert.equal(result.method, 'crop')
    assert.equal(result.providerPriceUsd, '0')
    assert.equal(result.priceSource, 'local-processing')
    const {data, info} = await sharp(result.buffer).raw().toBuffer({resolveWithObject: true})
    assert.ok(info.channels >= 3)
    assert.deepEqual([...data.subarray(0, 3)], [0, 0, 255])
    assert.deepEqual(bytes, original)
})
test('resize contain adds transparent or solid padding and supports exact fill without losing alpha', async () => {
    const bytes = await source()
    const transparent = await processLocalPipelineImage(bytes, {type: 'resize', config: {width: 12, height: 12, fit: 'contain', background: 'transparent'}})
    const {data, info} = await sharp(transparent.buffer).raw().toBuffer({resolveWithObject: true})
    assert.deepEqual([info.width, info.height, info.channels], [12, 12, 4])
    assert.equal(data[3], 0)
    const solid = await processLocalPipelineImage(bytes, {type: 'resize', config: {width: 12, height: 12, fit: 'contain', background: '#00ff00'}})
    const green = await sharp(solid.buffer).raw().toBuffer()
    assert.deepEqual([...green.subarray(0, 4)], [0, 255, 0, 255])
    const inside = await processLocalPipelineImage(bytes, {type: 'resize', config: {width: 3, height: 3, fit: 'inside'}})
    assert.deepEqual([inside.width, inside.height], [3, 2])
})
test('upscale is deterministic standard resampling at 2x or 4x and honors EXIF orientation', async () => {
    const bytes = await source()
    for (const scale of [2, 4] as const) {
        const result = await processLocalPipelineImage(bytes, {type: 'upscale', config: {scale}})
        assert.deepEqual([result.width, result.height, result.method], [12 * scale, 6 * scale, 'standard-resampling'])
    }
    const portrait = await sharp({create: {width: 8, height: 4, channels: 3, background: '#aabbcc'}})
        .jpeg().withMetadata({orientation: 6}).toBuffer()
    const oriented = await processLocalPipelineImage(portrait, {type: 'upscale', config: {scale: 2}})
    assert.deepEqual([oriented.width, oriented.height], [8, 16])
})
test('local transforms reject corrupt media, invalid settings and dimensions before publishing', async () => {
    const bytes = await source()
    for (const [operation, statusCode] of [
        [{type: 'crop', config: {width: 8193, height: 2, position: 'centre'}}, 413],
        [{type: 'crop', config: {width: 8192, height: 8192, position: 'centre'}}, 413],
        [{type: 'crop', config: {width: -1, height: 6, position: 'centre'}}, 413],
        [{type: 'crop', config: {width: 6, height: 6, position: 'malicious/path'}}, 400],
        [{type: 'upscale', config: {scale: 10000}}, 400],
        [{type: 'upscale', config: {scale: 2, mode: 'ai'}}, 400],
        [{type: 'resize', config: {width: 6, height: 6, fit: 'contain', background: 'url(secret)'}}, 400],
        [{type: 'resize', config: {width: 6, height: 6, fit: 'unspecified'}}, 400],
    ] as const) {
        await assert.rejects(processLocalPipelineImage(bytes, operation as unknown as LocalPipelineImageOperation),
            error => (error as {statusCode?: number}).statusCode === statusCode)
    }
    await assert.rejects(processLocalPipelineImage(Buffer.from('not an image'), {type: 'upscale', config: {scale: 2}}),
        error => (error as {statusCode?: number}).statusCode === 415)
    await assert.rejects(processLocalPipelineImage(Buffer.alloc(25 * 1024 * 1024 + 1), {type: 'upscale', config: {scale: 2}}),
        error => (error as {statusCode?: number}).statusCode === 413)
})
test('pre-cancelled local image work never starts and concurrent transforms remain isolated', async () => {
    const bytes = await source(), signal = AbortSignal.abort(new Error('private cancellation detail'))
    await assert.rejects(processLocalPipelineImage(bytes, {type: 'upscale', config: {scale: 2}}, signal),
        error => (error as {statusCode?: number}).statusCode === 499 && !(error as Error).message.includes('private'))
    const outputs = await Promise.all(Array.from({length: 6}, (_, index) => processLocalPipelineImage(bytes,
        {type: 'crop', config: {width: index + 2, height: index + 2, position: 'centre'}})))
    assert.deepEqual(outputs.map(output => output.width), [2, 3, 4, 5, 6, 7])
})
test('output conversion uses decoded JPEG/WebP MIME and preserves dimensions; JPEG flattens alpha on white', async () => {
    const bytes = await source()
    for (const [format, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
        const result = await processLocalPipelineImage(bytes, {type: 'convert', config: {format, quality: 90}})
        const metadata = await sharp(result.buffer).metadata()
        assert.deepEqual([result.width, result.height, result.mimeType, result.method], [12, 6, mime, 'convert'])
        assert.equal(metadata.format, format)
        if (format === 'jpeg') assert.equal(metadata.hasAlpha, false)
        else assert.equal(metadata.hasAlpha, true)
    }
    await assert.rejects(processLocalPipelineImage(bytes, {type: 'convert', config: {format: 'webp', quality: 101}}),
        error => (error as {statusCode?: number}).statusCode === 400)
})
test('generative expansion preparation preserves the original rectangle and creates correct alpha and luminance masks', async () => {
    const bytes = await source(), original = Buffer.from(bytes)
    const result = await prepareExpansionCanvas(bytes, {mode: 'pixels', top: 2, bottom: 3, left: 1, right: 4, aspectRatio: '1:1'})
    assert.deepEqual([result.width, result.height, result.mimeType], [17, 11, 'image/png'])
    assert.deepEqual(result.placement, {left: 1, top: 2, width: 12, height: 6})
    const padded = await sharp(result.buffer).raw().toBuffer({resolveWithObject: true})
    assert.equal(padded.data[3], 0, 'outside the source rectangle is transparent')
    const preserved = await sharp(result.buffer).extract(result.placement).raw().toBuffer()
    const sourcePixels = await sharp(bytes).raw().toBuffer()
    assert.deepEqual(preserved, sourcePixels)
    const alpha = await sharp(result.maskBuffer).raw().toBuffer({resolveWithObject: true})
    assert.equal(alpha.data[3], 0, 'padding is editable for alpha-mask models')
    assert.equal(alpha.data[(2 * 17 + 1) * alpha.info.channels + 3], 255, 'the original rectangle is protected')
    const luminance = await sharp(result.luminanceMaskBuffer).raw().toBuffer({resolveWithObject: true})
    assert.deepEqual([...luminance.data.subarray(0, 3)], [255, 255, 255], 'padding is editable for luminance-mask models')
    assert.equal(luminance.data[(2 * 17 + 1) * luminance.info.channels], 0, 'the original rectangle is protected')
    assert.deepEqual(bytes, original)
    const ratio = await prepareExpansionCanvas(bytes, {mode: 'aspect-ratio', top: 0, bottom: 0, left: 0, right: 0, aspectRatio: '1:1'})
    assert.deepEqual([ratio.width, ratio.height, ratio.placement], [12, 12, {left: 0, top: 3, width: 12, height: 6}])
    await assert.rejects(prepareExpansionCanvas(bytes, {mode: 'pixels', top: 4096, bottom: 4096, left: 1, right: 1, aspectRatio: '1:1'}),
        error => (error as {statusCode?: number}).statusCode === 413)
    await assert.rejects(prepareExpansionCanvas(bytes, {mode: 'aspect-ratio', top: 0, bottom: 0, left: 0, right: 0, aspectRatio: '99999999:1'}),
        error => (error as {statusCode?: number}).statusCode === 400)
})
test('the local native-memory queue rejects overload instead of retaining unbounded transforms', async () => {
    const bytes = await source()
    const outcomes = await Promise.allSettled(Array.from({length: 15}, () => processLocalPipelineImage(bytes,
        {type: 'crop', config: {width: 4, height: 4, position: 'centre'}})))
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 10, 'two running and eight queued transforms are admitted')
    const rejected = outcomes.filter(result => result.status === 'rejected')
    assert.equal(rejected.length, 5)
    assert.ok(rejected.every(result => result.status === 'rejected' && result.reason.statusCode === 429))
})
test('cancellation during native transform discards its result and releases the memory slot', async () => {
    const bytes = await sharp({create: {width: 500, height: 500, channels: 4, background: '#445566'}}).png().toBuffer()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('private cancellation detail')), 40)
    try {
        await assert.rejects(processLocalPipelineImage(bytes, {type: 'crop', config: {width: 4096, height: 4096, position: 'centre'}}, controller.signal),
            error => (error as {statusCode?: number}).statusCode === 499 && !(error as Error).message.includes('private'))
    } finally {clearTimeout(timer)}
    const next = await processLocalPipelineImage(bytes, {type: 'crop', config: {width: 10, height: 10, position: 'centre'}})
    assert.equal(next.width, 10)
})
