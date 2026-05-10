<script setup lang="ts">
const data = useDataStore()
const prompt = ref('')
const loading = ref(false)
const errorMsg = ref<string | null>(null)
const temperature = ref(1)
const topP = ref(0.95)

// Fetch all image-capable models from the gateway (across providers).
type ModelPricing = {
  input: string
  output: string
  cachedInputTokens?: string
  cacheCreationInputTokens?: string
} | null

type ImageModelInfo = {
  id: string
  name: string
  description?: string
  provider: string
  modelType: 'language' | 'image'
  pricing?: ModelPricing
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
  return ` — ${inp ?? '?'} in / ${out ?? '?'} out per 1M tok`
}

function priceScore(p?: ModelPricing) {
  if (!p) return -1
  const inp = Number(p.input) || 0
  const out = Number(p.output) || 0
  // Weight output 4x — typical chat ratio, also avoids zero-input image models tying.
  const score = inp + out * 4
  return score > 0 ? score : -1
}

const sortedModels = computed<ImageModelInfo[]>(() => {
  const items = [...(modelsFetch.data.value?.items || [])]
  items.sort((a, b) => {
    const da = priceScore(a.pricing)
    const db = priceScore(b.pricing)
    if (db !== da) return db - da // expensive first; unpriced (-1) sink to bottom
    return a.id.localeCompare(b.id)
  })
  return items
})

type ModelOption = { label: string; value: string }
const modelOptions = computed<ModelOption[]>(() => {
  return sortedModels.value.map(m => ({
    label: `${m.provider} · ${m.name || m.id.split('/').pop()}${pricingLabel(m.pricing)}`,
    value: m.id
  }))
})

const selectedModelInfo = computed<ImageModelInfo | undefined>(() => {
  const items = modelsFetch.data.value?.items || []
  return items.find(m => m.id === data.selectedModel)
})

const selectedPricingText = computed(() => {
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
  return `${parts.join(' · ')} per 1M tokens`
})

// Detect the nano-banana family (Gemini 3 pro image preview) for nano-only options.
const nanoBananaModelId = computed(() => {
  const items = modelsFetch.data.value?.items || []
  const exact = items.find(m => m.id === 'google/gemini-3-pro-image-preview')
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
  if (data.inputImages.length === 0) {
    errorMsg.value = 'Please select at least one input image.'
    return
  }
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
            temperature: temperature.value,
            topP: topP.value,
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
        <span class="text-sm text-gray-700 dark:text-gray-200">Generating with Gemini…</span>
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
      <div class="grid grid-cols-2 gap-8">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model</label>
          <USelect
              v-model="data.selectedModel"
              :items="modelOptions"
              placeholder="Select a Gemini model"
          />
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Using: {{ data.selectedModel }}</p>
          <p v-if="selectedPricingText" class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {{ selectedPricingText }}
          </p>
        </div>
        <!-- nanoBananaPro-only options -->
        <div v-if="isNanoBananaSelected" class="col-span-1">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Aspect ratio</label>
          <USelect
              v-model="data.imageConfig.aspectRatio"
              :items="aspectRatioOptions"
              placeholder="Default (model decides)"
              clearable
          />
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Optional. Choose image aspect ratio.</p>
        </div>
        <div v-if="isNanoBananaSelected" class="col-span-1">
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Image size</label>
          <USelect
              v-model="data.imageConfig.imageSize"
              :items="imageSizeOptions"
              placeholder="Default (1K)"
              clearable
          />
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Optional. Higher values take longer.</p>
        </div>
        <div>
          <p>Temperature: {{temperature}}</p>
          <p class="text-sm">Creativity allowed in the responses</p>
          <USlider v-model="temperature" :min="0" :max="1" :step="0.01" tooltip/>
        </div>
        <div>
          <p>topP: {{topP}}</p>
          <p class="text-sm">Probability threshold for top-p sampling</p>
          <USlider v-model="topP" :min="0" :max="1" :step="0.01" tooltip/>
        </div>
      </div>
      <div class="mt-2">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Prompt</label>
        <UTextarea v-model="prompt" class="w-full" placeholder="Describe how to transform the input image(s)..."
                   autoresize/>
      </div>
      <div class="flex items-center gap-2 justify-end">
        <UButton class="w-full" @click="submit()" :disabled="data.inputImages.length === 0 || loading">
          <span v-if="loading">Submitting...</span>
          <span v-else>Submit</span>
        </UButton>
        <span v-if="errorMsg" class="text-red-500 text-sm">{{ errorMsg }}</span>
      </div>

    </div>
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