<script setup lang="ts">
import { refreshNuxtData } from '#app'
import {hasConfirmedGenerationPrice} from '~~/schemas/generation-billing'
import {formatUsd} from '../utils/generationPrice'
import {replaySaveFormat} from '../utils/imageSaveFormat'
import {
  ImageModelIdSchema,
  isOpenAiImageSettings,
  isGeminiImageSettings,
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
  outputImageDeletedAt?: string | null
  generationModel?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  priceUsd?: string | null
  priceSource?: string | null
  billingState?: string | null
  gatewayGenerationId?: string | null
  createdAt: string
  errors?: string | null
  status?: 'pending' | 'succeeded' | 'failed' | null
  parentSystemPromptId?: number | null
  generationConfig?: StoredGenerationConfig | null
  outputMetadata?: OutputMetadata | null
}

const props = defineProps<{ data: SystemPrompt }>()
const { t, locale } = useI18n()
const account = useAccount()
const generationCredit = useGenerationCredit()
// A history card belongs to the account that created this component. Do not
// rebind old replay data to a new session when the browser changes accounts.
const cardAccount = {identity: account.identity.value, epoch: account.epoch.value}
const cardIsCurrent = computed(() => !!cardAccount.identity
  && cardAccount.identity === account.identity.value && cardAccount.epoch === account.epoch.value)
const historyKey = `systemPrompts:${cardAccount.identity}:${cardAccount.epoch}`
const historyData = useNuxtData<{items?: SystemPrompt[]}>(historyKey)
const detailData = ref<SystemPrompt | null>(null)
const detailLoading = ref(false)
const detailLoaded = ref(false)
const outputMetadata = computed(() => detailData.value?.outputMetadata ?? props.data?.outputMetadata)

const createdAt = computed(() => {
  const d = props.data?.createdAt ? new Date(props.data.createdAt) : null
  return d ? d.toLocaleString(locale.value) : ''
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
  if (!config) return t('generation.card.replayModelMissing')
  const storedInputs = Array.isArray(props.data?.serverImages) ? props.data.serverImages : []
  const sharedInputs = Array.isArray(props.data?.modelImages) ? props.data.modelImages : []
  if (!config.storeInputImages
      && storedInputs.length === 0
      && sharedInputs.length === 0
      && !props.data?.parentSystemPromptId) {
    return t('generation.card.replaySourceMissing')
  }
  return ''
})
const settingsSummary = computed(() => {
  const settings = replayConfig.value?.settings
  if (!settings) return ''
  if (isOpenAiImageSettings(settings)) {
    return `${settings.size || t('generation.card.autoSize')} · ${settings.quality} · ${settings.outputFormat.toUpperCase()}`
  }
  if (!isGeminiImageSettings(settings)) {
    return [('size' in settings ? settings.size : undefined) || ('aspectRatio' in settings ? settings.aspectRatio : undefined),
      'resolution' in settings ? settings.resolution : undefined,
      'outputFormat' in settings ? settings.outputFormat.toUpperCase() : undefined].filter(Boolean).join(' · ') || t('generation.card.modelDefaults')
  }
  const size = 'imageSize' in settings ? settings.imageSize : '1K'
  return `${settings.aspectRatio || t('generation.card.inputRatio')} · ${size}`
})
const outputDimensions = computed(() => {
  const metadata = outputMetadata.value
  return metadata?.width && metadata?.height ? `${metadata.width}×${metadata.height}` : ''
})
const grounding = computed(() => outputMetadata.value?.grounding)
function singleOutputDerivativeSettings(settings: StoredGenerationConfig['settings']) {
  return 'numberOfImages' in settings
    ? {...settings, numberOfImages: 1 as const}
    : settings
}
const tokenUsageText = computed(() => {
  const total = props.data?.totalTokens
  const input = props.data?.inputTokens
  const output = props.data?.outputTokens
  if (total == null && input == null && output == null) return ''
  const parts: string[] = []
  if (total != null) parts.push(t('generation.card.tokensTotal', { count: total.toLocaleString(locale.value) }))
  if (input != null) parts.push(t('generation.card.tokensIn', { count: input.toLocaleString(locale.value) }))
  if (output != null) parts.push(t('generation.card.tokensOut', { count: output.toLocaleString(locale.value) }))
  return parts.join(' / ')
})
const priceText = computed(() => {
  return formatUsd(currentResult.value?.priceUsd)
})
const regenLoading = ref(false)
const regenCount = ref<number>(1)
const toast = useToast()

async function loadOutputDetails() {
  if (!cardIsCurrent.value || detailLoading.value || detailLoaded.value) return
  detailLoading.value = true
  try {
    const response = await $fetch<{ok: true; item: SystemPrompt}>(`/api/systemprompts/${props.data.id}`)
    if (!cardIsCurrent.value) return
    detailData.value = response.item
    detailLoaded.value = true
  } catch (error: any) {
    if (!cardIsCurrent.value) return
    toast.add({
      title: t('generation.card.toast.detailsFailed'),
      description: error?.data?.statusMessage || error?.message || t('generation.card.toast.tryLater'),
      color: 'warning',
    })
  } finally {
    if (cardIsCurrent.value) detailLoading.value = false
  }
}

const chatInput = ref('')
const chatLoading = ref(false)
// Current output for this card. Regenerate can advance this value.
const currentResult = ref<SystemPrompt>(props.data)
const priceConfirmed = computed(() => hasConfirmedGenerationPrice(currentResult.value))
const currentImage = computed(() => cardIsCurrent.value && priceConfirmed.value && !currentResult.value.outputImageDeletedAt
  ? currentResult.value.outputImage || null : null)
const outputImageExpired = computed(() => !!currentResult.value.outputImageDeletedAt && !currentImage.value)
const outputImageDeletedAt = computed(() => props.data?.outputImageDeletedAt
  ? new Date(props.data.outputImageDeletedAt).toLocaleString(locale.value)
  : '')

watch(cardIsCurrent, current => {
  if (current) return
  currentResult.value = {...currentResult.value, outputImage: null}
  detailData.value = null
  chatInput.value = ''
}, {flush: 'sync'})

watch(
  () => props.data,
  (row) => {
    if (cardIsCurrent.value && !regenLoading.value) currentResult.value = row
  }
  , {deep: true}
)

async function sendRefine() {
  const text = chatInput.value.trim()
  if (!cardIsCurrent.value || !text || chatLoading.value || generationCredit.checking.value) return
  if (!currentImage.value) {
    toast.add({
      title: t('generation.card.toast.noImage'),
      description: outputImageExpired.value ? t('generation.card.toast.noImageExpired') : undefined,
      color: 'warning',
    })
    return
  }
  const sourceImage = currentImage.value
  const config = replayConfig.value
  if (!config) {
    toast.add({ title: t('generation.card.toast.modelUnavailable'), description: t('generation.card.toast.modelUnavailableBody'), color: 'warning' })
    return
  }
  chatLoading.value = true
  try {
    if (!await generationCredit.ensureCredit() || !cardIsCurrent.value) {
      if (cardIsCurrent.value && !generationCredit.open.value && generationCredit.blockedReason.value) toast.add({title: t('generation.card.toast.generationUnavailable'), description: generationCredit.blockedReason.value, color: 'warning'})
      return
    }
    chatInput.value = ''
    const res = await $fetch<{ ok: boolean; obj: SystemPrompt[] }>('/api/image-generate', {
      method: 'POST',
      timeout: 360_000,
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
        saveFormat: replaySaveFormat(config.saveFormat),
        parentSystemPromptId: props.data.id,
      },
    })
    if (!cardIsCurrent.value) return
    const row = res?.obj?.[0]
    if (row && !row.errors && (row.status === 'succeeded' || row.outputImage)) {
      toast.add({ title: hasConfirmedGenerationPrice(row) ? t('generation.card.toast.refinementCreated') : t('generation.card.toast.refinementCreatedPending') })
      await refreshNuxtData(historyKey)
    } else {
      toast.add({ title: t('generation.card.toast.refinementFailed'), description: row?.errors || t('generation.card.toast.unknownError'), color: 'warning' })
    }
  } catch (e: any) {
    if (!cardIsCurrent.value) return
    if (await generationCredit.handleError(e)) { if (cardIsCurrent.value && !chatInput.value) chatInput.value = text; return }
    if (cardIsCurrent.value) toast.add({ title: t('generation.card.toast.refinementFailed'), description: e?.data?.statusMessage || e?.message || t('generation.card.toast.requestFailed'), color: 'warning' })
  } finally {
    if (cardIsCurrent.value) chatLoading.value = false
  }
}

function onChatKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendRefine()
  }
}

async function regenerate() {
  if (!cardIsCurrent.value || regenLoading.value || generationCredit.checking.value) return
  try {
    regenLoading.value = true
    const storedInputImages = Array.isArray(props.data?.serverImages) ? props.data.serverImages : []
    const modelImages = Array.isArray(props.data?.modelImages) ? props.data.modelImages : []
    const config = replayConfig.value
    if (!config || replayUnavailableReason.value) {
      toast.add({
        title: t('generation.card.toast.cannotRegenerate'),
        description: replayUnavailableReason.value || t('generation.card.toast.configUnavailable'),
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
        if (!cardIsCurrent.value) return
        parent = response?.item
      }
      if (!parent?.outputImage || parent.outputImageDeletedAt || !hasConfirmedGenerationPrice(parent)) {
        toast.add({
          title: t('generation.card.toast.cannotReproduce'),
          description: parent?.outputImageDeletedAt
            ? t('generation.card.toast.sourceExpired')
            : t('generation.card.toast.sourceGone'),
          color: 'warning',
        })
        return
      }
      replayInputs = [parent.outputImage]
    }
    const replayMask = replayInputs.length > 0 || modelImages.length > 0
        ? config.maskImage
        : undefined

    if (!await generationCredit.ensureCredit() || !cardIsCurrent.value) {
      if (cardIsCurrent.value && !generationCredit.open.value && generationCredit.blockedReason.value) toast.add({title: t('generation.card.toast.generationUnavailable'), description: generationCredit.blockedReason.value, color: 'warning'})
      return
    }

    // Ask the user to edit/confirm the prompt before regenerating
    const currentPrompt = props.data?.TextPrompt || ''
    const editedPrompt = typeof window !== 'undefined' ? window.prompt(t('generation.card.editPrompt'), currentPrompt) : currentPrompt
    if (!cardIsCurrent.value || editedPrompt === null) {
      // User cancelled
      return
    }

    const count = Math.max(1, Math.min(50, Number(regenCount.value) || 1))

    // Run the job count times
    for (let i = 0; i < count; i++) {
      if (!cardIsCurrent.value) return
      if (!await generationCredit.ensureCredit() || !cardIsCurrent.value) {
        if (cardIsCurrent.value && !generationCredit.open.value && generationCredit.blockedReason.value) toast.add({title: t('generation.card.toast.generationUnavailable'), description: generationCredit.blockedReason.value, color: 'warning'})
        return
      }
      const res = await $fetch<{ ok: boolean; obj: SystemPrompt[] }>('/api/image-generate', {
        method: 'POST',
        timeout: 360_000,
        body: {
          prompt: editedPrompt,
          inputImages: replayInputs,
          modelImages,
          maskImage: replayMask,
          model: config.effectiveModel,
          settings: config.settings,
          storeInputImages: true,
          saveFormat: replaySaveFormat(config.saveFormat),
          parentSystemPromptId: props.data.id,
        }
      })
      if (!cardIsCurrent.value) return
      const row = res?.obj?.[0]
      if (row && !row.errors && (row.status === 'succeeded' || row.outputImage)) {
        // Keep the existing priced output while the new generation's final
        // charge is pending. History adds the new card when it is confirmed.
        if (hasConfirmedGenerationPrice(row)) currentResult.value = row
      } else {
        throw new Error(row?.errors || t('generation.card.toast.unknownGenerationError'))
      }
    }

    toast.add({ title: t('generation.card.toast.regenerationStarted'), description: t(count > 1 ? 'generation.card.toast.regenerationCreatedOther' : 'generation.card.toast.regenerationCreatedOne', { count }) })
  } catch (e: any) {
    if (!cardIsCurrent.value) return
    if (await generationCredit.handleError(e)) return
    if (!cardIsCurrent.value) return
    toast.add({
      title: t('generation.card.toast.regenerationFailed'),
      description: e?.data?.statusMessage || e?.statusMessage || e?.message || t('generation.card.toast.requestFailed'),
      color: 'warning',
    })
  } finally {
    if (cardIsCurrent.value) {
      await refreshNuxtData(historyKey)
      if (cardIsCurrent.value) regenLoading.value = false
    }
  }
}
</script>

<template>
  <article v-if="cardIsCurrent && priceConfirmed" class="generation-result-card">
    <div v-if="currentImage" class="generation-preview">
      <DownloadableImage
        :src="currentImage"
        :preview-size="480"
        :alt="props.data?.TextPrompt || t('generation.card.outputAlt')"
        class="generation-preview-image"
      />
      <span class="generation-output-badge">{{ t('generation.card.outputBadge') }}</span>
    </div>
    <div v-else-if="outputImageExpired" role="status" class="generation-empty-preview">
      <UIcon name="i-lucide-image-off" class="size-7" aria-hidden="true" />
      <span>{{ t('generation.card.expired') }}</span>
      <p>{{ t('generation.card.expiredDeleted', { date: outputImageDeletedAt }) }}</p>
      <p>{{ t('generation.card.expiredRetained') }}</p>
    </div>
    <div v-else role="status" class="generation-empty-preview generation-empty-error">
      <UIcon name="i-lucide-image-off" class="size-7" aria-hidden="true" />
      <span>{{ t('generation.card.noOutput') }}</span>
    </div>

    <div class="generation-card-content">
      <p class="generation-prompt" :title="props.data?.TextPrompt">{{ props.data?.TextPrompt }}</p>

      <div class="generation-facts">
        <div class="generation-final-price" data-generation-price>
          <span>{{ t('generation.card.finalPrice') }}</span>
          <strong>{{ priceText }}</strong>
        </div>
        <dl class="generation-metadata">
          <div v-if="generationModelText">
            <dt>{{ t('generation.card.model') }}</dt>
            <dd>{{ generationModelText }}</dd>
          </div>
          <div v-if="settingsSummary">
            <dt>{{ t('generation.card.settings') }}</dt>
            <dd>
              {{ settingsSummary }}
              <span v-if="isLegacyConfig" class="generation-warning-note">{{ t('generation.card.legacyDefaults') }}</span>
            </dd>
          </div>
          <div v-if="outputDimensions">
            <dt>{{ t('generation.card.output') }}</dt>
            <dd>{{ outputDimensions }}</dd>
          </div>
          <div v-if="tokenUsageText">
            <dt>{{ t('generation.card.tokens') }}</dt>
            <dd>{{ tokenUsageText }}</dd>
          </div>
        </dl>
      </div>

      <div v-if="props.data?.errors" class="generation-note generation-note-error" role="alert">
        <UIcon name="i-lucide-triangle-alert" class="size-4" aria-hidden="true" />
        <span>{{ props.data.errors }}</span>
      </div>

      <UButton
        v-if="props.data?.outputImage && !outputMetadata && !detailLoaded"
        size="xs"
        variant="soft"
        color="neutral"
        class="generation-details-button"
        :loading="detailLoading"
        @click="loadOutputDetails"
      >
        {{ t('generation.card.loadDetails') }}
        <UIcon name="i-lucide-chevron-down" class="size-3.5" aria-hidden="true" />
      </UButton>

      <div v-if="outputMetadata?.responseText" class="generation-output-text">
        {{ outputMetadata.responseText }}
      </div>

      <details v-if="outputMetadata?.reasoningText" class="generation-details">
        <summary>{{ t('generation.card.thoughtSummary') }}</summary>
        <div class="generation-output-text">{{ outputMetadata.reasoningText }}</div>
      </details>

      <details v-if="outputMetadata?.warnings?.length" class="generation-details generation-provider-warnings">
        <summary>{{ t('generation.card.providerWarnings', { count: outputMetadata.warnings.length }) }}</summary>
        <ul>
          <li v-for="warning in outputMetadata.warnings" :key="warning">{{ warning }}</li>
        </ul>
      </details>

      <div v-if="grounding" class="generation-grounding">
        <div class="generation-section-label">{{ t('generation.card.grounding') }}</div>
        <div v-if="grounding.sources.length" class="generation-grounding-sources">
          <a
            v-for="source in grounding.sources"
            :key="source.url"
            :href="source.url"
            target="_blank"
            rel="noopener noreferrer"
          >{{ source.title || source.url }}</a>
        </div>
        <iframe
          v-if="grounding.searchEntryPointHtml"
          :srcdoc="grounding.searchEntryPointHtml"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          :title="t('generation.card.groundingFrame')"
          class="generation-grounding-frame"
        />
      </div>

      <div v-if="props.data?.serverImages?.length" class="generation-sources">
        <div class="generation-section-label">{{ t('generation.card.inputImages') }}</div>
        <div class="generation-source-grid">
          <DownloadableImage
            v-for="(source, index) in props.data.serverImages"
            :key="source"
            :src="source"
            :preview-size="160"
            :alt="t('generation.card.inputImageAlt', { index: index + 1 })"
            class="generation-source-image"
          />
        </div>
      </div>

      <div v-if="props.data?.modelImages?.length" class="generation-sources">
        <div class="generation-section-label">{{ t('generation.card.referenceImages') }}</div>
        <div class="generation-source-grid">
          <DownloadableImage
            v-for="(source, index) in props.data.modelImages"
            :key="source"
            :src="source"
            :preview-size="160"
            :alt="t('generation.card.referenceImageAlt', { index: index + 1 })"
            class="generation-source-image"
          />
        </div>
      </div>

      <div class="generation-replay">
        <div class="generation-replay-controls">
          <UButton
            size="xs"
            class="generation-regenerate-button"
            :loading="regenLoading"
            :disabled="regenLoading || !!replayUnavailableReason"
            @click="regenerate"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-3.5" aria-hidden="true" />
            {{ t('generation.card.regenerate') }}
          </UButton>
          <label class="generation-replay-count">
            <span>×</span>
            <UInput
              v-model.number="regenCount"
              type="number"
              size="xs"
              class="generation-count-input"
              :aria-label="t('generation.card.regenerationCount')"
              min="1"
              max="50"
              :disabled="regenLoading"
            />
          </label>
        </div>
        <p v-if="replayUnavailableReason" class="generation-warning-note">{{ replayUnavailableReason }}</p>
      </div>

      <div v-if="currentImage" class="generation-refinement">
        <label :for="`generation-refine-${props.data.id}`" class="generation-section-label">{{ t('generation.card.refineLabel') }}</label>
        <div class="generation-refinement-controls">
          <UTextarea
            :id="`generation-refine-${props.data.id}`"
            v-model="chatInput"
            :placeholder="t('generation.card.refinePlaceholder')"
            class="generation-refinement-input"
            :rows="2"
            autoresize
            :disabled="chatLoading"
            @keydown="onChatKeydown"
          />
          <UButton
            size="xs"
            class="generation-refine-button"
            :loading="chatLoading"
            :disabled="chatLoading || !chatInput.trim() || !currentImage"
            @click="sendRefine"
          >
            <UIcon name="i-lucide-arrow-up" class="size-4" aria-hidden="true" />
            <span>{{ t('generation.card.send') }}</span>
          </UButton>
        </div>
      </div>

      <time class="generation-created-at" :datetime="props.data.createdAt">{{ createdAt }}</time>
    </div>
  </article>
</template>

<style scoped>
.generation-result-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--workspace-border);
  border-radius: 16px;
  background: var(--workspace-surface);
  color: var(--workspace-text);
}
.generation-preview {
  position: relative;
  display: block;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  border-bottom: 1px solid var(--workspace-border);
  background: var(--workspace-bg);
}
.generation-preview-image,
.generation-preview :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.generation-preview-image {
  position: absolute;
  inset: 0;
  min-height: 0;
}
.generation-output-badge {
  position: absolute;
  top: 12px;
  left: 12px;
  padding: 4px 8px;
  border: 1px solid #f2eee626;
  border-radius: 6px;
  background: #211f1bd9;
  color: var(--workspace-text);
  font-size: 10px;
  font-weight: 600;
  pointer-events: none;
}
.generation-empty-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 210px;
  padding: 24px 20px;
  border-bottom: 1px solid var(--workspace-border);
  background: var(--workspace-bg);
  text-align: center;
  color: var(--workspace-muted);
}
.generation-empty-preview > span {font-size: 13px; font-weight: 600; color: var(--workspace-text);}
.generation-empty-preview > p {margin: 0; font-size: 11px; line-height: 1.65;}
.generation-empty-error > .iconify {color: #e9b29a;}
.generation-card-content {display: flex; flex: 1; flex-direction: column; gap: 16px; padding: 18px; min-width: 0;}
.generation-prompt {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  margin: 0;
  color: var(--workspace-text);
  font-size: 13px;
  font-weight: 550;
  line-height: 1.6;
}
.generation-facts {overflow: hidden; border: 1px solid var(--workspace-border); border-radius: 10px; background: var(--workspace-bg);}
.generation-final-price {display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 10px; padding: 12px; border-bottom: 1px solid var(--workspace-border);}
.generation-final-price > span {font-size: 11px; color: var(--workspace-muted);}
.generation-final-price > strong {font-size: 15px; font-weight: 600; letter-spacing: -.2px; font-variant-numeric: tabular-nums; color: var(--workspace-accent); overflow-wrap: anywhere;}
.generation-metadata {display: grid; gap: 8px; padding: 12px; font-size: 10px; line-height: 1.65;}
.generation-metadata > div {display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 8px;}
.generation-metadata dt {color: var(--workspace-muted);}
.generation-metadata dd {margin: 0; color: #ddd6ca; overflow-wrap: anywhere;}
.generation-warning-note {display: block; margin-top: 4px; color: #e3c19a; font-size: 10px; line-height: 1.6;}
.generation-note {display: flex; align-items: start; gap: 8px; padding: 11px 12px; border: 1px solid var(--workspace-border); border-radius: 9px; font-size: 11px; line-height: 1.7;}
.generation-note > .iconify {flex: 0 0 auto; margin-top: 2px;}
.generation-note > span {white-space: pre-line; overflow-wrap: anywhere;}
.generation-note-error {background: #382a24; border-color: #614639; color: #f1b8a2;}
.generation-details-button {justify-content: space-between; width: 100%; padding: 9px 11px; border: 1px solid var(--workspace-border); border-radius: 8px; background: var(--workspace-surface-raised); color: var(--workspace-text); font-size: 11px; font-weight: 500;}
.generation-details-button:hover:not(:disabled) {background: #39352e;}
.generation-output-text {border: 1px solid var(--workspace-border); border-radius: 9px; background: var(--workspace-bg); padding: 11px 12px; color: #ddd6ca; font-size: 11px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere;}
.generation-details {color: var(--workspace-muted); font-size: 11px; line-height: 1.7;}
.generation-details summary {cursor: pointer; color: var(--workspace-text);}
.generation-details[open] summary {margin-bottom: 10px;}
.generation-provider-warnings {color: #e3c19a;}
.generation-provider-warnings ul {padding-left: 18px; list-style: disc;}
.generation-provider-warnings li + li {margin-top: 5px;}
.generation-grounding {padding: 12px; border: 1px solid var(--workspace-border); border-radius: 9px; background: var(--workspace-bg);}
.generation-grounding-sources {display: flex; flex-wrap: wrap; gap: 7px 12px; margin-top: 10px; font-size: 11px; line-height: 1.65;}
.generation-grounding-sources a {color: var(--workspace-accent); text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere;}
.generation-grounding-frame {width: 100%; height: 64px; margin-top: 10px; border: 0; border-radius: 6px; background: #fff;}
.generation-section-label {display: block; color: var(--workspace-muted); font-size: 10px; font-weight: 500;}
.generation-source-grid {display: flex; flex-wrap: wrap; gap: 7px; margin-top: 8px;}
.generation-source-image {display: block; width: 52px; height: 62px; overflow: hidden; border: 1px solid var(--workspace-border); border-radius: 7px; background: var(--workspace-bg);}
.generation-source-grid :deep(img) {width: 100%; height: 100%; object-fit: cover;}
.generation-replay {display: grid; gap: 5px;}
.generation-replay-controls {display: flex; align-items: center; flex-wrap: wrap; gap: 10px;}
.generation-regenerate-button, .generation-refine-button {justify-content: center; gap: 7px; min-height: 34px; padding: 8px 11px; border: 1px solid transparent; border-radius: 8px; background: var(--workspace-accent); color: #241c15; font-size: 11px; font-weight: 600;}
.generation-regenerate-button:hover:not(:disabled), .generation-refine-button:hover:not(:disabled) {background: #edaf84;}
.generation-replay-count {display: flex; align-items: center; gap: 7px; color: var(--workspace-muted); font-size: 11px;}
.generation-count-input {width: 58px;}
.generation-count-input :deep(input) {min-height: 34px; border-radius: 8px; background: var(--workspace-bg); color: var(--workspace-text); font-size: 11px; font-variant-numeric: tabular-nums;}
.generation-refinement {padding-top: 15px; border-top: 1px solid var(--workspace-border);}
.generation-refinement-controls {display: flex; align-items: end; gap: 8px; margin-top: 8px;}
.generation-refinement-input {flex: 1; min-width: 0;}
.generation-refinement-input :deep(textarea) {min-height: 62px; padding: 10px 11px; border-radius: 9px; background: var(--workspace-bg); color: var(--workspace-text); font-size: 11px; line-height: 1.6;}
.generation-refinement-input :deep(textarea::placeholder) {color: var(--workspace-muted);}
.generation-refine-button {flex: 0 0 auto; min-height: 34px; padding: 8px 10px;}
.generation-created-at {margin-top: auto; padding-top: 3px; color: var(--workspace-muted); font-size: 10px; line-height: 1.6; overflow-wrap: anywhere;}
@media (max-width: 480px) {
  .generation-card-content {padding: 16px;}
  .generation-final-price > strong {font-size: 16px;}
}
</style>
