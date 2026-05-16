<script setup lang="ts">
const data = useDataStore()
const prompt = ref('')
const loading = ref(false)
const errorMsg = ref<string | null>(null)

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

function pricingLabel(p?: ModelPricing) {
  if (!p) return ''
  const inp = fmtPerMillion(p.input)
  const out = fmtPerMillion(p.output)
  if (!inp && !out) return ''
  return ` - ${inp ?? '?'} in / ${out ?? '?'} out per 1M tok`
}

function priceScore(p?: ModelPricing) {
  if (!p) return -1
  const inp = Number(p.input) || 0
  const out = Number(p.output) || 0
  // Weight output 4x - typical chat ratio, also avoids zero-input image models tying.
  const score = inp + out * 4
  return score > 0 ? score : -1
}

function modelPriceScore(m: ImageModelInfo) {
  const fixed = m.pricingDetails?.components.find(c => c.kind === 'fixed-image' && c.amountUsd != null)
  if (fixed?.amountUsd) return fixed.amountUsd
  const perMp = m.pricingDetails?.components.find(c => c.kind === 'megapixel' && c.amountUsd != null)
  if (perMp?.amountUsd) return perMp.amountUsd / 2
  return priceScore(m.pricing)
}

function acceptsImageInput(m: ImageModelInfo) {
  return !!m.capabilities?.input?.includes('image')
}

const sortedModels = computed<ImageModelInfo[]>(() => {
  const items = [...(modelsFetch.data.value?.items || [])]
  items.sort((a, b) => {
    const aImageInput = acceptsImageInput(a) ? 1 : 0
    const bImageInput = acceptsImageInput(b) ? 1 : 0
    if (bImageInput !== aImageInput) return bImageInput - aImageInput

    const da = modelPriceScore(a)
    const db = modelPriceScore(b)
    if (db !== da) return db - da // expensive first within capability group; unpriced (-1) sinks.

    return a.id.localeCompare(b.id)
  })
  return items
})

type ModelOption = { label: string; value: string; icon: string }
const modelOptions = computed<ModelOption[]>(() => {
  return sortedModels.value.map(m => ({
    label: `${m.provider} - ${m.name || m.id.split('/').pop()}`,
    value: m.id,
    icon: acceptsImageInput(m) ? 'i-lucide-images' : 'i-lucide-type'
  }))
})

const selectedModelInfo = computed<ImageModelInfo | undefined>(() => {
  const items = modelsFetch.data.value?.items || []
  return items.find(m => m.id === data.selectedModel)
})

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
const selectedWarnings = computed(() => selectedCapabilities.value?.warnings || [])
const selectedCapabilityPills = computed(() => {
  const caps = selectedCapabilities.value
  if (!caps) return []
  return [
    ...caps.operations.map(v => v.replaceAll('-', ' ')),
    ...caps.input.filter(v => v !== 'text').map(v => v.replaceAll('-', ' ') + ' input'),
    ...caps.output.filter(v => v !== 'image').map(v => v + ' output')
  ]
})
const estimatedOutputCount = computed(() => Math.max(1, data.inputImages.length))
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

// Detect the nano-banana family (Gemini 3 Pro Image) for nano-only options.
const nanoBananaModelId = computed(() => {
  const items = modelsFetch.data.value?.items || []
  const exact = items.find(m => m.id === 'google/gemini-3-pro-image')
  if (exact) return exact.id
  const match = items.find(m => /3[-_]?pro.*image/i.test(m.id) || /nano\s*banana/i.test(m.name))
  return match?.id
})

// Default selection = most expensive priced model. Falls back to first listed.
const defaultModel = computed(() => sortedModels.value[0]?.id)

// Set a default once the list arrives.
watch(defaultModel, (v) => {
  if (v && !data.selectedModel) data.selectedModel = v
}, { immediate: true })

const isNanoBananaSelected = computed(() => !!nanoBananaModelId.value && data.selectedModel === nanoBananaModelId.value)

type Option = { label: string; value: string }
// Radix Select (used by USelect) does not allow an empty string as an item value.
// Use a non-empty sentinel to represent "model default" and map it to undefined on submit.
const DEFAULT_ASPECT_RATIO = '__DEFAULT__'
const aspectRatioOptions: Option[] = [
  { label: 'Default (model decides)', value: DEFAULT_ASPECT_RATIO },
  { label: '1:1 (Square)', value: '1:1' },
  { label: '16:9 (Widescreen)', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '9:16 (Portrait)', value: '9:16' },
  { label: '3:2', value: '3:2' },
  { label: '2:3', value: '2:3' }
]
const imageSizeOptions: Option[] = [
  { label: '1K', value: '1K' },
  { label: '2K', value: '2K' },
  { label: '4K', value: '4K' }
]

// Clear or set sensible defaults when switching models
watch(
  () => data.selectedModel,
  (newVal) => {
    if (newVal !== nanoBananaModelId.value) {
      // Do not send nano-only config for other models
      data.imageConfig.aspectRatio = undefined
      data.imageConfig.imageSize = undefined
    } else {
      // If not set, keep them undefined so API defaults apply; user can override
    }
  }
)

let pastPrompts = useFetch('/api/systemprompts', {deep: true, key: () => 'systemPrompts',})
const gatewayLogs = useFetch<{ ok: boolean; items: AiGatewayLog[] }>('/api/ai-gateway-logs?limit=25', {
  key: 'aiGatewayLogs',
  immediate: false,
  default: () => ({ ok: true, items: [] })
})

const debugLogsOpen = ref(false)
const expandedLogIds = ref<Set<number>>(new Set())
const gatewayLogItems = computed(() => gatewayLogs.data.value?.items || [])

watch(debugLogsOpen, async (open) => {
  if (open && !gatewayLogItems.value.length) {
    await gatewayLogs.refresh()
  }
})

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

// Elapsed time counter for loading indicator
const elapsedMs = ref(0)
let timerId: any = null
const elapsedLabel = computed(() => {
  const totalSeconds = Math.floor(elapsedMs.value / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
})

function startTimer() {
  stopTimer()
  const start = Date.now()
  elapsedMs.value = 0
  timerId = setInterval(() => {
    elapsedMs.value = Date.now() - start
  }, 1000)
}

function stopTimer() {
  if (timerId) {
    clearInterval(timerId)
    timerId = null
  }
}

onBeforeUnmount(() => {
  stopTimer()
})

async function submit() {
  if (loading.value) return
  errorMsg.value = null
  try {
    loading.value = true
    startTimer()
    const res = await $fetch<{ ok: boolean; url?: string; message?: string }>(
        '/api/image-generate',
        {
          method: 'POST',
          body: {
            prompt: prompt.value,
            inputImages: data.inputImages,
            modelImages: data.models,
            model: data.selectedModel || undefined,
            responseModalities: ['IMAGE'],
            // Only include imageConfig if nanoBananaPro is selected
            imageConfig: isNanoBananaSelected.value ? {
              // Map sentinel or cleared value to undefined so the model decides
              aspectRatio: (!data.imageConfig.aspectRatio || data.imageConfig.aspectRatio === DEFAULT_ASPECT_RATIO)
                  ? undefined
                  : data.imageConfig.aspectRatio,
              imageSize: (data.imageConfig.imageSize as any) || undefined
            } : undefined
          }
        }
    )

  } catch (e: any) {
    errorMsg.value = e?.message || 'Request failed'
  } finally {
    await pastPrompts.refresh()
    if (debugLogsOpen.value) await gatewayLogs.refresh()
    stopTimer()
    loading.value = false
  }
}

</script>

<template>
  <div>
    <!-- Loading overlay while waiting for Gemini response -->
    <div v-if="loading" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div class="flex flex-col items-center gap-3 p-5 bg-white/90 dark:bg-gray-800/90 rounded-xl shadow-xl">
        <svg class="animate-spin h-7 w-7 text-primary-600" xmlns="http://www.w3.org/2000/svg" fill="none"
             viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
        </svg>
        <span class="text-sm text-gray-700 dark:text-gray-200">Generating...</span>
        <span class="text-xs font-mono text-gray-500 dark:text-gray-400">Elapsed {{ elapsedLabel }}</span>
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <UModal :ui="{ content: 'max-w-7xl'}">
        <UButton color="primary" variant="solid">
          Select Models ({{ data.models.length }})
        </UButton>
        <template #content>
          <Files :is-model-select="true" class="overflow-y-auto"/>
        </template>
      </UModal>
      <div class="flex items-center justify-between">
        <p class="text-sm text-gray-600 dark:text-gray-300">Selected model image(s)</p>
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
      <div class="grid grid-cols-1 xl:grid-cols-[minmax(520px,1fr)_360px] gap-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 content-start">
          <div class="sm:col-span-2">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model</label>
            <USelect
                v-model="data.selectedModel"
                :items="modelOptions"
                placeholder="Select model"
                class="w-full"
                :content="{ align: 'start', sideOffset: 6 }"
                :ui="{ content: 'min-w-[min(720px,calc(100vw-2rem))]' }"
            />
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400 break-all">Using: {{ data.selectedModel }}</p>
          </div>
          <!-- nanoBananaPro-only options -->
          <div v-if="isNanoBananaSelected">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Aspect ratio</label>
            <USelect
                v-model="data.imageConfig.aspectRatio"
                :items="aspectRatioOptions"
                placeholder="Default (model decides)"
                clearable
            />
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Optional. Choose image aspect ratio.</p>
          </div>
          <div v-if="isNanoBananaSelected">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Image size</label>
            <USelect
                v-model="data.imageConfig.imageSize"
                :items="imageSizeOptions"
                placeholder="Default (1K)"
                clearable
            />
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Optional. Higher values take longer.</p>
          </div>
        </div>
        <aside class="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/60 p-3 text-sm">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Model info</div>
              <div class="mt-1 font-semibold text-gray-900 dark:text-gray-100">{{ selectedModelInfo?.name || 'No model selected' }}</div>
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
      <div class="flex items-center gap-2 justify-end">
        <UButton class="w-full" @click="submit()" :disabled="loading">
          <span v-if="loading">Submitting...</span>
          <span v-else>Submit</span>
        </UButton>
        <span v-if="errorMsg" class="text-red-500 text-sm">{{ errorMsg }}</span>
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
        <UButton size="xs" variant="ghost" :loading="gatewayLogs.status === 'pending'" @click="gatewayLogs.refresh()">
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
                  <a v-if="log.outputImage" class="text-primary-600 dark:text-primary-400" :href="log.outputImage" target="_blank">
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
      <div v-if="pastPrompts.data?.value?.items?.length"
           class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        <system-promp
            v-for="item in pastPrompts.data.value.items"
            :key="item.id"
            :data="item"
        />
      </div>
      <div v-else class="text-sm text-gray-500">No system prompts yet.</div>
    </div>
  </div>
</template>

<style scoped>

</style>
