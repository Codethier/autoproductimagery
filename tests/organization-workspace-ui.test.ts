import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks, stripTypeScriptTypes} from 'node:module'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {compileScript, parse} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import {computed, createSSRApp, h, ref, watch} from 'vue'
import {formatBalanceUsd, formatUsd} from '../app/utils/generationPrice.ts'
import {createAssetFavourites} from '../app/utils/assetPreferences.ts'
import {createImageModelFavourites} from '../app/utils/imageModelFavourites.ts'
import type {AssetFile, AssetFolder} from '../schemas/image-storage.ts'
import {prepareServerlessRequest, serverlessFetchOptions, SERVERLESS_MUTATION_TIMEOUT_MS} from '../app/utils/serverlessRequests.ts'

const root = new URL('../', import.meta.url)
const browserUrl = new URL('app/components/AssetBrowser.vue', root).href
const legacyFilesUrl = new URL('app/components/files.vue', root).href
const layoutUrl = new URL('app/layouts/workspace.vue', root).href
const balanceUrl = new URL('app/components/AccountBalanceSummary.vue', root).href
const teamUrl = new URL('app/pages/team.vue', root).href
const environmentKey = '__organizationWorkspaceUiTest'
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('~~/')) return nextResolve(new URL(`${specifier.slice(3)}.ts`, root).href, context)
    if (specifier.startsWith('~/')) return nextResolve(new URL(`app/${specifier.slice(2)}.ts`, root).href, context)
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url !== browserUrl && url !== legacyFilesUrl && url !== layoutUrl && url !== balanceUrl && url !== teamUrl) return nextLoad(url, context)
    const filename = fileURLToPath(url)
    let source = readFileSync(filename, 'utf8')
    if (url === browserUrl) source = source.replace('</script>', 'defineExpose({files, directories, rootFolders, loading, openSharing, shareTarget, shareRecipient, saveShare, revokeShare, grants, currentFolder, preview, selection, selectedMetadata, confirmSelection, fetchPage, view, backgroundRemovalSources, openBackgroundRemoval, choose, selectionLimit, selectionAnchor, clearSelection, search, sourceUserId})\n</script>')
    if (url === legacyFilesUrl) source = source.replace('import {useDataStore} from "~/stores/data.store";', '')
    if (url === teamUrl) source = source.replace('</script>', 'defineExpose({openBalance, saveBalance, balanceForm, balanceDetails, balanceError})\n</script>')
    const {descriptor} = parse(source, {filename})
    const compiled = compileScript(descriptor, {id: filename, inlineTemplate: true})
    const services = `
      const useRoute = () => ({path: '/assets', query: {}});
      const useRouter = () => ({currentRoute: ref({query: {}}), push: () => undefined});
      const useAccount = () => globalThis.${environmentKey}.session;
      const useDataStore = () => ({pendingGenerations: [], inputImages: [], models: [], maskImage: null});
      const useAccountBalance = () => ({balance: ref(null), pending: ref(false), error: ref(''), refresh: async () => {}});
      const usePeopleGenerationProgress = () => ({count: ref(0)});
      const definePageMeta = () => {};
      const useHead = () => {};
      const useFetch = () => ({data: ref(globalThis.${environmentKey}.listing ?? {users: [], total: 0}), status: ref('success'), error: ref(null), refresh: async () => {}});
      const useToast = () => ({add: () => undefined});
      const useRequestFetch = () => (...args) => globalThis.${environmentKey}.fetch(...args);
      const $fetch = (...args) => globalThis.${environmentKey}.fetch(...args);
      const useAssetFavourites = () => ({urls: ref([]), persistent: ref(true), toggle: () => undefined, remove: () => undefined});
    `
    return {format: 'module', shortCircuit: true, source: stripTypeScriptTypes(`import {computed, ref, reactive, watch, nextTick, onMounted, onBeforeUnmount, onServerPrefetch, provide} from 'vue';\n${services}\n${compiled.content}`)}
  },
})

function fixtureFile(name: string, sourceId: string, permission: 'owner' | 'edit' | 'view'): AssetFile {
  return {id: sourceId + '-' + name, ownerUserId: sourceId, name, url: `/images/organizations/org/users/${sourceId}/objects/blob/${name}`, folder: '/Spring', selectedImage: false, selectedModel: false, selectedMask: false,
    permissions: {view: true, edit: permission !== 'view', share: permission === 'owner'}, kind: 'file', source: {userId: sourceId, username: sourceId, displayName: sourceId === 'alice' ? 'Alice' : 'Bea'},
    ...(permission !== 'owner' ? {sharedBy: {userId: sourceId, username: sourceId, displayName: sourceId === 'alice' ? 'Alice' : 'Bea'}} : {})}
}
async function renderBrowser(options: {shared?: boolean; files?: AssetFile[]; dirs?: AssetFolder[]; rootFolders?: AssetFolder[]; actorId?: string; currentFolder?: AssetFolder; selected?: boolean; preview?: boolean; sharing?: boolean; pickerLimit?: number; pickerCap?: number; initialize?: (state: any, session: any) => void} = {}) {
  const calls: Array<{url: string; options: any}> = []
  const session = {account: ref({userId: options.actorId ?? 'member', organizationId: 'org', displayName: 'Member', username: 'member', role: 'user', organizationName: 'Studio'}), epoch: ref(0), identity: ref('org.member'), isOwner: ref(false)}
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
      environment.exposed = value; value.files.value = options.files ?? []; value.directories.value = options.dirs ?? []; value.rootFolders.value = options.rootFolders ?? []; value.loading.value = false; if (options.currentFolder) value.currentFolder.value = options.currentFolder; if (options.selected) {value.selection.value = options.files?.map(file => file.url) ?? []; for (const file of options.files ?? []) value.selectedMetadata.value.set(file.url, file)}; if (options.preview) value.preview.value = options.files?.[0]; if (options.sharing) {value.shareTarget.value = options.files?.[0]; value.grants.value = [{id: 'legacy-grant', recipientUserId: 'recipient', permission: 'edit', username: 'cora', displayName: 'Cora', createdAt: '2026-10-12T00:00:00.000Z'}]}; options.initialize?.(value, session); context.expose(value)
    }})
  }}
  const app = createSSRApp({render: () => h(component, {initialScope: options.shared ? 'shared' : 'all', sharedOnly: options.shared, ...(options.pickerLimit !== undefined ? {selectionMode: 'multiple', maxSelection: options.pickerLimit, selectionCap: options.pickerCap} : {})})})
  app.component('UIcon', {render: () => h('span', {'aria-hidden': 'true'})})
  app.component('BackgroundRemovalPanel', {render: () => null})
  app.component('NuxtLink', {props: ['to'], setup: (props: any, {slots}: any) => () => h('a', {href: typeof props.to === 'string' ? props.to : props.to.path}, slots.default?.())})
  const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
  const html = await renderToString(app)
  assert.deepEqual(warnings, [])
  return {html, exposed: environment.exposed, calls, environment, session}
}

function fixtureFolder(name: string, itemCount?: number, shared = false): AssetFolder {
  return {id: `folder-${name}`, ownerUserId: 'alice', name, url: `/images/organizations/org/users/alice/${name}`, path: `/${name}`, kind: 'folder',
    permissions: {view: true, edit: !shared, share: !shared}, ...(itemCount === undefined ? {} : {itemCount}),
    ...(shared ? {sharedBy: {userId: 'alice', username: 'alice', displayName: 'Alice'}} : {})}
}

test('folder chips and cards show known item counts including zero without inventing a count for unknown folders', async () => {
  const folders = [fixtureFolder('Spring collection', 12), fixtureFolder('Empty collection', 0), fixtureFolder('Older collection')]
  const browser = await renderBrowser({dirs: folders, rootFolders: folders, actorId: 'alice'})
  const badges = [...browser.html.matchAll(/class="asset-folder-count"[^>]*>(\d+)</g)].map(match => match[1])
  assert.deepEqual(badges, ['12', '0', '12', '0'])
  assert.equal([...browser.html.matchAll(/aria-label="12 items"/g)].length, 2)
  assert.equal([...browser.html.matchAll(/aria-label="0 items"/g)].length, 2)
  assert.match(browser.html, /title="Older collection"/)
  assert.doesNotMatch(browser.html, /undefined items|NaN items/)
})

test('shared folder cards retain their source and view access alongside an accessible singular item count', async () => {
  const browser = await renderBrowser({shared: true, dirs: [fixtureFolder('Shared references', 1, true)]})
  assert.match(browser.html, /From Alice/)
  assert.match(browser.html, /class="asset-folder-count" aria-label="1 item" title="1 item">1</)
  assert.match(browser.html, /Can view/)
  assert.doesNotMatch(browser.html, /aria-label="Delete folder|aria-label="Share folder/)
})

test('legacy folder picker displays known counts and preserves missing count metadata', async () => {
  ;(globalThis as any)[environmentKey] = {listing: {files: [], dirs: [fixtureFolder('Products', 8), fixtureFolder('Empty', 0), fixtureFolder('Unknown')]}}
  const {default: Files} = await import(legacyFilesUrl)
  const app = createSSRApp({render: () => h(Files)})
  for (const name of ['UIcon', 'UBreadcrumb', 'UFileUpload', 'UPopover', 'UButton', 'UInput', 'UCheckbox']) app.component(name, {render() {return h('div', this.$slots.default?.())}})
  const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message)
  const html = await renderToString(app)
  assert.deepEqual(warnings, [])
  assert.deepEqual([...html.matchAll(/class="files-folder-count"[^>]*>(\d+)</g)].map(match => match[1]), ['8', '0'])
  assert.match(html, /aria-label="8 items"/)
  assert.match(html, /aria-label="0 items"/)
  assert.match(html, /title="Unknown"/)
})

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

test('personal file sharing grants view access with recipient IDs, then revokes only that grant', async () => {
  const file = fixtureFile('serum.png', 'alice', 'owner')
  const browser = await renderBrowser({files: [file], actorId: 'alice'})
  assert.match(browser.html, /aria-label="Share serum.png"/)
  await browser.exposed.openSharing(file)
  assert.equal(browser.calls[0].url, '/api/assets/share-targets')
  assert.equal(browser.calls[1].url, `/api/assets/${file.id}/shares`)
  browser.exposed.shareRecipient.value = 'recipient'
  await browser.exposed.saveShare()
  assert.deepEqual(browser.calls.find(call => call.options?.method === 'POST')?.options.body, {recipientUserId: 'recipient'})
  await browser.exposed.revokeShare(browser.exposed.grants.value[0])
  assert.equal(browser.calls.at(-1)?.url, `/api/assets/${file.id}/shares/recipient`)
  assert.equal(browser.calls.at(-1)?.options.method, 'DELETE')
})

test('sharing dialog has one view permission and displays historical grants as view access', async () => {
  const browser = await renderBrowser({files: [fixtureFile('serum.png', 'alice', 'owner')], actorId: 'alice', sharing: true})
  assert.match(browser.html, /Can view/)
  assert.match(browser.html, /Recipients can view, download, and use these images as generation inputs/)
  assert.doesNotMatch(browser.html, /Sharing permission|Can edit|value="edit"/)
})

test('received files and folders stay read-only even when older metadata claims edit permissions', async () => {
  const file = fixtureFile('legacy-shared.png', 'alice', 'edit')
  file.permissions!.share = true
  const folder: AssetFolder = {id: 'folder', ownerUserId: 'alice', name: 'Spring', url: '/images/organizations/org/users/alice/Spring', path: '/Spring', kind: 'folder', permissions: {view: true, edit: true, share: true}, sharedBy: file.sharedBy}
  const browser = await renderBrowser({shared: true, files: [file], dirs: [folder], currentFolder: folder, selected: true, preview: true})
  assert.match(browser.html, /Download/)
  assert.match(browser.html, /Use in editor/)
  assert.match(browser.html, /Can view/)
  assert.doesNotMatch(browser.html, /Can edit|New folder|>Upload images<|>Delete<|aria-label="Delete folder|aria-label="Share legacy-shared/)
  await browser.exposed.openSharing(file)
  assert.deepEqual(browser.calls, [])
})

test('sharing responses from a previous account never populate the current account’s dialog', async () => {
  const file = fixtureFile('private.png', 'alice', 'owner')
  const browser = await renderBrowser({files: [file], actorId: 'alice'})
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
    ;(globalThis as any)[environmentKey] = {session: {account: ref({displayName: 'Cora', username: 'cora', organizationName: 'Studio'}), identity: ref('org.cora'), epoch: ref(1), isOwner: ref(isOwner)}}
    const app = createSSRApp({render: () => h(Layout)})
    app.component('GenerationCreditDialog', {render: () => null})
    app.component('UIcon', {render: () => h('span')})
    app.component('NuxtLink', {props: ['to'], setup: (props: any, {slots}: any) => () => h('a', {href: props.to}, slots.default?.())})
    const html = await renderToString(app)
    assert.equal(html.includes('href="/team"'), isOwner)
    assert.match(html, /href="\/shared"/)
    assert.match(html, /href="\/people"/)
    assert.match(html, /Studio/)
  }
})

test('library thumbnails and previews withhold generated files with pending prices but retain uploaded media', async () => {
  const generated = {...fixtureFile('pending.png', 'alice', 'owner'), category: 'generated' as const, priceUsd: '0.050000000000', priceSource: 'estimate', billingState: 'pending'}
  const upload = fixtureFile('uploaded.png', 'alice', 'owner')
  const browser = await renderBrowser({files: [generated, upload], actorId: 'alice', preview: true})
  assert.match(browser.html, /Confirming price/)
  assert.match(browser.html, /\$0\.05 · estimate, final price pending/)
  assert.equal(browser.html.includes(`/api/data${generated.url}`), false)
  assert.equal(browser.html.includes(`href="/api/data${generated.url}"`), false)
  assert.equal(browser.html.includes(`src="/api/data${upload.url}?preview=480"`), true)
  const confirmed = await renderBrowser({files: [{...generated, priceUsd: '0.000000000000', priceSource: 'gateway', billingState: 'confirmed'}], actorId: 'alice', preview: true})
  assert.equal(confirmed.html.includes(`src="/api/data${generated.url}?preview=480"`), true)
  assert.equal(confirmed.html.includes(`src="/api/data${generated.url}?preview=1600"`), true)
  assert.equal(confirmed.html.includes(`href="/api/data${generated.url}"`), true, 'downloads preserve the original image bytes')
  assert.match(confirmed.html, /\$0\.00 · confirmed/)
  assert.match(confirmed.html, /Download/)
})

test('shared library grids request small previews while the modal and download keep separate image representations', async () => {
  const file = fixtureFile('shared-product.png', 'alice', 'view')
  const browser = await renderBrowser({shared: true, files: [file], preview: true})
  assert.equal(browser.html.includes(`src="/api/data${file.url}?preview=480"`), true)
  assert.equal(browser.html.includes(`src="/api/data${file.url}?preview=1600"`), true)
  assert.equal(browser.html.includes(`href="/api/data${file.url}"`), true)
  assert.equal(browser.html.includes(`src="/api/data${file.url}"`), false, 'a CSS thumbnail must not download an original')
  assert.match(browser.html, /decoding="async"/)
})

test('library previews and selected shared images offer cutouts while the source stays read-only', async () => {
  const source = fixtureFile('shared-product.png', 'alice', 'view')
  const browser = await renderBrowser({shared: true, files: [source], selected: true, preview: true})
  assert.match(browser.html, /Remove background/)
  assert.match(browser.html, /Remove backgrounds/)
  browser.exposed.openBackgroundRemoval([source.url])
  assert.deepEqual(browser.exposed.backgroundRemovalSources.value, [source.url])
  assert.equal(browser.exposed.preview.value, undefined)
  assert.equal(browser.exposed.files.value[0].url, source.url)
  assert.deepEqual(browser.calls, [])
})

test('completed local cutouts use normal library previews with their separate zero provider charge', async () => {
  const cutout: AssetFile = {...fixtureFile('product-cutout.png', 'alice', 'owner'), category: 'processed', processingPurpose: 'background-removal', priceUsd: '0', priceSource: 'local-processing'}
  const browser = await renderBrowser({files: [cutout], actorId: 'alice', preview: true})
  assert.match(browser.html, /\$0 provider charge · background removal/)
  assert.equal(browser.html.includes(`src="/api/data${cutout.url}?preview=480"`), true)
  assert.equal(browser.html.includes(`href="/api/data${cutout.url}"`), true)
  assert.doesNotMatch(browser.html, /Confirming price|estimate/)
})
test('pipeline images use a pipeline-processing label in library cards and original previews', async () => {
  const processed: AssetFile = {...fixtureFile('Crop.png', 'alice', 'owner'), category: 'processed', processingPurpose: 'pipeline', priceUsd: '0', priceSource: 'local-processing'}
  const browser = await renderBrowser({files: [processed], actorId: 'alice', preview: true})
  assert.equal((browser.html.match(/\$0 provider charge · pipeline processing/g) ?? []).length, 2)
  assert.doesNotMatch(browser.html, /\$0 provider charge · background removal/)
  const generic = await renderBrowser({files: [{...processed, processingPurpose: 'local'}], actorId: 'alice'})
  assert.match(generic.html, /\$0 provider charge · local processing/)
})
test('the Library pipeline picker accepts fifty existing images and refuses a fifty-first', async () => {
  const files = Array.from({length: 51}, (_, index) => fixtureFile(`product-${index}.png`, 'alice', 'owner'))
  const browser = await renderBrowser({files, actorId: 'alice', pickerLimit: 50, pickerCap: 50})
  for (const file of files) browser.exposed.choose(file)
  assert.equal(browser.exposed.selectionLimit.value, 50)
  assert.equal(browser.exposed.selection.value.length, 50)
  const normal = await renderBrowser({files, actorId: 'alice', pickerLimit: 50})
  assert.equal(normal.exposed.selectionLimit.value, 20)
})

test('Library Shift selection follows visible source grouping, keeps outside images, and honors picker slots', async () => {
  const files = [fixtureFile('a.png', 'alice', 'view'), fixtureFile('b.png', 'bea', 'view'), fixtureFile('c.png', 'alice', 'view'), fixtureFile('d.png', 'bea', 'view')]
  const browser = await renderBrowser({files, shared: true, pickerLimit: 4, pickerCap: 50})
  browser.exposed.selection.value = ['/images/another-folder.png']
  browser.exposed.choose(files[0])
  browser.exposed.choose(files[3], {shiftKey: true})
  assert.deepEqual(browser.exposed.selection.value, ['/images/another-folder.png', files[0]!.url, files[2]!.url, files[1]!.url])
  assert.equal(browser.exposed.selectedMetadata.value.has(files[2]!.url), true)
  assert.equal(browser.exposed.selectedMetadata.value.has(files[3]!.url), false)
  browser.exposed.choose(files[3], {shiftKey: true})
  assert.equal(new Set(browser.exposed.selection.value).size, 4)
  browser.exposed.clearSelection()
  assert.equal(browser.exposed.selectionAnchor.value, '')
  assert.deepEqual(browser.exposed.selection.value, [])
})

test('Library changing search, sharer or account resets a Shift anchor before another click', async () => {
  const files = Array.from({length: 4}, (_, index) => fixtureFile(`${index}.png`, 'alice', 'owner'))
  // Run while the component's synchronous watchers are alive during setup.
  await renderBrowser({files, actorId: 'alice', pickerLimit: 5, initialize(state, session) {
    state.choose(files[0]); state.search.value = 'a new filter'
    assert.equal(state.selectionAnchor.value, '')
    state.choose(files[3], {shiftKey: true})
    assert.deepEqual(state.selection.value, [files[0]!.url, files[3]!.url])
    state.sourceUserId.value = 'bea'; assert.equal(state.selectionAnchor.value, '')
    state.choose(files[1]); session.epoch.value += 1
    assert.equal(state.selectionAnchor.value, '')
    assert.deepEqual(state.selection.value, [])
  }})
})

test('balance summary separates available credit, outstanding estimates and exact confirmed charges', async () => {
  const {default: Balance} = await import(balanceUrl)
  for (const unlimited of [true, false]) {
    const app = createSSRApp({render: () => h(Balance, {balance: {currency: 'USD', confirmedSpendUsd: '0.000000000001', outstandingEstimateUsd: '0.120000000000', outstandingCount: 3, outstandingUnknownCount: 1, actualBalanceUsd: unlimited ? null : '-0.005000000001', unlimited}})})
    app.component('UIcon', {render: () => h('span')})
    const html = await renderToString(app)
    assert.match(html, /Actual balance/)
    assert.match(html, /Outstanding balance/)
    assert.match(html, /Confirmed spend/)
    assert.match(html, /\$0\.000000000001/)
    assert.match(html, /\$0\.12/)
    assert.match(html, /3 generations awaiting final cost/)
    assert.match(html, /1 without an estimate/)
    assert.match(html, unlimited ? /<strong>Unlimited<\/strong>/ : /−\$0\.005000000001/)
  }
  assert.equal(formatUsd('0.000000000001'), '$0.000000000001')
  assert.equal(formatBalanceUsd('-0.000000000001'), '−$0.000000000001')
})

test('a late balance response cannot populate or override another user’s active balance request', async () => {
  const source = stripTypeScriptTypes(readFileSync(new URL('app/composables/useAccountBalance.ts', root), 'utf8')).replace(/import \{serverlessFetchOptions\} from '[^']+'/, '').replace('export function useAccountBalance', 'return function useAccountBalance')
  const state = ref<any>({identity: '', epoch: -1, balance: null, pending: false, error: ''})
  const account = {identity: ref('org.alice'), epoch: ref(1)}
  const completions: Array<(response: unknown) => void> = []
  const useBalance = new Function('computed', 'watch', 'useAccount', 'useState', 'useRequestFetch', 'serverlessFetchOptions', source)(computed, watch, () => account, () => state, () => () => new Promise(resolve => completions.push(resolve)), serverlessFetchOptions)
  const balance = useBalance()
  const alice = balance.refresh()
  account.identity.value = 'org.bea'; account.epoch.value += 1
  assert.equal(balance.balance.value, null)
  const bea = balance.refresh()
  completions[0]!({actualBalanceUsd: '500.000000000000', unlimited: false})
  await alice
  assert.equal(balance.balance.value, null)
  assert.equal(balance.pending.value, true)
  completions[1]!({actualBalanceUsd: null, unlimited: true, outstandingCount: 0})
  await bea
  assert.equal(balance.balance.value.unlimited, true)
  assert.equal(balance.pending.value, false)
})

test('owner balance controls preserve exact USD input, support Unlimited and discard stale account responses', async () => {
  const {default: Team} = await import(teamUrl)
  const session = {account: ref({userId: 'owner', organizationName: 'Studio'}), epoch: ref(1), identity: ref('org.owner'), isOwner: ref(true)}
  const calls: Array<{url: string; options: any}> = []
  const baseBalance = {currency: 'USD', confirmedSpendUsd: '0.000000000000', outstandingEstimateUsd: '0.000000000000', outstandingCount: 0, outstandingUnknownCount: 0, actualBalanceUsd: null, unlimited: true}
  const environment: any = {session, fetch: async (url: string, options: any) => {calls.push({url, options}); return {userId: 'member', balance: baseBalance}}}
  ;(globalThis as any)[environmentKey] = environment
  let exposed: any
  const originalSetup = Team.setup
  const component = {...Team, setup(props: unknown, context: any) {return originalSetup(props, {...context, expose(value: unknown) {exposed = value; context.expose(value)}})}}
  const app = createSSRApp({render: () => h(component)})
  app.component('UIcon', {render: () => h('span')})
  app.component('AccountBalanceSummary', {render: () => h('div')})
  app.component('AccountPaymentHistory', {render: () => h('div')})
  await renderToString(app)
  const member = {id: 'member', username: 'member', displayName: 'Mira', role: 'user', disabled: false, createdAt: '2026-10-13T00:00:00Z'}
  await exposed.openBalance(member)
  exposed.balanceForm.unlimited = false
  exposed.balanceForm.actualBalanceUsd = '12.123456789012'
  await exposed.saveBalance()
  assert.deepEqual(calls.at(-1), {url: '/api/org/users/member/balance', options: {method: 'PATCH', body: {actualBalanceUsd: '12.123456789012'}}})
  exposed.balanceForm.unlimited = true
  await exposed.saveBalance()
  assert.equal(calls.at(-1)!.options.body.actualBalanceUsd, null)
  const savedCalls = calls.length
  exposed.balanceForm.unlimited = false
  exposed.balanceForm.actualBalanceUsd = '1e6'
  await exposed.saveBalance()
  assert.equal(calls.length, savedCalls)
  assert.match(exposed.balanceError.value, /nonnegative USD amount/)
  let finish!: (value: unknown) => void
  environment.fetch = () => new Promise(resolve => {finish = resolve})
  const loading = exposed.openBalance(member)
  session.identity.value = 'org.bea'; session.epoch.value += 1
  finish({userId: 'member', balance: {...baseBalance, actualBalanceUsd: '900.000000000000', unlimited: false}})
  await loading
  assert.equal(exposed.balanceDetails.value, null)
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
  const source = stripTypeScriptTypes(readFileSync(new URL('app/plugins/auth-fetch.ts', root), 'utf8')).replace(/import \{prepareServerlessRequest, SERVERLESS_MUTATION_TIMEOUT_MS\} from '[^']+'/, '').replace('export default defineNuxtPlugin', 'return defineNuxtPlugin').replace('if (!import.meta.client) return', '')
  let hooks: any
  let clears = 0
  const session = {epoch: ref(0), clear() {clears += 1; this.epoch.value += 1}}
  const originalFetch = (globalThis as any).$fetch
  const fetch: any = async () => true
  fetch.create = (options: unknown) => {hooks = options; return fetch}
  ;(globalThis as any).$fetch = fetch
  const initialize = new Function('defineNuxtPlugin', 'useRouter', 'useAccount', 'useToast', 'navigateTo', 'prepareServerlessRequest', 'SERVERLESS_MUTATION_TIMEOUT_MS', source)
  try {
    initialize((callback: () => unknown) => callback(), () => ({currentRoute: ref({path: '/assets', fullPath: '/assets'})}), () => session, () => ({add() {}}), async () => undefined, prepareServerlessRequest, SERVERLESS_MUTATION_TIMEOUT_MS)
    const forbiddenOptions: any = {}; hooks.onRequest({options: forbiddenOptions})
    await hooks.onResponseError({response: {status: 403}, options: forbiddenOptions})
    assert.equal(clears, 0)
    const oldOptions: any = {}; hooks.onRequest({options: oldOptions}); session.epoch.value += 1
    hooks.onRequest({options: oldOptions})
    await hooks.onResponseError({response: {status: 401}, options: oldOptions})
    assert.equal(clears, 0)
    const currentOptions: any = {}; hooks.onRequest({options: currentOptions})
    await hooks.onResponseError({response: {status: 401}, options: currentOptions})
    assert.equal(clears, 1)
  } finally { (globalThis as any).$fetch = originalFetch }
})
