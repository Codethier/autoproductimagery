<script setup lang="ts">
import {computed} from 'vue'
import type {ImageGenerationSettings} from '../../schemas/image-generation'
import {getImageModelGuidance} from '../../schemas/image-model-guidance'

const props = withDefaults(defineProps<{
  modelId: string
  settings?: ImageGenerationSettings
  compact?: boolean
  context?: 'generation' | 'people' | 'pipeline'
}>(), {compact: false, context: 'generation'})
const guidance = computed(() => getImageModelGuidance(props.modelId, props.settings))
</script>

<template>
  <section v-if="guidance" class="model-guidance" :class="{'model-guidance--compact': compact}" :aria-label="`${guidance.modelName} guide`">
    <p class="model-guidance-purpose">{{ guidance.purpose }}</p>
    <div v-if="guidance.mask && context !== 'people'" class="model-guidance-mask">
      <strong>{{ guidance.mask.title }}</strong>
      <p>{{ guidance.mask.meaning }}</p>
    </div>
    <details :key="modelId" class="model-guidance-details">
      <summary>How to use this model <span aria-hidden="true">+</span></summary>
      <div class="model-guidance-body">
        <div><strong>Sources and references</strong><p>{{ guidance.references }}</p></div>
        <div v-if="guidance.mask && context !== 'people'"><strong>Preparing a mask</strong><p>{{ guidance.mask.preparation }}</p><p>{{ guidance.mask.example }}</p><p v-if="context === 'pipeline'">Connect the source to the image input and the prepared mask to Mask, or choose the mask in this step’s settings.</p></div>
        <div v-else-if="guidance.mask && context === 'people'"><strong>Editing with a mask</strong><p>Masks guide a selected region of an existing picture. The People generator uses identity references without a separate mask. Use Edit or a pipeline when you need a masked edit.</p></div>
        <div><strong>Transparent backgrounds</strong><p>{{ guidance.transparency }}</p></div>
        <div v-if="guidance.settings"><strong>Choosing settings</strong><p>{{ guidance.settings }}</p></div>
        <div><strong>Outputs and price</strong><p>{{ context === 'people' ? 'Variations creates separate jobs; the model’s image count adds outputs to each job. The People factory accepts at most 4 pictures per request. Final prices appear after they are confirmed.' : guidance.output }}</p></div>
        <div v-if="context !== 'people'"><strong>Example prompt</strong><p class="model-guidance-example">{{ guidance.promptExample }}</p></div>
      </div>
    </details>
  </section>
</template>

<style scoped>
.model-guidance{margin:12px 0;color:var(--workspace-muted,#8f9299);font-size:11px;line-height:1.7}.model-guidance-purpose{margin:0 0 10px}.model-guidance-mask{padding:11px 12px;border:1px solid var(--workspace-border,#323335);border-radius:9px;background:var(--workspace-surface-raised,#242527)}.model-guidance strong{display:block;color:var(--workspace-text,#f3f1ed);font-size:11px;font-weight:550}.model-guidance p{margin:5px 0 0}.model-guidance-details{margin-top:9px}.model-guidance-details summary{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;cursor:pointer;color:var(--workspace-text,#f3f1ed);font-size:11px}.model-guidance-details summary span{font-size:16px;color:var(--workspace-accent,#e5ad79)}.model-guidance-details[open] summary span{transform:rotate(45deg)}.model-guidance-body{display:grid;gap:13px;padding:9px 0 3px}.model-guidance-example{padding:9px 11px;border-left:2px solid var(--workspace-accent,#e5ad79);background:var(--workspace-surface-raised,#242527);border-radius:0 6px 6px 0}.model-guidance--compact{font-size:10px}.model-guidance--compact .model-guidance-mask{padding:9px 10px}.model-guidance--compact strong,.model-guidance--compact summary{font-size:10px}
</style>
