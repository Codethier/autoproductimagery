import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'

export function assertNodeRuntimeLibraries(output: string): void {
    if (/not found/i.test(output) || !/libatomic\.so\.1\s*=>\s*\S+/.test(output)) {
        throw new Error('Node runtime libraries are incomplete')
    }
}

export async function verifyBackgroundRemovalRuntime(): Promise<void> {
    if (Number(process.versions.node.split('.')[0]) !== 26) throw new Error('Unsupported Node runtime')
    if (process.platform === 'linux') {
        const {stdout} = await promisify(execFile)('ldd', [process.execPath], {timeout: 5_000, maxBuffer: 16 * 1024})
        assertNodeRuntimeLibraries(stdout)
    }
    // Importing ORT loads the actual platform binding and its shared libraries. No session/model is created.
    if (!ort.listSupportedBackends().some(backend => backend.name === 'cpu' && backend.bundled)) {
        throw new Error('CPU runtime unavailable')
    }
    const pixel = await sharp({create: {width: 1, height: 1, channels: 4, background: '#ffffff'}}).png().toBuffer()
    const decoded = await sharp(pixel).metadata()
    if (decoded.format !== 'png' || decoded.width !== 1 || decoded.height !== 1) throw new Error('Image runtime unavailable')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    try {
        await verifyBackgroundRemovalRuntime()
        console.log('Background removal CPU runtime verified')
    } catch {
        console.error('Background removal CPU runtime verification failed')
        process.exitCode = 1
    }
}
