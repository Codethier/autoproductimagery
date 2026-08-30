<script setup lang="ts">
import type { Component } from 'vue'
import {
  IMAGE_MODEL_PROFILES,
  ImageGenerationRequestSchema,
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

const data = useDataStore()
const prompt = ref('')
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

type PendingGeneration = {
  id: string
  prompt: string
  model: string
  inputImages: string[]
  modelImages: string[]
  startedAt: number
  status: 'pending' | 'failed'
  error?: string
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

type ModelOption = { label: string; value: ImageModelId; icon: string; disabled: boolean }
const modelOptions = computed<ModelOption[]>(() => SUPPORTED_IMAGE_MODEL_IDS.map((id) => {
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
}
const selectedSettingsComponent = computed(() => settingsComponents[selectedProfile.value.settingsComponent])

watch(() => data.selectedModel, (model, previousModel) => {
  if (model !== previousModel) data.generationSettings = createDefaultSettings(model)
  if (!selectedProfile.value.supportsMask) data.maskImage = null
}, {flush: 'sync'})

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
const outputsPerJob = computed(() => data.generationSettings.kind === 'openai-gpt-image-2'
    ? data.generationSettings.numberOfImages
    : 1)
const estimatedOutputCount = computed(() => Math.max(1, data.inputImages.length) * outputsPerJob.value)
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
  const hasImageInputs = data.inputImages.length > 0 || data.models.length > 0
  const caps = selectedCapabilities.value
  if (!hasImageInputs || !caps) return ''
  return caps.input.includes('image')
      ? ''
      : 'Selected images may be rejected because this model is text-to-image only.'
})

const referenceCount = computed(() => (data.inputImages.length > 0 ? 1 : 0) + data.models.length)
const referenceOverflow = computed(() => Math.max(0, referenceCount.value - selectedProfile.value.maxReferenceImages))
const maskWithoutReference = computed(() => !!data.maskImage && referenceCount.value === 0)
const maskFileNotPng = computed(() => !!data.maskImage && !/\.png(?:$|[?#])/i.test(data.maskImage))
const maskSources = computed(() => data.inputImages.length > 0
    ? data.inputImages
    : data.models.slice(0, 1))
const maskSourceNotPng = computed(() => !!data.maskImage
    && maskSources.value.some(source => !/\.png(?:$|[?#])/i.test(source)))
const referenceSummary = computed(() => {
  const inputPart = data.inputImages.length > 0 ? '1 per input job' : 'no per-job input'
  return `${referenceCount.value}/${selectedProfile.value.maxReferenceImages} references per generation (${inputPart} + ${data.models.length} shared)`
})

let pastPrompts = useFetch('/api/systemprompts', {deep: true, key: () => 'systemPrompts',})
const gatewayLogs = useFetch<{ ok: boolean; items: AiGatewayLog[] }>('/api/ai-gateway-logs?limit=25', {
  key: 'aiGatewayLogs',
  immediate: false,
  default: () => ({ ok: true, items: [] })
})

const debugLogsOpen = ref(false)
const expandedLogIds = ref<Set<number>>(new Set())
const gatewayLogItems = computed(() => gatewayLogs.data.value?.items || [])
const gatewayLogsPending = computed(() => gatewayLogs.status.value === 'pending')
const pendingGenerations = ref<PendingGeneration[]>([])
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
  const price = value ? Number(value) : NaN
  if (!Number.isFinite(price)) return source === 'unknown' ? 'Unknown' : ''
  const amount = price < 0.01 ? `$${price.toFixed(6)}` : `$${price.toFixed(4)}`
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

function clearModels() {
  try {
    // empty array while preserving reactivity
    ;(data.models as any).splice(0)
  } catch { /* no-op */
  }
}

function clearInputImages() {
  try {
    ;(data.inputImages as any).splice(0)
  } catch { /* no-op */
  }
}

function clearMaskImage() {
  data.maskImage = null
}

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
})

async function submit() {
  const promptText = prompt.value.trim()
  if (!promptText) {
    errorMsg.value = 'Prompt is required'
    return
  }
  if (!selectedModelAvailable.value) {
    errorMsg.value = selectedModelInfo.value?.availabilityNote || 'This model is not currently available through AI Gateway.'
    return
  }

  const maskImage = data.maskImage || undefined
  const settings = structuredClone(toRaw(data.generationSettings))
  const requestBody = {
    prompt: promptText,
    inputImages: [...data.inputImages],
    modelImages: [...data.models],
    model: data.selectedModel,
    settings,
    maskImage,
    storeInputImages: true,
  }
  const validation = ImageGenerationRequestSchema.safeParse(requestBody)
  if (!validation.success) {
    errorMsg.value = validation.error.issues.map(issue => issue.message).join(' ')
    return
  }

  errorMsg.value = null
  const job: PendingGeneration = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    prompt: promptText,
    model: data.selectedModel || 'Default model',
    inputImages: [...data.inputImages],
    modelImages: [...data.models],
    startedAt: Date.now(),
    status: 'pending'
  }
  pendingGenerations.value.unshift(job)
  if (!keepSubmitInputs.value) {
    prompt.value = ''
    clearInputImages()
    clearModels()
    clearMaskImage()
  }
  let serverCreatedRows = false

  try {
    const res = await $fetch<{ ok: boolean; obj?: Array<{ outputImage?: string | null; errors?: string | null }> }>(
        '/api/image-generate',
        {
          method: 'POST',
          body: validation.data
        }
    )
    serverCreatedRows = true
    const failedRow = res?.obj?.find((row) => row?.errors)
    if (failedRow?.errors) {
      job.status = 'failed'
      job.error = failedRow.errors
    } else {
      removePendingJob(job.id)
    }
  } catch (e: any) {
    job.status = 'failed'
    job.error = e?.data?.statusMessage || e?.message || 'Request failed'
  } finally {
    await pastPrompts.refresh()
    if (debugLogsOpen.value) await gatewayLogs.refresh()
    if (serverCreatedRows) {
      removePendingJob(job.id)
    }
    if (job.status === 'failed' && job.error) {
      errorMsg.value = job.error
    }
  }
}

</script>

<template>
  <div>
    <div class="flex flex-col gap-2">
      <UModal :ui="{ content: 'max-w-7xl'}">
        <UButton color="primary" variant="solid">
          Select Shared References ({{ data.models.length }})
        </UButton>
        <template #content>
          <Files :is-model-select="true" class="overflow-y-auto"/>
        </template>
      </UModal>
      <div class="flex items-center justify-between">
        <p class="text-sm text-gray-600 dark:text-gray-300">Shared reference image(s)</p>
        <UButton v-if="data.models.length > 0" size="xs" variant="ghost" @click="clearModels">Clear</UButton>
      </div>
      <div v-if="data.models.length > 0"
           class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 justify-items-center items-center gap-2">
        <DownloadableImage v-for="m in data.models" :key="m" :src="m"
                           class="w-full object-contain rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800"/>
      </div>
      <UModal :ui="{ content: 'max-w-7xl'}">
        <UButton color="primary" variant="outline">
          Select Input Images ({{ data.inputImages.length }})
        </UButton>
        <template #content>
          <Files :is-image-select="true" class="overflow-y-auto"/>
        </template>
      </UModal>
      <div class="flex items-center justify-between">
        <p class="text-sm text-gray-600 dark:text-gray-300">Selected input image(s)</p>
        <UButton v-if="data.inputImages.length > 0" size="xs" variant="ghost" @click="clearInputImages">Clear</UButton>
      </div>
      <div v-if="data.inputImages.length > 0"
           class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 justify-items-center items-center gap-2">
        <DownloadableImage v-for="i in data.inputImages" :key="i" :src="i"
                           class="w-full object-contain rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800"/>
      </div>
      <div v-if="selectedProfile.supportsMask" class="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="text-sm font-medium text-gray-800 dark:text-gray-100">GPT edit mask</p>
            <p class="text-xs text-gray-500 dark:text-gray-400">Optional PNG with an alpha channel. The first reference must also be PNG with identical dimensions. The mask guides, rather than precisely bounds, the edit.</p>
          </div>
          <div class="flex gap-2">
            <UModal :ui="{ content: 'max-w-7xl'}">
              <UButton size="sm" variant="outline">{{ data.maskImage ? 'Change mask' : 'Select mask' }}</UButton>
              <template #content>
                <Files :is-mask-select="true" class="overflow-y-auto"/>
              </template>
            </UModal>
            <UButton v-if="data.maskImage" size="sm" variant="ghost" color="neutral" @click="clearMaskImage">Clear</UButton>
          </div>
        </div>
        <div v-if="data.maskImage" class="mt-3 flex items-center gap-3">
          <DownloadableImage :src="data.maskImage" class="h-24 w-24 rounded-md border border-gray-200 bg-gray-50 object-contain dark:border-gray-700 dark:bg-gray-800"/>
          <span class="break-all text-xs text-gray-500 dark:text-gray-400">{{ data.maskImage }}</span>
        </div>
      </div>
      <div
          class="rounded-lg border px-3 py-2 text-xs"
          :class="referenceOverflow || maskWithoutReference || maskFileNotPng || maskSourceNotPng
              ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200'
              : 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-800 dark:bg-gray-900/60 dark:text-gray-300'"
      >
        <span class="font-medium">Reference usage:</span> {{ referenceSummary }}.
        <span v-if="referenceOverflow"> Remove {{ referenceOverflow }} shared reference image{{ referenceOverflow === 1 ? '' : 's' }} before submitting.</span>
        <span v-if="maskWithoutReference"> Select at least one input or shared reference image before using a mask.</span>
        <span v-if="maskFileNotPng"> The mask itself must be a PNG image with an alpha channel.</span>
        <span v-if="maskSourceNotPng"> Every per-job source must be PNG when a PNG mask is selected.</span>
        <span v-if="data.maskImage && !maskSourceNotPng && !maskWithoutReference"> The server verifies the mask against every source's dimensions before starting the batch.</span>
      </div>
      <div class="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
        <span class="font-medium">Image-only references:</span>
        this product accepts image files as model inputs. PDF, video, audio, and other document/media inputs are out of scope.
      </div>
      <div class="grid grid-cols-1 xl:grid-cols-[minmax(520px,1fr)_360px] gap-4">
        <div class="space-y-4 content-start">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model</label>
            <USelect
                v-model="selectedModelValue"
                :items="modelOptions"
                placeholder="Select model"
                class="w-full"
                :content="{ align: 'start', sideOffset: 6 }"
                :ui="{ content: 'min-w-[min(720px,calc(100vw-2rem))]' }"
            />
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">{{ selectedProfile.description }}</p>
            <p class="mt-1 break-all text-xs text-gray-400 dark:text-gray-500">{{ data.selectedModel }}</p>
          </div>
          <section class="rounded-lg border border-gray-200 bg-white/70 p-4 dark:border-gray-800 dark:bg-gray-900/60">
            <div class="mb-4 flex items-center justify-between gap-2">
              <h2 class="text-sm font-semibold text-gray-900 dark:text-gray-100">{{ selectedProfile.shortName }} settings</h2>
              <UButton size="xs" variant="ghost" color="neutral" @click="data.generationSettings = createDefaultSettings(data.selectedModel)">Reset settings</UButton>
            </div>
            <component :is="selectedSettingsComponent" v-model="data.generationSettings"/>
          </section>
        </div>
        <aside class="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/60 p-3 text-sm">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Model info</div>
              <div class="mt-1 font-semibold text-gray-900 dark:text-gray-100">{{ selectedProfile.name }}</div>
              <div class="mt-1 text-xs capitalize text-gray-500 dark:text-gray-400">{{ selectedProfile.lifecycle }}</div>
            </div>
            <span class="shrink-0 rounded border border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-300 capitalize">
              {{ selectedPricingMethod }}
            </span>
          </div>
          <div class="mt-3 space-y-2 text-xs text-gray-600 dark:text-gray-300">
            <div v-if="selectedPricingText">
              <span class="font-medium text-gray-800 dark:text-gray-100">Pricing:</span>
              {{ selectedPricingText }}
            </div>
            <div>
              <span class="font-medium text-gray-800 dark:text-gray-100">Batch cost:</span>
              {{ selectedCostEstimate }}
            </div>
            <div v-if="selectedCapabilityPills.length" class="flex flex-wrap gap-1.5 pt-1">
              <span
                  v-for="cap in selectedCapabilityPills"
                  :key="cap"
                  class="rounded border border-gray-200 dark:border-gray-700 px-2 py-0.5 text-[11px] text-gray-700 dark:text-gray-200"
              >
                {{ cap }}
              </span>
            </div>
            <div v-if="inputCapabilityWarning" class="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              {{ inputCapabilityWarning }}
            </div>
            <div v-if="!selectedModelAvailable" class="rounded border border-red-200 bg-red-50 p-2 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
              {{ selectedModelInfo?.availabilityNote || 'This model is not currently available through AI Gateway.' }}
            </div>
            <div v-else-if="selectedModelInfo?.catalogStatus === 'unknown'" class="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              {{ selectedModelInfo.availabilityNote || 'Live Gateway availability could not be verified; the request will still use this exact curated model ID.' }}
            </div>
            <div v-if="selectedProfile.lifecycleNote" class="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              {{ selectedProfile.lifecycleNote }}
            </div>
            <div
                v-for="warning in selectedWarnings"
                :key="warning"
                class="rounded border border-gray-200 bg-gray-50 p-2 text-gray-600 dark:border-gray-800 dark:bg-gray-800/60 dark:text-gray-300"
            >
              {{ warning }}
            </div>
          </div>
        </aside>
      </div>
      <div class="mt-2">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Prompt</label>
        <UTextarea v-model="prompt" class="w-full" placeholder="Describe how to transform the input image(s)..."
                   autoresize/>
      </div>
      <UCheckbox
          v-model="keepSubmitInputs"
          label="Keep prompt and selected images after submit"
          class="self-start"
      />
      <div class="flex items-center gap-2 justify-end">
        <UButton class="w-full" @click="submit()" :disabled="!prompt.trim() || !!referenceOverflow || maskWithoutReference || maskFileNotPng || maskSourceNotPng || !selectedModelAvailable">
          Submit
        </UButton>
      </div>
      <div
          v-if="activeGenerationCount || failedGenerationCount || errorMsg"
          class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/50 px-3 py-2 text-xs text-gray-600 dark:text-gray-300"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span v-if="activeGenerationCount" class="inline-flex items-center gap-1.5 text-primary-600 dark:text-primary-400">
            <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
            {{ activeGenerationCount }} generating
          </span>
          <span v-if="failedGenerationCount" class="text-red-600 dark:text-red-300">
            {{ failedGenerationCount }} failed
          </span>
          <span v-if="errorMsg" class="text-red-600 dark:text-red-300">{{ errorMsg }}</span>
        </div>
        <UButton v-if="failedGenerationCount" size="xs" variant="ghost" color="neutral" @click="clearFailedJobs">
          Clear failed
        </UButton>
      </div>

    </div>
    <div class="mt-4 flex justify-end">
      <UButton
          size="xs"
          variant="ghost"
          icon="i-lucide-bug"
          @click="toggleDebugLogs"
      >
        {{ debugLogsOpen ? 'Hide debug logs' : 'Debug logs' }}
      </UButton>
    </div>
    <section v-if="debugLogsOpen" class="mt-2 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
      <div class="flex items-center justify-between gap-3 px-3 py-2 bg-gray-50 dark:bg-gray-900/70 border-b border-gray-200 dark:border-gray-800">
        <div>
          <h2 class="text-sm font-semibold text-gray-900 dark:text-gray-100">AI Gateway debug log</h2>
          <p class="text-xs text-gray-500 dark:text-gray-400">Raw request/response records for development</p>
        </div>
        <UButton size="xs" variant="ghost" :loading="gatewayLogsPending" @click="gatewayLogs.refresh()">
          Refresh
        </UButton>
      </div>
      <div class="overflow-x-auto">
        <table class="min-w-full text-xs">
          <thead class="bg-white dark:bg-gray-950 text-gray-500 dark:text-gray-400">
            <tr>
              <th class="px-3 py-2 text-left font-medium">Time</th>
              <th class="px-3 py-2 text-left font-medium">Status</th>
              <th class="px-3 py-2 text-left font-medium">Model</th>
              <th class="px-3 py-2 text-left font-medium">Prompt</th>
              <th class="px-3 py-2 text-left font-medium">Inputs</th>
              <th class="px-3 py-2 text-left font-medium">Tokens</th>
              <th class="px-3 py-2 text-left font-medium">Cost</th>
              <th class="px-3 py-2 text-left font-medium">Output/Error</th>
              <th class="px-3 py-2 text-left font-medium">JSON</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-800">
            <template v-for="log in gatewayLogItems" :key="log.id">
              <tr class="bg-white/70 dark:bg-gray-900/40 align-top">
                <td class="px-3 py-2 whitespace-nowrap text-gray-600 dark:text-gray-300">{{ formatLogTime(log.createdAt) }}</td>
                <td class="px-3 py-2">
                  <span
                      class="rounded px-2 py-0.5 text-[11px] font-medium"
                      :class="log.status === 'success'
                          ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300'
                          : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'"
                  >
                    {{ log.status }}
                  </span>
                </td>
                <td class="px-3 py-2 max-w-48 truncate text-gray-800 dark:text-gray-100" :title="log.model">{{ log.model }}</td>
                <td class="px-3 py-2 max-w-64 truncate text-gray-600 dark:text-gray-300" :title="log.prompt">{{ log.prompt }}</td>
                <td class="px-3 py-2 whitespace-nowrap text-gray-600 dark:text-gray-300">
                  {{ formatLogImages(log.inputImages) }} / {{ formatLogImages(log.modelImages) }}
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-gray-600 dark:text-gray-300">
                  {{ log.totalTokens?.toLocaleString?.() || '-' }}
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-gray-600 dark:text-gray-300">
                  {{ formatLogPrice(log.priceUsd, log.priceSource) || '-' }}
                </td>
                <td class="px-3 py-2 max-w-56 truncate">
                  <a v-if="log.outputImage" class="text-primary-600 dark:text-primary-400" :href="`/api/data${log.outputImage}`" target="_blank">
                    {{ log.outputImage }}
                  </a>
                  <span v-else class="text-red-600 dark:text-red-300" :title="log.error || ''">{{ log.error || '-' }}</span>
                </td>
                <td class="px-3 py-2 whitespace-nowrap">
                  <UButton
                      size="xs"
                      variant="ghost"
                      :icon="isLogExpanded(log.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                      @click="toggleLogDetails(log.id)"
                  >
                    {{ isLogExpanded(log.id) ? 'Hide' : 'View' }}
                  </UButton>
                </td>
              </tr>
              <tr v-if="isLogExpanded(log.id)" class="bg-gray-50 dark:bg-gray-950">
                <td colspan="9" class="px-3 py-3">
                  <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
                    <div>
                      <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Request JSON</div>
                      <pre class="max-h-96 overflow-auto rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-black p-3 text-[11px] leading-5 text-gray-800 dark:text-gray-100">{{ formatJson(log.requestJson) }}</pre>
                    </div>
                    <div>
                      <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Response JSON</div>
                      <pre class="max-h-96 overflow-auto rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-black p-3 text-[11px] leading-5 text-gray-800 dark:text-gray-100">{{ formatJson(log.responseJson) }}</pre>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="!gatewayLogItems.length">
              <td colspan="9" class="px-3 py-6 text-center text-gray-500 dark:text-gray-400">No Gateway logs yet.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <div class="mt-6">
      <div
          v-if="pendingGenerations.length || pastPrompts.data?.value?.items?.length"
           class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        <div
            v-for="job in pendingGenerations"
            :key="job.id"
            class="overflow-hidden rounded-xl border shadow-sm"
            :class="job.status === 'failed'
                ? 'border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-950/30'
                : 'border-primary-200 dark:border-primary-800 bg-white/70 dark:bg-gray-900/50'"
        >
          <div
              class="flex min-h-28 items-center justify-center gap-2 border-b p-6"
              :class="job.status === 'failed'
                  ? 'border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
                  : 'border-primary-200 dark:border-primary-800 text-primary-700 dark:text-primary-300'"
          >
            <UIcon
                :name="job.status === 'failed' ? 'i-lucide-triangle-alert' : 'i-lucide-loader-circle'"
                class="size-5"
                :class="job.status === 'pending' ? 'animate-spin' : ''"
            />
            <span class="text-sm font-medium">{{ job.status === 'failed' ? 'Generation failed' : 'Generating image' }}</span>
          </div>
          <div class="flex flex-col gap-3 p-3">
            <p class="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-3" :title="job.prompt">
              {{ job.prompt }}
            </p>
            <div class="grid grid-cols-1 gap-1 rounded bg-gray-50 p-2 text-[11px] text-gray-600 dark:bg-gray-800/70 dark:text-gray-400">
              <div>
                <span class="font-medium text-gray-700 dark:text-gray-300">Model:</span>
                {{ job.model }}
              </div>
              <div>
                <span class="font-medium text-gray-700 dark:text-gray-300">Elapsed:</span>
                {{ elapsedLabel(job.startedAt) }}
              </div>
            </div>
            <div v-if="job.error" class="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
              {{ job.error }}
            </div>
            <div v-if="job.inputImages.length" class="mt-1">
              <div class="mb-1 text-xs font-medium text-gray-700 dark:text-gray-300">Input image(s)</div>
              <div class="grid grid-cols-5 gap-1">
                <DownloadableImage
                    v-for="src in job.inputImages"
                    :key="src"
                    :src="src"
                    :alt="'Pending input ' + src"
                    class="h-16 w-full rounded bg-gray-50 object-cover dark:bg-gray-800"
                />
              </div>
            </div>
          </div>
        </div>
        <system-promp
            v-for="item in pastPrompts.data?.value?.items || []"
            :key="item.id"
            :data="item"
        />
      </div>
      <div v-else class="text-sm text-gray-500">No system prompts yet.</div>
    </div>
  </div>
</template>

<style scoped>
.line-clamp-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
