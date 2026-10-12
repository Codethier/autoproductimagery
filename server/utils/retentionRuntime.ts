import {execFileSync} from 'node:child_process'

// Run in the final Linux image, where a successful build alone cannot establish
// that Node 26's shared libraries were installed in the runtime stage.
export function verifyRetentionRuntime() {
    if (process.platform !== 'linux') return
    if (Number(process.versions.node.split('.')[0]) !== 26) {
        throw new Error('The image retention worker requires Node 26.')
    }
    const libraries = execFileSync('ldd', [process.execPath], {encoding: 'utf8', timeout: 5000})
    if (/not found/i.test(libraries) || !/libatomic\.so\.1\s+=>\s+\//.test(libraries)) {
        throw new Error('The image retention worker runtime is missing required shared libraries.')
    }
}
