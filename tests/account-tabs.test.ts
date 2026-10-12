import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import test from 'node:test'
import {ref} from 'vue'
import {ACCOUNT_CHANGE_CHANNEL, parseAccountChange, publishAccountChange, subscribeAccountChanges, type AccountChangeSurface} from '../app/utils/accountChanges.ts'

function tabHub() {
  const channels = new Set<{listeners: Set<(event: {data: unknown}) => void>} & Record<string, any>>()
  const surfaces: Array<{surface: AccountChangeSurface; storage: Set<(event: {key: string | null; newValue: string | null}) => void>}> = []
  const messages: unknown[] = []
  function tab(withChannel = true): AccountChangeSurface {
    const storage = new Set<(event: {key: string | null; newValue: string | null}) => void>()
    const surface: AccountChangeSurface = {
      ...(withChannel ? {openChannel() {
        const port = {listeners: new Set<(event: {data: unknown}) => void>(),
          postMessage(data: unknown) {messages.push(data); for (const peer of channels) if (peer !== port) for (const listener of peer.listeners) listener({data})},
          close() {channels.delete(port)}, addEventListener(_type: string, listener: (event: {data: unknown}) => void) {port.listeners.add(listener)}, removeEventListener(_type: string, listener: (event: {data: unknown}) => void) {port.listeners.delete(listener)}}
        channels.add(port); return port
      }} : {}),
      writeStorage(key, newValue) { messages.push(JSON.parse(newValue)); for (const peer of surfaces) if (peer.surface !== surface) for (const listener of peer.storage) listener({key, newValue}) },
      listenStorage(listener) { storage.add(listener); return () => storage.delete(listener) },
    }
    surfaces.push({surface, storage})
    return surface
  }
  return {tab, messages, channels}
}

test('completed account changes clear other tabs without clearing the publishing tab or broadcasting profile data', () => {
  const hub = tabHub(); const first = hub.tab(); const second = hub.tab()
  let ownChanges = 0; let otherChanges = 0
  const stopFirst = subscribeAccountChanges(() => ownChanges++, first)
  const stopSecond = subscribeAccountChanges(() => otherChanges++, second)
  publishAccountChange(first)
  assert.equal(ownChanges, 0)
  assert.equal(otherChanges, 1)
  assert.deepEqual(Object.keys(hub.messages[0] as object).sort(), ['nonce', 'type'])
  assert.equal((hub.messages[0] as any).type, 'account-changed')
  stopFirst(); stopFirst(); stopSecond()
  assert.equal(hub.channels.size, 0)
})

test('storage fallback synchronizes account changes and rejects malformed or duplicate events', () => {
  const hub = tabHub(); const first = hub.tab(false); const second = hub.tab(false)
  let changes = 0
  const stop = subscribeAccountChanges(() => changes++, second)
  publishAccountChange(first)
  assert.equal(changes, 1)
  const event = JSON.stringify(hub.messages[0])
  first.writeStorage(ACCOUNT_CHANGE_CHANNEL, event)
  assert.equal(changes, 1, 'duplicate events must not repeat account clearing or navigation')
  for (const bad of [null, {}, [], {type: 'account-changed', nonce: 'short'}, {type: 'account-changed', nonce: 'x'.repeat(16), username: 'private'}, {type: 'other', nonce: 'x'.repeat(16)}]) assert.equal(parseAccountChange(bad), undefined)
  first.writeStorage(ACCOUNT_CHANGE_CHANNEL, JSON.stringify({type: 'account-changed', nonce: 'x'.repeat(16), password: 'never broadcast'}))
  assert.equal(changes, 1)
  stop()
})

test('receiving-tab plugin clears account and redirects without revoking the other tab’s session', () => {
  const source = stripTypeScriptTypes(readFileSync(new URL('../app/plugins/account-tabs.client.ts', import.meta.url), 'utf8'))
    .replace(/import \{subscribeAccountChanges\} from '[^']+'/, '')
    .replace('export default defineNuxtPlugin', 'return defineNuxtPlugin')
    .replace('import.meta.hot?.dispose(stop)', '')
  let listener!: () => void
  let clearCount = 0; let destination = ''
  const initialize = new Function('defineNuxtPlugin', 'subscribeAccountChanges', 'useAccount', 'useRouter', 'navigateTo', source)
  initialize((callback: (app: unknown) => unknown) => callback({hook() {}}), (callback: () => void) => {listener = callback; return () => undefined},
    () => ({clear() {clearCount++}}), () => ({currentRoute: ref({path: '/edit', fullPath: '/edit?source=private'})}), (path: string) => {destination = path})
  listener()
  assert.equal(clearCount, 1)
  assert.equal(destination, '/login?redirect=%2Fedit')
  assert.doesNotMatch(source, /\$fetch\(|\/api\/logout/)
})

test('restoring a cached page clears stale account state while keeping its message subscription active', () => {
  const source = stripTypeScriptTypes(readFileSync(new URL('../app/plugins/account-tabs.client.ts', import.meta.url), 'utf8'))
    .replace(/import \{subscribeAccountChanges\} from '[^']+'/, '')
    .replace('export default defineNuxtPlugin', 'return defineNuxtPlugin')
    .replace('import.meta.hot?.dispose(stop)', '')
  const originalWindow = (globalThis as any).window
  const listeners = new Map<string, (event: {persisted: boolean}) => void>()
  let mount!: () => void; let clears = 0; let stops = 0
  ;(globalThis as any).window = {addEventListener: (type: string, listener: (event: {persisted: boolean}) => void) => listeners.set(type, listener)}
  const initialize = new Function('defineNuxtPlugin', 'subscribeAccountChanges', 'useAccount', 'useRouter', 'navigateTo', source)
  try {
    initialize((callback: (app: unknown) => unknown) => callback({hook(_name: string, listener: () => void) {mount = listener}}), () => () => stops++,
      () => ({clear() {clears++}}), () => ({currentRoute: ref({path: '/assets', fullPath: '/assets?folder=private'})}), () => undefined)
    mount()
    listeners.get('pagehide')!({persisted: true})
    assert.equal(stops, 0)
    listeners.get('pageshow')!({persisted: true})
    assert.equal(clears, 1)
    listeners.get('pagehide')!({persisted: false})
    assert.equal(stops, 1)
  } finally { (globalThis as any).window = originalWindow }
})
