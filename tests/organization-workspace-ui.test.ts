import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks, stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {compileScript, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {createSSRApp, h, ref} from 'vue'
import {createAssetFavourites} from '../app/utils/assetPreferences.ts'
import {createImageModelFavourites} from '../app/utils/imageModelFavourites.ts'
import type {AssetFile, AssetFolder} from '../schemas/image-storage.ts'

const root = new URL('../', import.meta.url)
const browserUrl = new URL('app/components/AssetBrowser.vue', root).href
const layoutUrl = new URL('app/layouts/workspace.vue', root).href
const environmentKey = '__organizationWorkspaceUiTest'
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('~~/')) return nextResolve(new URL(`${specifier.slice(3)}.ts`, root).href, context)
    if (specifier.startsWith('~/')) return nextResolve(new URL(`app/${specifier.slice(2)}.ts`, root).href, context)
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url !== browserUrl && url !== layoutUrl) return nextLoad(url, context)
    const filename = fileURLToPath(url)
    let source = readFileSync(filename, 'utf8')
    if (url === browserUrl) source = source.replace('</script>', 'defineExpose({files, directories, loading, openSharing, shareTarget, shareRecipient, sharePermission, saveShare, revokeShare, grants, currentFolder, selection, selectedMetadata, confirmSelection, fetchPage, view})\n</script>')
    const {descriptor} = parse(source, {filename})
    const compiled = compileScript(descriptor, {id: filename, inlineTemplate: true})
    const services = `
      const useRoute = () => ({path: '/assets'});
      const useAccount = () => globalThis.${environmentKey}.session;
      const useToast = () => ({add: () => undefined});
      const useRequestFetch = () => (...args) => globalThis.${environmentKey}.fetch(...args);
      const $fetch = (...args) => globalThis.${environmentKey}.fetch(...args);
      const useAssetFavourites = () => ({urls: ref([]), persistent: ref(true), toggle: () => undefined, remove: () => undefined});
    `
    return {format: 'module', shortCircuit: true, source: stripTypeScriptTypes(`import {computed, ref, watch, nextTick, onMounted, onBeforeUnmount, provide} from 'vue';\n${services}\n${compiled.content}`)}
  },
})

function fixtureFile(name: string, sourceId: string, permission: 'owner' | 'edit' | 'view'): AssetFile {
  return {id: sourceId + '-' + name, name, url: `/images/organizations/org/users/${sourceId}/objects/blob/${name}`, folder: '/Spring', selectedImage: false, selectedModel: false, selectedMask: false,
    permissions: {view: true, edit: permission !== 'view', share: permission === 'owner'}, kind: 'file', source: {userId: sourceId, username: sourceId, displayName: sourceId === 'alice' ? 'Alice' : 'Bea'},
    ...(permission !== 'owner' ? {sharedBy: {userId: sourceId, username: sourceId, displayName: sourceId === 'alice' ? 'Alice' : 'Bea'}} : {})}
}
async function renderBrowser(options: {shared?: boolean; files?: AssetFile[]; dirs?: AssetFolder[]} = {}) {
  const calls: Array<{url: string; options: any}> = []
  const session = {account: ref({userId: 'member', organizationId: 'org', displayName: 'Member', username: 'member', role: 'user', organizationName: 'Studio'}), epoch: ref(0), identity: ref('org.member'), isOwner: ref(false)}
  const environment: any = {session, exposed: undefined, fetch: async (url: string, options: any) => {
    calls.push({url, options})
    if (url === '/api/assets/share-targets') return {users: [{id: 'recipient', displayName: 'Cora', username: 'cora'}]}
    return {shares: [{id: 'grant', recipientUserId: 'recipient', permission: 'view', displayName: 'Cora', username: 'cora', createdAt: new Date().toISOString()}]}
  }}
  ;(globalThis as any)[environmentKey] = environment
  const {default: Browser} = await import(browserUrl)
  const originalSetup = Browser.setup
  const component = {...Browser, setup(props: unknown, context: any) {
    return originalSetup(props, {...context, expose(value: any) {
      environment.exposed = value; value.files.value = options.files ?? []; value.directories.value = options.dirs ?? []; value.loading.value = false; context.expose(value)
    }})
  }}
  const app = createSSRApp({render: () => h(component, {initialScope: options.shared ? 'shared' : 'all', sharedOnly: options.shared})})
  app.component('UIcon', {render: () => h('span', {'aria-hidden': 'true'})})
  app.component('NuxtLink', {props: ['to'], setup: (props: any, {slots}: any) => () => h('a', {href: typeof props.to === 'string' ? props.to : props.to.path}, slots.default?.())})
  const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
  const html = await renderToString(app)
  assert.deepEqual(warnings, [])
  return {html, exposed: environment.exposed, calls, environment, session}
}

test('shared library groups images by the sharing person and hides destructive controls for view grants', async () => {
  const browser = await renderBrowser({shared: true, files: [fixtureFile('serum.png', 'alice', 'view'), fixtureFile('oil.png', 'bea', 'view')]})
  assert.match(browser.html, /From Alice/)
  assert.match(browser.html, /From Bea/)
  assert.doesNotMatch(browser.html, /aria-label="Share serum.png"/)
  assert.doesNotMatch(browser.html, />Upload images</)
  assert.doesNotMatch(browser.html, /organizations\/org\/users\/alice\/objects\/blob<\/p>/)
  browser.exposed.selection.value = [browser.exposed.files.value[0].url]
  browser.exposed.selectedMetadata.value.set(browser.exposed.files.value[0].url, browser.exposed.files.value[0])
  browser.exposed.confirmSelection()
})

test('personal file sharing uses recipient IDs and explicit permissions, then revokes only that grant', async () => {
  const file = fixtureFile('serum.png', 'alice', 'owner')
  const browser = await renderBrowser({files: [file]})
  assert.match(browser.html, /aria-label="Share serum.png"/)
  await browser.exposed.openSharing(file)
  assert.equal(browser.calls[0].url, '/api/assets/share-targets')
  assert.equal(browser.calls[1].url, `/api/assets/${file.id}/shares`)
  browser.exposed.shareRecipient.value = 'recipient'
  browser.exposed.sharePermission.value = 'view'
  await browser.exposed.saveShare()
  assert.deepEqual(browser.calls.find(call => call.options?.method === 'POST')?.options.body, {recipientUserId: 'recipient', permission: 'view'})
  await browser.exposed.revokeShare(browser.exposed.grants.value[0])
  assert.equal(browser.calls.at(-1)?.url, `/api/assets/${file.id}/shares/recipient`)
  assert.equal(browser.calls.at(-1)?.options.method, 'DELETE')
})

test('sharing responses from a previous account never populate the current account’s dialog', async () => {
  const file = fixtureFile('private.png', 'alice', 'owner')
  const browser = await renderBrowser({files: [file]})
  let finishTargets!: (result: unknown) => void
  let finishShares!: (result: unknown) => void
  browser.environment.fetch = (url: string) => new Promise(resolve => { if (url === '/api/assets/share-targets') finishTargets = resolve; else finishShares = resolve })
  const loading = browser.exposed.openSharing(file)
  browser.session.epoch.value += 1
  finishTargets({users: [{id: 'private-user', username: 'private-name', displayName: 'Private person'}]})
  finishShares({shares: [{recipientUserId: 'private-user', username: 'private-name', displayName: 'Private person', permission: 'edit'}]})
  await loading
  assert.deepEqual(browser.exposed.grants.value, [])
})

test('organization owner sees Team navigation while a member does not', async () => {
  const {default: Layout} = await import(layoutUrl)
  for (const isOwner of [false, true]) {
    ;(globalThis as any)[environmentKey] = {session: {account: ref({displayName: 'Cora', username: 'cora', organizationName: 'Studio'}), identity: ref('org.cora'), isOwner: ref(isOwner)}}
    const app = createSSRApp({render: () => h(Layout)})
    app.component('UIcon', {render: () => h('span')})
    app.component('NuxtLink', {props: ['to'], setup: (props: any, {slots}: any) => () => h('a', {href: props.to}, slots.default?.())})
    const html = await renderToString(app)
    assert.equal(html.includes('href="/team"'), isOwner)
    assert.match(html, /href="\/shared"/)
    assert.match(html, /Studio/)
  }
})

test('asset and model favorites stay isolated between user storage namespaces', () => {
  const data = new Map<string, string>()
  const storage = () => ({getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => {data.set(key, value)}})
  let identity = 'org.alice'
  const assets = createAssetFavourites(storage, () => `assets.${identity}`)
  const models = createImageModelFavourites(storage, () => `models.${identity}`)
  assets.toggle([], '/images/private.png'); models.toggle([], 'google/gemini-3.1-flash-image')
  identity = 'org.bea'
  assert.deepEqual(assets.load().urls, []); assert.deepEqual(models.load().ids, [])
  assets.toggle([], '/images/bea.png')
  identity = 'org.alice'
  assert.deepEqual(assets.load().urls, ['/images/private.png'])
  assert.deepEqual(models.load().ids, ['google/gemini-3.1-flash-image'])
})

test('permission denials preserve the session and late unauthorized responses cannot sign out a new account', async () => {
  const source = stripTypeScriptTypes(readFileSync(new URL('app/plugins/auth-fetch.ts', root), 'utf8')).replace('export default defineNuxtPlugin', 'return defineNuxtPlugin').replace('if (!import.meta.client) return', '')
  let hooks: any
  let clears = 0
  const session = {epoch: ref(0), clear() {clears += 1; this.epoch.value += 1}}
  const originalFetch = (globalThis as any).$fetch
  const fetch: any = async () => true
  fetch.create = (options: unknown) => {hooks = options; return fetch}
  ;(globalThis as any).$fetch = fetch
  const initialize = new Function('defineNuxtPlugin', 'useRouter', 'useAccount', 'useToast', 'navigateTo', source)
  try {
    initialize((callback: () => unknown) => callback(), () => ({currentRoute: ref({path: '/assets', fullPath: '/assets'})}), () => session, () => ({add() {}}), async () => undefined)
    const forbiddenOptions: any = {}; hooks.onRequest({options: forbiddenOptions})
    await hooks.onResponseError({response: {status: 403}, options: forbiddenOptions})
    assert.equal(clears, 0)
    const oldOptions: any = {}; hooks.onRequest({options: oldOptions}); session.epoch.value += 1
    await hooks.onResponseError({response: {status: 401}, options: oldOptions})
    assert.equal(clears, 0)
    const currentOptions: any = {}; hooks.onRequest({options: currentOptions})
    await hooks.onResponseError({response: {status: 401}, options: currentOptions})
    assert.equal(clears, 1)
  } finally { (globalThis as any).$fetch = originalFetch }
})
