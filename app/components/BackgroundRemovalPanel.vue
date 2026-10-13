<script setup lang="ts">
import type {BackgroundRemovalJob, BackgroundRemovalModel, CreateBackgroundRemoval} from '../../schemas/background-removal'
import {ImagePathSchema} from '../../schemas/image-generation'
import {BACKGROUND_REMOVAL_MODELS, getBackgroundRemovalModel} from '../../schemas/background-removal-models'
import {imageDownloadUrl, imagePreviewUrl} from '../utils/imageDelivery'
import {imageName} from '../utils/generationComposer'

const props = defineProps<{sourceUrls: string[]}>()
const emit = defineEmits<{close: []; completed: [job: BackgroundRemovalJob]; 'use-output': [url: string]}>()
const account = useAccount()
const requestFetch = useRequestFetch()
const initialAccount = {epoch: account.epoch.value, identity: account.identity.value}
const model = ref<BackgroundRemovalModel>('birefnet-lite')
const jobs = ref<BackgroundRemovalJob[]>([])
const submitting = ref(false)
const loading = ref(false)
const historyReady = ref(false)
const panelElement = ref<HTMLElement>()
const errorMessage = ref('')
const pollingPaused = ref(false)
const unavailable = ref(new Set<string>())
const sources = computed(() => initialAccount.epoch === account.epoch.value && initialAccount.identity === account.identity.value
  ? [...new Set(props.sourceUrls)].filter(url => ImagePathSchema.safeParse(url).success) : [])
const activeJobs = computed(() => jobs.value.filter(job => job.status === 'queued' || job.status === 'running'))
const waitingSources = computed(() => new Set(activeJobs.value.map(job => job.sourceUrl)))
const readySources = computed(() => sources.value.filter(url => !waitingSources.value.has(url)))
const canStart = computed(() => sources.value.length > 0 && sources.value.length <= 5 && readySources.value.length > 0 && historyReady.value && !submitting.value && !loading.value)
const modelName = (id: BackgroundRemovalModel) => getBackgroundRemovalModel(id).label
const statusName = (job: BackgroundRemovalJob) => job.status === 'succeeded' && job.outputExpired ? 'Image removed or expired'
  : ({queued: 'Queued', running: 'Removing background', succeeded: 'Ready', failed: 'Could not process', cancelled: 'Cancelled'})[job.status]
const output = (job: BackgroundRemovalJob) => job.status === 'succeeded' && !job.outputExpired && job.outputUrl && ImagePathSchema.safeParse(job.outputUrl).success ? job.outputUrl : null
const attemptKeys = new Map<string, string>()
const requests = new Set<AbortController>()
const completedIds = new Set<string>()
let mounted = false
let revision = 0
let pollAttempts = 0
let timer: ReturnType<typeof setTimeout> | undefined
let polling = false
let focusBeforeDialog: HTMLElement | null = null

function snapshot() { return {epoch: account.epoch.value, identity: account.identity.value, revision} }
function current(value: ReturnType<typeof snapshot>) { return value.epoch === account.epoch.value && value.identity === account.identity.value && value.revision === revision }
function safeMessage(error: unknown, fallback: string) {
  const status = (error as {statusCode?: number; status?: number; response?: {status?: number}})?.statusCode
    ?? (error as {status?: number})?.status ?? (error as {response?: {status?: number}})?.response?.status
  if (status === 429) return 'The processing queue is full. Wait for a current job to finish, then try again.'
  if (status === 403 || status === 404) return 'One of these images is no longer available to your account.'
  if (status === 503) return 'Background removal is temporarily unavailable. Please try again later.'
  return fallback
}
async function fetchRequest<T>(url: string, options: {method?: 'POST'; body?: CreateBackgroundRemoval; query?: Record<string, number>} = {}) {
  const controller = new AbortController()
  requests.add(controller)
  try { return await requestFetch<T>(url, {...options, signal: controller.signal, timeout: 20_000}) }
  finally { requests.delete(controller) }
}
function record(job: BackgroundRemovalJob, announce = true) {
  if (!sources.value.includes(job.sourceUrl)) return
  const index = jobs.value.findIndex(known => known.id === job.id)
  if (index === -1) jobs.value.unshift(job)
  else jobs.value[index] = job
  if (announce && output(job) && !completedIds.has(job.id)) { completedIds.add(job.id); emit('completed', job) }
}
function stopRequests() {
  revision += 1
  clearTimeout(timer); timer = undefined
  for (const request of requests) request.abort()
  requests.clear()
  polling = false
}
function schedulePoll() {
  if (!mounted || timer || polling || !activeJobs.value.length) return
  if (pollAttempts >= 90) { pollingPaused.value = true; return }
  timer = setTimeout(() => { timer = undefined; void pollJobs() }, activeJobs.value.some(job => job.status === 'running') ? 3000 : 5000)
}
async function pollJobs() {
  if (!mounted || polling || !activeJobs.value.length) return
  if (document.visibilityState === 'hidden') { schedulePoll(); return }
  const value = snapshot()
  polling = true
  pollAttempts += 1
  try {
    const result = await Promise.allSettled(activeJobs.value.slice(0, 5).map(job => fetchRequest<{job: BackgroundRemovalJob}>(`/api/background-removal/${job.id}`)))
    if (!current(value)) return
    for (const response of result) {
      if (response.status === 'fulfilled') record(response.value.job)
      else errorMessage.value = safeMessage(response.reason, 'Could not refresh processing progress. Your jobs remain saved; try checking again.')
    }
  } finally { if (current(value)) { polling = false; schedulePoll() } }
}
async function loadJobs() {
  const value = snapshot()
  loading.value = true
  try {
    const result = await fetchRequest<{jobs: BackgroundRemovalJob[]}>('/api/background-removal', {query: {limit: 50}})
    if (!current(value)) return
    for (const job of result.jobs) record(job, false)
    historyReady.value = true
    schedulePoll()
  } catch (error) { if (current(value)) errorMessage.value = safeMessage(error, 'Could not load recent processing jobs. Refresh progress before starting another job.') }
  finally { if (current(value)) loading.value = false }
}
async function start() {
  if (!canStart.value) return
  const value = snapshot()
  const selectedModel = model.value
  const pending = [...readySources.value]
  submitting.value = true; errorMessage.value = ''; pollingPaused.value = false; pollAttempts = 0
  try {
    for (const sourceUrl of pending) {
      if (!current(value)) return
      const key = `${selectedModel}:${sourceUrl}`
      let idempotencyKey = attemptKeys.get(key)
      if (!idempotencyKey) { idempotencyKey = crypto.randomUUID(); attemptKeys.set(key, idempotencyKey) }
      const result = await fetchRequest<{job: BackgroundRemovalJob}>('/api/background-removal', {method: 'POST', body: {sourceUrl, model: selectedModel, idempotencyKey}})
      if (!current(value)) return
      record(result.job)
      attemptKeys.delete(key)
    }
  } catch (error) { if (current(value)) errorMessage.value = safeMessage(error, 'Could not queue this image. Try again; accepted jobs will keep processing.') }
  finally { if (current(value)) { submitting.value = false; schedulePoll() } }
}
function resume() { pollAttempts = 0; pollingPaused.value = false; errorMessage.value = ''; if (activeJobs.value.length) void pollJobs(); else void loadJobs() }
function visibilityChanged() { if (document.visibilityState === 'visible' && !pollingPaused.value) schedulePoll() }
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close') }
  if (event.key === 'Tab') {
    const focusable = [...(panelElement.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]') ?? [])]
    const first = focusable[0]; const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
watch(account.epoch, () => { stopRequests(); jobs.value = []; attemptKeys.clear(); completedIds.clear(); unavailable.value = new Set(); errorMessage.value = ''; submitting.value = false; loading.value = false; historyReady.value = false }, {flush: 'sync'})
watch(() => props.sourceUrls, () => { stopRequests(); jobs.value = []; errorMessage.value = ''; loading.value = false; submitting.value = false; historyReady.value = false; pollAttempts = 0; pollingPaused.value = false; if (mounted) void loadJobs() }, {deep: true})
onMounted(() => { mounted = true; focusBeforeDialog = document.activeElement instanceof HTMLElement ? document.activeElement : null; panelElement.value?.querySelector<HTMLButtonElement>('button')?.focus(); void loadJobs(); document.addEventListener('visibilitychange', visibilityChanged); window.addEventListener('keydown', onKeydown, {capture: true}) })
onBeforeUnmount(() => { mounted = false; stopRequests(); document.removeEventListener('visibilitychange', visibilityChanged); window.removeEventListener('keydown', onKeydown, {capture: true}); if (focusBeforeDialog?.isConnected) focusBeforeDialog.focus() })
</script>

<template>
  <section ref="panelElement" class="cutout-panel" role="dialog" aria-modal="true" aria-labelledby="cutout-title">
    <header class="cutout-heading"><div><span class="cutout-eyebrow">A cleaner starting point</span><h2 id="cutout-title">Remove background</h2></div><button class="cutout-icon" type="button" aria-label="Close background removal" @click="emit('close')"><UIcon name="i-lucide-x" /></button></header>
    <p class="cutout-description">Create a transparent PNG. Your original stays in place; the cutout is saved to your own library.</p>
    <div class="cutout-sources"><img v-for="source in sources.slice(0, 5)" :key="source" :src="imagePreviewUrl(source, 160)" :alt="imageName(source)" loading="lazy" decoding="async"><span>{{ sources.length }} image{{ sources.length === 1 ? '' : 's' }}</span></div>
    <fieldset class="cutout-models"><legend>Background removal model</legend><label v-for="profile in BACKGROUND_REMOVAL_MODELS" :key="profile.id" class="cutout-model" :class="{'cutout-model--selected': model === profile.id}"><input v-model="model" type="radio" name="background-removal-model" :value="profile.id" :disabled="submitting"><span><strong>{{ profile.label }} <small v-if="profile.id === 'birefnet-lite'">Recommended</small></strong><span>{{ profile.description }}</span></span></label></fieldset>
    <div class="cutout-start"><div><strong>$0 provider charge</strong><small>Runs on this server · one image at a time</small></div><button class="cutout-button" type="button" :disabled="!canStart" @click="start"><UIcon :name="submitting ? 'i-lucide-loader-circle' : 'i-lucide-scissors'" :class="{'cutout-spin': submitting}" />{{ submitting ? 'Queueing…' : sources.length > 1 ? 'Remove backgrounds' : 'Remove background' }}</button></div>
    <p v-if="sources.length > 5" class="cutout-error" role="alert">Select up to 5 images for background removal at a time.</p><p v-else-if="!sources.length" class="cutout-error" role="alert">Choose an image from your library first.</p>
    <p v-if="errorMessage" class="cutout-error" role="alert">{{ errorMessage }} <button v-if="!historyReady" class="cutout-text-button" type="button" :disabled="loading" @click="resume">Retry loading jobs</button></p>
    <div v-if="loading" class="cutout-progress" role="status">Loading recent cutouts…</div>
    <section v-if="jobs.length" class="cutout-results" aria-label="Background removal jobs"><div class="cutout-results-heading"><h3>Recent cutouts</h3><button type="button" class="cutout-text-button" :disabled="loading || polling" @click="resume">Check progress</button></div><article v-for="job in jobs.slice(0, 20)" :key="job.id" class="cutout-result"><div v-if="output(job)" class="cutout-result-image"><img v-if="!unavailable.has(job.id)" :src="imagePreviewUrl(output(job)!, 480)" :alt="`Cutout of ${imageName(job.sourceUrl)}`" loading="lazy" decoding="async" @error="unavailable = new Set([...unavailable, job.id])"><span v-else>Preview unavailable</span></div><div class="cutout-result-details"><strong>{{ imageName(job.sourceUrl) }}</strong><small>{{ modelName(job.model) }} · $0 provider charge</small><span class="cutout-status" :class="{'cutout-status--ready': job.status === 'succeeded' && !job.outputExpired}" role="status"><UIcon v-if="job.status === 'running'" name="i-lucide-loader-circle" class="cutout-spin" />{{ statusName(job) }}</span><p v-if="job.status === 'failed'" class="cutout-job-error">{{ job.error?.message || 'This image could not be processed. Try again.' }}</p><div v-if="output(job)" class="cutout-result-actions"><a class="cutout-text-button" :href="imageDownloadUrl(output(job)!)" :download="imageName(output(job)!)"><UIcon name="i-lucide-download" />Download PNG</a><button type="button" class="cutout-text-button" @click="emit('use-output', output(job)!)">Use in editor<UIcon name="i-lucide-arrow-right" /></button></div></div></article></section>
    <p v-if="pollingPaused && activeJobs.length" class="cutout-description" role="status">Your jobs are still saved. Check progress to continue watching, or find completed cutouts in your library.</p><p class="cutout-footnote">You can close this panel while processing continues. Full BiRefNet can take several minutes on a CPU.</p>
  </section>
</template>

<style scoped>
.cutout-panel{width:min(620px,100%);max-height:calc(100dvh - 48px);overflow:auto;padding:28px;background:var(--workspace-surface);border:1px solid var(--workspace-border);border-radius:20px;color:var(--workspace-text);font-size:12px;box-shadow:0 20px 80px #0008}.cutout-heading{display:flex;align-items:start;justify-content:space-between;gap:16px}.cutout-eyebrow{display:block;color:var(--workspace-accent);text-transform:uppercase;letter-spacing:1.2px;font-size:9px;margin-bottom:8px}.cutout-heading h2{font-weight:550;font-size:24px;letter-spacing:-.6px}.cutout-icon{width:28px;height:28px;display:grid;place-items:center;color:var(--workspace-muted);border-radius:7px}.cutout-icon:hover{background:var(--workspace-surface-raised);color:var(--workspace-text)}.cutout-icon .iconify{width:16px;height:16px}.cutout-description,.cutout-footnote{color:var(--workspace-muted);line-height:1.8;margin:14px 0}.cutout-sources{display:flex;align-items:center;gap:7px;margin:20px 0}.cutout-sources img{width:44px;height:44px;object-fit:contain;background:var(--workspace-bg);border:1px solid var(--workspace-border);border-radius:8px}.cutout-sources>span{margin-left:6px;color:var(--workspace-muted);font-size:11px}.cutout-models{display:flex;flex-direction:column;gap:10px}.cutout-models legend{color:var(--workspace-muted);font-size:11px;margin-bottom:10px}.cutout-model{display:flex;align-items:center;gap:12px;cursor:pointer;border:1px solid var(--workspace-border);border-radius:12px;padding:15px;background:var(--workspace-bg)}.cutout-model--selected{border-color:#a07853;background:#3b3027}.cutout-model input{accent-color:var(--workspace-accent);width:15px;height:15px;flex-shrink:0}.cutout-model strong{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;font-weight:550}.cutout-model strong small{font-size:9px;padding:3px 6px;border-radius:999px;background:#51402f;color:#e9c099;font-weight:400}.cutout-model>span>span{display:block;margin-top:7px;color:var(--workspace-muted);font-size:11px;line-height:1.7}.cutout-start{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:22px}.cutout-start strong{font-size:12px;font-weight:550;color:#e9c099}.cutout-start small{display:block;font-size:10px;color:var(--workspace-muted);margin-top:6px}.cutout-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border-radius:8px;padding:11px 13px;background:var(--workspace-accent);color:#241c15;font-size:12px;font-weight:550;white-space:nowrap}.cutout-button:disabled{opacity:.45;cursor:not-allowed}.cutout-button .iconify,.cutout-status .iconify,.cutout-text-button .iconify{width:14px;height:14px;flex-shrink:0}.cutout-error{color:#f7c4ac;padding:12px;margin-top:18px;background:#48352b60;border:1px solid #795242;border-radius:9px;line-height:1.7}.cutout-progress{color:var(--workspace-muted);font-size:11px;margin-top:20px}.cutout-results{border-top:1px solid var(--workspace-border);margin-top:24px;padding-top:18px}.cutout-results-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.cutout-results-heading h3{font-size:12px;font-weight:550}.cutout-result{display:flex;gap:14px;padding:14px 0;border-top:1px solid var(--workspace-border)}.cutout-result-image{width:100px;height:100px;flex-shrink:0;border:1px solid var(--workspace-border);border-radius:9px;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);place-items:center;background-color:#27231d;background-image:linear-gradient(45deg,#ffffff08 25%,transparent 25%),linear-gradient(-45deg,#ffffff08 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ffffff08 75%),linear-gradient(-45deg,transparent 75%,#ffffff08 75%);background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0}.cutout-result-image img{width:100%;height:100%;min-width:0;min-height:0;object-fit:contain}.cutout-result-image>span{font-size:10px;text-align:center;color:var(--workspace-muted)}.cutout-result-details{min-width:0;flex:1}.cutout-result-details>strong{display:block;font-size:11px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cutout-result-details>small{display:block;color:var(--workspace-muted);font-size:10px;margin-top:6px}.cutout-status{display:flex;align-items:center;gap:5px;margin-top:10px;color:#d5b998;font-size:10px}.cutout-status--ready{color:#b8ca9b}.cutout-job-error{font-size:10px;color:#f7c4ac;line-height:1.7;margin-top:8px}.cutout-result-actions{display:flex;align-items:center;flex-wrap:wrap;gap:14px;margin-top:14px}.cutout-text-button{display:inline-flex;align-items:center;gap:5px;color:var(--workspace-accent);font-size:10px}.cutout-text-button:disabled{opacity:.45;cursor:not-allowed}.cutout-footnote{font-size:10px;margin:20px 0 0}.cutout-spin{animation:cutout-spin 1s linear infinite}button:not(:disabled),a{cursor:pointer}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--workspace-accent);outline-offset:3px}@keyframes cutout-spin{to{transform:rotate(360deg)}}@media(max-width:600px){.cutout-panel{padding:22px;max-height:calc(100dvh - 24px)}.cutout-start{align-items:start;flex-direction:column}.cutout-button{width:100%}.cutout-result-image{width:80px;height:80px}.cutout-result-actions{gap:10px}}@media(prefers-reduced-motion:reduce){.cutout-spin{animation:none}}
</style>
