<script setup lang="ts">
import type {Component} from 'vue'
import type {Person, PersonPhoto} from '../../schemas/people'
import {DEFAULT_IMAGE_MODEL_ID, IMAGE_MODEL_PROFILES, SUPPORTED_IMAGE_MODEL_IDS, ImageGenerationRequestSchema, createDefaultSettings, generationOutputCount, type ImageGenerationSettings, type ImageModelId, type ImageModelProfile} from '../../schemas/image-generation'
import {isNewImageModel, orderImageModels} from '../../schemas/image-model-discovery'
import {parseUsdUnits} from '../../schemas/account-billing'
import {hasConfirmedGenerationPrice} from '../../schemas/generation-billing'
import {useImageModelFavourites} from '../composables/useImageModelFavourites'
import {formatBalanceUsd} from '../utils/generationPrice'
import {imagePreviewUrl} from '../utils/imageDelivery'
import Gemini31FlashImageSettings from './generation-settings/Gemini31FlashImageSettings.vue'
import Gemini3ProImageSettings from './generation-settings/Gemini3ProImageSettings.vue'
import Gemini31FlashLiteImageSettings from './generation-settings/Gemini31FlashLiteImageSettings.vue'
import Gemini25FlashImageSettings from './generation-settings/Gemini25FlashImageSettings.vue'
import OpenAiGptImage2Settings from './generation-settings/OpenAiGptImage2Settings.vue'
import OpenAiGptImage25Settings from './generation-settings/OpenAiGptImage25Settings.vue'
import OpenAiGptImageLegacySettings from './generation-settings/OpenAiGptImageLegacySettings.vue'
import CatalogImageSettings from './generation-settings/CatalogImageSettings.vue'

const props = defineProps<{person: Person; photos: PersonPhoto[]; selectedUrls?: string[]}>()
const emit = defineEmits<{close: []; generated: []}>()
const account = useAccount()
const balance = useAccountBalance()
const generationProgress = usePeopleGenerationProgress()
const requestFetch = useRequestFetch()
const initialAccount = {epoch: account.epoch.value, identity: account.identity.value}
const currentAccount = computed(() => initialAccount.epoch === account.epoch.value && initialAccount.identity === account.identity.value)
const {favouriteModelIds, favouriteSet, ready: favouritesReady, persistent: favouritesPersistent, toggleFavourite} = useImageModelFavourites()
const model = ref<ImageModelId>(DEFAULT_IMAGE_MODEL_ID)
const settings = ref<ImageGenerationSettings>(createDefaultSettings(DEFAULT_IMAGE_MODEL_ID))
const scene = ref('A natural studio portrait, neutral background, soft light, realistic detail.')
const pictureCount = ref(1)
const referenceUrls = ref<string[]>([])
const models = ref<Array<{id: string; catalogStatus: 'available' | 'unavailable' | 'unknown'; availabilityNote?: string}>>([])
const loadingModels = ref(false)
const generating = ref(false)
const running = computed(() => generating.value || generationProgress.running(props.person.id))
const errorMessage = ref('')
const panel = ref<HTMLElement>()
const profile = computed(() => IMAGE_MODEL_PROFILES[model.value])
const eligiblePhotos = computed(() => currentAccount.value ? props.photos.filter(photo => photo.generationId === null || hasConfirmedGenerationPrice(photo)) : [])
const selectedReferences = computed(() => referenceUrls.value.filter(url => eligiblePhotos.value.some(photo => photo.url === url)))
const totalPictures = computed(() => pictureCount.value * generationOutputCount(settings.value))
const modelAvailable = computed(() => models.value.some(item => item.id === model.value && item.catalogStatus !== 'unavailable'))
const orderedModels = computed(() => orderImageModels(SUPPORTED_IMAGE_MODEL_IDS, favouriteModelIds.value).map(id => ({id, profile: IMAGE_MODEL_PROFILES[id], disabled: IMAGE_MODEL_PROFILES[id].requiresMask || !models.value.some(item => item.id === id && item.catalogStatus !== 'unavailable')})))
const creditBlockReason = computed(() => {
  const value = balance.balance.value
  if (!value || value.unlimited) return ''
  if (!value.actualBalanceUsd || value.actualBalanceUsd.startsWith('-') || parseUsdUnits(value.actualBalanceUsd) === 0n) return 'Your credit is used up. Ask an organization owner to add credit.'
  if (value.generationBlockedByOutstanding ?? value.outstandingCount > 0) return 'Your previous image prices must settle before another generation can use your credit.'
  return ''
})
const canGenerate = computed(() => currentAccount.value && modelAvailable.value && !profile.value.requiresMask && !running.value && !!scene.value.trim() && selectedReferences.value.length <= profile.value.maxReferenceImages && totalPictures.value <= 4 && !creditBlockReason.value)
const settingsComponents: Record<ImageModelProfile['settingsComponent'], Component> = {Gemini31FlashImageSettings, Gemini3ProImageSettings, Gemini31FlashLiteImageSettings, Gemini25FlashImageSettings, OpenAiGptImage2Settings, OpenAiGptImage25Settings, OpenAiGptImageLegacySettings, CatalogImageSettings}
const component = computed(() => settingsComponents[profile.value.settingsComponent])
let revision = 0
const requests = new Set<AbortController>()
const generationRequests = new Set<AbortController>()
let previousFocus: HTMLElement | null = null
function snapshot() { return {epoch: account.epoch.value, identity: account.identity.value, revision} }
function current(value: ReturnType<typeof snapshot>) { return currentAccount.value && value.epoch === account.epoch.value && value.identity === account.identity.value && value.revision === revision }
async function request<T>(url: string, options: {method?: 'POST'; body?: Record<string, unknown>; timeout?: number} = {}) {
  const controller = new AbortController(); requests.add(controller)
  try { return await requestFetch<T>(url, {...options, timeout: options.timeout ?? 20_000, signal: controller.signal}) }
  finally { requests.delete(controller) }
}
async function loadModels() {
  const value = snapshot(); loadingModels.value = true
  try { const response = await request<{items: typeof models.value}>('/api/image-models'); if (current(value)) models.value = response.items }
  catch { if (current(value)) errorMessage.value = 'Could not load image models. Try again.' }
  finally { if (current(value)) loadingModels.value = false }
}
function toggleReference(url: string) {
  if (generating.value || !eligiblePhotos.value.some(photo => photo.url === url)) return
  if (referenceUrls.value.includes(url)) referenceUrls.value = referenceUrls.value.filter(value => value !== url)
  else if (selectedReferences.value.length < profile.value.maxReferenceImages) referenceUrls.value.push(url)
}
function generationPrompt() {
  return [selectedReferences.value.length ? 'Create a new photograph of the same adult person shown in the reference images. Preserve their facial identity and distinctive features.' : 'Create a fictional adult person for a product photography reference.', `Person: ${props.person.name}.`, props.person.description.trim() ? `Appearance and character: ${props.person.description.trim()}` : '', `Photograph: ${scene.value.trim()}`].filter(Boolean).join('\n\n')
}
async function generate() {
  if (!canGenerate.value) return
  let body: ReturnType<typeof ImageGenerationRequestSchema.parse>
  try { body = ImageGenerationRequestSchema.parse({personId: props.person.id, personPictureCount: pictureCount.value, prompt: generationPrompt(), model: model.value, settings: structuredClone(toRaw(settings.value)), inputImages: [], modelImages: [...selectedReferences.value], storeInputImages: true}) }
  catch { errorMessage.value = 'Check the model settings and reference limit before generating.'; return }
  const token = generationProgress.claim(props.person.id)
  if (!token) return
  const value = snapshot(); generating.value = true; errorMessage.value = ''
  const controller = new AbortController(); generationRequests.add(controller)
  try {
    const response = await requestFetch<{ok: boolean; obj?: Array<{errors?: string | null}>}>('/api/image-generate', {method: 'POST', body, timeout: 600_000, signal: controller.signal})
    if (!current(value)) return
    if (response.obj?.some(row => row.errors)) errorMessage.value = 'Some pictures could not be generated. Saved results will appear when their exact price is confirmed.'
    emit('generated')
    await balance.refresh()
  } catch (error) {
    if (!current(value)) return
    const status = (error as {statusCode?: number; status?: number})?.statusCode ?? (error as {status?: number})?.status
    errorMessage.value = status === 429 ? 'The generation queue is busy. Try again after the current work finishes.' : 'Could not finish this generation. Refresh the person’s pictures before trying again; accepted work stays in your history.'
    emit('generated'); await balance.refresh()
  } finally { generationRequests.delete(controller); generationProgress.release(token); if (current(value)) generating.value = false }
}
function cancelRequests() { revision += 1; for (const controller of requests) controller.abort(); requests.clear() }
function close() { emit('close') }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  if (event.key === 'Tab') {
    const elements = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? [])]
    if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus() }
    else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus() }
  }
}
watch(model, () => { settings.value = createDefaultSettings(model.value); errorMessage.value = '' }, {flush: 'sync'})
watch([account.epoch, account.identity], () => { cancelRequests(); for (const controller of generationRequests) controller.abort(); models.value = []; referenceUrls.value = []; scene.value = ''; model.value = DEFAULT_IMAGE_MODEL_ID; settings.value = createDefaultSettings(DEFAULT_IMAGE_MODEL_ID); pictureCount.value = 1; errorMessage.value = ''; generating.value = false; loadingModels.value = false }, {flush: 'sync'})
onMounted(() => {
  const supplied = (props.selectedUrls ?? []).filter(url => eligiblePhotos.value.some(photo => photo.url === url))
  referenceUrls.value = supplied.length ? supplied.slice(0, profile.value.maxReferenceImages) : eligiblePhotos.value.slice(0, 1).map(photo => photo.url)
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  panel.value?.querySelector<HTMLButtonElement>('button')?.focus()
  document.addEventListener('keydown', keydown, {capture: true})
  void loadModels(); void balance.refresh()
})
onBeforeUnmount(() => { cancelRequests(); document.removeEventListener('keydown', keydown, {capture: true}); if (previousFocus?.isConnected) previousFocus.focus() })
</script>

<template>
  <section ref="panel" class="person-generator" role="dialog" aria-modal="true" aria-labelledby="person-generator-title">
    <header><div><span class="person-eyebrow">People factory</span><h2 id="person-generator-title">Photograph {{ currentAccount ? person.name : 'a person' }}</h2></div><button type="button" class="person-icon" aria-label="Close person generator" @click="close"><UIcon name="i-lucide-x" /></button></header>
    <p class="person-muted">Create their first portrait or explore new looks with the same person as a reference. Pictures join this profile once their exact cost is confirmed.</p>
    <label class="person-label" for="person-scene">Scene, pose & styling</label><textarea id="person-scene" v-model="scene" class="person-input" rows="3" maxlength="12000" :disabled="generating" />
    <fieldset v-if="eligiblePhotos.length" class="person-identity"><legend>Identity references <span>{{ selectedReferences.length }}/{{ profile.maxReferenceImages }}</span></legend><div><button v-for="photo in eligiblePhotos" :key="photo.id" class="person-reference" :class="{'is-selected': selectedReferences.includes(photo.url)}" type="button" :aria-pressed="selectedReferences.includes(photo.url)" :aria-label="`Use ${photo.name} as identity reference`" :disabled="generating || (!selectedReferences.includes(photo.url) && selectedReferences.length >= profile.maxReferenceImages)" @click="toggleReference(photo.url)"><img :src="imagePreviewUrl(photo.url, 160)" :alt="photo.name" loading="lazy" decoding="async"><span v-if="selectedReferences.includes(photo.url)"><UIcon name="i-lucide-check" /></span></button></div><p class="person-muted">Selected pictures help preserve identity. Different angles and lighting can still vary.</p></fieldset>
    <div class="person-model-row"><div><label class="person-label" for="person-model">Image model</label><div class="person-model-select"><select id="person-model" v-model="model" class="person-input" :disabled="generating || loadingModels"><option v-for="item in orderedModels" :key="item.id" :value="item.id" :disabled="item.disabled">{{ favouriteSet.has(item.id) ? '♥ ' : '' }}{{ item.profile.shortName }}{{ isNewImageModel(item.id) ? ' · New' : '' }}{{ item.profile.requiresMask ? ' · mask required' : item.disabled ? ' · unavailable' : '' }}</option></select><button type="button" class="person-icon" :disabled="!favouritesReady || generating" :aria-pressed="favouriteSet.has(model)" :aria-label="`${favouriteSet.has(model) ? 'Remove' : 'Add'} ${profile.shortName} ${favouriteSet.has(model) ? 'from' : 'to'} favourites`" @click="toggleFavourite(model)"><UIcon name="i-lucide-heart" :class="{'person-heart': favouriteSet.has(model)}" /></button></div></div><div><label class="person-label" for="person-picture-count">Variations</label><select id="person-picture-count" v-model.number="pictureCount" class="person-input" :disabled="generating"><option v-for="count in 4" :key="count" :value="count">{{ count }}</option></select></div></div>
    <p v-if="!favouritesPersistent" class="person-muted" role="status">Favourites last for this visit because browser storage is unavailable.</p><p v-if="profile.requiresMask" class="person-error" role="alert">This model requires a mask and cannot create person portraits here.</p>
    <details class="person-settings"><summary>Model settings <span>{{ profile.shortName }}<small v-if="isNewImageModel(model)">New</small></span></summary><div><NuxtErrorBoundary :key="model"><component :is="component" v-model="settings" /><template #error><p class="person-error">Settings could not load. <button type="button" @click="settings = createDefaultSettings(model)">Restore defaults</button></p></template></NuxtErrorBoundary></div></details>
    <p v-if="totalPictures > 4" class="person-error" role="alert">Choose fewer variations or reduce the model’s number of images. A person batch can contain up to 4 pictures.</p><p v-if="selectedReferences.length > profile.maxReferenceImages" class="person-error" role="alert">This model accepts up to {{ profile.maxReferenceImages }} reference pictures. Remove some selections.</p>
    <p v-if="creditBlockReason || errorMessage" class="person-error" role="alert">{{ creditBlockReason || errorMessage }} <button v-if="!models.length" type="button" :disabled="loadingModels" @click="loadModels">Reload models</button></p>
    <footer><div><strong>{{ totalPictures }} picture{{ totalPictures === 1 ? '' : 's' }}</strong><span>Available credit: {{ balance.balance.value ? balance.balance.value.unlimited ? 'Unlimited' : formatBalanceUsd(balance.balance.value.actualBalanceUsd) : 'loading…' }}</span><small>Final price appears with each picture.</small></div><button type="button" class="person-primary" :disabled="!canGenerate" @click="generate"><UIcon :name="generating ? 'i-lucide-loader-circle' : 'i-lucide-sparkles'" :class="{'person-spin': generating}" />{{ generating ? 'Generating…' : 'Generate pictures' }}</button></footer>
    <p v-if="running" class="person-muted" role="status">This person’s generation is running. You can close the panel; accepted pictures are saved to this profile after price confirmation.</p>
  </section>
</template>

<style scoped>
.person-generator{width:min(720px,100%);max-height:calc(100dvh - 48px);overflow:auto;padding:30px;background:var(--workspace-surface);border:1px solid var(--workspace-border);border-radius:20px;color:var(--workspace-text);font-size:12px;box-shadow:0 24px 90px #0009}.person-generator header{display:flex;justify-content:space-between;align-items:start;gap:18px}.person-eyebrow{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--workspace-accent)}.person-generator h2{font-size:25px;font-weight:550;letter-spacing:-.7px;margin-top:7px}.person-icon{display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:8px;color:var(--workspace-muted)}.person-icon:hover{background:var(--workspace-surface-raised);color:var(--workspace-text)}.person-icon .iconify{width:16px;height:16px}.person-muted{color:var(--workspace-muted);line-height:1.8;margin:13px 0 22px}.person-label{display:block;font-size:11px;color:var(--workspace-muted);margin:0 0 9px}.person-input{width:100%;background:var(--workspace-bg);border:1px solid var(--workspace-border);border-radius:9px;padding:11px 12px;color:var(--workspace-text);font-size:12px;line-height:1.6}.person-input:focus{outline:2px solid var(--workspace-accent);outline-offset:2px}.person-model-row{display:grid;grid-template-columns:minmax(0,1fr) 90px;gap:20px;margin-top:24px}.person-model-select{display:flex;align-items:center;gap:7px;min-width:0}.person-model-select select{min-width:0}.person-heart{color:#e3a899}.person-identity{margin-top:23px}.person-identity legend{width:100%;display:flex;justify-content:space-between;margin-bottom:10px;color:var(--workspace-muted);font-size:11px}.person-identity>div{display:flex;gap:8px;overflow:auto;padding:2px}.person-reference{flex:none;position:relative;width:76px;height:92px;border:1px solid var(--workspace-border);border-radius:9px;overflow:hidden;background:var(--workspace-bg)}.person-reference.is-selected{border-color:var(--workspace-accent);outline:1px solid var(--workspace-accent)}.person-reference img{width:100%;height:100%;object-fit:contain}.person-reference>span{position:absolute;right:4px;bottom:4px;display:grid;place-items:center;background:var(--workspace-accent);color:#241c15;border-radius:50%;width:19px;height:19px}.person-reference .iconify{width:12px;height:12px}.person-reference:disabled{opacity:.45}.person-settings{margin-top:22px;border:1px solid var(--workspace-border);border-radius:10px}.person-settings summary{display:flex;justify-content:space-between;gap:8px;padding:14px;cursor:pointer;color:var(--workspace-muted);font-size:11px}.person-settings summary>span{font-size:10px}.person-settings small{margin-left:7px;color:var(--workspace-accent)}.person-settings>div{padding:5px 16px 18px}.person-error{font-size:11px;color:#e4a698;line-height:1.8;margin-top:15px}.person-error button{text-decoration:underline}.person-generator footer{display:flex;justify-content:space-between;align-items:center;gap:18px;border-top:1px solid var(--workspace-border);padding-top:23px;margin-top:25px}.person-generator footer strong{font-size:13px;font-weight:550}.person-generator footer span,.person-generator footer small{display:block;color:var(--workspace-muted);font-size:10px;margin-top:6px}.person-primary{display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap;padding:11px 15px;border-radius:9px;background:var(--workspace-accent);color:#231c16;font-size:12px;font-weight:550}.person-primary .iconify{width:14px;height:14px}.person-primary:disabled{opacity:.4;cursor:not-allowed}.person-spin{animation:person-spin 1s linear infinite}@keyframes person-spin{to{transform:rotate(360deg)}}@media(max-width:560px){.person-generator{padding:22px;max-height:calc(100dvh - 24px)}.person-generator h2{font-size:22px}.person-generator footer{align-items:stretch;flex-direction:column}.person-model-row{gap:10px;grid-template-columns:minmax(0,1fr) 68px}}
</style>
