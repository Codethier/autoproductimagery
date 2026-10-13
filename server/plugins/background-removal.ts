import {kickBackgroundRemovalQueue, closeBackgroundRemovalQueue} from '../utils/backgroundRemovalRunner'
import {verifyBackgroundRemovalRuntime} from '../utils/backgroundRemovalRuntime'

export default defineNitroPlugin(async nitro => {
    await verifyBackgroundRemovalRuntime()
    console.info('Background removal CPU runtime verified')
    console.info(JSON.stringify({component: 'background-removal', availableMemoryGiB: Math.floor(process.availableMemory() / (1024 ** 3)),
        memoryLimitGiB: Math.floor(process.constrainedMemory() / (1024 ** 3)) || null}))
    // Recover queued work after Git deployment. Idle instances have no background DB polling.
    void kickBackgroundRemovalQueue()
    nitro.hooks.hook('close', closeBackgroundRemovalQueue)
})
