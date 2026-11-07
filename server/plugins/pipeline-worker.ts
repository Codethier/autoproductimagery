import {getPipelineWorkerWakeConfig, wakePipelineWorker} from '../utils/pipelineWorkerWake'
import {hasPendingPipelineWorkerWork} from '../utils/pipelineRunner'
import {recoverPipelineWorkerAtStartup} from '../utils/pipelineStartupRecovery'

export default defineNitroPlugin(() => {
    // If the runner deployed first, an older app may have saved a job while
    // its LISTEN connection was already idle. Check once on the new app's
    // startup and send a bounded wake; no idle poller or provider work here.
    void recoverPipelineWorkerAtStartup({
        configured: () => Boolean(getPipelineWorkerWakeConfig()),
        pending: hasPendingPipelineWorkerWork,
        wake: wakePipelineWorker,
        unavailable: () => console.error('Pipeline startup recovery is temporarily unavailable; saved runs can be resumed.'),
    })
})
