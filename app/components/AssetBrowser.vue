<script setup lang="ts">
import type {SelectableFile} from '~~/schemas/main.dto'
import type {AssetFile, AssetListingPage} from '~~/schemas/image-storage'
import {assetFromImageUrl, assetSelectionLimit, MAX_ASSET_FAVOURITES, toggleAssetSelection, validateAssetUploads} from '~/utils/assetPreferences'

const props = withDefaults(defineProps<{
  selectionMode?: 'single' | 'multiple'
  selectedUrls?: string[]
  acceptedExtensions?: string[]
  maxSelection?: number
  initialPath?: string
  title?: string
}>(), {selectedUrls: () => [], acceptedExtensions: () => [], initialPath: '/', title: 'Assets'})
const emit = defineEmits<{
  'update:selectedUrls': [urls: string[]]
  select: [file: SelectableFile]
  confirm: [files: SelectableFile[]]
  navigate: [path: string]
  deleted: [urls: string[]]
}>()

type View = 'all' | 'uploads' | 'generated' | 'favourites' | 'folder'
type FolderPage = {files: SelectableFile[]; dirs: Array<{name: string}>; nextCursor?: string}
const toast = useToast()
const browserElement = ref<HTMLElement>()
const requestFetch = useRequestFetch()
const favourites = useAssetFavourites()
const view = ref<View>(props.initialPath === '/' ? 'all' : 'folder')
const folderPath = ref(props.initialPath)
const files = ref<AssetFile[]>([])
const directories = ref<Array<{name: string}>>([])
const rootFolders = ref<Array<{name: string}>>([])
const rootCursor = ref<string>()
const foldersLoading = ref(false)
const nextCursor = ref<string>()
const search = ref('')
const keyword = ref('')
const loading = ref(true)
const loadingMore = ref(false)
const errorMessage = ref('')
const uploading = ref(false)
const deleting = ref(false)
const creating = ref(false)
const newFolderOpen = ref(false)
const newFolderName = ref('')
const newFolderInput = ref<HTMLInputElement>()
const fileInput = ref<HTMLInputElement>()
const density = ref<'compact' | 'comfortable'>('comfortable')
const selection = ref<string[]>([])
const preview = ref<AssetFile>()
const unavailable = ref(new Set<string>())
const deleteTarget = ref<{files?: AssetFile[]; directory?: {name: string; path: string}}>()
const dragDepth = ref(0)
let requestNumber = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined
let listingAbort: AbortController | undefined
let focusBeforeDialog: HTMLElement | null = null

const isPicker = computed(() => Boolean(props.selectionMode))
const selectionLimit = computed(() => assetSelectionLimit(props.selectionMode, props.maxSelection))
const favouriteSet = computed(() => new Set(favourites.urls.value))
const uploadPath = computed(() => view.value === 'folder' ? folderPath.value : '/')
const scopeTitle = computed(() => ({all: 'All images', uploads: 'Uploads', generated: 'Generated images', favourites: 'Favorites', folder: folderPath.value.split('/').filter(Boolean).at(-1) ?? 'Folders'})[view.value])
const displayFiles = computed(() => view.value === 'favourites'
  ? favourites.urls.value.flatMap(url => {
    const file = assetFromImageUrl(url)
    return file && (!keyword.value || `${file.folder}/${file.name}`.toLocaleLowerCase().includes(keyword.value.toLocaleLowerCase())) ? [file] : []
  }) : files.value)
const selectedSet = computed(() => new Set(selection.value))
const selectedFiles = computed(() => selection.value.flatMap(url => {
  const file = displayFiles.value.find(item => item.url === url) ?? assetFromImageUrl(url)
  return file ? [file] : []
}))
const breadcrumbs = computed(() => {
  const parts = folderPath.value.split('/').filter(Boolean)
  return [{name: 'Folders', path: '/'}, ...parts.map((name, index) => ({name, path: '/' + parts.slice(0, index + 1).join('/')}))]
})
const emptyTitle = computed(() => keyword.value ? 'No matching images on this page'
  : view.value === 'favourites' ? 'Your favorites belong here' : 'No images yet')

function permitted(file: AssetFile) {
  if (isPicker.value && selectionLimit.value === 0) return false
  return !props.acceptedExtensions.length || props.acceptedExtensions.some(extension => file.name.toLowerCase().endsWith('.' + extension.replace(/^\./, '').toLowerCase()))
}
function syncSelection(urls: readonly string[]) {
  const valid = urls.filter(url => { const file = assetFromImageUrl(url); return file && permitted(file) })
  selection.value = [...new Set(valid)].slice(0, selectionLimit.value)
}
watch(() => props.selectedUrls, syncSelection, {immediate: true, deep: true})
watch(() => props.acceptedExtensions, () => syncSelection(selection.value), {deep: true})
watch(() => [props.maxSelection, props.selectionMode], () => syncSelection(selection.value))
watch(() => props.initialPath, path => { if (path !== folderPath.value) enterFolder(path) })
watch(search, value => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { keyword.value = value.trim(); void refresh() }, 250)
})
watch(newFolderOpen, async open => { if (open) { await nextTick(); newFolderInput.value?.focus() } })
watch([newFolderOpen, deleteTarget, preview], async () => {
  const open = newFolderOpen.value || Boolean(deleteTarget.value || preview.value)
  if (open && !focusBeforeDialog) focusBeforeDialog = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick()
  if (open) browserElement.value?.querySelector<HTMLElement>('[role="dialog"] input, [role="dialog"] button')?.focus()
  else { if (focusBeforeDialog?.isConnected) focusBeforeDialog.focus(); focusBeforeDialog = null }
})

function safeMessage(error: unknown, fallback: string): string {
  const e = error as {data?: {statusMessage?: string}; statusMessage?: string}
  return e?.data?.statusMessage ?? e?.statusMessage ?? fallback
}
function appendPage(page: AssetListingPage & {dirs?: Array<{name: string}>}) {
  const known = new Set(files.value.map(file => file.url))
  files.value.push(...page.files.filter(file => !known.has(file.url)))
  nextCursor.value = page.nextCursor
  const knownDirs = new Set(directories.value.map(dir => dir.name))
  directories.value.push(...(page.dirs ?? []).filter(dir => !knownDirs.has(dir.name)))
}
async function refreshFolders(more = false) {
  if (foldersLoading.value || (more && !rootCursor.value)) return
  foldersLoading.value = true
  try {
    const page = await requestFetch<FolderPage>('/api/files', {query: {path: '/', limit: 100, ...(more ? {cursor: rootCursor.value} : {})}})
    rootFolders.value = more ? [...rootFolders.value, ...page.dirs.filter(dir => !rootFolders.value.some(known => known.name === dir.name))] : page.dirs
    rootCursor.value = page.nextCursor
  } catch { /* The main browser displays storage failures and offers retry. */ }
  finally { foldersLoading.value = false }
}
async function fetchPage(cursor?: string) {
  if (view.value === 'folder' && !keyword.value) {
    const currentPath = folderPath.value
    const page = await requestFetch<FolderPage>('/api/files', {query: {path: folderPath.value, limit: 60, cursor}, signal: listingAbort?.signal})
    return {files: page.files.map(file => ({...file, folder: currentPath})), dirs: page.dirs, nextCursor: page.nextCursor}
  }
  return requestFetch<AssetListingPage>('/api/assets', {
    query: {scope: view.value === 'uploads' || view.value === 'generated' ? view.value : 'all', path: view.value === 'folder' ? folderPath.value : '/', query: keyword.value, limit: 60, cursor},
    signal: listingAbort?.signal,
  })
}
async function refresh() {
  const number = ++requestNumber
  listingAbort?.abort()
  listingAbort = new AbortController()
  loading.value = true
  loadingMore.value = false
  files.value = []
  directories.value = []
  nextCursor.value = undefined
  errorMessage.value = ''
  if (view.value === 'favourites') { loading.value = false; return }
  try {
    const page = await fetchPage()
    if (number === requestNumber) appendPage(page)
  } catch (error) { if (number === requestNumber) errorMessage.value = safeMessage(error, 'Could not load your images. Please try again.') }
  finally { if (number === requestNumber) loading.value = false }
}
async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  const number = requestNumber
  loadingMore.value = true
  errorMessage.value = ''
  try {
    const page = await fetchPage(nextCursor.value)
    if (number === requestNumber) appendPage(page)
  } catch (error) { if (number === requestNumber) errorMessage.value = safeMessage(error, 'Could not load more images. Please try again.') }
  finally { if (number === requestNumber) loadingMore.value = false }
}
function changeView(next: View) {
  view.value = next
  folderPath.value = '/'
  search.value = ''
  keyword.value = ''
  clearTimeout(searchTimer)
  emit('navigate', '/')
  void refresh()
}
function enterFolder(path: string) {
  folderPath.value = path
  view.value = 'folder'
  emit('navigate', path)
  void refresh()
}
function childPath(name: string) { return `${folderPath.value === '/' ? '' : folderPath.value}/${name}` }
function choose(file: AssetFile) {
  if (!permitted(file)) return
  const max = selectionLimit.value
  if (!selectedSet.value.has(file.url) && selection.value.length >= max && props.selectionMode !== 'single') {
    toast.add({title: `Select up to ${max} images`, color: 'warning'}); return
  }
  selection.value = toggleAssetSelection(selection.value, file.url, props.selectionMode ?? 'multiple')
  emit('update:selectedUrls', [...selection.value])
  emit('select', file)
}
function clearSelection() { selection.value = []; emit('update:selectedUrls', []) }
function toggleFavourite(file: AssetFile) {
  if (!favouriteSet.value.has(file.url) && favourites.urls.value.length >= MAX_ASSET_FAVOURITES) {
    toast.add({title: `You can save up to ${MAX_ASSET_FAVOURITES} favorites`, color: 'warning'}); return
  }
  favourites.toggle(file.url)
}
function markUnavailable(url: string) { unavailable.value = new Set([...unavailable.value, url]) }
function openPreview(file: AssetFile) { preview.value = file }
function confirmSelection() { emit('confirm', selectedFiles.value) }

async function uploadFiles(chosen: File[]) {
  if (uploading.value) return
  const invalid = validateAssetUploads(chosen)
  if (invalid) { toast.add({title: 'Could not upload images', description: invalid, color: 'error'}); return }
  const target = uploadPath.value
  const body = new FormData()
  body.append('path', target)
  chosen.forEach(file => body.append('files', file))
  uploading.value = true
  try {
    const result = await $fetch<{saved: string[]; failed: Array<{filename: string; reason: string}>}>('/api/upload', {method: 'POST', body})
    if (result.saved.length) toast.add({title: `${result.saved.length} image${result.saved.length === 1 ? '' : 's'} uploaded`, color: 'success'})
    if (result.failed.length) toast.add({title: 'Some images could not be uploaded', description: result.failed.map(file => `${file.filename}: ${file.reason}`).join('\n'), color: 'error'})
    if (isPicker.value && result.saved.length) {
      const uploaded = result.saved.flatMap(name => {
        const url = '/images/' + [...target.split('/').filter(Boolean), name].map(encodeURIComponent).join('/')
        const file = assetFromImageUrl(url)
        return file && permitted(file) ? [file] : []
      })
      const max = selectionLimit.value
      selection.value = props.selectionMode === 'single' ? uploaded.slice(0, max).map(file => file.url)
        : [...new Set([...selection.value, ...uploaded.map(file => file.url)])].slice(0, max)
      emit('update:selectedUrls', [...selection.value])
    }
    if (view.value === 'generated' || view.value === 'favourites') changeView('uploads')
    else await refresh()
    await refreshFolders()
  } catch (error) { toast.add({title: 'Upload failed', description: safeMessage(error, 'Please try again.'), color: 'error'}) }
  finally { uploading.value = false; if (fileInput.value) fileInput.value.value = '' }
}
function onFilesChanged(event: Event) { const input = event.target as HTMLInputElement; if (input.files?.length) void uploadFiles([...input.files]) }
function dragEnter(event: DragEvent) { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth.value += 1 } }
function dragLeave() { dragDepth.value = Math.max(0, dragDepth.value - 1) }
function dropFiles(event: DragEvent) { event.preventDefault(); dragDepth.value = 0; if (event.dataTransfer?.files.length) void uploadFiles([...event.dataTransfer.files]) }
async function createFolder() {
  const name = newFolderName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    await $fetch('/api/createFolder', {method: 'POST', body: {path: uploadPath.value, name}})
    newFolderOpen.value = false
    newFolderName.value = ''
    await Promise.all([refresh(), refreshFolders()])
    toast.add({title: `Folder “${name}” created`, color: 'success'})
  } catch (error) { toast.add({title: 'Could not create folder', description: safeMessage(error, 'Please try again.'), color: 'error'}) }
  finally { creating.value = false }
}
async function deleteEntries() {
  const target = deleteTarget.value
  if (!target || deleting.value) return
  deleting.value = true
  const deletedUrls: string[] = []
  try {
    if (target.directory) {
      await $fetch('/api/deleteFileOrFolder', {method: 'DELETE', body: {path: target.directory.path, entryType: 'directory'}})
      const prefix = '/images/' + target.directory.path.split('/').filter(Boolean).map(encodeURIComponent).join('/') + '/'
      deletedUrls.push(...selection.value.filter(url => url.startsWith(prefix)))
      favourites.remove(prefix, true)
    } else for (const file of target.files ?? []) {
      await $fetch('/api/deleteFileOrFolder', {method: 'DELETE', body: {path: `${file.folder === '/' ? '' : file.folder}/${file.name}`, entryType: 'file'}})
      deletedUrls.push(file.url)
      favourites.remove(file.url)
    }
    toast.add({title: target.directory ? 'Folder deleted' : `${deletedUrls.length} image${deletedUrls.length === 1 ? '' : 's'} deleted`, color: 'success'})
    deleteTarget.value = undefined
  } catch (error) {
    deleteTarget.value = undefined
    toast.add({title: 'Deletion stopped', description: safeMessage(error, 'Some images could not be deleted. Refresh and try again.'), color: 'error'})
  } finally {
    selection.value = selection.value.filter(url => !deletedUrls.includes(url))
    if (deletedUrls.length) { emit('update:selectedUrls', [...selection.value]); emit('deleted', deletedUrls) }
    if (preview.value && deletedUrls.includes(preview.value.url)) preview.value = undefined
    await Promise.all([refresh(), refreshFolders()])
    deleting.value = false
  }
}
function onKeydown(event: KeyboardEvent) {
  const dialog = browserElement.value?.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (!deleting.value && !creating.value) { preview.value = undefined; deleteTarget.value = undefined; newFolderOpen.value = false }
  }
  if (event.key === 'Tab') {
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')]
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
onMounted(() => { void refresh(); void refreshFolders(); window.addEventListener('keydown', onKeydown, {capture: true}) })
onBeforeUnmount(() => { listingAbort?.abort(); clearTimeout(searchTimer); window.removeEventListener('keydown', onKeydown, {capture: true}) })
</script>

<template>
  <section ref="browserElement" class="asset-browser" :class="{'asset-browser--picker': isPicker}" @dragenter="dragEnter" @dragleave="dragLeave" @dragover.prevent @drop="dropFiles">
    <aside class="asset-rail" aria-label="Asset library">
      <div class="asset-rail-heading"><UIcon name="i-lucide-folder"/><span>{{ title }}</span></div>
      <nav class="asset-views">
        <button type="button" :class="{active: view === 'all'}" @click="changeView('all')"><UIcon name="i-lucide-layout-grid"/>All images</button>
        <button type="button" :class="{active: view === 'uploads'}" @click="changeView('uploads')"><UIcon name="i-lucide-image"/>Uploads</button>
        <button type="button" :class="{active: view === 'favourites'}" @click="changeView('favourites')"><UIcon name="i-lucide-heart"/>Favorites<span v-if="favourites.urls.value.length" class="asset-count">{{ favourites.urls.value.length }}</span></button>
        <button type="button" :class="{active: view === 'generated'}" @click="changeView('generated')"><UIcon name="i-lucide-sparkles"/>Generated images</button>
      </nav>
      <div class="asset-rail-label"><button type="button" class="asset-folder-navigation" aria-label="Browse folders" @click="enterFolder('/')"><UIcon name="i-lucide-folder" class="asset-mobile-folder-icon"/>Folders</button><button type="button" class="asset-icon" aria-label="New folder" @click="newFolderOpen = true"><UIcon name="i-lucide-plus"/></button></div>
      <nav class="asset-folders" aria-label="Folders">
        <button v-for="folder in rootFolders" :key="folder.name" type="button" :class="{active: view === 'folder' && folderPath === '/' + folder.name}" @click="enterFolder('/' + folder.name)"><UIcon name="i-lucide-folder"/><span>{{ folder.name }}</span></button>
        <p v-if="!rootFolders.length && !foldersLoading" class="asset-rail-empty">Organize images into folders.</p>
        <button v-if="rootCursor" type="button" class="asset-more-folders" :disabled="foldersLoading" @click="refreshFolders(true)">{{ foldersLoading ? 'Loading…' : 'More folders' }}</button>
      </nav>
      <p v-if="!favourites.persistent.value" class="asset-preference-note">Favorites are saved for this visit. Browser storage is unavailable.</p>
    </aside>

    <div class="asset-main">
      <header class="asset-toolbar">
        <label class="asset-search"><UIcon name="i-lucide-search"/><input v-model="search" type="search" :placeholder="`Search ${scopeTitle.toLowerCase()}`" aria-label="Search assets"/></label>
        <div class="asset-toolbar-actions">
          <button class="asset-icon asset-density" type="button" aria-label="Smaller thumbnails" :aria-pressed="density === 'compact'" @click="density = 'compact'"><UIcon name="i-lucide-minus"/></button>
          <button class="asset-icon asset-density" type="button" aria-label="Larger thumbnails" :aria-pressed="density === 'comfortable'" @click="density = 'comfortable'"><UIcon name="i-lucide-plus"/></button>
          <button class="asset-button asset-button--secondary" type="button" aria-label="New folder" @click="newFolderOpen = true"><UIcon name="i-lucide-folder-plus"/><span class="asset-button-label">New folder</span></button>
          <button class="asset-button" type="button" :disabled="uploading" @click="fileInput?.click()"><UIcon :name="uploading ? 'i-lucide-loader-circle' : 'i-lucide-upload'" :class="{'asset-spin': uploading}"/><span>{{ uploading ? 'Uploading…' : 'Upload' }}</span></button>
          <input ref="fileInput" class="asset-hidden-input" type="file" multiple accept=".jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.heic,image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff,image/heic" aria-label="Upload images" @change="onFilesChanged"/>
        </div>
      </header>
      <div class="asset-content">
        <div class="asset-content-heading">
          <nav v-if="view === 'folder'" class="asset-breadcrumbs" aria-label="Breadcrumb"><template v-for="(crumb, index) in breadcrumbs" :key="crumb.path"><UIcon v-if="index" name="i-lucide-chevron-right"/><button type="button" @click="enterFolder(crumb.path)">{{ crumb.name }}</button></template></nav>
          <h1 v-else>{{ scopeTitle }}</h1>
          <button type="button" class="asset-icon" aria-label="Refresh assets" :disabled="loading" @click="refresh"><UIcon name="i-lucide-refresh-cw" :class="{'asset-spin': loading}"/></button>
        </div>
        <p v-if="isPicker && selectionLimit === 0" class="asset-filter-note">This model does not accept additional image inputs.</p>
        <p v-else-if="isPicker && acceptedExtensions.length" class="asset-filter-note">Select {{ acceptedExtensions.map(value => value.replace(/^\./, '').toUpperCase()).join(', ') }} images for this input.</p>
        <div v-if="errorMessage" class="asset-error" role="alert"><UIcon name="i-lucide-circle-alert"/><p>{{ errorMessage }}</p><button type="button" @click="nextCursor ? loadMore() : refresh()">Try again</button></div>
        <div v-if="loading" class="asset-grid" :class="`asset-grid--${density}`" aria-busy="true" aria-label="Loading images"><div v-for="number in 8" :key="number" class="asset-skeleton"/></div>
        <template v-else>
          <div v-if="directories.length" class="asset-folder-grid">
            <div v-for="directory in directories" :key="directory.name" class="asset-folder-card"><button type="button" @click="enterFolder(childPath(directory.name))"><UIcon name="i-lucide-folder"/><span>{{ directory.name }}</span></button><button class="asset-icon" type="button" :aria-label="`Delete folder ${directory.name}`" @click="deleteTarget = {directory: {name: directory.name, path: childPath(directory.name)}}"><UIcon name="i-lucide-trash-2"/></button></div>
          </div>
          <div v-if="displayFiles.length" class="asset-grid" :class="`asset-grid--${density}`">
            <article v-for="file in displayFiles" :key="file.url" class="asset-card" :class="{'asset-card--selected': selectedSet.has(file.url), 'asset-card--disabled': isPicker && !permitted(file)}">
              <button class="asset-image" type="button" :aria-label="`${isPicker ? 'Select' : 'Preview'} ${file.name}`" :disabled="isPicker && !permitted(file)" @click="isPicker ? choose(file) : openPreview(file)">
                <img v-if="!unavailable.has(file.url)" :src="`/api/data${file.url}`" :alt="file.name" loading="lazy" @error="markUnavailable(file.url)"/>
                <span v-else class="asset-unavailable"><UIcon name="i-lucide-image-off"/>Preview unavailable</span>
              </button>
              <button class="asset-select" type="button" :class="{'asset-select--checked': selectedSet.has(file.url)}" :aria-label="`${selectedSet.has(file.url) ? 'Deselect' : 'Select'} ${file.name}`" :aria-pressed="selectedSet.has(file.url)" :disabled="!permitted(file)" @click="choose(file)"><UIcon v-if="selectedSet.has(file.url)" name="i-lucide-check"/></button>
              <button class="asset-heart" type="button" :class="{'asset-heart--active': favouriteSet.has(file.url)}" :aria-label="`${favouriteSet.has(file.url) ? 'Remove' : 'Add'} ${file.name} ${favouriteSet.has(file.url) ? 'from' : 'to'} favorites`" :aria-pressed="favouriteSet.has(file.url)" @click="toggleFavourite(file)"><UIcon name="i-lucide-heart"/></button>
              <div class="asset-caption"><span :title="file.name">{{ file.name }}</span><button type="button" class="asset-icon" :aria-label="`Preview ${file.name}`" @click="openPreview(file)"><UIcon name="i-lucide-expand"/></button></div>
              <p v-if="view !== 'folder' && file.folder !== '/'" class="asset-location">{{ file.folder.slice(1) }}</p>
            </article>
          </div>
          <div v-if="!displayFiles.length && !directories.length && !errorMessage" class="asset-empty">
            <div class="asset-empty-icon"><UIcon :name="view === 'favourites' ? 'i-lucide-heart' : 'i-lucide-images'"/></div>
            <h2>{{ emptyTitle }}</h2>
            <p v-if="keyword">{{ nextCursor ? 'Continue searching to check more of your library.' : 'Try a different name or folder.' }}</p>
            <p v-else-if="view === 'favourites'">Tap the heart on an image to keep it close.</p>
            <p v-else>Images you upload or generate will appear here.</p>
            <button v-if="!keyword && view !== 'favourites'" class="asset-button" type="button" :disabled="uploading" @click="fileInput?.click()"><UIcon name="i-lucide-upload"/>Upload images</button>
            <small v-if="!keyword && view !== 'favourites'">JPG · PNG · WebP · GIF · BMP · TIFF · HEIC</small>
          </div>
          <div v-if="nextCursor" class="asset-load-more"><button type="button" class="asset-button asset-button--secondary" :disabled="loadingMore" @click="loadMore"><UIcon v-if="loadingMore" name="i-lucide-loader-circle" class="asset-spin"/>{{ loadingMore ? 'Loading…' : keyword && !displayFiles.length ? 'Continue searching' : 'Load more images' }}</button></div>
        </template>
      </div>
      <footer v-if="isPicker || selection.length" class="asset-selection-bar">
        <span>{{ selection.length }} selected</span><button v-if="selection.length" type="button" class="asset-text-button" @click="clearSelection">Clear</button>
        <div class="asset-selection-actions">
          <template v-if="!isPicker && selection.length"><NuxtLink v-if="selection.length === 1" class="asset-button asset-button--secondary" :to="{path: '/edit', query: {source: selection[0]}}"><UIcon name="i-lucide-sliders-horizontal"/>Edit image</NuxtLink><button type="button" class="asset-button asset-button--secondary" @click="deleteTarget = {files: selectedFiles}"><UIcon name="i-lucide-trash-2"/>Delete</button></template>
          <button v-if="isPicker" type="button" class="asset-button" :disabled="!selection.length" @click="confirmSelection">Use {{ selection.length === 1 ? 'image' : `${selection.length} images` }}<UIcon name="i-lucide-arrow-right"/></button>
        </div>
      </footer>
    </div>
    <div v-if="dragDepth" class="asset-drop-overlay"><UIcon name="i-lucide-upload"/><h2>Drop images to upload</h2><p>They’ll be saved in {{ uploadPath === '/' ? 'your library' : uploadPath }}.</p></div>

    <div v-if="newFolderOpen" class="asset-modal-backdrop" @click.self="!creating && (newFolderOpen = false)">
      <form class="asset-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-folder-title" @submit.prevent="createFolder">
        <h2 id="asset-folder-title">New folder</h2><p>Create a folder in {{ uploadPath === '/' ? 'your library' : uploadPath }}.</p>
        <label>Folder name<input ref="newFolderInput" v-model="newFolderName" class="asset-dialog-input" maxlength="255" required placeholder="e.g. Spring collection"/></label>
        <div class="asset-dialog-actions"><button type="button" class="asset-button asset-button--secondary" :disabled="creating" @click="newFolderOpen = false">Cancel</button><button type="submit" class="asset-button" :disabled="!newFolderName.trim() || creating">{{ creating ? 'Creating…' : 'Create folder' }}</button></div>
      </form>
    </div>
    <div v-if="deleteTarget" class="asset-modal-backdrop" @click.self="!deleting && (deleteTarget = undefined)">
      <div class="asset-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-delete-title">
        <h2 id="asset-delete-title">Delete {{ deleteTarget.directory ? 'folder' : deleteTarget.files?.length === 1 ? 'image' : `${deleteTarget.files?.length} images` }}?</h2>
        <p>{{ deleteTarget.directory ? `“${deleteTarget.directory.name}” and every image inside it will be permanently deleted.` : 'Selected images will be permanently deleted from your library.' }} This cannot be undone.</p>
        <div class="asset-dialog-actions"><button type="button" class="asset-button asset-button--secondary" :disabled="deleting" @click="deleteTarget = undefined">Cancel</button><button type="button" class="asset-button asset-button--danger" :disabled="deleting" @click="deleteEntries">{{ deleting ? 'Deleting…' : 'Delete permanently' }}</button></div>
      </div>
    </div>
    <div v-if="preview" class="asset-modal-backdrop asset-modal-backdrop--preview" @click.self="preview = undefined">
      <div class="asset-preview" role="dialog" aria-modal="true" :aria-label="`Preview ${preview.name}`">
        <header><span>{{ preview.name }}</span><button type="button" class="asset-icon" aria-label="Close preview" @click="preview = undefined"><UIcon name="i-lucide-x"/></button></header>
        <div class="asset-preview-image"><img v-if="!unavailable.has(preview.url)" :src="`/api/data${preview.url}`" :alt="preview.name" @error="markUnavailable(preview.url)"/><div v-else class="asset-preview-unavailable"><UIcon name="i-lucide-image-off"/><p>This image is unavailable.</p><span>It may have been removed, expired, or use a format your browser cannot preview.</span></div></div>
        <footer><button type="button" class="asset-button asset-button--secondary" :aria-pressed="favouriteSet.has(preview.url)" @click="toggleFavourite(preview)"><UIcon name="i-lucide-heart"/>{{ favouriteSet.has(preview.url) ? 'Favorited' : 'Favorite' }}</button><a class="asset-button asset-button--secondary" :href="`/api/data${preview.url}`" :download="preview.name"><UIcon name="i-lucide-download"/>Download</a><button type="button" class="asset-button asset-button--secondary" @click="deleteTarget = {files: [preview]}; preview = undefined"><UIcon name="i-lucide-trash-2"/>Delete</button><button v-if="isPicker" type="button" class="asset-button" :disabled="!permitted(preview)" @click="choose(preview); preview = undefined">{{ selectedSet.has(preview.url) ? 'Deselect' : 'Select image' }}</button><NuxtLink v-else class="asset-button" :to="{path: '/edit', query: {source: preview.url}}">Edit image<UIcon name="i-lucide-arrow-right"/></NuxtLink></footer>
      </div>
    </div>
  </section>
</template>

<style scoped>
.asset-browser{position:relative;display:flex;min-height:calc(100dvh - 58px);background:var(--workspace-bg,#0b0b0d);color:var(--workspace-text,#eeeef0);font-size:13px}
.asset-rail{width:224px;flex-shrink:0;border-right:1px solid var(--workspace-border,#29292e);padding:0 9px 20px;display:flex;flex-direction:column}
.asset-rail-heading{height:56px;display:flex;align-items:center;gap:9px;padding:0 9px;font-weight:600;border-bottom:1px solid var(--workspace-border,#29292e);margin:0 -9px 8px;padding-left:18px}
.asset-views,.asset-folders{display:grid;gap:3px}.asset-views>button,.asset-folders>button{display:flex;align-items:center;gap:9px;text-align:left;min-height:34px;padding:7px 9px;border-radius:7px;color:var(--workspace-muted,#91919b);transition:background .15s,color .15s}
.asset-views>button:hover,.asset-folders>button:hover{background:#ffffff09;color:var(--workspace-text,#eeeef0)}.asset-views>button.active,.asset-folders>button.active{background:#28282c;color:var(--workspace-text,#eeeef0);font-weight:500}
.asset-views .iconify,.asset-folders .iconify,.asset-toolbar .iconify{width:16px;height:16px;flex-shrink:0}.asset-folders>button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.asset-count{font-size:11px;margin-left:auto;padding:1px 7px;border-radius:20px;background:#303036;font-weight:400}.asset-rail-label{display:flex;align-items:center;justify-content:space-between;margin:25px 9px 6px;color:var(--workspace-muted,#91919b);font-size:12px}
.asset-mobile-folder-icon{display:none}.asset-folder-navigation{display:inline-flex;align-items:center;gap:7px}.asset-rail-empty,.asset-preference-note{color:var(--workspace-muted,#91919b);font-size:11px;line-height:1.6;padding:6px 9px}.asset-preference-note{margin-top:auto}.asset-folders .asset-more-folders{font-size:11px;min-height:28px}
.asset-main{flex:1;min-width:0;display:flex;flex-direction:column}.asset-toolbar{height:56px;border-bottom:1px solid var(--workspace-border,#29292e);display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 24px;flex-shrink:0}.asset-search{display:flex;align-items:center;gap:9px;background:var(--workspace-surface,#171719);border:1px solid var(--workspace-border,#29292e);border-radius:7px;height:33px;padding:0 10px;max-width:320px;width:100%;color:var(--workspace-muted,#91919b)}.asset-search input{width:100%;background:transparent;border:0;outline:0;color:var(--workspace-text,#eeeef0);font-size:12px}.asset-search:focus-within{border-color:var(--workspace-accent,#168bff)}
.asset-toolbar-actions{display:flex;align-items:center;gap:7px}.asset-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;white-space:nowrap;border:1px solid transparent;background:var(--workspace-accent,#168bff);color:#fff;font-size:12px;font-weight:500;border-radius:7px;padding:8px 11px;line-height:1.25;transition:filter .15s}.asset-button:hover{filter:brightness(1.12)}.asset-button--secondary{background:#252529;border-color:#303036;color:var(--workspace-text,#eeeef0)}.asset-button--danger{background:#d94148}.asset-button:disabled,.asset-icon:disabled{opacity:.45;cursor:not-allowed}.asset-icon{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;color:var(--workspace-muted,#91919b);flex-shrink:0}.asset-icon:hover{color:var(--workspace-text,#eeeef0);background:#ffffff0a}.asset-icon .iconify{width:16px;height:16px}.asset-icon[aria-pressed=true]{background:#252529;color:var(--workspace-text,#eeeef0)}.asset-hidden-input{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.asset-content{padding:18px 24px 28px;flex:1;min-height:480px}.asset-content-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:17px;min-height:28px}.asset-content-heading h1{font-size:14px;font-weight:500}.asset-breadcrumbs{display:flex;align-items:center;flex-wrap:wrap;gap:5px;font-size:12px;color:var(--workspace-muted,#91919b)}.asset-breadcrumbs button:last-child{color:var(--workspace-text,#eeeef0)}.asset-breadcrumbs .iconify{width:12px;height:12px}.asset-breadcrumbs button:hover{color:var(--workspace-text,#eeeef0)}.asset-filter-note{font-size:11px;color:var(--workspace-muted,#91919b);margin-bottom:16px}.asset-error{display:flex;align-items:center;gap:10px;padding:14px;border:1px solid #7a3438;background:#3e1b2140;border-radius:7px;color:#ffb7ba;font-size:12px;margin-bottom:18px}.asset-error>button{margin-left:auto;white-space:nowrap;text-decoration:underline}
.asset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(164px,1fr));gap:16px}.asset-grid--compact{grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:12px}.asset-card{position:relative;min-width:0;border:1px solid transparent;border-radius:9px;padding:4px;transition:border-color .15s}.asset-card:hover{border-color:var(--workspace-border,#29292e);background:#ffffff03}.asset-card--selected{border-color:var(--workspace-accent,#168bff)!important;background:#168bff0c!important}.asset-card--disabled .asset-image{opacity:.4}.asset-image{width:100%;aspect-ratio:1;display:block;background:#1d1d20;border-radius:7px;overflow:hidden}.asset-image img{display:block;width:100%;height:100%;object-fit:contain}.asset-caption{display:flex;align-items:center;gap:4px;padding:4px 2px 0;min-width:0}.asset-caption>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;flex:1;color:#c8c8ce}.asset-caption .asset-icon{width:22px;height:22px;opacity:0}.asset-caption .asset-icon .iconify{width:12px;height:12px}.asset-card:hover .asset-caption .asset-icon,.asset-card:focus-within .asset-caption .asset-icon{opacity:1}.asset-location{font-size:10px;color:var(--workspace-muted,#91919b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 2px}
.asset-select,.asset-heart{position:absolute;top:11px;width:23px;height:23px;display:flex;align-items:center;justify-content:center;border-radius:5px;color:white;background:#0b0b0dcc;opacity:0;transition:opacity .15s}.asset-select{left:11px;border:1px solid #ffffff85;width:19px;height:19px}.asset-heart{right:11px}.asset-select .iconify,.asset-heart .iconify{width:14px;height:14px}.asset-card:hover .asset-select,.asset-card:hover .asset-heart,.asset-card:focus-within .asset-select,.asset-card:focus-within .asset-heart,.asset-browser--picker .asset-select,.asset-select--checked,.asset-heart--active{opacity:1}.asset-select--checked{background:var(--workspace-accent,#168bff);border-color:var(--workspace-accent,#168bff)}.asset-heart--active{color:#ff889b}.asset-heart--active .iconify{filter:drop-shadow(0 0 2px #fb637366)}.asset-unavailable{display:flex;height:100%;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--workspace-muted,#91919b);font-size:11px}.asset-unavailable .iconify{height:26px;width:26px}
.asset-folder-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:18px}.asset-folder-card{border:1px solid var(--workspace-border,#29292e);border-radius:7px;display:flex;align-items:center;gap:5px;padding:7px;background:var(--workspace-surface,#171719)}.asset-folder-card>button:first-child{display:flex;align-items:center;gap:8px;min-width:0;flex:1;padding:3px}.asset-folder-card span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.asset-folder-card .iconify{width:18px;height:18px;flex-shrink:0}.asset-folder-card .asset-icon{opacity:0}.asset-folder-card:hover .asset-icon,.asset-folder-card:focus-within .asset-icon{opacity:1}.asset-skeleton{aspect-ratio:1;background:#19191c;border-radius:8px;animation:asset-pulse 1.6s ease-in-out infinite}
.asset-empty{min-height:calc(100dvh - 230px);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 20px}.asset-empty-icon{display:flex;align-items:center;justify-content:center;width:58px;height:58px;border-radius:15px;background:#142232;color:var(--workspace-accent,#168bff);margin-bottom:18px}.asset-empty-icon .iconify{height:27px;width:27px}.asset-empty h2{font-size:15px;font-weight:600;margin-bottom:7px}.asset-empty p{color:var(--workspace-muted,#91919b);font-size:12px;max-width:340px;line-height:1.65}.asset-empty .asset-button{margin-top:20px}.asset-empty small{margin-top:16px;color:#676771;font-size:10px}.asset-load-more{display:flex;justify-content:center;margin-top:28px}
.asset-selection-bar{position:sticky;bottom:0;min-height:61px;display:flex;align-items:center;gap:14px;border-top:1px solid var(--workspace-border,#29292e);background:#171719f2;padding:12px 24px;z-index:5;font-size:12px;backdrop-filter:blur(12px)}.asset-selection-actions{display:flex;gap:8px;margin-left:auto}.asset-text-button{color:var(--workspace-muted,#91919b);font-size:11px;text-decoration:underline}.asset-drop-overlay{position:absolute;inset:8px;background:#102032ef;border:2px dashed var(--workspace-accent,#168bff);border-radius:12px;z-index:25;display:flex;align-items:center;justify-content:center;flex-direction:column;pointer-events:none;gap:12px}.asset-drop-overlay .iconify{width:40px;height:40px;color:var(--workspace-accent,#168bff)}.asset-drop-overlay h2{font-size:20px;font-weight:600}.asset-drop-overlay p{color:var(--workspace-muted,#91919b)}
.asset-modal-backdrop{position:fixed;inset:0;z-index:100;background:#000b;display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(5px)}.asset-dialog{width:100%;max-width:400px;background:#19191c;border:1px solid var(--workspace-border,#29292e);border-radius:13px;padding:25px;box-shadow:0 20px 80px #0008}.asset-dialog h2{font-size:17px;font-weight:600;margin-bottom:10px}.asset-dialog p{font-size:12px;line-height:1.8;color:var(--workspace-muted,#91919b);margin-bottom:20px}.asset-dialog label{font-size:12px;color:#c8c8ce}.asset-dialog-input{display:block;width:100%;border:1px solid var(--workspace-border,#29292e);background:#101012;border-radius:7px;padding:9px 11px;margin-top:7px;color:var(--workspace-text,#eeeef0);outline:0}.asset-dialog-input:focus{border-color:var(--workspace-accent,#168bff)}.asset-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}.asset-modal-backdrop--preview{z-index:90}.asset-preview{width:min(950px,100%);max-height:calc(100dvh - 48px);background:#151517;border:1px solid var(--workspace-border,#29292e);border-radius:12px;display:flex;flex-direction:column;overflow:hidden}.asset-preview>header{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;border-bottom:1px solid var(--workspace-border,#29292e);padding:12px 18px}.asset-preview>header>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.asset-preview-image{display:flex;justify-content:center;align-items:center;min-height:240px;overflow:hidden;padding:20px;background:#0c0c0e}.asset-preview-image img{max-width:100%;max-height:calc(100dvh - 224px);object-fit:contain;border-radius:3px}.asset-preview>footer{display:flex;justify-content:flex-end;gap:8px;padding:14px 18px;border-top:1px solid var(--workspace-border,#29292e);flex-wrap:wrap}.asset-preview-unavailable{text-align:center;color:var(--workspace-muted,#91919b);padding:40px}.asset-preview-unavailable .iconify{width:32px;height:32px;margin-bottom:12px}.asset-preview-unavailable p{font-size:14px;margin-bottom:8px}.asset-preview-unavailable span{font-size:11px}.asset-spin{animation:asset-spin 1s linear infinite}.asset-browser--picker{min-height:560px;max-height:75dvh;overflow:auto}.asset-browser--picker .asset-empty{min-height:340px}.asset-browser--picker .asset-content{min-height:380px}
button:not(:disabled),a{cursor:pointer}button:focus-visible,a:focus-visible{outline:2px solid var(--workspace-accent,#168bff);outline-offset:3px}.asset-button .iconify{height:14px;width:14px;flex-shrink:0}
@keyframes asset-spin{to{transform:rotate(360deg)}}@keyframes asset-pulse{50%{opacity:.45}}
@media(min-width:1600px){.asset-grid--comfortable{grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}}
@media(max-width:1000px){.asset-rail{width:185px}.asset-toolbar{padding:0 16px}.asset-content{padding:18px 16px}.asset-density{display:none}}
@media(max-width:760px){.asset-browser{display:block}.asset-rail{width:100%;border-right:0;border-bottom:1px solid var(--workspace-border,#29292e);padding:8px 12px}.asset-rail-heading,.asset-folders,.asset-rail-empty{display:none}.asset-rail-label{display:flex;margin:5px 2px 0;min-height:28px}.asset-mobile-folder-icon{display:inline-block;width:14px;height:14px}.asset-views{display:flex;gap:3px;overflow-x:auto}.asset-views>button{white-space:nowrap;flex-shrink:0;font-size:11px;padding:7px 9px}.asset-views .iconify{width:14px;height:14px}.asset-toolbar{padding:10px 12px;height:auto;min-height:60px;flex-wrap:wrap}.asset-search{flex:1;min-width:140px}.asset-toolbar-actions .asset-button--secondary .asset-button-label{display:none}.asset-content{padding:16px 12px}.asset-grid{grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}.asset-grid--compact{grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px}.asset-empty{min-height:calc(100dvh - 300px)}.asset-selection-bar{padding:12px;font-size:11px}.asset-select,.asset-heart,.asset-caption .asset-icon{opacity:1}.asset-browser--picker{max-height:80dvh}.asset-modal-backdrop{padding:12px}.asset-preview>footer{padding:12px;justify-content:center}.asset-preview>footer .asset-button{font-size:11px;padding:7px}.asset-preview>header{font-size:11px}}
@media(prefers-reduced-motion:reduce){.asset-spin,.asset-skeleton{animation:none}*{transition:none!important}}
</style>
