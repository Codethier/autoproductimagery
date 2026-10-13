import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {stat} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import {getBackgroundRemovalModel, type BackgroundRemovalModelId} from '../schemas/background-removal-models'
import {encodeBackgroundRemovalOutput, maskFromLogits, prepareBackgroundRemovalInput, MASK_SIZE} from './background-removal-inference'

// One child process holds one fixed model. The parent replaces it to switch models,
// releasing native allocations before another model can be loaded.
const profile = getBackgroundRemovalModel(process.argv[2] as BackgroundRemovalModelId)
const threads = Math.max(1, Math.min(2, Number(process.argv[3]) || 1))
ort.env.logLevel = 'error'
sharp.cache(false)
sharp.concurrency(1)
let session: ort.InferenceSession | undefined
let busy = false

async function getSession() {
    if (session) return session
    const modelPath = new URL(`./models/${profile.filename}`, import.meta.url)
    const model = await stat(modelPath)
    if (!model.isFile() || model.size !== profile.bytes) throw new Error('Model integrity error')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(modelPath)) hash.update(chunk)
    if (hash.digest('hex') !== profile.sha256) throw new Error('Model integrity error')
    session = await ort.InferenceSession.create(fileURLToPath(modelPath), {
        executionProviders: ['cpu'],
        executionMode: 'sequential',
        graphOptimizationLevel: 'basic',
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        enableCpuMemArena: false,
        enableMemPattern: false,
        logSeverityLevel: 3,
    })
    if (session.inputNames.length !== 1 || session.outputNames.length !== 1) throw new Error('Unsupported model graph')
    return session
}

process.on('disconnect', () => process.exit(0))
process.on('message', async (message: {id: number; buffer: Uint8Array}) => {
    if (busy) { process.send!({id: message.id, error: {code: 'BUSY', retryable: true}}); return }
    busy = true
    try {
        const input = await prepareBackgroundRemovalInput(Buffer.from(message.buffer.buffer, message.buffer.byteOffset, message.buffer.byteLength))
        const loaded = await getSession()
        const tensor = new ort.Tensor('float32', input.tensor, [1, 3, MASK_SIZE, MASK_SIZE])
        const result = await loaded.run({[loaded.inputNames[0]!]: tensor})
        const output = result[loaded.outputNames[0]!]!
        if (output.type !== 'float32' || output.dims.length !== 4 || output.dims[0] !== 1 || output.dims[1] !== 1
            || output.dims[2] !== MASK_SIZE || output.dims[3] !== MASK_SIZE || !(output.data instanceof Float32Array)) {
            throw new Error('Invalid model output')
        }
        const image = await encodeBackgroundRemovalOutput(input, maskFromLogits(output.data))
        process.send!({id: message.id, result: {...image, modelVersion: profile.version}})
    } catch (error) {
        // Native decoder/runtime errors often contain paths; only explicit public codes cross IPC.
        const invalidInput = Boolean(error && typeof error === 'object' && 'statusCode' in error
            && [413, 415].includes(Number(error.statusCode)))
        process.send!({id: message.id, error: {code: invalidInput ? 'INVALID_IMAGE' : 'PROCESSING_FAILED', retryable: !invalidInput}})
    } finally {
        busy = false
    }
})
