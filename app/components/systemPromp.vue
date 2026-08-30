<script setup lang="ts">
import { refreshNuxtData } from '#app'
import {
  ImageModelIdSchema,
  StoredGenerationConfigSchema,
  canonicalizeImageModelId,
  createDefaultSettings,
  getImageModelProfile,
  type OutputMetadata,
  type StoredGenerationConfig,
} from '~~/schemas/image-generation'

type SystemPrompt = {
  id: number
  TextPrompt: string
  serverImages?: string[] | null
  modelImages?: string[] | null
  outputImage: string | null
  generationModel?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  priceUsd?: string | null
  priceSource?: string | null
  gatewayGenerationId?: string | null
  createdAt: string
  errors?: string | null
  status?: 'pending' | 'succeeded' | 'failed' | null
  parentSystemPromptId?: number | null
  generationConfig?: StoredGenerationConfig | null
  outputMetadata?: OutputMetadata | null
}

const props = defineProps<{ data: SystemPrompt }>()
const historyData = useNuxtData<{items?: SystemPrompt[]}>('systemPrompts')
const detailData = ref<SystemPrompt | null>(null)
const detailLoading = ref(false)
const detailLoaded = ref(false)
const outputMetadata = computed(() => detailData.value?.outputMetadata ?? props.data?.outputMetadata)

const createdAt = computed(() => {
  const d = props.data?.createdAt ? new Date(props.data.createdAt) : null
  return d ? d.toLocaleString() : ''
})

const generationModelText = computed(() => props.data?.generationModel || '')
const replayConfig = computed<StoredGenerationConfig | null>(() => {
  const stored = StoredGenerationConfigSchema.safeParse(props.data?.generationConfig)
  if (stored.success) return stored.data
  const canonical = canonicalizeImageModelId(props.data?.generationModel)
  const model = ImageModelIdSchema.safeParse(canonical)
  if (!model.success) return null
  const profile = getImageModelProfile(model.data)
  if (!profile) return null
  return {
    schemaVersion: 1,
    profileVersion: profile.profileVersion,
    requestedModel: props.data?.generationModel || model.data,
    effectiveModel: model.data,
    settings: createDefaultSettings(model.data),
    storeInputImages: true,
  }
})
const isLegacyConfig = computed(() => !StoredGenerationConfigSchema.safeParse(props.data?.generationConfig).success)
const replayUnavailableReason = computed(() => {
  const config = replayConfig.value
  if (!config) return 'The original model is no longer in the curated catalog.'
  const storedInputs = Array.isArray(props.data?.serverImages) ? props.data.serverImages : []
  const sharedInputs = Array.isArray(props.data?.modelImages) ? props.data.modelImages : []
  if (!config.storeInputImages
      && storedInputs.length === 0
      && sharedInputs.length === 0
      && !props.data?.parentSystemPromptId) {
    return 'The original source image was not retained, so this edit cannot be replayed exactly.'
  }
  return ''
})
const settingsSummary = computed(() => {
  const settings = replayConfig.value?.settings
  if (!settings) return ''
  if (settings.kind === 'openai-gpt-image-2') {
    return `${settings.size || 'auto size'} · ${settings.quality} · ${settings.outputFormat.toUpperCase()}`
  }
  const size = 'imageSize' in settings ? settings.imageSize : '1K'
  return `${settings.aspectRatio || 'input/default ratio'} · ${size}`
})
const outputDimensions = computed(() => {
  const metadata = outputMetadata.value
  return metadata?.width && metadata?.height ? `${metadata.width}×${metadata.height}` : ''
})
const grounding = computed(() => outputMetadata.value?.grounding)
function singleOutputDerivativeSettings(settings: StoredGenerationConfig['settings']) {
  return settings.kind === 'openai-gpt-image-2'
    ? {...settings, numberOfImages: 1 as const}
    : settings
}
const tokenUsageText = computed(() => {
  const total = props.data?.totalTokens
  const input = props.data?.inputTokens
  const output = props.data?.outputTokens
  if (total == null && input == null && output == null) return ''
  const parts: string[] = []
  if (total != null) parts.push(`${total.toLocaleString()} total`)
  if (input != null) parts.push(`${input.toLocaleString()} in`)
  if (output != null) parts.push(`${output.toLocaleString()} out`)
  return parts.join(' / ')
})
const priceText = computed(() => {
  const price = props.data?.priceUsd ? Number(props.data.priceUsd) : NaN
  if (!Number.isFinite(price)) return ''
  return price < 0.01 ? `$${price.toFixed(6)}` : `$${price.toFixed(4)}`
})
const priceSourceText = computed(() => {
  const source = (props.data as any)?.priceSource
  if (source === 'gateway') return 'Gateway'
  if (source === 'estimate') return 'Estimated'
  return ''
})

const regenLoading = ref(false)
const regenCount = ref<number>(1)
const toast = useToast()
const billingLoading = ref(false)

async function loadOutputDetails() {
  if (detailLoading.value || detailLoaded.value) return
  detailLoading.value = true
  try {
    const response = await $fetch<{ok: true; item: SystemPrompt}>(`/api/systemprompts/${props.data.id}`)
    detailData.value = response.item
    detailLoaded.value = true
  } catch (error: any) {
    toast.add({
      title: 'Could not load output details',
      description: error?.data?.statusMessage || error?.message || 'Try again later.',
      color: 'warning',
    })
  } finally {
    detailLoading.value = false
  }
}

const chatInput = ref('')
const chatLoading = ref(false)
// Current output for this card. Regenerate can advance this value.
const currentImage = ref<string | null>(props.data?.outputImage || null)

watch(
  () => props.data?.outputImage,
  (v) => {
    if (!regenLoading.value) currentImage.value = v || null
  }
)

async function sendRefine() {
  const text = chatInput.value.trim()
  if (!text || chatLoading.value) return
  if (!currentImage.value) {
    toast.add({ title: 'No image to refine', color: 'warning' })
    return
  }
  const sourceImage = currentImage.value
  const config = replayConfig.value
  if (!config) {
    toast.add({ title: 'Original model is unavailable', description: 'This legacy item cannot be refined safely without choosing a replacement explicitly.', color: 'warning' })
    return
  }
  chatInput.value = ''
  chatLoading.value = true
  try {
    const res = await $fetch<{ ok: boolean; obj: SystemPrompt[] }>('/api/image-generate', {
      method: 'POST',
      body: {
        prompt: text,
        inputImages: [sourceImage],
        modelImages: [],
        // Preserve the exact edit source so replay means replay, not another
        // edit of whatever output happens to be displayed later.
        storeInputImages: true,
        model: config.effectiveModel,
        // Refinement is intentionally a single-output derivative. Regenerate
        // below preserves the stored output-count setting exactly.
        settings: singleOutputDerivativeSettings(config.settings),
        parentSystemPromptId: props.data.id,
      },
    })
    const row = res?.obj?.[0]
    if (row?.outputImage && !row.errors) {
      toast.add({ title: 'Refinement created' })
      await refreshNuxtData('systemPrompts')
    } else {
      toast.add({ title: 'Refinement failed', description: row?.errors || 'Unknown error', color: 'warning' })
    }
  } catch (e: any) {
    toast.add({ title: 'Refinement failed', description: e?.data?.statusMessage || e?.message || 'Request failed', color: 'warning' })
  } finally {
    chatLoading.value = false
  }
}

async function refreshBilling() {
  if (billingLoading.value || !props.data?.id) return
  billingLoading.value = true
  try {
    await $fetch(`/api/systemprompts/${props.data.id}/billing-refresh`, { method: 'POST' })
    toast.add({ title: 'Cost refreshed' })
    await refreshNuxtData('systemPrompts')
  } catch (e: any) {
    toast.add({
      title: 'Cost unavailable',
      description: e?.data?.statusMessage || e?.message || 'Gateway billing is not ready yet.',
      color: 'warning'
    })
  } finally {
    billingLoading.value = false
  }
}

function onChatKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendRefine()
  }
}

async function regenerate() {
  if (regenLoading.value) return
  try {
    regenLoading.value = true
    const storedInputImages = Array.isArray(props.data?.serverImages) ? props.data.serverImages : []
    const modelImages = Array.isArray(props.data?.modelImages) ? props.data.modelImages : []
    const config = replayConfig.value
    if (!config || replayUnavailableReason.value) {
      toast.add({
        title: 'Cannot regenerate',
        description: replayUnavailableReason.value || 'The original generation configuration is unavailable.',
        color: 'warning',
      })
      return
    }
    let replayInputs = storedInputImages
    if (replayInputs.length === 0 && props.data.parentSystemPromptId) {
      // Backward-compatible replay for refinements created before exact source
      // images were retained: their parent output was the refinement source.
      let parent = historyData.data.value?.items?.find(item => item.id === props.data.parentSystemPromptId)
      if (!parent?.outputImage) {
        const response = await $fetch<{ok: true; item: SystemPrompt}>(`/api/systemprompts/${props.data.parentSystemPromptId}`)
          .catch(() => undefined)
        parent = response?.item
      }
      if (!parent?.outputImage) {
        toast.add({
          title: 'Cannot reproduce this refinement',
          description: 'Its exact source image is no longer available.',
          color: 'warning',
        })
        return
      }
      replayInputs = [parent.outputImage]
    }
    const replayMask = replayInputs.length > 0 || modelImages.length > 0
        ? config.maskImage
        : undefined

    // Ask the user to edit/confirm the prompt before regenerating
    const currentPrompt = props.data?.TextPrompt || ''
    const editedPrompt = typeof window !== 'undefined' ? window.prompt('Edit prompt before regenerating:', currentPrompt) : currentPrompt
    if (editedPrompt === null) {
      // User cancelled
      return
    }

    const count = Math.max(1, Math.min(50, Number(regenCount.value) || 1))

    // Run the job count times
    for (let i = 0; i < count; i++) {
      const res = await $fetch<{ ok: boolean; obj: SystemPrompt[] }>('/api/image-generate', {
        method: 'POST',
        body: {
          prompt: editedPrompt,
          inputImages: replayInputs,
          modelImages,
          maskImage: replayMask,
          model: config.effectiveModel,
          settings: config.settings,
          storeInputImages: true,
          parentSystemPromptId: props.data.id,
        }
      })
      const row = res?.obj?.[0]
      if (row?.outputImage && !row.errors) {
        currentImage.value = row.outputImage
      } else {
        throw new Error(row?.errors || 'Unknown generation error')
      }
    }

    toast.add({ title: 'Regeneration started', description: `Created ${count} job${count > 1 ? 's' : ''}.` })
  } catch (e: any) {
    console.error(e)
    toast.add({ title: 'Regeneration failed', color: 'warning' })
  } finally {
    await refreshNuxtData('systemPrompts')
    regenLoading.value = false
  }
}
</script>

<template>
  <div
    class="group relative overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/50 shadow-sm hover:shadow-lg transition-all duration-200"
  >
    <div v-if="props.data?.outputImage" class="relative">
      <DownloadableImage
        :src="currentImage || props.data?.outputImage || ''"
        :alt="props.data?.TextPrompt || 'Output image'"
        class="w-full h-auto object-contain bg-gray-50 dark:bg-gray-800"
      />
      <span class="absolute top-2 left-2 px-2 py-0.5 text-[10px] font-medium rounded bg-white/80 dark:bg-gray-900/70 text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-700">
        Output
      </span>
    </div>
    <div v-else class="relative flex items-center gap-2 justify-center p-6 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-b border-red-200 dark:border-red-800">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5">
        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.721-1.36 3.486 0l6.518 11.58c.75 1.333-.213 2.996-1.742 2.996H3.48c-1.53 0-2.492-1.663-1.743-2.996L8.257 3.1zM11 14a1 1 0 10-2 0 1 1 0 002 0zm-1-2a.75.75 0 01-.75-.75v-3.5a.75.75 0 011.5 0v3.5A.75.75 0 0110 12z" clip-rule="evenodd" />
      </svg>
      <span class="text-sm font-medium">No output image</span>
    </div>

    <div class="p-3 flex flex-col gap-3">
      <p class="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-3" :title="props.data?.TextPrompt">
        {{ props.data?.TextPrompt }}
      </p>

      <div
        v-if="generationModelText || tokenUsageText || priceText || settingsSummary || outputDimensions"
        class="grid grid-cols-1 gap-1 text-[11px] text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/70 rounded p-2"
      >
        <div v-if="generationModelText">
          <span class="font-medium text-gray-700 dark:text-gray-300">Model:</span>
          {{ generationModelText }}
        </div>
        <div v-if="settingsSummary">
          <span class="font-medium text-gray-700 dark:text-gray-300">Settings:</span>
          {{ settingsSummary }}
          <span v-if="isLegacyConfig" class="text-amber-600 dark:text-amber-300"> (legacy defaults inferred)</span>
        </div>
        <div v-if="outputDimensions">
          <span class="font-medium text-gray-700 dark:text-gray-300">Output:</span>
          {{ outputDimensions }}
        </div>
        <div v-if="tokenUsageText">
          <span class="font-medium text-gray-700 dark:text-gray-300">Tokens:</span>
          {{ tokenUsageText }}
        </div>
        <div v-if="priceText || props.data?.gatewayGenerationId" class="flex items-center justify-between gap-2">
          <span>
            <span class="font-medium text-gray-700 dark:text-gray-300">Price:</span>
            <span v-if="priceText">
              {{ priceText }}<span v-if="priceSourceText"> ({{ priceSourceText }})</span>
            </span>
            <span v-else>Pending</span>
          </span>
          <UButton
              v-if="props.data?.gatewayGenerationId && priceSourceText !== 'Gateway'"
              size="xs"
              variant="ghost"
              :loading="billingLoading"
              :disabled="billingLoading"
              @click="refreshBilling"
          >
            Refresh cost
          </UButton>
        </div>
      </div>

      <div v-if="props.data?.errors" class="flex items-start gap-2 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded border border-red-200 dark:border-red-800">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4 mt-0.5">
          <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.721-1.36 3.486 0l6.518 11.58c.75 1.333-.213 2.996-1.742 2.996H3.48c-1.53 0-2.492-1.663-1.743-2.996L8.257 3.1zM11 14a1 1 0 10-2 0 1 1 0 002 0zm-1-2a.75.75 0 01-.75-.75v-3.5a.75.75 0 011.5 0v3.5A.75.75 0 0110 12z" clip-rule="evenodd" />
        </svg>
        <span class="whitespace-pre-line">{{ props.data.errors }}</span>
      </div>

      <UButton
        v-if="props.data?.outputImage && !outputMetadata && !detailLoaded"
        size="xs"
        variant="soft"
        color="neutral"
        :loading="detailLoading"
        @click="loadOutputDetails"
      >
        Load output details
      </UButton>

      <div
        v-if="outputMetadata?.responseText"
        class="rounded border border-gray-200 bg-gray-50 p-2 text-xs whitespace-pre-wrap text-gray-700 dark:border-gray-800 dark:bg-gray-800/60 dark:text-gray-200"
      >
        {{ outputMetadata.responseText }}
      </div>

      <details v-if="outputMetadata?.reasoningText" class="text-xs text-gray-600 dark:text-gray-300">
        <summary class="cursor-pointer">Thought summary</summary>
        <div class="mt-1 whitespace-pre-wrap rounded bg-gray-50 p-2 dark:bg-gray-800/60">{{ outputMetadata.reasoningText }}</div>
      </details>

      <details v-if="outputMetadata?.warnings?.length" class="text-xs text-amber-700 dark:text-amber-300">
        <summary class="cursor-pointer">Provider warnings ({{ outputMetadata.warnings.length }})</summary>
        <ul class="mt-1 list-disc space-y-1 pl-5">
          <li v-for="warning in outputMetadata.warnings" :key="warning">{{ warning }}</li>
        </ul>
      </details>

      <div v-if="grounding" class="rounded border border-blue-200 bg-blue-50 p-2 text-xs dark:border-blue-900 dark:bg-blue-950/30">
        <div class="font-medium text-blue-900 dark:text-blue-100">Google Search grounding</div>
        <div v-if="grounding.sources.length" class="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          <a
            v-for="source in grounding.sources"
            :key="source.url"
            :href="source.url"
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-700 underline dark:text-blue-300"
          >{{ source.title || source.url }}</a>
        </div>
        <iframe
          v-if="grounding.searchEntryPointHtml"
          :srcdoc="grounding.searchEntryPointHtml"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          title="Google Search suggestions"
          class="mt-2 h-16 w-full rounded border-0 bg-white"
        />
      </div>

      <div v-if="props.data?.serverImages?.length" class="mt-1">
        <div class="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Input image(s)</div>
        <div class="grid grid-cols-5 gap-1">
          <DownloadableImage
            v-for="s in props.data.serverImages"
            :key="s"
            :src="s"
            :alt="'Input ' + s"
            class="h-16 w-full object-cover rounded bg-gray-50 dark:bg-gray-800"
          />
        </div>
      </div>

      <div v-if="props.data?.modelImages?.length" class="mt-1">
        <div class="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Model image(s)</div>
        <div class="grid grid-cols-5 gap-1">
          <DownloadableImage
            v-for="m in props.data.modelImages"
            :key="m"
            :src="m"
            :alt="'Model ' + m"
            class="h-16 w-full object-cover rounded bg-gray-50 dark:bg-gray-800"
          />
        </div>
      </div>

      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <UButton size="xs" :loading="regenLoading" :disabled="regenLoading || !!replayUnavailableReason" @click="regenerate">
            Regenerate
          </UButton>
          <div class="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
            <span>×</span>
            <UInput v-model.number="regenCount" type="number" size="xs" class="w-14" min="1" :disabled="regenLoading" />
            <span>times</span>
          </div>
          <p v-if="replayUnavailableReason" class="text-xs text-amber-700 dark:text-amber-300">
            {{ replayUnavailableReason }}
          </p>
        </div>
        <span class="text-[11px] text-gray-500 dark:text-gray-400">{{ createdAt }}</span>
      </div>

      <!-- Standalone refinement -->
      <div v-if="props.data?.outputImage" class="mt-2 border-t border-gray-200 dark:border-gray-800 pt-2">
        <div class="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Refine</div>
        <div class="flex items-end gap-2">
          <UTextarea
            v-model="chatInput"
            placeholder="Describe a refinement"
            class="flex-1"
            :rows="1"
            autoresize
            :disabled="chatLoading"
            @keydown="onChatKeydown"
          />
          <UButton
            size="xs"
            :loading="chatLoading"
            :disabled="chatLoading || !chatInput.trim() || !currentImage"
            @click="sendRefine"
          >
            Send
          </UButton>
        </div>
      </div>
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
