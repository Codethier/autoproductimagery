import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolve} from 'node:path'

/** Validate native CPU dependencies in the final image, without loading weights or doing inference. */
export async function verifyBackgroundRemovalRuntime() {
    const env: NodeJS.ProcessEnv = {NODE_ENV: 'production'}
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    try {
        const {stdout} = await promisify(execFile)(process.execPath,
            [resolve(process.cwd(), '.output/background-removal/check-runtime.mjs')], {
                env, timeout: 15_000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 16 * 1024,
            })
        if (stdout.trim() !== 'Background removal CPU runtime verified') throw new Error('Runtime verification did not complete')
    } catch {throw new Error('Background removal CPU runtime verification failed')}
}
