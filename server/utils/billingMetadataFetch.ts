/** The SDK metadata helpers do not accept AbortSignal. Apply the deadline at
 * their supported fetch boundary so timed-out lookups release real sockets,
 * rather than merely abandoning a Promise while another instance retries. */
export function createBillingMetadataFetch(
    fetchImplementation: typeof fetch = globalThis.fetch,
    timeoutMs = 10_000,
): typeof fetch {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
        throw new Error('Invalid Gateway metadata deadline')
    }
    return async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        if (url.pathname !== '/v1/generation' && !url.pathname.endsWith('/config')) {
            return fetchImplementation(input, init)
        }
        const signals = [AbortSignal.timeout(timeoutMs)]
        if (input instanceof Request) signals.push(input.signal)
        if (init?.signal) signals.push(init.signal)
        return fetchImplementation(input, {...init, signal: AbortSignal.any(signals)})
    }
}
