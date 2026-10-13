<script setup lang="ts">
import {imageDownloadUrl, imagePreviewUrl, type ImagePreviewSize} from '../utils/imageDelivery'
import type { Component } from 'vue'
import type { SelectableFile } from '../../schemas/main.dto'
import { buildComposerRequest, composerSources, imageName, type GenerationComposerMode, type PendingGeneration } from '../utils/generationComposer'
import { isNewImageModel, orderImageModels } from '../../schemas/image-model-discovery'
import { useImageModelFavourites } from '../composables/useImageModelFavourites'
import { watchImageModelSelection } from '../utils/watchImageModelSelection'
import {hasConfirmedGenerationPrice} from '~~/schemas/generation-billing'
import {formatBalanceUsd, formatUsd, generationPriceLabel, type GenerationPrice} from '../utils/generationPrice'
import {parseUsdUnits} from '~~/schemas/account-billing'
import {
  IMAGE_MODEL_PROFILES,
  generationOutputCount,
  ImagePathSchema,
  SUPPORTED_IMAGE_MODEL_IDS,
  createDefaultSettings,
  type ImageModelProfile,
  type ImageModelId,
} from '~~/schemas/image-generation'
import Gemini31FlashImageSettings from './generation-settings/Gemini31FlashImageSettings.vue'
import Gemini3ProImageSettings from './generation-settings/Gemini3ProImageSettings.vue'
import Gemini31FlashLiteImageSettings from './generation-settings/Gemini31FlashLiteImageSettings.vue'
import Gemini25FlashImageSettings from './generation-settings/Gemini25FlashImageSettings.vue'
import OpenAiGptImage2Settings from './generation-settings/OpenAiGptImage2Settings.vue'
import OpenAiGptImage25Settings from './generation-settings/OpenAiGptImage25Settings.vue'
import OpenAiGptImageLegacySettings from './generation-settings/OpenAiGptImageLegacySettings.vue'
import CatalogImageSettings from './generation-settings/CatalogImageSettings.vue'

const props = withDefaults(defineProps<{ mode?: GenerationComposerMode }>(), { mode: 'batch' })
const data = useDataStore()
const account = useAccount()
const accountBalance = useAccountBalance()
function accountSnapshot() { return {epoch: account.epoch.value, identity: account.identity.value} }
function isCurrentAccount(snapshot: ReturnType<typeof accountSnapshot>) {
  return snapshot.epoch === account.epoch.value && snapshot.identity === account.identity.value
}
const sourceImages = computed(() => composerSources(props.mode, data.editSource, data.inputImages))
const isEdit = computed(() => props.mode === 'edit')
const hasSources = computed(() => sourceImages.value.length > 0)
const { favouriteModelIds, favouriteSet, persistent: favouritesPersistent, ready: favouritesReady, toggleFavourite } = useImageModelFavourites()
const selectedIsFavourite = computed(() => favouriteSet.value.has(data.selectedModel))
const prompt = toRef(data, 'composerPrompt')
const errorMsg = ref<string | null>(null)
const keepSubmitInputs = ref(true)

// Fetch all image-capable models from the gateway (across providers).
type ModelPricing = {
  input: string
  output: string
  cachedInputTokens?: string
  cacheCreationInputTokens?: string
} | null

type PricingComponent = {
  kind: 'token' | 'fixed-image' | 'megapixel' | 'unknown'
  label: string
  amountUsd?: number
  unit?: 'token' | 'image' | 'megapixel'
  source: 'gateway-config' | 'vercel-catalog' | 'inferred'
  note?: string
}

type PricingDetails = {
  method: 'token' | 'fixed-image' | 'megapixel' | 'mixed' | 'unknown'
  summary: string
  components: PricingComponent[]
  estimateNote: string
}

type ModelCapabilities = {
  referenceInputScope: 'images-only'
  output: Array<'image' | 'text'>
  input: Array<'text' | 'image' | 'multiple-images'>
  operations: Array<'text-to-image' | 'image-edit' | 'image-to-image' | 'multi-reference'>
  warnings: string[]
}

type ImageModelInfo = {
  id: string
  name: string
  description?: string
  provider: string
  modelType: 'language' | 'image'
  pricing?: ModelPricing
  pricingDetails?: PricingDetails
  capabilities?: ModelCapabilities
  profile: ImageModelProfile
  available: boolean
  catalogStatus: 'available' | 'unavailable' | 'unknown'
  availabilityNote?: string
}

type AiGatewayLog = {
  id: number
  systemPromptId?: number | null
  status: string
  model: string
  prompt: string
  inputImages?: string[] | null
  modelImages?: string[] | null
  outputImage?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  priceUsd?: string | null
  priceSource?: string | null
  gatewayGenerationId?: string | null
  requestJson?: unknown
  responseJson?: unknown
  error?: string | null
  durationMs?: number | null
  createdAt: string
}

const modelsFetch = useFetch<{ ok: boolean; items: ImageModelInfo[] }>('/api/image-models', {
  key: 'image-models',
  default: () => ({ ok: true, items: [] })
})

function fmtPerMillion(perTokenUsd?: string) {
  if (!perTokenUsd) return null
  const v = Number(perTokenUsd) * 1_000_000
  if (!isFinite(v) || v <= 0) return null
  return v < 1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`
}

type ModelOption = { label: string; value: ImageModelId; icon: string; disabled: boolean; isNew: boolean; isFavourite: boolean }
const modelOptions = computed<ModelOption[]>(() => orderImageModels(SUPPORTED_IMAGE_MODEL_IDS, favouriteModelIds.value).map((id) => {
  const item = modelsFetch.data.value?.items.find(model => model.id === id)
  const profile = item?.profile ?? IMAGE_MODEL_PROFILES[id]
  const usable = !!item && item.catalogStatus !== 'unavailable'
  const statusLabel = item?.catalogStatus === 'unknown'
      ? ' — unverified'
      : usable
          ? ''
          : ' — unavailable'
  return {
    label: `${profile.shortName}${profile.lifecycle === 'recommended' ? ' (Recommended)' : ''}${statusLabel}`,
    value: id,
    icon: profile.provider === 'openai' ? 'i-lucide-image' : 'i-lucide-sparkles',
    disabled: !usable,
    isNew: isNewImageModel(id),
    isFavourite: favouriteSet.value.has(id),
  }
}))

const selectedModelInfo = computed<ImageModelInfo | undefined>(() => {
  const items = modelsFetch.data.value?.items || []
  return items.find(m => m.id === data.selectedModel)
})
const selectedProfile = computed(() => selectedModelInfo.value?.profile ?? IMAGE_MODEL_PROFILES[data.selectedModel])
// A catalog outage is not proof that the exact, curated model is unavailable.
// Keep generation usable while showing that live availability is unverified.
const selectedModelAvailable = computed(() => !!selectedModelInfo.value
    && selectedModelInfo.value.catalogStatus !== 'unavailable')
const selectedModelValue = computed<ImageModelId | undefined>({
  get: () => data.selectedModel,
  set: (value) => {
    if (value && SUPPORTED_IMAGE_MODEL_IDS.includes(value)) {
      data.selectedModel = value
    }
  }
})

const settingsComponents: Record<ImageModelProfile['settingsComponent'], Component> = {
  Gemini31FlashImageSettings,
  Gemini3ProImageSettings,
  Gemini31FlashLiteImageSettings,
  Gemini25FlashImageSettings,
  OpenAiGptImage2Settings,
  OpenAiGptImage25Settings,
  OpenAiGptImageLegacySettings,
  CatalogImageSettings,
}
const selectedSettingsComponent = computed(() => settingsComponents[selectedProfile.value.settingsComponent])
const settingsPanelRevision = ref(0)
const settingsResetMessage = ref('')

function resetModelSettings() {
  data.generationSettings = createDefaultSettings(data.selectedModel)
  // Recreate the controls as well as their values, including after a render error.
  settingsPanelRevision.value += 1
  settingsResetMessage.value = `${selectedProfile.value.shortName} settings restored to defaults.`
}

watch(() => [data.selectedModel, data.generationSettings], () => {
  settingsResetMessage.value = ''
}, {deep: true, flush: 'sync'})

watchImageModelSelection(data)

const selectedPricingText = computed(() => {
  const details = selectedModelInfo.value?.pricingDetails
  if (details?.summary) return details.summary
  const p = selectedModelInfo.value?.pricing
  if (!p) return null
  const inp = fmtPerMillion(p.input)
  const out = fmtPerMillion(p.output)
  const cached = fmtPerMillion(p.cachedInputTokens)
  const parts: string[] = []
  if (inp) parts.push(`${inp} input`)
  if (out) parts.push(`${out} output`)
  if (cached) parts.push(`${cached} cached input`)
  if (!parts.length) return null
  return `${parts.join(' - ')} per 1M tokens`
})

const selectedPricingMethod = computed(() => selectedModelInfo.value?.pricingDetails?.method || 'unknown')
const selectedPricingComponents = computed(() => selectedModelInfo.value?.pricingDetails?.components || [])
const selectedCapabilities = computed(() => selectedModelInfo.value?.capabilities)
const selectedWarnings = computed(() => Array.from(new Set([
  ...selectedProfile.value.warnings,
  ...(selectedCapabilities.value?.warnings || []),
])))
const selectedCapabilityPills = computed(() => {
  const caps = selectedCapabilities.value
  if (!caps) return []
  return [
    ...caps.operations.map(v => v.replaceAll('-', ' ')),
    ...caps.input.filter(v => v !== 'text').map(v => v.replaceAll('-', ' ') + ' input'),
    ...caps.output.filter(v => v !== 'image').map(v => v + ' output')
  ]
})
const outputsPerJob = computed(() => generationOutputCount(data.generationSettings))
const estimatedOutputCount = computed(() => sourceImages.value.length * outputsPerJob.value)
const selectedCostEstimate = computed(() => {
  const components = selectedPricingComponents.value
  const fixed = components.find(c => c.kind === 'fixed-image' && c.amountUsd != null)
  if (fixed?.amountUsd != null) {
    const total = fixed.amountUsd * estimatedOutputCount.value
    return `Estimate: $${total.toFixed(total < 0.01 ? 4 : 2)} for ${estimatedOutputCount.value} image${estimatedOutputCount.value > 1 ? 's' : ''}`
  }
  const mp = components.find(c => c.kind === 'megapixel')
  if (mp) return `Estimate needs final dimensions (${mp.label})`
  const token = components.find(c => c.kind === 'token')
  if (token) return 'Estimate needs final token usage; exact Gateway cost is stored after generation when available.'
  return 'Exact cost will be queried from the Gateway generation record after generation when available.'
})
const inputCapabilityWarning = computed(() => {
  const hasImageInputs = sourceImages.value.length > 0 || data.models.length > 0
  const caps = selectedCapabilities.value
  if (!hasImageInputs || !caps) return ''
  return caps.input.includes('image')
      ? ''
      : 'Selected images may be rejected because this model is text-to-image only.'
})

const referenceCount = computed(() => (sourceImages.value.length > 0 ? 1 : 0) + data.models.length)
const referenceOverflow = computed(() => Math.max(0, referenceCount.value - selectedProfile.value.maxReferenceImages))
const missingRequiredMask = computed(() => selectedProfile.value.requiresMask && !data.maskImage)
const luminanceMask = computed(() => selectedProfile.value.maskMode === 'luminance')
const maskWithoutReference = computed(() => !!data.maskImage && referenceCount.value === 0)
const maskFileNotPng = computed(() => !!data.maskImage && !/\.png(?:$|[?#])/i.test(data.maskImage))
const maskSources = computed(() => sourceImages.value.length > 0
    ? sourceImages.value
    : data.models.slice(0, 1))
const maskSourceNotPng = computed(() => !luminanceMask.value && !!data.maskImage
    && maskSources.value.some(source => !/\.png(?:$|[?#])/i.test(source)))
const referenceSummary = computed(() => {
  const inputPart = sourceImages.value.length > 0 ? '1 per input job' : 'no per-job input'
  return `${referenceCount.value}/${selectedProfile.value.maxReferenceImages} references per generation (${inputPart} + ${data.models.length} shared)`
})

const pastPrompts = useFetch('/api/systemprompts', {
  deep: true, query: { take: 20 }, key: computed(() => `systemPrompts:${account.identity.value}:${account.epoch.value}`),
})
const gatewayLogs = useFetch<{ ok: boolean; items: AiGatewayLog[] }>('/api/ai-gateway-logs?limit=25', {
  key: computed(() => `aiGatewayLogs:${account.identity.value}:${account.epoch.value}`),
  immediate: false,
  default: () => ({ ok: true, items: [] })
})

const debugLogsOpen = ref(false)
const expandedLogIds = ref<Set<number>>(new Set())
const gatewayLogItems = computed(() => gatewayLogs.data.value?.items || [])
const gatewayLogsPending = computed(() => gatewayLogs.status.value === 'pending')
const pendingGenerations = toRef(data, 'pendingGenerations')
const pendingTick = ref(Date.now())
let pendingTimerId: ReturnType<typeof setInterval> | null = null

const activeGenerationCount = computed(() => pendingGenerations.value.filter((job) => job.status === 'pending').length)
const failedGenerationCount = computed(() => pendingGenerations.value.filter((job) => job.status === 'failed').length)

watch(debugLogsOpen, async (open) => {
  if (open && !gatewayLogItems.value.length) {
    await gatewayLogs.refresh()
  }
})

watch(activeGenerationCount, (count) => {
  if (count > 0 && !pendingTimerId) {
    pendingTimerId = setInterval(() => {
      pendingTick.value = Date.now()
    }, 1000)
  }
  if (count === 0 && pendingTimerId) {
    clearInterval(pendingTimerId)
    pendingTimerId = null
  }
}, { immediate: true })

function formatLogTime(value?: string) {
  return value ? new Date(value).toLocaleString() : ''
}

function formatLogPrice(value?: string | null, source?: string | null) {
  const amount = formatUsd(value)
  if (!amount) return source === 'unknown' ? 'Unknown' : ''
  return source ? `${amount} (${source})` : amount
}

function formatLogImages(items?: string[] | null) {
  const count = Array.isArray(items) ? items.length : 0
  return `${count} image${count === 1 ? '' : 's'}`
}

function formatJson(value: unknown) {
  if (value == null || value === '') return ''
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return JSON.stringify(parsed, null, 2)
  } catch {
    return String(value)
  }
}

function toggleDebugLogs() {
  debugLogsOpen.value = !debugLogsOpen.value
}

function toggleLogDetails(id: number) {
  const next = new Set(expandedLogIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedLogIds.value = next
}

function isLogExpanded(id: number) {
  return expandedLogIds.value.has(id)
}

function clearModels() { data.models.splice(0) }
function clearInputImages() {
  if (isEdit.value) data.editSource = null
  else data.inputImages.splice(0)
}
function clearMaskImage() { data.maskImage = null }

const uploadInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const dragging = ref(false)
const pickerOpen = ref(false)
const pickerKind = ref<'source' | 'references' | 'mask'>('source')
const pickerSelection = ref<string[]>([])
type GenerationResult = GenerationPrice & {id?: number; outputImage?: string | null; outputImageDeletedAt?: string | null; errors?: string | null; status?: string | null}
const previewResult = ref<GenerationResult | null>(null)
const previewOutput = computed(() => previewResult.value && hasConfirmedGenerationPrice(previewResult.value)
  && !previewResult.value.outputImageDeletedAt ? previewResult.value.outputImage || null : null)
const previewPrice = computed(() => previewResult.value ? generationPriceLabel(previewResult.value) : '')
const sourceUnavailable = ref(false)
const previewImage = computed(() => previewOutput.value || data.editSource)
const zoom = ref(1)
const imageDimensions = ref('')
const additionalHistory = ref<NonNullable<typeof pastPrompts.data.value>['items']>([])
const displayedHistory = computed(() => [...(pastPrompts.data.value?.items || []), ...additionalHistory.value])
const confirmedHistory = computed(() => displayedHistory.value.filter(hasConfirmedGenerationPrice))
watch(() => pastPrompts.data.value, () => { additionalHistory.value = [] })
const recentImages = computed(() => displayedHistory.value
  .filter(item => !!item.outputImage && !item.outputImageDeletedAt && hasConfirmedGenerationPrice(item))
  .slice(0, 12))
watch(displayedHistory, rows => {
  if (!previewResult.value?.id) return
  const updated = rows.find(row => row.id === previewResult.value?.id)
  if (updated) previewResult.value = updated
})
const historyOpen = ref(false)
const loadingHistory = ref(false)
const showMoreHistory = computed(() => displayedHistory.value.length < (pastPrompts.data.value?.count || 0))
let billingPollTimer: ReturnType<typeof setTimeout> | undefined
let billingPollRunning = false
let billingPollAttempts = 0
let billingPollingMounted = false
const awaitingPrices = computed(() => displayedHistory.value.some(row => row.status === 'succeeded' && !row.outputImageDeletedAt && !hasConfirmedGenerationPrice(row)))
function scheduleBillingPoll() {
  if (!billingPollingMounted || billingPollTimer || billingPollRunning || !awaitingPrices.value || billingPollAttempts >= 30) return
  const snapshot = accountSnapshot()
  billingPollTimer = setTimeout(async () => {
    billingPollTimer = undefined
    if (!isCurrentAccount(snapshot) || !billingPollingMounted) return
    if (document.visibilityState !== 'visible') { scheduleBillingPoll(); return }
    billingPollRunning = true
    billingPollAttempts += 1
    try { await pastPrompts.refresh() }
    catch { /* Leave unconfirmed results hidden and retry automatically. */ }
    finally { billingPollRunning = false; if (isCurrentAccount(snapshot)) scheduleBillingPoll() }
  }, 10_000)
}
watch(awaitingPrices, awaiting => { scheduleBillingPoll(); if (!awaiting) void accountBalance.refresh() })
onMounted(() => { billingPollingMounted = true; scheduleBillingPoll() })

watch(account.epoch, () => {
  errorMsg.value = null
  additionalHistory.value = []
  expandedLogIds.value = new Set()
  debugLogsOpen.value = false
  historyOpen.value = false
  loadingHistory.value = false
  uploading.value = false
  dragging.value = false
  pickerOpen.value = false
  pickerSelection.value = []
  previewResult.value = null
  billingPollAttempts = 0
  if (billingPollTimer) clearTimeout(billingPollTimer)
  billingPollTimer = undefined
}, {flush: 'sync'})

watch(() => data.editSource, () => {
  previewResult.value = null
  zoom.value = 1
  imageDimensions.value = ''
  sourceUnavailable.value = false
})

const route = useRoute()
watch(() => route.query.source, (source) => {
  if (!isEdit.value || typeof source !== 'string') return
  const parsed = ImagePathSchema.safeParse(source)
  if (parsed.success) data.editSource = parsed.data
  else errorMsg.value = 'This image link is invalid. Choose an image from Assets.'
}, { immediate: true })

function chooseSource(source: string) {
  if (isEdit.value) data.editSource = source
  else if (!data.inputImages.includes(source)) {
    if (data.inputImages.length >= 20) { errorMsg.value = 'A batch supports at most 20 input images.'; return }
    data.inputImages.push(source)
  }
  errorMsg.value = null
}

function removeSource(source: string) {
  if (isEdit.value) data.editSource = null
  else data.inputImages = data.inputImages.filter(image => image !== source)
}

function openPicker(kind: 'source' | 'references' | 'mask') {
  pickerKind.value = kind
  pickerSelection.value = kind === 'source' ? [...sourceImages.value]
    : kind === 'references' ? [...data.models] : (data.maskImage ? [data.maskImage] : [])
  pickerOpen.value = true
}

function confirmPicker(files: SelectableFile[]) {
  const urls = files.map(file => file.url)
  if (pickerKind.value === 'source') {
    if (isEdit.value) data.editSource = urls[0] || null
    else if (urls.length <= 20) data.inputImages = urls
    else { errorMsg.value = 'A batch supports at most 20 input images.'; return }
  } else if (pickerKind.value === 'references') {
    data.models = urls
  } else data.maskImage = urls[0] || null
  pickerOpen.value = false
}

function sourceUrl(source: string, size: ImagePreviewSize = 160) { return imagePreviewUrl(source, size) }

async function uploadFiles(files: File[]) {
  if (!files.length || uploading.value) return
  if (isEdit.value && files.length !== 1) {
    errorMsg.value = 'Choose one image for Edit. Use Same-origin batch for multiple images.'
    return
  }
  if (files.length + (isEdit.value ? 0 : data.inputImages.length) > 20) {
    errorMsg.value = 'A batch supports at most 20 input images.'
    return
  }
  if (files.some(file => file.size > 25 * 1024 * 1024) || files.reduce((bytes, file) => bytes + file.size, 0) > 100 * 1024 * 1024) {
    errorMsg.value = 'Images must be under 25 MB each and uploads under 100 MB in total.'
    return
  }
  uploading.value = true
  errorMsg.value = null
  const snapshot = accountSnapshot()
  const form = new FormData()
  files.forEach(file => form.append('files', file))
  form.append('path', '/')
  try {
    const result = await $fetch<{ savedFiles: Array<{url: string}>; failed: Array<{ filename: string; reason: string }> }>('/api/upload', { method: 'POST', body: form })
    if (!isCurrentAccount(snapshot)) return
    for (const file of result.savedFiles) chooseSource(ImagePathSchema.parse(file.url))
    if (result.failed.length) errorMsg.value = result.failed.map(file => `${file.filename}: ${file.reason}`).join(' ')
    await refreshNuxtData('asset-files')
  } catch (error: any) {
    if (isCurrentAccount(snapshot)) errorMsg.value = error?.data?.statusMessage || error?.statusMessage || 'Could not upload the images. Please try again.'
  } finally {
    if (isCurrentAccount(snapshot)) {
      uploading.value = false
      if (uploadInput.value) uploadInput.value.value = ''
    }
  }
}

function onUploadChange(event: Event) {
  const target = event.target as HTMLInputElement
  void uploadFiles(Array.from(target.files || []))
}
function onDrop(event: DragEvent) {
  dragging.value = false
  void uploadFiles(Array.from(event.dataTransfer?.files || []))
}
function onPreviewLoad(event: Event) {
  const image = event.target as HTMLImageElement
  imageDimensions.value = `${image.naturalWidth} × ${image.naturalHeight}`
  if (!previewOutput.value) sourceUnavailable.value = false
}
function onPreviewError() {
  if (!previewOutput.value) sourceUnavailable.value = true
  errorMsg.value = 'This image is unavailable or has expired. Choose another image from Assets.'
}
function adjustZoom(amount: number) { zoom.value = Math.max(0.25, Math.min(2, Math.round((zoom.value + amount) * 100) / 100)) }

async function loadMoreHistory() {
  if (loadingHistory.value || !showMoreHistory.value) return
  loadingHistory.value = true
  const snapshot = accountSnapshot()
  const skip = displayedHistory.value.length
  try {
    const page = await $fetch<NonNullable<typeof pastPrompts.data.value>>('/api/systemprompts', { query: { take: 20, skip } })
    if (!isCurrentAccount(snapshot) || displayedHistory.value.length !== skip) return
    const known = new Set(displayedHistory.value.map(item => item.id))
    additionalHistory.value.push(...page.items.filter(item => !known.has(item.id)))
  } catch { if (isCurrentAccount(snapshot)) errorMsg.value = 'Could not load more generation history.' }
  finally { if (isCurrentAccount(snapshot)) loadingHistory.value = false }
}

const creditBlockReason = computed(() => {
  const balance = accountBalance.balance.value
  if (!balance || balance.unlimited) return ''
  if (!balance.actualBalanceUsd || balance.actualBalanceUsd.startsWith('-') || parseUsdUnits(balance.actualBalanceUsd) === 0n) return 'Your credit is used up. Ask an organization owner to add credit before generating another image.'
  if (balance.generationBlockedByOutstanding ?? (balance.outstandingCount > 0)) return 'Your previous generation prices are still being confirmed. They must settle before another generation can use your credit.'
  return ''
})
const canSubmit = computed(() => hasSources.value && !!prompt.value.trim()
  && !referenceOverflow.value && !missingRequiredMask.value && !maskWithoutReference.value
  && !maskFileNotPng.value && !maskSourceNotPng.value && selectedModelAvailable.value
  && estimatedOutputCount.value <= 50 && !sourceUnavailable.value
  && !activeGenerationCount.value && !uploading.value && !creditBlockReason.value)

function elapsedLabel(startedAt: number) {
  const totalSeconds = Math.max(0, Math.floor((pendingTick.value - startedAt) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function removePendingJob(id: string) {
  pendingGenerations.value = pendingGenerations.value.filter((job) => job.id !== id)
}

function clearFailedJobs() {
  pendingGenerations.value = pendingGenerations.value.filter((job) => job.status !== 'failed')
}

onBeforeUnmount(() => {
  if (pendingTimerId) clearInterval(pendingTimerId)
  billingPollingMounted = false
  if (billingPollTimer) clearTimeout(billingPollTimer)
})

async function submit() {
  if (activeGenerationCount.value) return
  if (creditBlockReason.value) { errorMsg.value = creditBlockReason.value; return }
  if (!selectedModelAvailable.value) {
    errorMsg.value = selectedModelInfo.value?.availabilityNote || 'This model is not currently available through AI Gateway.'
    return
  }
  let requestBody: ReturnType<typeof buildComposerRequest>
  try {
    requestBody = buildComposerRequest({
      mode: props.mode,
      editSource: data.editSource,
      batchInputs: data.inputImages,
      prompt: prompt.value,
      model: data.selectedModel,
      settings: structuredClone(toRaw(data.generationSettings)),
      sharedReferences: data.models,
      maskImage: data.maskImage,
    })
  } catch (error: any) {
    errorMsg.value = error?.issues?.map((issue: { message: string }) => issue.message).join(' ') || error?.message || 'Check your generation settings.'
    return
  }

  errorMsg.value = null
  billingPollAttempts = 0
  const snapshot = accountSnapshot()
  const jobs = requestBody.inputImages.map((source, index): PendingGeneration => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${index}`,
    prompt: requestBody.prompt,
    model: requestBody.model,
    inputImages: [source],
    modelImages: [...requestBody.modelImages],
    startedAt: Date.now(),
    status: 'pending',
  }))
  pendingGenerations.value.unshift(...jobs)
  if (!keepSubmitInputs.value) {
    prompt.value = ''
    clearInputImages()
    clearModels()
    clearMaskImage()
  }
  let serverCreatedRows = false
  try {
    const response = await $fetch<{ ok: boolean; obj?: GenerationResult[] }>('/api/image-generate', {
      method: 'POST', body: requestBody,
    })
    if (!isCurrentAccount(snapshot)) return
    serverCreatedRows = true
    const failures = response.obj?.filter(row => !!row.errors) || []
    if (failures.length) errorMsg.value = `${failures.length} output${failures.length === 1 ? '' : 's'} failed. ${failures[0]?.errors || ''}`
    const firstResult = response.obj?.find(row => !row.errors && (row.status === 'succeeded' || !!row.outputImage))
    // A changed source must not be replaced by an older in-flight request.
    if (isEdit.value && firstResult && data.editSource === requestBody.inputImages[0]) {
      previewResult.value = firstResult
      zoom.value = 1
    }
    historyOpen.value = true
  } catch (error: any) {
    if (!isCurrentAccount(snapshot)) return
    const message = error?.data?.statusMessage || error?.statusMessage || 'Generation failed. Please try again.'
    for (const job of jobs) {
      const retainedJob = pendingGenerations.value.find(item => item.id === job.id)
      if (retainedJob) { retainedJob.status = 'failed'; retainedJob.error = message }
    }
    errorMsg.value = message
  } finally {
    if (isCurrentAccount(snapshot)) {
      if (serverCreatedRows) for (const job of jobs) removePendingJob(job.id)
      await pastPrompts.refresh()
      if (isCurrentAccount(snapshot)) scheduleBillingPoll()
      if (isCurrentAccount(snapshot)) await accountBalance.refresh()
      if (isCurrentAccount(snapshot) && debugLogsOpen.value) await gatewayLogs.refresh()
    }
  }
}

</script>

<template>
  <div class="generation-studio" :class="{ 'generation-studio--empty': !hasSources }">
    <header class="studio-route-header"><h1><UIcon :name="isEdit ? 'i-lucide-sliders-horizontal' : 'i-lucide-layers'" class="size-4" />{{ isEdit ? 'Edit' : 'Same-origin batch' }}</h1><span v-if="hasSources">{{ isEdit ? 'Single image editor' : `${sourceImages.length} input images` }}</span></header>
    <input ref="uploadInput" class="sr-only" type="file" :multiple="!isEdit"
           accept="image/jpeg,image/png,image/webp,image/gif,image/bmp,image/tiff,image/heic,.heic"
           aria-label="Upload source images" @change="onUploadChange">
    <UModal v-model:open="pickerOpen" :title="pickerKind === 'source' ? (isEdit ? 'Choose an image to edit' : 'Choose batch input images') : pickerKind === 'mask' ? 'Choose a PNG mask' : 'Choose shared reference images'"
            :ui="{ content: 'max-w-6xl max-h-[90vh]' }">
      <template #body>
        <AssetBrowser v-model:selected-urls="pickerSelection"
                      :selection-mode="pickerKind === 'references' || (pickerKind === 'source' && !isEdit) ? 'multiple' : 'single'"
                      :max-selection="pickerKind === 'references' ? Math.max(0, selectedProfile.maxReferenceImages - 1) : pickerKind === 'source' && !isEdit ? 20 : 1"
                      :accepted-extensions="pickerKind === 'mask' ? ['png'] : undefined"
                      @confirm="confirmPicker" />
      </template>
    </UModal>
    <div class="studio-workspace" :class="{ 'studio-workspace--editing': hasSources }">
      <section class="studio-canvas-area" aria-label="Image canvas" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="onDrop">
        <div v-if="!hasSources" class="studio-start">
          <div class="studio-start-story"><span class="workspace-eyebrow">{{ isEdit ? 'The editing room' : 'A collection, one direction' }}</span><h2>{{ isEdit ? 'Make room for a new perspective.' : 'Give every image the same creative direction.' }}</h2><p>{{ isEdit ? 'Bring a product photo into the studio. Shape the scene with a prompt and reference images, then explore the result.' : 'Each selected image gets its own generation, with one shared prompt and the same references.' }}</p><span class="studio-start-line" /></div>
          <div class="studio-drop-zone" :class="{ 'studio-drop-zone--dragging': dragging }">
            <span class="studio-upload-symbol"><UIcon :name="isEdit ? 'i-lucide-layers' : 'i-lucide-images'" class="size-10" /></span>
            <h2>{{ isEdit ? 'Start with a product photo' : 'One prompt. Every product image.' }}</h2>
            <p>{{ isEdit ? 'Upload an image or choose one from your assets to get started.' : 'Upload multiple images. Run the same prompt once for each input, with shared references.' }}</p>
            <div class="studio-upload-actions">
              <UButton icon="i-lucide-upload" :loading="uploading" :disabled="uploading" @click="uploadInput?.click()">Upload {{ isEdit ? 'image' : 'images' }}</UButton>
              <UButton color="neutral" variant="soft" icon="i-lucide-folder" @click="openPicker('source')">Assets</UButton>
            </div>
            <div class="studio-file-types"><span>JPG</span><span>PNG</span><span>WebP</span><span>HEIC</span></div>
            <p class="studio-upload-limits">Images only · up to 25 MB per image{{ isEdit ? '' : ' · up to 20 inputs' }}</p>
          </div>
          <div v-if="recentImages.length" class="studio-recent">
            <span>Continue editing</span>
            <div class="studio-recent-grid">
              <button v-for="item in recentImages" :key="item.id" type="button" :aria-label="`Edit result: ${item.TextPrompt}`" :title="item.TextPrompt" @click="chooseSource(item.outputImage!)">
                <img :src="sourceUrl(item.outputImage!)" alt="Recent generated image" loading="lazy" decoding="async">
                <span class="studio-recent-price">{{ generationPriceLabel(item) }}</span>
              </button>
            </div>
          </div>
        </div>
        <template v-else-if="isEdit">
          <div class="studio-canvas-toolbar">
            <div class="studio-source-title"><UIcon name="i-lucide-image" class="size-4" /><span>{{ imageName(data.editSource!) }}</span><span v-if="previewOutput" class="studio-result-label">Result · {{ previewPrice }}</span></div>
            <div class="studio-toolbar-actions">
              <UButton v-if="previewOutput" color="neutral" variant="ghost" size="sm" @click="data.editSource = previewOutput">Use as input</UButton>
              <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-folder" @click="openPicker('source')">Replace</UButton>
              <UButton v-if="previewImage" :href="imageDownloadUrl(previewImage)" :download="imageName(previewImage)" external color="neutral" variant="soft" size="sm" icon="i-lucide-download">Download</UButton>
            </div>
          </div>
          <div class="studio-image-stage" :class="{ 'studio-image-stage--dragging': dragging }">
            <div class="studio-image-sheet" :style="{ transform: `scale(${zoom})` }">
              <img v-if="previewImage" :key="previewImage" :src="sourceUrl(previewImage, 1600)" decoding="async" :alt="previewOutput ? 'Generated result' : 'Image being edited'" @load="onPreviewLoad" @error="onPreviewError">
            </div>
            <div v-if="activeGenerationCount" class="studio-generating-overlay" role="status"><UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" /><span>Creating your image…</span></div>
          </div>
          <div class="studio-canvas-footer">
            <span>{{ imageDimensions }}</span>
            <div class="studio-zoom-controls">
              <button type="button" aria-label="Zoom out" :disabled="zoom <= 0.25" @click="adjustZoom(-0.25)"><UIcon name="i-lucide-minus" class="size-4" /></button>
              <span>{{ Math.round(zoom * 100) }}%</span>
              <button type="button" aria-label="Zoom in" :disabled="zoom >= 2" @click="adjustZoom(0.25)"><UIcon name="i-lucide-plus" class="size-4" /></button>
              <button type="button" @click="zoom = 1">Fit</button>
            </div>
            <button v-if="previewOutput" type="button" class="studio-text-button" @click="previewResult = null">View original</button>
            <button v-else type="button" class="studio-text-button" @click="clearInputImages">Close image</button>
          </div>
        </template>
        <template v-else>
          <div class="studio-canvas-toolbar">
            <div><strong>{{ sourceImages.length }} input{{ sourceImages.length === 1 ? '' : 's' }}</strong><p class="studio-toolbar-description">Each input creates an independent generation job.</p></div>
            <div class="studio-toolbar-actions">
              <UButton color="neutral" variant="ghost" size="sm" @click="clearInputImages">Clear</UButton>
              <UButton color="neutral" variant="soft" size="sm" icon="i-lucide-folder" @click="openPicker('source')">Assets</UButton>
              <UButton size="sm" icon="i-lucide-plus" :loading="uploading" @click="uploadInput?.click()">Add images</UButton>
            </div>
          </div>
          <div class="studio-batch-grid" :class="{ 'studio-batch-grid--dragging': dragging }">
            <div v-for="(image, index) in sourceImages" :key="image" class="studio-input-card">
              <div class="studio-input-preview"><img :src="sourceUrl(image, 480)" :alt="`Input ${index + 1}: ${imageName(image)}`" loading="lazy" decoding="async"><span class="studio-input-number">{{ index + 1 }}</span><button type="button" :aria-label="`Remove ${imageName(image)} from batch`" @click="removeSource(image)"><UIcon name="i-lucide-x" class="size-4" /></button></div>
              <div class="studio-input-caption"><span :title="imageName(image)">{{ imageName(image) }}</span><small>{{ outputsPerJob }} output{{ outputsPerJob === 1 ? '' : 's' }}</small></div>
            </div>
            <button v-if="sourceImages.length < 20" type="button" class="studio-add-card" @click="uploadInput?.click()"><UIcon name="i-lucide-plus" class="size-7" /><span>Add images</span><small>or drop them here</small></button>
          </div>
        </template>
      </section>
      <aside v-if="hasSources" class="studio-composer" aria-label="Generation settings">
        <div class="studio-composer-scroll">
          <div class="studio-panel-heading"><h2>{{ isEdit ? 'Edit image' : 'Same-origin batch' }}</h2><span>AI image editor</span></div>
          <div class="studio-control-group">
            <label for="image-model-select">Model</label>
            <div class="studio-model-row">
              <USelect id="image-model-select" v-model="selectedModelValue" :items="modelOptions" placeholder="Select model" class="min-w-0 flex-1" :content="{ align: 'end', sideOffset: 6 }" :ui="{ content: 'min-w-[min(560px,calc(100vw-2rem))]' }">
                <template #item-leading="{ item }"><UIcon :name="item.isFavourite ? 'i-lucide-heart' : item.icon" class="size-4 shrink-0" :class="{ 'text-rose-400': item.isFavourite }" /></template>
                <template #item-trailing="{ item }"><span v-if="item.isFavourite" class="sr-only">Favourite</span><UBadge v-if="item.isNew" size="xs" color="primary" variant="subtle">New</UBadge></template>
              </USelect>
              <UButton type="button" variant="ghost" :color="selectedIsFavourite ? 'error' : 'neutral'" :disabled="!favouritesReady" :aria-pressed="selectedIsFavourite" :aria-label="`${selectedIsFavourite ? 'Remove' : 'Add'} ${selectedProfile.shortName} ${selectedIsFavourite ? 'from' : 'to'} favourites`" @click="toggleFavourite(data.selectedModel)">
                <svg aria-hidden="true" viewBox="0 0 24 24" class="size-4" :fill="selectedIsFavourite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z" /></svg>
              </UButton>
            </div>
            <div class="studio-model-meta"><UBadge v-if="isNewImageModel(data.selectedModel)" size="xs" color="primary" variant="subtle">New</UBadge><span v-if="selectedProfile.lifecycle === 'recommended'">Recommended</span><span v-if="selectedIsFavourite">Favourite</span></div>
            <p v-if="!favouritesPersistent" role="status" class="studio-notice">Browser storage is unavailable. Favourites last for this visit.</p>
          </div>
          <details class="studio-settings">
            <summary><span>Model settings</span><UIcon name="i-lucide-sliders-horizontal" class="size-4" /></summary>
            <div class="studio-settings-body">
              <div class="studio-settings-reset"><span>{{ selectedProfile.shortName }}</span><button type="button" @click="resetModelSettings">Reset</button></div>
              <p v-if="settingsResetMessage" role="status" class="studio-notice">{{ settingsResetMessage }}</p>
              <component :is="selectedSettingsComponent" :key="`${data.selectedModel}:${settingsPanelRevision}`" v-model="data.generationSettings" />
            </div>
          </details>
          <div class="studio-control-group studio-references">
            <div class="studio-group-title"><label>Reference images <span class="studio-optional">Optional</span></label><button v-if="data.models.length" type="button" @click="clearModels">Clear</button></div>
            <div class="studio-reference-thumbnails">
              <div v-for="image in data.models" :key="image" class="studio-reference-thumb"><img :src="sourceUrl(image)" :alt="`Shared reference: ${imageName(image)}`" loading="lazy" decoding="async"><button type="button" :aria-label="`Remove shared reference ${imageName(image)}`" @click="data.models = data.models.filter(source => source !== image)"><UIcon name="i-lucide-x" class="size-3" /></button></div>
              <button type="button" class="studio-reference-add" aria-label="Choose shared reference images" @click="openPicker('references')"><UIcon name="i-lucide-plus" class="size-5" /></button>
            </div>
            <p class="studio-help">{{ referenceSummary }}</p>
            <p v-if="!isEdit" class="studio-help">The same references are attached to every input job.</p>
          </div>
          <div v-if="selectedProfile.supportsMask" class="studio-control-group">
            <div class="studio-group-title"><label>{{ luminanceMask ? 'Fill mask' : 'Edit mask' }} <span class="studio-optional">{{ selectedProfile.requiresMask ? 'Required' : 'Optional' }}</span></label><button v-if="data.maskImage" type="button" @click="clearMaskImage">Clear</button></div>
            <button type="button" class="studio-mask-picker" @click="openPicker('mask')"><img v-if="data.maskImage" :src="sourceUrl(data.maskImage)" alt="Selected edit mask" decoding="async"><UIcon v-else name="i-lucide-scan" class="size-5" /><span>{{ data.maskImage ? imageName(data.maskImage) : 'Choose a PNG mask' }}</span><UIcon name="i-lucide-chevron-right" class="size-4" /></button>
            <p class="studio-help">{{ luminanceMask ? 'White areas are replaced, black areas are preserved. Match the source dimensions.' : 'Transparent areas guide the edit. The PNG mask and every source must have identical dimensions.' }}</p>
          </div>
          <p v-if="referenceOverflow" class="studio-validation" role="alert">Remove {{ referenceOverflow }} shared reference{{ referenceOverflow === 1 ? '' : 's' }} to meet this model’s limit.</p>
          <p v-if="estimatedOutputCount > 50" class="studio-validation" role="alert">A request supports at most 50 outputs. Reduce the inputs or this model’s output count.</p>
          <p v-if="missingRequiredMask" class="studio-validation" role="alert">This model requires a PNG mask.</p>
          <p v-if="maskWithoutReference || maskFileNotPng || maskSourceNotPng" class="studio-validation" role="alert">{{ maskWithoutReference ? 'A mask needs a source image.' : maskFileNotPng ? 'The mask must be PNG.' : 'Every source must be PNG when using this edit mask.' }}</p>
          <p v-if="!selectedModelAvailable" class="studio-validation" role="alert">{{ selectedModelInfo?.availabilityNote || 'This model is unavailable through AI Gateway.' }}</p>
          <p v-else-if="selectedModelInfo?.catalogStatus === 'unknown'" class="studio-notice">Live availability is unverified. Requests use this exact curated model.</p>
          <details class="studio-model-details">
            <summary>Model details &amp; pricing <UIcon name="i-lucide-info" class="size-4" /></summary>
            <div class="studio-details-body"><strong>{{ selectedProfile.name }}</strong><p>{{ selectedProfile.description }}</p><code>{{ data.selectedModel }}</code><p v-if="selectedPricingText">{{ selectedPricingText }}</p><p>{{ selectedCostEstimate }}</p><p v-if="selectedProfile.lifecycleNote">{{ selectedProfile.lifecycleNote }}</p><p v-for="warning in selectedWarnings" :key="warning">{{ warning }}</p><p v-if="inputCapabilityWarning">{{ inputCapabilityWarning }}</p></div>
          </details>
        </div>
        <div class="studio-prompt-composer">
          <label for="edit-prompt">Prompt</label>
          <UTextarea id="edit-prompt" v-model="prompt" class="w-full" :rows="4" placeholder="Describe the changes you want to make…" autoresize />
          <p v-if="!isEdit" class="studio-help">One prompt for all {{ sourceImages.length }} input images · {{ estimatedOutputCount }} expected output{{ estimatedOutputCount === 1 ? '' : 's' }}.</p>
          <UButton class="studio-generate-button" icon="i-lucide-sparkles" :loading="!!activeGenerationCount" :disabled="!canSubmit" @click="submit">{{ activeGenerationCount ? 'Generating…' : isEdit ? 'Generate' : 'Run batch' }}</UButton>
          <p class="studio-generation-price">{{ selectedCostEstimate }}</p>
          <p v-if="accountBalance.balance.value" class="studio-generation-credit">Available credit: {{ accountBalance.balance.value.unlimited ? 'Unlimited' : formatBalanceUsd(accountBalance.balance.value.actualBalanceUsd) }}</p>
          <p v-if="creditBlockReason" class="studio-validation" role="status">{{ creditBlockReason }}</p>
          <div class="studio-submit-preferences"><UCheckbox v-model="keepSubmitInputs" label="Keep prompt and images" /></div>
        </div>
      </aside>
    </div>
    <div v-if="errorMsg" role="alert" class="studio-error"><UIcon name="i-lucide-triangle-alert" class="size-4 shrink-0" /><span>{{ errorMsg }}</span><button type="button" aria-label="Dismiss error" @click="errorMsg = null"><UIcon name="i-lucide-x" class="size-4" /></button></div>
    <section v-if="pendingGenerations.length" class="studio-pending" aria-live="polite">
      <div class="studio-section-heading"><h2>{{ activeGenerationCount ? `${activeGenerationCount} input jobs running` : 'Unfinished requests' }}</h2><UButton v-if="failedGenerationCount" size="xs" color="neutral" variant="ghost" @click="clearFailedJobs">Clear failed</UButton></div>
      <div class="studio-pending-grid"><div v-for="job in pendingGenerations" :key="job.id" class="studio-pending-card"><img :src="sourceUrl(job.inputImages[0]!)" alt="Generation source" loading="lazy" decoding="async"><div><UIcon :name="job.status === 'failed' ? 'i-lucide-triangle-alert' : 'i-lucide-loader-circle'" :class="{ 'animate-spin': job.status === 'pending' }" class="size-4" /><strong>{{ job.status === 'failed' ? 'Failed' : 'Generating' }}</strong><span>{{ elapsedLabel(job.startedAt) }}</span><p v-if="job.error">{{ job.error }}</p></div></div></div>
    </section>
    <details class="studio-history" :open="historyOpen" @toggle="historyOpen = ($event.target as HTMLDetailsElement).open">
      <summary><span>Generation history <span v-if="confirmedHistory.length" class="studio-history-count">{{ confirmedHistory.length }}</span></span><UIcon name="i-lucide-chevron-down" class="size-4" /></summary>
      <div v-if="historyOpen" class="studio-history-content">
        <p v-if="pastPrompts.status.value === 'pending'" class="studio-help" role="status">Loading history…</p>
        <p v-else-if="pastPrompts.error.value" class="studio-validation">Could not load generation history. <button type="button" @click="pastPrompts.refresh()">Try again</button></p>
        <div v-else-if="confirmedHistory.length" class="studio-history-grid"><system-promp v-for="item in confirmedHistory" :key="item.id" :data="item" /></div>
        <p v-else class="studio-help">Your generated images will appear here with their final prices.</p>
        <UButton v-if="showMoreHistory" color="neutral" variant="soft" :loading="loadingHistory" @click="loadMoreHistory">Load more history</UButton>
      </div>
    </details>
    <div class="studio-debug-toggle"><button type="button" @click="toggleDebugLogs"><UIcon name="i-lucide-bug" class="size-3.5" />{{ debugLogsOpen ? 'Hide' : 'Show' }} Gateway diagnostics</button></div>
    <section v-if="debugLogsOpen" class="studio-diagnostics">
      <div class="studio-section-heading"><div><h2>Gateway diagnostics</h2><p class="studio-help">Redacted request records, billing, and provider errors.</p></div><UButton size="xs" color="neutral" variant="ghost" :loading="gatewayLogsPending" @click="gatewayLogs.refresh()">Refresh</UButton></div>
      <div v-for="log in gatewayLogItems" :key="log.id" class="studio-log"><button type="button" class="studio-log-summary" @click="toggleLogDetails(log.id)"><span>{{ log.status }}</span><span>{{ log.model }}</span><span>{{ formatLogPrice(log.priceUsd, log.priceSource) || 'Cost pending' }}</span><span>{{ formatLogTime(log.createdAt) }}</span><UIcon :name="isLogExpanded(log.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-4" /></button><div v-if="isLogExpanded(log.id)" class="studio-log-body"><p>{{ log.prompt }}</p><p v-if="log.error" class="studio-validation">{{ log.error }}</p><p>{{ formatLogImages(log.inputImages) }} inputs · {{ formatLogImages(log.modelImages) }} references · {{ log.totalTokens?.toLocaleString() || 'Unknown' }} tokens</p><div class="studio-log-json"><div><h3>Request</h3><pre>{{ formatJson(log.requestJson) }}</pre></div><div><h3>Response</h3><pre>{{ formatJson(log.responseJson) }}</pre></div></div></div></div>
      <p v-if="!gatewayLogItems.length" class="studio-help">No Gateway diagnostics yet.</p>
    </section>
  </div>
</template>

<style scoped>
.studio-generation-price{font-size:10px;line-height:1.7;color:#e3c19a;margin-top:12px}.studio-generation-credit{font-size:10px;color:var(--workspace-muted);margin-top:8px}
.generation-studio { color: var(--workspace-text); }
.studio-route-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 76px; padding: 18px 32px; border-bottom: 1px solid var(--workspace-border); background: var(--workspace-bg); }
.studio-route-header h1 { display: flex; align-items: center; gap: 9px; font-size: 20px; letter-spacing: -.4px; font-weight: 550; }
.studio-route-header > span { color: var(--workspace-muted); font-size: 11px; }
.studio-workspace { min-height: calc(100dvh - 162px); }
.studio-workspace--editing { display: grid; grid-template-columns: minmax(0, 1fr) 358px; border-bottom: 1px solid var(--workspace-border); }
.studio-canvas-area { min-width: 0; display: flex; flex-direction: column; background: #211f1b; position: relative; }
.generation-studio--empty .studio-canvas-area { background: var(--workspace-bg); min-height: calc(100dvh - 162px); }
.studio-start { margin: auto; padding: 70px 50px; width: min(1180px, 100%); display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 76px; align-items: center; }
.studio-start-story h2 { font-family: Georgia, serif; font-size: clamp(34px, 3.4vw, 52px); font-weight: 400; letter-spacing: -1.5px; line-height: 1.12; max-width: 470px; margin: 16px 0 22px; }
.studio-start-story p { font-size: 13px; line-height: 1.9; color: var(--workspace-muted); max-width: 380px; }
.studio-start-line { display: block; height: 1px; width: 70px; background: var(--workspace-accent); margin-top: 35px; }
.studio-drop-zone { border: 1px solid #5a5043; border-radius: 24px; padding: 46px 30px 28px; background: #2c2822; text-align: center; transition: border-color 150ms, background 150ms; }
.studio-drop-zone--dragging, .studio-image-stage--dragging, .studio-batch-grid--dragging { background: #403126; border-color: var(--workspace-accent); }
.studio-upload-symbol { display: grid; place-items: center; background: #493628; color: var(--workspace-accent); width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 24px; }
.studio-drop-zone h2 { font-size: 20px; font-weight: 650; margin: 0 0 9px; letter-spacing: -.3px; }
.studio-drop-zone p { font-size: 13px; color: var(--workspace-muted); line-height: 1.6; max-width: 420px; margin: 0 auto; }
.studio-upload-actions { display: flex; justify-content: center; gap: 10px; margin: 24px 0 22px; }
.studio-file-types { display: flex; justify-content: center; gap: 7px; }
.studio-file-types span { background: #373127; color: #bfb4a4; border-radius: 4px; padding: 3px 7px; font-size: 11px; }
.studio-drop-zone .studio-upload-limits { color: #9c9385; font-size: 11px; margin-top: 14px; }
.studio-recent { padding: 17px 3px 0; grid-column: 1 / -1; max-width: 640px; }
.studio-recent > span { display: block; font-size: 12px; color: var(--workspace-muted); margin-bottom: 9px; }
.studio-recent-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 9px; }
.studio-recent-grid button { position: relative; border: 1px solid var(--workspace-border); border-radius: 8px; overflow: hidden; aspect-ratio: 1; background: var(--workspace-surface); cursor: pointer; }
.studio-recent-price { position: absolute; bottom: 0; left: 0; right: 0; font-size: 8px; line-height: 1.4; padding: 4px; color: #f8eddc; background: #211a13de; }
.studio-recent-grid img { width: 100%; height: 100%; object-fit: cover; }
.studio-recent-grid button:hover { border-color: var(--workspace-accent); }
.studio-canvas-toolbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding: 15px 22px; border-bottom: 1px solid var(--workspace-border); min-height: 65px; }
.studio-canvas-toolbar strong { font-size: 14px; font-weight: 600; }
.studio-source-title { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; max-width: 46%; color: #c0b5a6; }
.studio-source-title > span:first-of-type { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-result-label { font-size: 10px; color: #efbb95; background: #463327; border: 1px solid #77503a; border-radius: 4px; padding: 2px 5px; }
.studio-toolbar-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.studio-toolbar-description { color: #787880; font-size: 12px; margin-top: 5px; }
.studio-image-stage { flex: 1; min-height: 480px; max-height: calc(100dvh - 279px); padding: 44px; overflow: auto; display: flex; align-items: center; justify-content: center; position: relative; }
.studio-image-sheet { transform-origin: center; background-color: #28282b; background-image: linear-gradient(45deg, #202022 25%, transparent 25%), linear-gradient(-45deg, #202022 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #202022 75%), linear-gradient(-45deg, transparent 75%, #202022 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0; box-shadow: 0 12px 36px #0004; flex-shrink: 0; max-width: 100%; }
.studio-image-sheet img { display: block; max-width: 100%; max-height: calc(100dvh - 367px); width: auto; height: auto; object-fit: contain; }
.studio-generating-overlay { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); padding: 12px 20px; border: 1px solid #39393f; border-radius: 999px; background: #1c1c1ff2; display: flex; gap: 10px; align-items: center; color: #d8d8df; font-size: 13px; white-space: nowrap; }
.studio-generating-overlay :first-child { color: var(--workspace-accent); }
.studio-canvas-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 52px; padding: 8px 20px; color: var(--workspace-muted); font-size: 11px; }
.studio-zoom-controls { display: flex; align-items: center; background: var(--workspace-surface); border: 1px solid var(--workspace-border); border-radius: 8px; height: 34px; gap: 7px; }
.studio-zoom-controls button { display: grid; place-items: center; min-width: 30px; height: 32px; padding: 0 8px; color: #d3c8b9; cursor: pointer; }
.studio-zoom-controls button:disabled { opacity: .3; cursor: default; }
.studio-zoom-controls span { width: 40px; text-align: center; }
.studio-text-button { color: var(--workspace-muted); cursor: pointer; }
.studio-text-button:hover { color: #f5f5f6; }
.studio-batch-grid { padding: 26px; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 18px; align-content: start; flex: 1; }
.studio-input-card { border: 1px solid var(--workspace-border); border-radius: 12px; background: var(--workspace-surface); overflow: hidden; }
.studio-input-preview { position: relative; aspect-ratio: 1; background: #302b24; }
.studio-input-preview img { width: 100%; height: 100%; object-fit: contain; }
.studio-input-number { position: absolute; top: 9px; left: 9px; display: grid; place-items: center; min-width: 23px; height: 23px; border-radius: 6px; color: #d9d9df; background: #111c; font-size: 11px; }
.studio-input-preview button { position: absolute; top: 9px; right: 9px; padding: 4px; border-radius: 50%; background: #111c; display: grid; place-items: center; cursor: pointer; }
.studio-input-caption { padding: 12px; display: flex; flex-direction: column; gap: 4px; }
.studio-input-caption span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.studio-input-caption small { color: #7f7f88; font-size: 11px; }
.studio-add-card { min-height: 215px; border: 1px dashed #5a5043; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--workspace-muted); font-size: 13px; cursor: pointer; }
.studio-add-card:hover { border-color: var(--workspace-accent); color: var(--workspace-accent); }
.studio-add-card small { color: #9c9385; font-size: 11px; }
.studio-composer { background: var(--workspace-surface); border-left: 1px solid var(--workspace-border); display: flex; flex-direction: column; min-width: 0; max-height: calc(100dvh - 162px); position: sticky; top: 0; align-self: start; height: calc(100dvh - 162px); }
.studio-composer-scroll { overflow-y: auto; padding: 21px 20px 8px; min-height: 0; }
.studio-panel-heading { margin-bottom: 22px; }
.studio-panel-heading h2 { font-size: 15px; font-weight: 650; margin: 0 0 4px; }
.studio-panel-heading span { font-size: 11px; color: var(--workspace-muted); }
.studio-control-group { margin-bottom: 20px; }
.studio-control-group label, .studio-prompt-composer > label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 9px; color: #e2d8c9; }
.studio-model-row { display: flex; align-items: center; gap: 3px; }
.studio-model-meta { display: flex; gap: 8px; margin-top: 7px; color: var(--workspace-muted); font-size: 10px; align-items: center; }
.studio-optional { color: #8c8273; margin-left: 4px; font-weight: 400; font-size: 11px; }
.studio-settings { border-top: 1px solid var(--workspace-border); border-bottom: 1px solid var(--workspace-border); margin-bottom: 20px; }
.studio-settings summary, .studio-model-details summary { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; cursor: pointer; font-size: 12px; list-style: none; color: #c7bcaa; }
.studio-settings summary::-webkit-details-marker, .studio-model-details summary::-webkit-details-marker, .studio-history summary::-webkit-details-marker { display: none; }
.studio-settings summary :last-child { color: #998e7e; }
.studio-settings-body { padding: 0 0 18px; }
.studio-settings-reset { display: flex; justify-content: space-between; color: var(--workspace-muted); font-size: 10px; margin-bottom: 10px; }
.studio-settings-reset button, .studio-group-title > button { color: var(--workspace-muted); cursor: pointer; font-size: 11px; }
.studio-settings-reset button:hover, .studio-group-title > button:hover { color: var(--workspace-accent); }
.studio-settings-body :deep(.grid) { grid-template-columns: minmax(0, 1fr); }
.studio-settings-body :deep(label) { color: #baae9c; font-size: 11px; }
.studio-settings-body :deep(.setting-input) { font-size: 12px; padding: 8px 10px; }
.studio-group-title { display: flex; justify-content: space-between; align-items: start; gap: 8px; }
.studio-reference-thumbnails { display: flex; flex-wrap: wrap; gap: 8px; }
.studio-reference-thumb, .studio-reference-add { width: 58px; height: 64px; border-radius: 8px; border: 1px solid var(--workspace-border); overflow: hidden; background: var(--workspace-surface-raised); position: relative; }
.studio-reference-thumb img { width: 100%; height: 100%; object-fit: cover; }
.studio-reference-thumb button { position: absolute; top: 3px; right: 3px; border-radius: 50%; background: #000a; padding: 2px; display: grid; place-items: center; cursor: pointer; }
.studio-reference-add { border-style: dashed; display: grid; place-items: center; color: #aea18e; cursor: pointer; }
.studio-reference-add:hover { border-color: var(--workspace-accent); color: var(--workspace-accent); }
.studio-help, .studio-notice { font-size: 11px; line-height: 1.6; color: var(--workspace-muted); margin-top: 8px; }
.studio-notice { color: #b6a270; }
.studio-mask-picker { width: 100%; display: flex; align-items: center; gap: 10px; padding: 9px; border: 1px solid var(--workspace-border); border-radius: 8px; color: var(--workspace-muted); font-size: 11px; text-align: left; cursor: pointer; }
.studio-mask-picker > img { width: 32px; height: 32px; object-fit: contain; }
.studio-mask-picker > span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; }
.studio-validation { margin: 10px 0; color: #f6a6a6; font-size: 11px; line-height: 1.6; }
.studio-model-details { border-top: 1px solid var(--workspace-border); margin-top: 15px; }
.studio-details-body { font-size: 11px; color: var(--workspace-muted); line-height: 1.65; padding-bottom: 12px; }
.studio-details-body p { margin-top: 9px; }
.studio-details-body code { display: block; overflow-wrap: anywhere; font-size: 10px; margin-top: 8px; color: #998e7e; }
.studio-prompt-composer { margin-top: auto; padding: 18px 20px 16px; border-top: 1px solid var(--workspace-border); background: var(--workspace-surface); }
.studio-generate-button { width: 100%; display: flex; justify-content: center; margin-top: 12px; min-height: 39px; }
.studio-submit-preferences { margin-top: 11px; font-size: 11px; }
.studio-submit-preferences :deep(label) { font-size: 11px; color: var(--workspace-muted); }
.studio-error { display: flex; align-items: start; gap: 9px; margin: 16px 24px; padding: 12px 14px; background: #2d1919; border: 1px solid #643333; border-radius: 8px; color: #f2b2b2; font-size: 12px; line-height: 1.6; }
.studio-error > span { flex: 1; }
.studio-error button { cursor: pointer; color: #c28080; }
.studio-pending { padding: 22px 26px; border-top: 1px solid var(--workspace-border); }
.studio-section-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.studio-section-heading h2 { font-size: 13px; font-weight: 550; }
.studio-pending-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.studio-pending-card { display: flex; gap: 13px; background: #19191c; border: 1px solid #303039; border-radius: 10px; padding: 10px; }
.studio-pending-card > img { width: 70px; height: 75px; object-fit: contain; border-radius: 5px; background: #232327; }
.studio-pending-card > div { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12px; }
.studio-pending-card strong { font-weight: 500; }
.studio-pending-card span { color: var(--workspace-muted); font-size: 11px; }
.studio-pending-card p { width: 100%; color: #e99c9c; font-size: 11px; }
.studio-history { border-top: 1px solid var(--workspace-border); margin: 0 26px; }
.studio-history > summary { padding: 19px 0; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--workspace-muted); list-style: none; cursor: pointer; }
.studio-history-count { margin-left: 6px; background: var(--workspace-border); padding: 2px 6px; border-radius: 5px; font-size: 10px; }
.studio-history-content { padding-bottom: 24px; }
.studio-history-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 288px), 1fr)); gap: 18px; align-items: stretch; margin-bottom: 18px; }
.studio-debug-toggle { display: flex; justify-content: end; padding: 0 26px 15px; }
.studio-debug-toggle button { display: flex; align-items: center; gap: 6px; font-size: 10px; color: #8c8273; cursor: pointer; }
.studio-diagnostics { margin: 10px 26px 30px; padding: 18px; background: #151517; border: 1px solid var(--workspace-border); border-radius: 10px; }
.studio-log { border-top: 1px solid #2d2d33; }
.studio-log-summary { width: 100%; display: flex; gap: 10px; justify-content: space-between; align-items: center; text-align: left; font-size: 11px; color: var(--workspace-muted); padding: 12px 0; cursor: pointer; }
.studio-log-summary > span:nth-child(2) { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.studio-log-body { padding-bottom: 20px; font-size: 11px; color: #9999a6; }
.studio-log-body p { margin-bottom: 10px; }
.studio-log-json { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.studio-log-json h3 { font-size: 11px; margin: 10px 0; }
.studio-log-json pre { background: #09090b; border: 1px solid #27272e; border-radius: 6px; padding: 12px; max-height: 340px; overflow: auto; font-size: 10px; line-height: 1.6; }
@media (min-width: 1500px) { .studio-workspace--editing { grid-template-columns: minmax(0, 1fr) 380px; } }
@media (max-width: 1100px) { .studio-workspace--editing { grid-template-columns: minmax(0, 1fr) 320px; } .studio-canvas-toolbar { padding: 12px; } .studio-source-title { max-width: 100%; } .studio-image-stage { padding: 24px; } .studio-composer-scroll, .studio-prompt-composer { padding-left: 16px; padding-right: 16px; } .studio-batch-grid { padding: 18px; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; } }
@media (max-width: 760px) { .studio-workspace--editing { display: flex; flex-direction: column; } .studio-composer { position: static; height: auto; max-height: none; border-left: none; border-top: 1px solid var(--workspace-border); } .studio-composer-scroll { overflow: visible; } .studio-image-stage { min-height: 320px; max-height: 520px; padding: 26px; } .studio-image-sheet img { max-height: 440px; } .studio-canvas-footer { flex-wrap: wrap; } .studio-start { padding: 40px 22px; grid-template-columns: minmax(0, 1fr); gap: 28px; } .studio-start-story h2 { font-size: 36px; max-width: 430px; } .studio-start-line { display: none; } .studio-drop-zone { padding: 30px 18px 22px; } .studio-drop-zone h2 { font-size: 18px; } .studio-recent-grid { gap: 6px; } .studio-log-json { grid-template-columns: minmax(0, 1fr); } .studio-log-summary { flex-wrap: wrap; } .studio-history, .studio-diagnostics { margin-left: 16px; margin-right: 16px; } }
</style>
