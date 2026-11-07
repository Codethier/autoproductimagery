<script setup lang="ts">
import type {PeopleList, Person, PersonDetail, PersonPhoto, PersonShare, PersonShareTarget} from '../../schemas/people'
import type {AssetSource} from '../../schemas/image-storage'
import {CreatePersonSchema, UpdatePersonSchema} from '../../schemas/people'
import {ImagePathSchema} from '../../schemas/image-generation'
import {hasConfirmedGenerationPrice} from '../../schemas/generation-billing'
import type {SelectableFile} from '../../schemas/main.dto'
import {imageDownloadUrl, imagePreviewUrl} from '../utils/imageDelivery'
import {formatUsd} from '../utils/generationPrice'
import {selectImageRange} from '../utils/imageSelection'

const props = withDefaults(defineProps<{selectionMode?: 'browse' | 'multiple'; maxSelection?: number; selectionCap?: number; selectionLabel?: 'references' | 'pictures'; selectedUrls?: string[]; sharedOnly?: boolean; sourceId?: string}>(), {selectionMode: 'browse', maxSelection: 16, selectionCap: 16, selectionLabel: 'references', selectedUrls: () => [], sharedOnly: false})
const emit = defineEmits<{'update:selectedUrls': [urls: string[]]; confirm: [urls: string[]]}>()
const account = useAccount()
const requestFetch = useRequestFetch()
const generationProgress = usePeopleGenerationProgress()
const initialAccount = {epoch: account.epoch.value, identity: account.identity.value}
const currentAccount = computed(() => initialAccount.epoch === account.epoch.value && initialAccount.identity === account.identity.value)
const people = ref<Person[]>([])
const nextCursor = ref<string | null>(null)
const scope = ref<'mine' | 'shared'>(props.sharedOnly ? 'shared' : 'mine')
const sources = ref<AssetSource[]>([])
const sourceId = ref(props.sourceId ?? '')
const search = ref('')
const keyword = ref('')
const ready = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const detailLoading = ref(false)
const photoLoadingMore = ref(false)
const activePerson = ref<Person | null>(null)
const photos = ref<PersonPhoto[]>([])
const photoCursor = ref<string | null>(null)
const pendingCount = ref(0)
const failedCount = ref(0)
const errorMessage = ref('')
const detailError = ref('')
const selection = ref<string[]>([])
const selectionAnchor = ref('')
const selectionNotice = ref('')
const createOpen = ref(false)
const newName = ref('')
const newDescription = ref('')
const creating = ref(false)
const editOpen = ref(false)
const editName = ref('')
const editDescription = ref('')
const saving = ref(false)
const deleteOpen = ref(false)
const deleting = ref(false)
const removing = ref<string | null>(null)
const generatorOpen = ref(false)
const attachOpen = ref(false)
const attachSelection = ref<string[]>([])
const attaching = ref(false)
const pollingPaused = ref(false)
const dialogElement = ref<HTMLElement>()
const unavailable = ref(new Set<string>())
const shareTarget = ref<Person | null>(null)
const shares = ref<PersonShare[]>([])
const shareUsers = ref<PersonShareTarget[]>([])
const shareRecipient = ref('')
const shareLoading = ref(false)
const shareSaving = ref(false)
const shareError = ref('')
const isPicker = computed(() => props.selectionMode === 'multiple')
const sharedScope = computed(() => props.sharedOnly || scope.value === 'shared')
const canCreate = computed(() => currentAccount.value && !isPicker.value && !sharedScope.value)
const selectionLimit = computed(() => Number.isInteger(props.maxSelection) && props.maxSelection >= 0 && Number.isInteger(props.selectionCap) && props.selectionCap >= 0 ? Math.min(50, props.selectionCap, props.maxSelection) : 0)
const selectedSet = computed(() => new Set(selection.value))
const visiblePhotos = computed(() => currentAccount.value ? photos.value.filter(photoReady) : [])
const currentPeople = computed(() => currentAccount.value ? people.value : [])
const selectedPersonPhotos = computed(() => visiblePhotos.value.filter(photo => selectedSet.value.has(photo.url)).map(photo => photo.url))
const groups = computed(() => {
  if (!sharedScope.value) return [{key: 'mine', source: null as AssetSource | null, people: currentPeople.value}]
  const result = new Map<string, {key: string; source: AssetSource | null; people: Person[]}>()
  for (const person of currentPeople.value) {
    const source = person.sharedBy ?? null
    const key = source?.userId ?? person.ownerUserId
    if (!result.has(key)) result.set(key, {key, source, people: []})
    result.get(key)!.people.push(person)
  }
  return [...result.values()]
})
const editablePerson = computed(() => activePerson.value && canEdit(activePerson.value))
let revision = 0
let listRevision = 0
let detailRevision = 0
let detailRequestRevision = 0
let shareRevision = 0
let mounted = false
let searchTimer: ReturnType<typeof setTimeout> | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let pollAttempts = 0
let polling = false
let detailRequestActive = false
let refreshQueued = false
let refreshAllQueued = false
const requests = new Set<AbortController>()
let focusBeforeDialog: HTMLElement | null = null
function snapshot() { return {epoch: account.epoch.value, identity: account.identity.value, revision} }
function current(value: ReturnType<typeof snapshot>) { return currentAccount.value && value.epoch === account.epoch.value && value.identity === account.identity.value && value.revision === revision }
function canEdit(person: Person) { return currentAccount.value && !props.sharedOnly && person.ownerUserId === account.account.value?.userId && !person.sharedBy && person.permissions?.edit === true }
function canShare(person: Person) { return canEdit(person) && person.permissions?.share === true }
function photoReady(photo: PersonPhoto) { return ImagePathSchema.safeParse(photo.url).success && (photo.generationId === null || hasConfirmedGenerationPrice(photo)) }
function photoPrice(photo: PersonPhoto) { return photo.generationId !== null ? `${formatUsd(photo.priceUsd)} · confirmed` : photo.priceSource === 'local-processing' ? '$0 provider charge' : 'Uploaded reference' }
function photoCover(person: Person) { return person.cover && photoReady(person.cover) ? person.cover : null }
async function request<T>(url: string, options: {method?: 'POST' | 'PATCH' | 'DELETE'; body?: Record<string, unknown>; query?: Record<string, string | number>} = {}) {
  const controller = new AbortController(); requests.add(controller)
  try { return await requestFetch<T>(url, {...options, timeout: 25_000, signal: controller.signal}) }
  finally { requests.delete(controller) }
}
function syncSelection(urls: readonly string[]) { selection.value = currentAccount.value ? [...new Set(urls.filter(url => ImagePathSchema.safeParse(url).success))] : [] }
function togglePhoto(photo: PersonPhoto, event?: Pick<MouseEvent, 'shiftKey'>) {
  if (!photoReady(photo) || !currentAccount.value) return
  selectionNotice.value = ''
  // Direct calls retain the ordinary toggle contract; Shift ranges use only the live visible gallery.
  const visible = visiblePhotos.value.map(item => item.url)
  if (!event?.shiftKey && !visible.includes(photo.url)) visible.push(photo.url)
  const result = selectImageRange(selection.value, visible, photo.url, {anchor: selectionAnchor.value, shift: event?.shiftKey, limit: selectionLimit.value})
  selection.value = result.selection; selectionAnchor.value = result.anchor
  if (result.limited) selectionNotice.value = props.selectionLabel === 'pictures' ? `This batch accepts up to ${selectionLimit.value} pictures. Remove a selection before adding another.` : `This model accepts up to ${selectionLimit.value} references. Remove a selection before adding another.`
  emit('update:selectedUrls', [...selection.value])
}
function clearSelection() { selection.value = []; selectionAnchor.value = ''; selectionNotice.value = ''; emit('update:selectedUrls', []) }
function confirm() { if (currentAccount.value && selection.value.length && selection.value.length <= selectionLimit.value) emit('confirm', [...selection.value]) }
async function loadPeople(more = false) {
  if (!currentAccount.value || (more && (!nextCursor.value || loadingMore.value))) return
  const value = snapshot(); const operation = ++listRevision
  if (more) loadingMore.value = true
  else loading.value = true
  errorMessage.value = ''
  try {
    const response = await request<PeopleList>('/api/people', {query: {limit: 24, search: keyword.value, scope: sharedScope.value ? 'shared' : 'mine', ...(sharedScope.value && sourceId.value ? {sourceId: sourceId.value} : {}), ...(more && nextCursor.value ? {cursor: nextCursor.value} : {})}})
    if (!current(value) || operation !== listRevision) return
    people.value = more ? [...people.value, ...response.people.filter(person => !people.value.some(known => known.id === person.id))] : response.people
    nextCursor.value = response.nextCursor; sources.value = response.sources ?? []; ready.value = true
  } catch { if (current(value) && operation === listRevision) errorMessage.value = 'Could not load your people. Try again.' }
  finally { if (current(value) && operation === listRevision) { loading.value = false; loadingMore.value = false } }
}
function updatePerson(person: Person) {
  const index = people.value.findIndex(known => known.id === person.id)
  if (index !== -1) people.value[index] = person
  if (activePerson.value?.id === person.id) activePerson.value = person
}
function forgetPerson(personId: string) {
  const revokedOwner = (activePerson.value?.id === personId ? activePerson.value : people.value.find(person => person.id === personId))?.sharedBy?.userId
  const revokedPhotos = new Set(activePerson.value?.id === personId ? photos.value.map(photo => photo.url) : [])
  const cover = people.value.find(person => person.id === personId)?.cover
  if (cover) revokedPhotos.add(cover.url)
  people.value = people.value.filter(person => person.id !== personId)
  if (revokedOwner && !people.value.some(person => person.sharedBy?.userId === revokedOwner)) sources.value = sources.value.filter(source => source.userId !== revokedOwner)
  selection.value = selection.value.filter(url => !revokedPhotos.has(url))
  emit('update:selectedUrls', [...selection.value])
  if (activePerson.value?.id === personId) back()
  errorMessage.value = 'This person is no longer available. Their owner may have changed sharing.'
}
function stopPolling() { clearTimeout(pollTimer); pollTimer = undefined; polling = false }
function schedulePoll() {
  if (!mounted || pollTimer || polling || !activePerson.value || (!pendingCount.value && !generationProgress.running(activePerson.value.id)) || generatorOpen.value || pollingPaused.value || document.visibilityState === 'hidden') return
  if (pollAttempts >= 60) { pollingPaused.value = true; return }
  pollTimer = setTimeout(() => { pollTimer = undefined; void pollDetail() }, 5000)
}
async function loadPerson(personId: string, options: {more?: boolean; quiet?: boolean; all?: boolean} = {}) {
  if (!currentAccount.value || activePerson.value?.id !== personId) return
  if (options.quiet && detailRequestActive) { refreshQueued = true; refreshAllQueued ||= !!options.all; return }
  if (options.more && (!photoCursor.value || photoLoadingMore.value)) return
  const value = snapshot(); const operation = detailRevision; const requestOperation = ++detailRequestRevision
  detailRequestActive = true
  if (options.more) photoLoadingMore.value = true
  else if (!options.quiet) detailLoading.value = true
  if (!options.quiet) detailError.value = ''
  try {
    const response = await request<PersonDetail>(`/api/people/${personId}`, {query: {limit: 40, ...(options.more && photoCursor.value ? {cursor: photoCursor.value} : {})}})
    if (!current(value) || operation !== detailRevision || requestOperation !== detailRequestRevision || activePerson.value?.id !== personId) return
    let refreshedPhotos = response.photos
    let refreshedCursor = response.nextCursor
    // Refresh previously loaded pages together. A new photo can sort anywhere
    // in the UUID cursor order, so a fixed leading-page splice would lose it.
    const target = options.all || (options.quiet && pendingCount.value > 0 && response.pendingCount === 0) ? 200 : Math.max(40, Math.min(200, photos.value.length))
    if (options.quiet) {
      for (let page = 1; refreshedCursor && refreshedPhotos.length < target && page < 5; page += 1) {
        const next = await request<PersonDetail>(`/api/people/${personId}`, {query: {limit: 40, cursor: refreshedCursor}})
        if (!current(value) || operation !== detailRevision || requestOperation !== detailRequestRevision || activePerson.value?.id !== personId) return
        const known = new Set(refreshedPhotos.map(photo => photo.id))
        refreshedPhotos = [...refreshedPhotos, ...next.photos.filter(photo => !known.has(photo.id))]
        refreshedCursor = next.nextCursor
      }
    }
    updatePerson(response.person)
    if (options.more) photos.value = [...photos.value, ...response.photos.filter(photo => !photos.value.some(known => known.id === photo.id))]
    else { photos.value = refreshedPhotos; photoCursor.value = refreshedCursor }
    if (options.more) photoCursor.value = response.nextCursor
    pendingCount.value = response.pendingCount; failedCount.value = response.failedCount
    schedulePoll()
  } catch (error) {
    if (current(value) && operation === detailRevision && requestOperation === detailRequestRevision && activePerson.value?.id === personId) {
      const status = (error as {statusCode?: number; status?: number; response?: {status?: number}})?.statusCode ?? (error as {status?: number})?.status ?? (error as {response?: {status?: number}})?.response?.status
      if (status === 401 || status === 403 || status === 404) forgetPerson(personId)
      else detailError.value = 'Could not load this person’s pictures. Try again.'
    }
  }
  finally {
    if (current(value) && operation === detailRevision && requestOperation === detailRequestRevision && activePerson.value?.id === personId) {
      detailLoading.value = false; photoLoadingMore.value = false; detailRequestActive = false
      if (refreshQueued) { const all = refreshAllQueued; refreshQueued = false; refreshAllQueued = false; void loadPerson(personId, {quiet: true, all}) }
    }
  }
}
async function pollDetail() {
  if (!mounted || polling || !activePerson.value || (!pendingCount.value && !generationProgress.running(activePerson.value.id)) || generatorOpen.value || document.visibilityState === 'hidden') return
  const personId = activePerson.value.id; const value = snapshot(); const operation = detailRevision
  polling = true; pollAttempts += 1
  try { await loadPerson(personId, {quiet: true}) }
  finally { if (current(value) && operation === detailRevision) { polling = false; schedulePoll() } }
}
function openPerson(person: Person) {
  closeShares()
  stopPolling(); detailRevision += 1; detailRequestRevision += 1; detailRequestActive = false; refreshQueued = false; refreshAllQueued = false; activePerson.value = person; photos.value = []; photoCursor.value = null; pendingCount.value = 0; failedCount.value = 0; detailError.value = ''; editOpen.value = false; saving.value = false; removing.value = null; attaching.value = false; photoLoadingMore.value = false; pollAttempts = 0; pollingPaused.value = false
  void loadPerson(person.id)
}
function back() { closeShares(); stopPolling(); detailRevision += 1; detailRequestRevision += 1; detailRequestActive = false; refreshQueued = false; refreshAllQueued = false; activePerson.value = null; photos.value = []; pendingCount.value = 0; failedCount.value = 0; detailError.value = ''; detailLoading.value = false; photoLoadingMore.value = false; editOpen.value = false; generatorOpen.value = false; attachOpen.value = false; deleteOpen.value = false; saving.value = false; removing.value = null; attaching.value = false }
async function createPerson() {
  if (creating.value || !canCreate.value) return
  const parsed = CreatePersonSchema.safeParse({name: newName.value, description: newDescription.value})
  if (!parsed.success) { errorMessage.value = 'Give your person a name of up to 80 characters and a description of up to 4,000 characters.'; return }
  const value = snapshot(); creating.value = true; errorMessage.value = ''
  try {
    const response = await request<{person: Person}>('/api/people', {method: 'POST', body: parsed.data})
    if (!current(value)) return
    createOpen.value = false; newName.value = ''; newDescription.value = ''; people.value.unshift(response.person); openPerson(response.person)
  } catch { if (current(value)) errorMessage.value = 'Could not create this person. Try again.' }
  finally { if (current(value)) creating.value = false }
}
function beginEdit() { if (!activePerson.value || !canEdit(activePerson.value)) return; editName.value = activePerson.value.name; editDescription.value = activePerson.value.description; editOpen.value = true }
async function savePerson() {
  if (!activePerson.value || saving.value || !canEdit(activePerson.value)) return
  const parsed = UpdatePersonSchema.safeParse({name: editName.value, description: editDescription.value})
  if (!parsed.success) { detailError.value = 'Use a name of up to 80 characters and a description of up to 4,000 characters.'; return }
  const personId = activePerson.value.id; const operation = detailRevision; const value = snapshot(); saving.value = true; detailError.value = ''
  try { const response = await request<{person: Person}>(`/api/people/${personId}`, {method: 'PATCH', body: parsed.data}); if (current(value) && operation === detailRevision) { updatePerson(response.person); editOpen.value = false } }
  catch { if (current(value) && operation === detailRevision) detailError.value = 'Could not save the profile. Try again.' }
  finally { if (current(value) && operation === detailRevision) saving.value = false }
}
async function deletePerson() {
  if (!activePerson.value || deleting.value || !canEdit(activePerson.value)) return
  const personId = activePerson.value.id; const operation = detailRevision; const value = snapshot(); deleting.value = true; detailError.value = ''
  try { await request(`/api/people/${personId}`, {method: 'DELETE'}); if (!current(value) || operation !== detailRevision) return; people.value = people.value.filter(person => person.id !== personId); deleteOpen.value = false; back() }
  catch { if (current(value)) detailError.value = 'Could not remove the profile. Try again.' }
  finally { if (current(value)) deleting.value = false }
}
async function removePhoto(photo: PersonPhoto) {
  if (!activePerson.value || removing.value || !canEdit(activePerson.value)) return
  const personId = activePerson.value.id; const operation = detailRevision; const value = snapshot(); removing.value = photo.id; detailError.value = ''
  try {
    await request(`/api/people/${personId}/photos/${photo.id}`, {method: 'DELETE'})
    if (!current(value) || operation !== detailRevision) return
    photos.value = photos.value.filter(item => item.id !== photo.id)
    selection.value = selection.value.filter(url => url !== photo.url); emit('update:selectedUrls', [...selection.value])
    await loadPerson(personId, {quiet: true})
  } catch { if (current(value) && operation === detailRevision) detailError.value = 'Could not remove the picture from this profile. Try again.' }
  finally { if (current(value) && operation === detailRevision) removing.value = null }
}
async function attachPhotos(files: SelectableFile[]) {
  if (!activePerson.value || attaching.value || !canEdit(activePerson.value)) return
  const urls = [...new Set(files.map(file => file.url))]
  if (!urls.length || urls.length > 20) return
  const personId = activePerson.value.id; const operation = detailRevision; const value = snapshot(); attaching.value = true; detailError.value = ''
  try { await request(`/api/people/${personId}/photos`, {method: 'POST', body: {urls}}); if (!current(value) || operation !== detailRevision) return; attachOpen.value = false; attachSelection.value = []; await loadPerson(personId, {quiet: true}) }
  catch { if (current(value) && operation === detailRevision) detailError.value = 'Only available pictures from your own library can be added. Shared or unpriced images cannot be attached.' }
  finally { if (current(value) && operation === detailRevision) attaching.value = false }
}
function closeShares() {
  shareRevision += 1; shareTarget.value = null; shares.value = []; shareUsers.value = []; shareRecipient.value = ''; shareError.value = ''; shareLoading.value = false; shareSaving.value = false
}
function shareCurrent(value: ReturnType<typeof snapshot>, operation: number, personId: string) { return current(value) && operation === shareRevision && shareTarget.value?.id === personId && canShare(shareTarget.value) }
async function loadShares() {
  const person = shareTarget.value
  if (!person || !canShare(person)) return
  const value = snapshot(); const operation = shareRevision; shareLoading.value = true; shareError.value = ''
  try {
    const [grants, targets] = await Promise.all([request<{shares: PersonShare[]}>(`/api/people/${person.id}/shares`), request<{users: PersonShareTarget[]}>('/api/people/share-targets')])
    if (!shareCurrent(value, operation, person.id)) return
    shares.value = grants.shares; shareUsers.value = targets.users
    if (!shareUsers.value.some(user => user.id === shareRecipient.value)) shareRecipient.value = ''
  } catch { if (shareCurrent(value, operation, person.id)) shareError.value = 'Could not load sharing. Try again.' }
  finally { if (shareCurrent(value, operation, person.id)) shareLoading.value = false }
}
function openShares(person: Person) {
  if (isPicker.value || !canShare(person)) return
  closeShares(); shareTarget.value = person; void loadShares()
}
async function grantShare() {
  const person = shareTarget.value; const recipientUserId = shareRecipient.value
  if (!person || !canShare(person) || shareSaving.value || shareLoading.value || !shareUsers.value.some(user => user.id === recipientUserId) || shares.value.some(share => share.recipientUserId === recipientUserId)) return
  const value = snapshot(); const operation = shareRevision; shareSaving.value = true; shareError.value = ''
  try {
    await request(`/api/people/${person.id}/shares`, {method: 'POST', body: {recipientUserId}})
    if (!shareCurrent(value, operation, person.id)) return
    shareRecipient.value = ''; await loadShares()
  } catch { if (shareCurrent(value, operation, person.id)) shareError.value = 'Could not share this person. Choose an enabled member of your organization and try again.' }
  finally { if (shareCurrent(value, operation, person.id)) shareSaving.value = false }
}
async function revokeShare(recipientUserId: string) {
  const person = shareTarget.value
  if (!person || !canShare(person) || shareSaving.value || shareLoading.value || !shares.value.some(share => share.recipientUserId === recipientUserId)) return
  const value = snapshot(); const operation = shareRevision; shareSaving.value = true; shareError.value = ''
  try {
    await request(`/api/people/${person.id}/shares/${recipientUserId}`, {method: 'DELETE'})
    if (!shareCurrent(value, operation, person.id)) return
    shares.value = shares.value.filter(share => share.recipientUserId !== recipientUserId)
  } catch { if (shareCurrent(value, operation, person.id)) shareError.value = 'Could not remove this person’s shared access. Try again.' }
  finally { if (shareCurrent(value, operation, person.id)) shareSaving.value = false }
}
function changeScope(value: 'mine' | 'shared') { if (!props.sharedOnly && scope.value !== value) { scope.value = value; sourceId.value = '' } }
function refreshPeople() { if (activePerson.value) void loadPerson(activePerson.value.id, {quiet: true}); else void loadPeople() }
function generated() { if (!activePerson.value || !currentAccount.value) return; pollAttempts = 0; pollingPaused.value = false; void loadPerson(activePerson.value.id, {quiet: true, all: true}) }
function generatorClosed() { generatorOpen.value = false; generated(); schedulePoll() }
function visibilityChanged() {
  if (document.visibilityState === 'hidden') { clearTimeout(pollTimer); pollTimer = undefined }
  else {
    if (activePerson.value && !canEdit(activePerson.value)) void loadPerson(activePerson.value.id, {quiet: true})
    else if (!activePerson.value && sharedScope.value) void loadPeople()
    if (!pollingPaused.value) schedulePoll()
  }
}
function cancelRequests() { revision += 1; listRevision += 1; detailRevision += 1; detailRequestActive = false; refreshQueued = false; refreshAllQueued = false; for (const controller of requests) controller.abort(); requests.clear(); clearTimeout(searchTimer); stopPolling() }
function keydown(event: KeyboardEvent) {
  if (!createOpen.value && !attachOpen.value && !deleteOpen.value && !shareTarget.value) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!creating.value && !attaching.value && !deleting.value && !shareSaving.value) { createOpen.value = false; attachOpen.value = false; deleteOpen.value = false; closeShares() } }
  if (event.key === 'Tab') {
    const elements = [...(dialogElement.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])]
    if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus() }
    else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus() }
  }
}
watch(() => props.selectedUrls, syncSelection, {immediate: true, deep: true})
watch(() => [activePerson.value?.id, scope.value, sourceId.value, search.value, keyword.value, account.epoch.value, account.identity.value, props.maxSelection, props.selectionCap], () => { selectionAnchor.value = '' }, {flush: 'sync'})
watch(() => visiblePhotos.value.map(photo => photo.url), urls => { if (selectionAnchor.value && !urls.includes(selectionAnchor.value)) selectionAnchor.value = '' }, {flush: 'sync'})
watch(search, value => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { keyword.value = value.trim().slice(0, 100); void loadPeople() }, 250) })
watch([scope, sourceId], () => { back(); createOpen.value = false; listRevision += 1; people.value = []; nextCursor.value = null; errorMessage.value = ''; ready.value = false; if (mounted) void loadPeople() })
watch(() => props.sharedOnly, value => { scope.value = value ? 'shared' : 'mine'; sourceId.value = props.sourceId ?? '' })
watch(() => props.sourceId, value => { sourceId.value = value ?? '' })
watch([account.epoch, account.identity], () => { cancelRequests(); closeShares(); people.value = []; sources.value = []; sourceId.value = ''; activePerson.value = null; photos.value = []; selection.value = []; createOpen.value = false; generatorOpen.value = false; attachOpen.value = false; deleteOpen.value = false; editOpen.value = false; errorMessage.value = ''; detailError.value = ''; pendingCount.value = 0; failedCount.value = 0; loading.value = false; loadingMore.value = false; detailLoading.value = false; photoLoadingMore.value = false; creating.value = false; saving.value = false; attaching.value = false; deleting.value = false; removing.value = null; newName.value = ''; newDescription.value = ''; editName.value = ''; editDescription.value = ''; search.value = ''; keyword.value = ''; attachSelection.value = []; selectionNotice.value = ''; unavailable.value = new Set() }, {flush: 'sync'})
watch(() => activePerson.value ? generationProgress.running(activePerson.value.id) : false, (running, previous) => { if (!running && previous && mounted) generated(); else if (running) schedulePoll() })
watch([createOpen, attachOpen, deleteOpen, shareTarget], async () => {
  if (!mounted) return
  const open = createOpen.value || attachOpen.value || deleteOpen.value || Boolean(shareTarget.value)
  if (open) { if (!focusBeforeDialog) focusBeforeDialog = document.activeElement instanceof HTMLElement ? document.activeElement : null; await nextTick(); dialogElement.value?.querySelector<HTMLElement>('input, button')?.focus() }
  else { if (focusBeforeDialog?.isConnected) focusBeforeDialog.focus(); focusBeforeDialog = null }
})
onServerPrefetch(() => loadPeople())
onMounted(() => { mounted = true; if (!ready.value) void loadPeople(); document.addEventListener('visibilitychange', visibilityChanged); document.addEventListener('keydown', keydown, {capture: true}) })
onBeforeUnmount(() => { mounted = false; cancelRequests(); document.removeEventListener('visibilitychange', visibilityChanged); document.removeEventListener('keydown', keydown, {capture: true}) })
</script>

<template>
  <section class="people-studio" :class="{'people-studio--picker': isPicker}" aria-label="People library">
    <header class="people-heading"><div><span class="people-eyebrow">{{ sharedScope ? 'From your organization' : 'Your cast, your creative direction' }}</span><h1>{{ isPicker ? 'Choose your people' : sharedScope ? 'Shared people' : 'People' }}</h1><p>{{ isPicker ? selectionLabel === 'pictures' ? 'Select individual pictures to run through the pipeline independently.' : 'Select individual pictures to use as references in your next generation.' : sharedScope ? 'People shared with you, grouped by the person who shared them. Use their pictures as references in your own work.' : 'Build a cast of generated people. Keep their identity, explore new looks, and bring them into product photographs.' }}</p></div><button v-if="canCreate" class="people-primary" type="button" @click="createOpen = true"><UIcon name="i-lucide-user-round-plus" />Create person</button></header>
    <nav v-if="!sharedOnly" class="people-scope-tabs" aria-label="People collections"><button type="button" :aria-pressed="scope === 'mine'" @click="changeScope('mine')"><UIcon name="i-lucide-user-round" />My people</button><button type="button" :aria-pressed="scope === 'shared'" @click="changeScope('shared')"><UIcon name="i-lucide-users-round" />Shared with me</button></nav>
    <div v-if="!activePerson" class="people-collection">
      <div class="people-toolbar"><label class="people-search"><UIcon name="i-lucide-search" /><input v-model="search" type="search" maxlength="100" placeholder="Search names & descriptions" aria-label="Search people"></label><label v-if="sharedScope && sources.length" class="people-source-filter"><span class="sr-only">Person who shared</span><select v-model="sourceId" aria-label="Filter shared people by sharer"><option value="">All sharers</option><option v-for="source in sources" :key="source.userId" :value="source.userId">{{ source.displayName || source.username }}</option></select></label><span>{{ currentPeople.length }} profile{{ currentPeople.length === 1 ? '' : 's' }}{{ nextCursor ? '+' : '' }}</span><button class="people-text" type="button" :disabled="loading || !currentAccount" @click="refreshPeople"><UIcon name="i-lucide-refresh-cw" />Refresh</button></div>
      <p v-if="errorMessage" class="people-error" role="alert">{{ errorMessage }} <button type="button" :disabled="loading" @click="loadPeople()">Try again</button></p>
      <div v-if="loading && !currentPeople.length" class="people-empty" role="status"><UIcon name="i-lucide-loader-circle" class="people-spin" /><h2>Getting your cast ready…</h2></div>
      <div v-else-if="!currentPeople.length && !errorMessage" class="people-empty"><span class="people-empty-mark"><UIcon name="i-lucide-user-round" /></span><h2>{{ keyword ? 'No people found' : sharedScope ? 'A place for your shared cast' : 'Meet your next creative collaborator' }}</h2><p>{{ keyword ? 'Try another name or a detail from their description.' : sharedScope ? 'When someone in your organization shares a person with you, their confirmed pictures will appear here.' : 'Start with a name and a few details. Generate portraits, add different angles, and choose the pictures that fit your next shoot.' }}</p><button v-if="canCreate && !keyword" class="people-primary" type="button" @click="createOpen = true">Create your first person<UIcon name="i-lucide-arrow-right" /></button></div>
      <div v-else class="people-groups"><section v-for="group in groups" :key="group.key" class="people-source-group"><header v-if="sharedScope" class="people-source-heading"><span>{{ (group.source?.displayName || group.source?.username || '?').slice(0, 1).toUpperCase() }}</span><div><h2>{{ group.source?.displayName || group.source?.username || 'Shared with you' }}</h2><p>Shared by {{ group.source?.username || 'an organization member' }} · Can view</p></div></header><div class="people-grid"><button v-for="person in group.people" :key="person.id" class="people-profile-card" type="button" @click="openPerson(person)"><div class="people-cover"><img v-if="photoCover(person) && !unavailable.has(person.id)" :src="imagePreviewUrl(photoCover(person)!.url, 480)" :alt="person.name" loading="lazy" decoding="async" @error="unavailable = new Set([...unavailable, person.id])"><span v-else class="people-monogram">{{ person.name.slice(0, 1).toUpperCase() }}</span><span class="people-picture-count"><UIcon name="i-lucide-images" />{{ person.photoCount }} picture{{ person.photoCount === 1 ? '' : 's' }}</span></div><div class="people-card-caption"><div><h2>{{ person.name }}</h2><UIcon name="i-lucide-arrow-up-right" /></div><p>{{ person.description || 'A new face, waiting for a first photograph.' }}</p></div></button></div></section></div>
      <button v-if="nextCursor" class="people-more" type="button" :disabled="loadingMore" @click="loadPeople(true)">{{ loadingMore ? 'Loading…' : 'Load more people' }}<UIcon name="i-lucide-chevron-down" /></button>
    </div>
    <div v-else class="people-detail">
      <div class="people-detail-top"><button class="people-text" type="button" @click="back"><UIcon name="i-lucide-arrow-left" />All people</button><div class="people-detail-tools"><button class="people-text" type="button" :disabled="detailLoading || !currentAccount" @click="refreshPeople"><UIcon name="i-lucide-refresh-cw" />Refresh</button><template v-if="!isPicker && editablePerson"><button v-if="canShare(activePerson)" class="people-text" type="button" @click="openShares(activePerson)"><UIcon name="i-lucide-share-2" />Share person</button><button class="people-text" type="button" :disabled="saving" @click="beginEdit"><UIcon name="i-lucide-pencil" />Edit profile</button><button class="people-text" type="button" :disabled="pendingCount > 0 || detailLoading || generationProgress.running(activePerson.id)" @click="deleteOpen = true" title="Pending generations must finish before removing the profile"><UIcon name="i-lucide-trash-2" />Remove profile</button></template></div></div>
      <div class="people-profile-intro"><div class="people-identity-mark">{{ activePerson.name.slice(0, 1).toUpperCase() }}</div><div><span class="people-eyebrow">Person profile</span><h2>{{ activePerson.name }}</h2><p>{{ activePerson.description || 'Add appearance, personality, and styling notes to guide their photographs.' }}</p><span class="people-profile-stat">{{ activePerson.photoCount }} picture{{ activePerson.photoCount === 1 ? '' : 's' }} · {{ activePerson.sharedBy ? `Shared by ${activePerson.sharedBy.displayName || activePerson.sharedBy.username} · Can view` : 'Your person profile' }}</span></div></div>
      <form v-if="editOpen && !isPicker && editablePerson" class="people-profile-form" @submit.prevent="savePerson"><label>Name<input v-model="editName" class="people-input" required maxlength="80" :disabled="saving"></label><label>Description<textarea v-model="editDescription" class="people-input" maxlength="4000" rows="3" :disabled="saving" /></label><div><button class="people-primary" type="submit" :disabled="saving">{{ saving ? 'Saving…' : 'Save profile' }}</button><button class="people-text" type="button" :disabled="saving" @click="editOpen = false">Cancel</button></div></form>
      <div class="people-photo-heading"><div><h3>Pictures</h3><p>Choose the faces and angles you want to reuse.</p></div><div v-if="!isPicker && editablePerson" class="people-photo-actions"><button class="people-secondary" type="button" :disabled="detailLoading || attaching" @click="attachSelection = []; attachOpen = true"><UIcon name="i-lucide-folder-open" />Add from library</button><button class="people-primary" type="button" :disabled="detailLoading || generatorOpen" @click="generatorOpen = true"><UIcon name="i-lucide-sparkles" />Generate pictures</button></div></div>
      <p v-if="pendingCount || generationProgress.running(activePerson.id)" class="people-pending" role="status"><UIcon name="i-lucide-loader-circle" class="people-spin" />{{ pendingCount || 'Your' }} picture{{ pendingCount === 1 ? '' : 's' }} generating or awaiting exact price. Confirmed results appear here automatically.</p><p v-if="failedCount" class="people-muted">{{ failedCount }} previous generation{{ failedCount === 1 ? '' : 's' }} could not be completed. You can create a new batch.</p>
      <p v-if="detailError" class="people-error" role="alert">{{ detailError }} <button type="button" :disabled="detailLoading" @click="loadPerson(activePerson.id)">Try again</button></p><p v-if="detailLoading" class="people-muted" role="status">Loading pictures…</p>
      <div v-if="!detailLoading && !visiblePhotos.length && !detailError" class="people-photo-empty"><UIcon name="i-lucide-camera" /><h3>{{ editablePerson ? 'A first photograph is the start' : 'No confirmed pictures yet' }}</h3><p>{{ isPicker || !editablePerson ? 'This person has no confirmed pictures to select yet.' : 'Generate a portrait from their description, or add a picture from your library.' }}</p><button v-if="!isPicker && editablePerson" class="people-text" type="button" @click="generatorOpen = true">Create their first picture<UIcon name="i-lucide-arrow-right" /></button></div>
      <div v-if="visiblePhotos.length" class="people-photo-grid"><article v-for="photo in visiblePhotos" :key="photo.id" class="people-photo-card" :class="{'is-selected': selectedSet.has(photo.url)}"><button type="button" class="people-photo-select" :aria-pressed="selectedSet.has(photo.url)" :aria-label="`${selectedSet.has(photo.url) ? 'Deselect' : 'Select'} ${photo.name}`" @click="togglePhoto(photo, $event)"><img v-if="!unavailable.has(photo.id)" :src="imagePreviewUrl(photo.url, 480)" :alt="photo.name" loading="lazy" decoding="async" @error="unavailable = new Set([...unavailable, photo.id])"><span v-else class="people-preview-unavailable">Preview unavailable</span><span class="people-selection-dot"><UIcon v-if="selectedSet.has(photo.url)" name="i-lucide-check" /></span></button><div class="people-photo-caption"><strong :title="photo.name">{{ photo.name }}</strong><span>{{ photoPrice(photo) }}</span><div><a class="people-text" :href="imageDownloadUrl(photo.url)" :download="photo.name" :aria-label="`Download ${photo.name}`"><UIcon name="i-lucide-download" />Download</a><button v-if="!isPicker && editablePerson" type="button" class="people-text" :disabled="Boolean(removing)" :aria-label="`Remove ${photo.name} from this person, keeping the library image`" @click="removePhoto(photo)"><UIcon name="i-lucide-unlink" />{{ removing === photo.id ? 'Removing…' : 'Unlink' }}</button></div></div></article></div>
      <button v-if="photoCursor" class="people-more" type="button" :disabled="photoLoadingMore" @click="loadPerson(activePerson.id, {more: true})">{{ photoLoadingMore ? 'Loading…' : 'Load more pictures' }}<UIcon name="i-lucide-chevron-down" /></button><p v-if="pollingPaused && pendingCount" class="people-muted" role="status">Progress watching is paused. Your generations remain saved. <button class="people-text" type="button" @click="pollAttempts = 0; pollingPaused = false; loadPerson(activePerson.id)">Refresh pictures</button></p>
    </div>
    <div v-if="selection.length || isPicker" class="people-selection-bar"><div><strong>{{ selection.length }} {{ selectionLabel === 'pictures' ? 'picture' : 'reference' }}{{ selection.length === 1 ? '' : 's' }} selected</strong><small>{{ selection.length }}/{{ selectionLimit }} available slots · selections can span people · Shift selects a range</small></div><div><button class="people-text" type="button" :disabled="!selection.length" @click="clearSelection">Clear</button><button class="people-primary" type="button" :disabled="!selection.length || selection.length > selectionLimit || !currentAccount" @click="confirm">{{ isPicker ? 'Use selected pictures' : 'Use as references' }}<UIcon name="i-lucide-arrow-right" /></button></div></div>
    <p v-if="selectionNotice || selection.length > selectionLimit" class="people-error" role="alert">{{ selectionNotice || (selectionLabel === 'pictures' ? `Remove some selections. This batch accepts ${selectionLimit} pictures.` : `Remove some selections. The current model supports ${selectionLimit} reference pictures.`) }}</p>
    <div v-if="createOpen && canCreate" class="people-overlay"><form ref="dialogElement" class="people-dialog" role="dialog" aria-modal="true" aria-labelledby="person-create-title" @submit.prevent="createPerson"><header><div><span class="people-eyebrow">A fresh face</span><h2 id="person-create-title">Create a person</h2></div><button class="people-icon" type="button" :disabled="creating" aria-label="Close create person" @click="createOpen = false"><UIcon name="i-lucide-x" /></button></header><p class="people-muted">Give them a name and the details that make them recognizable. You can generate their pictures next.</p><label>Name<input v-model="newName" class="people-input" placeholder="e.g. Alex" required maxlength="80" :disabled="creating"></label><label>Description<textarea v-model="newDescription" class="people-input" placeholder="Appearance, hair, distinguishing features, personal style…" rows="4" maxlength="4000" :disabled="creating" /></label><p v-if="errorMessage" class="people-error" role="alert">{{ errorMessage }}</p><footer><button class="people-text" type="button" :disabled="creating" @click="createOpen = false">Cancel</button><button class="people-primary" type="submit" :disabled="creating || !newName.trim()">{{ creating ? 'Creating…' : 'Create person' }}<UIcon name="i-lucide-arrow-right" /></button></footer></form></div>
    <div v-if="deleteOpen && activePerson && editablePerson" class="people-overlay"><section ref="dialogElement" class="people-dialog" role="dialog" aria-modal="true" aria-labelledby="person-delete-title"><header><h2 id="person-delete-title">Remove {{ activePerson.name }}?</h2><button class="people-icon" type="button" :disabled="deleting" aria-label="Close remove profile" @click="deleteOpen = false"><UIcon name="i-lucide-x" /></button></header><p class="people-muted">This removes the profile and its picture associations. The pictures, generation history, and charges stay in your library.</p><p v-if="detailError" class="people-error" role="alert">{{ detailError }}</p><footer><button class="people-text" type="button" :disabled="deleting" @click="deleteOpen = false">Cancel</button><button class="people-primary" type="button" :disabled="deleting" @click="deletePerson">{{ deleting ? 'Removing…' : 'Remove profile' }}</button></footer></section></div>
    <div v-if="attachOpen && activePerson && editablePerson" class="people-overlay"><section ref="dialogElement" class="people-asset-dialog" role="dialog" aria-modal="true" aria-label="Add pictures to person"><header><div><strong>Add pictures to {{ activePerson.name }}</strong><p>Your own uploaded or confirmed library images.</p></div><button class="people-icon" type="button" :disabled="attaching" aria-label="Close picture library" @click="attachOpen = false"><UIcon name="i-lucide-x" /></button></header><p v-if="detailError" class="people-error" role="alert">{{ detailError }}</p><AssetBrowser v-model:selected-urls="attachSelection" selection-mode="multiple" :max-selection="20" title="Choose pictures" @confirm="attachPhotos" /></section></div>
    <div v-if="generatorOpen && activePerson && editablePerson" class="people-overlay"><PersonGenerator :key="`${activePerson.id}:${initialAccount.epoch}`" :person="activePerson" :photos="visiblePhotos" :selected-urls="selectedPersonPhotos" @close="generatorClosed" @generated="generated" /></div>
    <div v-if="shareTarget && canShare(shareTarget)" class="people-overlay"><section ref="dialogElement" class="people-dialog people-share-dialog" role="dialog" aria-modal="true" aria-labelledby="person-share-title"><header><div><span class="people-eyebrow">For your organization</span><h2 id="person-share-title">Share {{ shareTarget.name }}</h2></div><button class="people-icon" type="button" :disabled="shareSaving" aria-label="Close person sharing" @click="closeShares"><UIcon name="i-lucide-x" /></button></header><p class="people-muted">Share the profile and its pictures with an organization member. New confirmed pictures become available to them automatically.</p><p v-if="shareLoading" class="people-muted" role="status">Loading people with access…</p><template v-else><form class="people-share-form" @submit.prevent="grantShare"><label><span class="sr-only">Organization member</span><select v-model="shareRecipient" class="people-input" aria-label="Organization member to share with" :disabled="shareSaving"><option value="">Choose an organization member</option><option v-for="user in shareUsers" :key="user.id" :value="user.id" :disabled="shares.some(share => share.recipientUserId === user.id)">{{ user.displayName || user.username }} · {{ user.username }}</option></select></label><button class="people-primary" type="submit" :disabled="shareSaving || !shareRecipient">{{ shareSaving ? 'Saving…' : 'Share person' }}</button></form><p class="people-share-help">Can view, download, and use these pictures as references in their own generations. Only you can edit this person, add pictures, generate into the profile, or change sharing.</p><h3>People with access</h3><p v-if="!shares.length" class="people-muted">Only you have access.</p><div v-for="share in shares" :key="share.recipientUserId" class="people-share-grant"><div><strong>{{ share.displayName || share.username }}</strong><small>{{ share.username }}</small></div><span>Can view</span><button class="people-icon" type="button" :disabled="shareSaving" :aria-label="`Remove ${share.displayName || share.username}’s access to this person`" @click="revokeShare(share.recipientUserId)"><UIcon name="i-lucide-user-round-minus" /></button></div></template><p v-if="shareError" class="people-error" role="alert">{{ shareError }} <button v-if="!shareLoading" type="button" :disabled="shareSaving" @click="loadShares">Try again</button></p></section></div>
  </section>
</template>

<style scoped>
.people-scope-tabs{display:flex;align-items:center;gap:22px;border-bottom:1px solid var(--workspace-border);margin:7px 0 0}.people-scope-tabs button{display:flex;align-items:center;gap:7px;padding:16px 0;font-size:11px;color:var(--workspace-muted);border-bottom:2px solid transparent}.people-scope-tabs button[aria-pressed="true"]{color:var(--workspace-accent);border-bottom-color:var(--workspace-accent)}.people-scope-tabs .iconify{width:14px;height:14px}.people-source-filter select{max-width:180px;background:var(--workspace-surface);border:1px solid var(--workspace-border);border-radius:8px;color:var(--workspace-muted);font-size:10px;padding:9px 10px}.people-source-group+.people-source-group{margin-top:34px}.people-source-heading{display:flex;align-items:center;gap:12px;margin:6px 0 18px}.people-source-heading>span{width:34px;height:34px;display:grid;place-items:center;border:1px solid #c6aa8630;border-radius:50%;color:#c6aa86;background:#c6aa8610;font-size:14px}.people-source-heading h2{font-size:13px;font-weight:550}.people-source-heading p{font-size:9px;color:var(--workspace-muted);margin-top:5px}.people-share-form{display:flex;align-items:center;gap:10px;margin:22px 0 14px}.people-share-form label{min-width:0;flex:1;margin:0}.people-share-form .people-input{margin:0}.people-share-help{font-size:10px;line-height:1.8;color:var(--workspace-muted);padding-bottom:22px;margin-bottom:21px;border-bottom:1px solid var(--workspace-border)}.people-share-dialog h3{font-size:12px;font-weight:550;margin-bottom:12px}.people-share-grant{display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--workspace-border);padding:12px 0}.people-share-grant>div{min-width:0;flex:1}.people-share-grant strong{display:block;font-size:11px;font-weight:500;overflow-wrap:anywhere}.people-share-grant small{display:block;color:var(--workspace-muted);font-size:9px;margin-top:5px}.people-share-grant>span{font-size:9px;color:#c6aa86}@media(max-width:600px){.people-toolbar{flex-wrap:wrap}.people-source-filter{flex:1}.people-source-filter select{width:100%;max-width:none}.people-detail-top{align-items:start}.people-detail-tools{flex-wrap:wrap;justify-content:flex-end;max-width:230px}.people-share-form{flex-direction:column;align-items:stretch}.people-share-form label{width:100%}}
.people-studio{padding:48px 52px 36px;width:100%;max-width:1600px;margin:auto;color:var(--workspace-text);font-size:12px}.people-heading{display:flex;align-items:start;justify-content:space-between;gap:28px;padding-bottom:31px;border-bottom:1px solid var(--workspace-border)}.people-eyebrow{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--workspace-accent)}.people-heading h1{font-size:35px;font-weight:500;letter-spacing:-1.2px;margin-top:10px}.people-heading p{color:var(--workspace-muted);font-size:12px;line-height:1.9;max-width:550px;margin-top:10px}.people-heading>.people-primary{margin-top:28px}.people-primary,.people-secondary{display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap;font-size:11px;font-weight:550;border-radius:9px;padding:11px 15px}.people-primary{background:var(--workspace-accent);color:#241c15}.people-primary:disabled,.people-secondary:disabled,.people-text:disabled{opacity:.4;cursor:not-allowed}.people-secondary{color:var(--workspace-text);border:1px solid var(--workspace-border);background:var(--workspace-surface)}.people-primary .iconify,.people-secondary .iconify{width:14px;height:14px}.people-toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:26px 0}.people-toolbar>span{font-size:10px;color:var(--workspace-muted)}.people-search{display:flex;gap:9px;align-items:center;width:min(350px,100%);background:var(--workspace-surface);border:1px solid var(--workspace-border);border-radius:9px;padding:10px 12px;color:var(--workspace-muted)}.people-search .iconify{width:14px;height:14px;flex:none}.people-search input{background:transparent;outline:none;width:100%;font-size:11px;color:var(--workspace-text)}.people-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:22px}.people-profile-card{text-align:left;background:var(--workspace-surface);border:1px solid var(--workspace-border);border-radius:14px;overflow:hidden;transition:border-color .15s,transform .15s}.people-profile-card:hover{border-color:#85705a;transform:translateY(-2px)}.people-cover{position:relative;aspect-ratio:4/4.4;display:grid;place-items:center;background:radial-gradient(ellipse at 35% 25%,#504535,#2b2821 60%,#221f1b);overflow:hidden}.people-cover img{width:100%;height:100%;min-width:0;min-height:0;object-fit:contain}.people-monogram{font-size:90px;font-weight:300;color:#b29b7c;opacity:.55}.people-picture-count{position:absolute;left:12px;bottom:12px;display:flex;gap:6px;align-items:center;color:#fff1e1;background:#17140ec9;padding:6px 9px;border:1px solid #ffffff12;backdrop-filter:blur(8px);border-radius:99px;font-size:9px}.people-picture-count .iconify{width:12px;height:12px}.people-card-caption{padding:17px}.people-card-caption>div{display:flex;align-items:center;justify-content:space-between;gap:8px}.people-card-caption h2{font-size:15px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.people-card-caption .iconify{width:15px;height:15px;color:var(--workspace-muted)}.people-card-caption p{color:var(--workspace-muted);font-size:10px;line-height:1.8;margin-top:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:36px}.people-empty{text-align:center;padding:100px 22px}.people-empty-mark{display:grid;place-items:center;width:67px;height:77px;margin:0 auto 25px;background:#d2a97610;color:#c6aa86;border:1px solid #c6aa8620;border-radius:29px 29px 18px 18px}.people-empty-mark .iconify{width:28px;height:28px}.people-empty h2{font-size:22px;font-weight:500;letter-spacing:-.5px}.people-empty p{font-size:11px;line-height:1.9;max-width:370px;margin:14px auto 22px;color:var(--workspace-muted)}.people-more{display:flex;align-items:center;justify-content:center;gap:7px;margin:30px auto 0;color:var(--workspace-muted);font-size:11px;border:1px solid var(--workspace-border);border-radius:9px;padding:10px 15px}.people-more .iconify{width:13px;height:13px}.people-error{color:#e4a698;line-height:1.8;font-size:11px;margin:16px 0}.people-error button{text-decoration:underline;margin-left:7px}.people-text{display:inline-flex;align-items:center;gap:6px;font-size:10px;color:var(--workspace-muted)}.people-text:hover{color:var(--workspace-text)}.people-text .iconify{width:13px;height:13px}.people-detail-top{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:23px 0}.people-detail-tools{display:flex;gap:20px}.people-profile-intro{display:flex;gap:25px;align-items:start;margin:12px 0 37px;max-width:740px}.people-identity-mark{flex:none;width:70px;height:80px;border-radius:30px 30px 19px 19px;background:#c6aa8610;border:1px solid #c6aa8622;color:#c6aa86;font-size:34px;display:grid;place-items:center;font-weight:300}.people-profile-intro h2{font-size:28px;font-weight:500;letter-spacing:-.7px;margin:7px 0 8px;overflow-wrap:anywhere}.people-profile-intro p{font-size:12px;line-height:1.8;color:var(--workspace-muted);white-space:pre-line;overflow-wrap:anywhere}.people-profile-stat{display:block;color:#c6aa86;font-size:10px;margin-top:14px}.people-photo-heading{display:flex;justify-content:space-between;align-items:center;gap:22px;padding-top:28px;border-top:1px solid var(--workspace-border);margin-bottom:23px}.people-photo-heading h3{font-size:15px;font-weight:550}.people-photo-heading p{font-size:10px;color:var(--workspace-muted);margin-top:7px}.people-photo-actions{display:flex;gap:10px}.people-photo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:20px}.people-photo-card{border:1px solid var(--workspace-border);border-radius:12px;background:var(--workspace-surface);overflow:hidden}.people-photo-card.is-selected{border-color:var(--workspace-accent);box-shadow:0 0 0 1px var(--workspace-accent)}.people-photo-select{display:block;width:100%;aspect-ratio:4/5;position:relative;background:var(--workspace-bg);overflow:hidden}.people-photo-select img{display:block;width:100%;height:100%;min-width:0;min-height:0;object-fit:contain}.people-selection-dot{position:absolute;top:10px;left:10px;width:21px;height:21px;border:1px solid #ffffff70;background:#15120b66;display:grid;place-items:center;border-radius:50%}.people-selection-dot .iconify{width:13px;height:13px}.is-selected .people-selection-dot{background:var(--workspace-accent);border-color:var(--workspace-accent);color:#241c15}.people-preview-unavailable{display:grid;place-items:center;height:100%;font-size:10px;color:var(--workspace-muted)}.people-photo-caption{padding:14px}.people-photo-caption strong{display:block;font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.people-photo-caption>span{display:block;font-size:9px;color:#c6aa86;margin-top:6px;overflow-wrap:anywhere}.people-photo-caption>div{display:flex;justify-content:space-between;gap:10px;margin-top:15px}.people-photo-empty{text-align:center;border:1px dashed var(--workspace-border);border-radius:14px;padding:60px 20px;margin:20px 0}.people-photo-empty>.iconify{width:28px;height:28px;color:#b59a78}.people-photo-empty h3{font-size:17px;margin-top:16px;font-weight:500}.people-photo-empty p{color:var(--workspace-muted);font-size:11px;margin:10px 0 18px;line-height:1.7}.people-pending{display:flex;align-items:center;gap:8px;background:#c6aa8608;border:1px solid #c6aa8622;border-radius:10px;padding:13px 15px;color:#d4ba98;font-size:11px;line-height:1.8;margin-bottom:19px}.people-pending .iconify{width:14px;height:14px;flex:none}.people-muted{color:var(--workspace-muted);font-size:11px;line-height:1.8;margin:14px 0}.people-selection-bar{position:sticky;bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:20px;background:#29251ffc;backdrop-filter:blur(16px);border:1px solid #79684e;border-radius:12px;padding:15px 19px;margin-top:30px;box-shadow:0 8px 40px #0003;z-index:2}.people-selection-bar strong{font-size:11px;font-weight:550}.people-selection-bar small{display:block;font-size:9px;color:var(--workspace-muted);margin-top:5px}.people-selection-bar>div:last-child{display:flex;align-items:center;gap:20px}.people-overlay{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:#0b090be3;backdrop-filter:blur(7px);padding:24px}.people-dialog{width:min(540px,100%);max-height:calc(100dvh - 48px);overflow:auto;padding:30px;border-radius:18px;background:var(--workspace-surface);border:1px solid var(--workspace-border);box-shadow:0 24px 90px #0009}.people-dialog header{display:flex;justify-content:space-between;align-items:start;gap:18px}.people-dialog h2{font-size:23px;font-weight:550;letter-spacing:-.5px;margin-top:7px}.people-dialog label,.people-profile-form label{display:block;font-size:11px;color:var(--workspace-muted);margin:19px 0}.people-input{display:block;width:100%;margin-top:8px;background:var(--workspace-bg);border:1px solid var(--workspace-border);border-radius:9px;padding:11px 12px;color:var(--workspace-text);font-size:12px;line-height:1.6}.people-input:focus{outline:2px solid var(--workspace-accent);outline-offset:2px}.people-dialog footer{display:flex;align-items:center;justify-content:space-between;gap:15px;padding-top:20px;margin-top:25px;border-top:1px solid var(--workspace-border)}.people-icon{width:30px;height:30px;display:grid;place-items:center;color:var(--workspace-muted);border-radius:7px}.people-icon:hover{background:var(--workspace-surface-raised)}.people-icon .iconify{width:16px;height:16px}.people-asset-dialog{width:min(1100px,100%);height:min(780px,calc(100dvh - 48px));display:flex;flex-direction:column;background:var(--workspace-surface);border:1px solid var(--workspace-border);border-radius:18px;overflow:hidden}.people-asset-dialog>header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 24px;border-bottom:1px solid var(--workspace-border)}.people-asset-dialog strong{font-size:14px;font-weight:550}.people-asset-dialog header p{font-size:10px;color:var(--workspace-muted);margin-top:7px}.people-asset-dialog>.people-error{padding:0 24px}.people-asset-dialog:deep(.asset-browser){min-height:0;flex:1}.people-profile-form{max-width:650px;border:1px solid var(--workspace-border);background:var(--workspace-surface);padding:4px 23px 23px;border-radius:12px;margin-bottom:28px}.people-profile-form>div{display:flex;gap:20px;align-items:center}.people-spin{animation:people-spin 1s linear infinite}@keyframes people-spin{to{transform:rotate(360deg)}}.people-studio--picker{padding:26px 30px;max-width:none}.people-studio--picker .people-heading{padding-bottom:22px}.people-studio--picker .people-heading h1{font-size:25px}.people-studio--picker .people-heading p{font-size:11px}.people-studio--picker .people-grid{grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}.people-studio--picker .people-empty{padding:65px 20px}.people-studio--picker .people-photo-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px}@media(max-width:900px){.people-studio{padding:32px 28px}.people-grid{grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}}@media(max-width:600px){.people-studio{padding:26px 18px}.people-heading{gap:16px;flex-direction:column}.people-heading h1{font-size:30px}.people-heading>.people-primary{margin-top:0}.people-toolbar{gap:10px}.people-toolbar>span{display:none}.people-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.people-monogram{font-size:60px}.people-card-caption{padding:12px}.people-card-caption h2{font-size:13px}.people-cover{aspect-ratio:4/5}.people-picture-count{font-size:8px;left:8px;bottom:8px;padding:5px 7px}.people-detail-tools{gap:12px}.people-profile-intro{gap:16px}.people-identity-mark{width:52px;height:62px;font-size:25px}.people-profile-intro h2{font-size:25px}.people-photo-heading{flex-direction:column;align-items:start}.people-photo-actions{width:100%;gap:8px}.people-photo-actions button{flex:1;padding:10px;font-size:10px}.people-photo-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.people-photo-caption{padding:10px}.people-photo-caption>div{flex-wrap:wrap}.people-photo-caption .people-text{font-size:9px}.people-selection-bar{align-items:stretch;gap:15px;padding:15px;flex-direction:column}.people-selection-bar>div:last-child{justify-content:space-between}.people-dialog{padding:23px}.people-overlay{padding:12px}.people-studio--picker .people-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.people-studio--picker .people-photo-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.people-asset-dialog{height:calc(100dvh - 24px)}.people-empty{padding:70px 10px}.people-empty h2{font-size:19px}}
</style>
