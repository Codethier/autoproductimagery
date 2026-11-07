export const ACCOUNT_CHANGE_CHANNEL = 'autoproductimagery.account-changes.v1'
export type AccountChangeEvent = {type: 'account-changed'; nonce: string}
type MessageChannel = {postMessage(value: unknown): void; close(): void; addEventListener(type: 'message', listener: (event: {data: unknown}) => void): void; removeEventListener(type: 'message', listener: (event: {data: unknown}) => void): void}
export type AccountChangeSurface = {
  openChannel?: (name: string) => MessageChannel
  writeStorage: (key: string, value: string) => void
  listenStorage: (listener: (event: {key: string | null; newValue: string | null}) => void) => () => void
}
let defaultSurface: AccountChangeSurface | undefined
const channels = new WeakMap<AccountChangeSurface, {channel: MessageChannel; subscribers: number}>()
function browserSurface(): AccountChangeSurface {
  defaultSurface ??= {
    ...(typeof BroadcastChannel === 'function' ? {openChannel: (name: string) => new BroadcastChannel(name)} : {}),
    writeStorage: (key, value) => window.localStorage.setItem(key, value),
    listenStorage(listener) {
      window.addEventListener('storage', listener)
      return () => window.removeEventListener('storage', listener)
    },
  }
  return defaultSurface
}
export function parseAccountChange(value: unknown): AccountChangeEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const event = value as Record<string, unknown>
  if (Object.keys(event).length !== 2 || event.type !== 'account-changed' || typeof event.nonce !== 'string'
    || !/^[a-zA-Z\d_-]{16,80}$/.test(event.nonce)) return
  return {type: 'account-changed', nonce: event.nonce}
}
export function publishAccountChange(surface: AccountChangeSurface = browserSurface()) {
  const event: AccountChangeEvent = {type: 'account-changed', nonce: crypto.randomUUID()}
  try {
    if (surface.openChannel) {
      const subscribed = channels.get(surface)
      const channel = subscribed?.channel ?? surface.openChannel(ACCOUNT_CHANGE_CHANNEL)
      // Use this tab's subscribed channel so the sender never receives its
      // own login notification and clears the account it just selected.
      channel.postMessage(event)
      if (!subscribed) channel.close()
      return
    }
  } catch { /* Storage is an independent fallback when a channel is unavailable. */ }
  try { surface.writeStorage(ACCOUNT_CHANGE_CHANNEL, JSON.stringify(event)) } catch { /* Session checks still enforce access when browser messaging is blocked. */ }
}
export function subscribeAccountChanges(onChange: () => void, surface: AccountChangeSurface = browserSurface()) {
  const seen = new Set<string>()
  function receive(value: unknown) {
    const event = parseAccountChange(value)
    if (!event || seen.has(event.nonce)) return
    seen.add(event.nonce)
    if (seen.size > 64) seen.delete(seen.values().next().value!)
    onChange()
  }
  const listener = (event: {data: unknown}) => receive(event.data)
  let channel: MessageChannel | undefined
  try {
    if (surface.openChannel) {
      const shared = channels.get(surface) ?? {channel: surface.openChannel(ACCOUNT_CHANGE_CHANNEL), subscribers: 0}
      shared.subscribers += 1
      channels.set(surface, shared)
      channel = shared.channel
      channel.addEventListener('message', listener)
    }
  } catch {}
  const stopStorage = surface.listenStorage(event => {
    if (event.key !== ACCOUNT_CHANGE_CHANNEL || !event.newValue || event.newValue.length > 256) return
    try { receive(JSON.parse(event.newValue)) } catch {}
  })
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    stopStorage()
    channel?.removeEventListener('message', listener)
    const shared = channels.get(surface)
    if (shared && --shared.subscribers === 0) {shared.channel.close(); channels.delete(surface)}
  }
}
