export async function settleWithinMs<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`${label} timed out after ${timeoutMs} ms.`)
            error.name = 'GatewayMetadataTimeoutError'
            reject(error)
        }, timeoutMs)
    })
    try {
        return await Promise.race([promise, timeout])
    } finally {
        if (timer) clearTimeout(timer)
    }
}
