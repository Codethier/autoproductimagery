import type {FetchOptions} from 'ofetch'

export const SERVERLESS_READ_BUDGET_MS = 90_000
export const SERVERLESS_READ_ATTEMPT_MS = 45_000
export const SERVERLESS_MUTATION_TIMEOUT_MS = 180_000
export const SERVERLESS_RETRY_DELAY_MS = 750
export const SERVERLESS_RETRY_STATUS_CODES = [408, 500, 502, 503, 504]

type RequestState = {startedAt: number; budget: number; signal?: AbortSignal; deadline: AbortSignal}
type WorkspaceFetchOptions = FetchOptions & {workspaceRequestState?: RequestState; workspaceAccountEpoch?: number}

// ofetch's timeout is ignored when a caller supplies its own signal. Compose
// cancellation with real deadlines instead, retaining the same overall budget
// across its one safe-read retry. A mutation's response can be lost after commit:
// never retry mutations here, even if a caller accidentally enables retries.
export function prepareServerlessRequest(options: WorkspaceFetchOptions, accountEpoch?: number) {
  const method = (options.method ?? 'GET').toUpperCase()
  const read = method === 'GET' || method === 'HEAD'
  let state = options.workspaceRequestState
  if (!state) {
    const budget = read ? SERVERLESS_READ_BUDGET_MS : Math.max(SERVERLESS_MUTATION_TIMEOUT_MS, options.timeout ?? 0)
    state = {startedAt: Date.now(), budget, signal: options.signal ?? undefined, deadline: AbortSignal.timeout(budget)}
    options.workspaceRequestState = state
    if (accountEpoch !== undefined && options.workspaceAccountEpoch === undefined) options.workspaceAccountEpoch = accountEpoch
    options.retry = read ? (options.retry === false || options.retry === 0 ? 0 : 1) : 0
    options.retryDelay = SERVERLESS_RETRY_DELAY_MS
    options.retryStatusCodes = [...SERVERLESS_RETRY_STATUS_CODES]
  }
  const remaining = Math.max(0, state.budget - (Date.now() - state.startedAt))
  const timeout = read ? Math.min(SERVERLESS_READ_ATTEMPT_MS, remaining) : remaining
  options.timeout = timeout
  if (remaining === 0 || state.deadline.aborted || state.signal?.aborted) options.retry = 0
  options.signal = remaining === 0 ? AbortSignal.abort(new DOMException('Request deadline exceeded', 'TimeoutError'))
    : AbortSignal.any([...(state.signal ? [state.signal] : []), state.deadline, AbortSignal.timeout(timeout)])
}

// Explicit helpers also work with SSR's cookie-forwarding useRequestFetch.
// The hook retains the original account epoch through automatic read retries.
export function serverlessFetchOptions<const T extends FetchOptions>(options: T, accountEpoch?: number): T & Pick<FetchOptions, 'onRequest'> {
  return {...options, onRequest({options: requestOptions}) {prepareServerlessRequest(requestOptions, accountEpoch)}}
}

export function fetchStatusCode(error: unknown) {
  if (!error || typeof error !== 'object') return undefined
  const value = error as {statusCode?: number; status?: number; response?: {status?: number}}
  return value.statusCode ?? value.status ?? value.response?.status
}
