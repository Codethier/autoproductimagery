<script setup lang="ts">
import { ImagePathSchema } from "../../schemas/image-generation";
import { hasConfirmedGenerationPrice } from "../../schemas/generation-billing";
import type {
  PipelineImageValue,
  PipelineRunDTO,
  PipelineRunStepDTO,
} from "../../schemas/pipelines";
import { imageDownloadUrl, imagePreviewUrl } from "../utils/imageDelivery";
import { formatUsd } from "../utils/generationPrice";
import { pipelineNodeIcon } from "../utils/pipelineTemplates";
const props = defineProps<{
  run: PipelineRunDTO;
  busy?: boolean;
  error?: string;
  paused?: boolean;
}>();
const emit = defineEmits<{
  resume: [];
  cancel: [];
  retry: [stepIds: string[]];
  close: [];
  refresh: [];
}>();
const expandedItems = ref(new Set<string>());
const retryIds = ref<string[]>([]);
const retryOpen = ref(false);
const chargeConfirmed = ref(false);
const active = computed(() =>
  ["queued", "running", "awaiting-price"].includes(props.run.status),
);
const finalImages = computed(() => {
  const nodeIds = new Set(
    props.run.targetNodeId
      ? [props.run.targetNodeId]
      : props.run.definition.nodes
          .filter((node) => node.type === "output")
          .map((node) => node.id),
  );
  return [
    ...new Map(
      props.run.items
        .flatMap((item) =>
          item.steps
            .filter((step) => nodeIds.has(step.nodeId))
            .flatMap((step) => step.value?.images.filter(visibleImage) ?? []),
        )
        .map((image) => [image.url, image]),
    ).values(),
  ];
});
const zipAvailable = computed(
  () =>
    finalImages.value.length > 0 &&
    finalImages.value.length <= 200 &&
    finalImages.value.reduce((sum, image) => sum + (image.bytes ?? 0), 0) <=
      256 * 1024 * 1024,
);
const steps = computed(() =>
  props.run.definition.nodes.filter((node) =>
    props.run.items.some((item) =>
      item.steps.some((step) => step.nodeId === node.id),
    ),
  ),
);
const retryable = computed(() =>
  props.run.items.flatMap((item) =>
    item.steps
      .filter(
        (step) =>
          ["failed", "interrupted"].includes(step.status) &&
          step.error?.retryable,
      )
      .map((step) => ({ ...step, itemIndex: item.index })),
  ),
);
const stateLabels: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  "awaiting-price": "Awaiting exact price",
  succeeded: "Complete",
  partial: "Partly complete",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  skipped: "Skipped",
};
function visibleImage(image: PipelineImageValue) {
  return (
    ImagePathSchema.safeParse(image.url).success &&
    (image.generationId === undefined || hasConfirmedGenerationPrice(image))
  );
}
function imagePrice(image: PipelineImageValue) {
  if (image.priceSource === "local-processing")
    return "$0.00 · local processing";
  return hasConfirmedGenerationPrice(image)
    ? `${formatUsd(image.priceUsd)} · confirmed`
    : "";
}
function stepFor(item: PipelineRunDTO["items"][number], id: string) {
  return item.steps.find((step) => step.nodeId === id);
}
function status(step?: PipelineRunStepDTO) {
  return step ? (stateLabels[step.status] ?? step.status) : "Not in this run";
}
function toggleItem(id: string) {
  const next = new Set(expandedItems.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedItems.value = next;
}
function openRetry() {
  retryIds.value = retryable.value.map((step) => step.id);
  chargeConfirmed.value = false;
  retryOpen.value = true;
}
function retry() {
  if (!retryIds.value.length || !chargeConfirmed.value || props.busy) return;
  emit("retry", [...retryIds.value]);
  retryOpen.value = false;
}
watch(
  () => props.run.id,
  () => {
    expandedItems.value = new Set(
      props.run.items.slice(0, 3).map((item) => item.id),
    );
    retryIds.value = [];
    retryOpen.value = false;
  },
  { immediate: true },
);
</script>

<template>
  <section class="pipeline-run-results" aria-labelledby="pipeline-run-title">
    <header>
      <div>
        <span class="pipeline-eyebrow"
          >Saved run · revision {{ run.revision }}</span
        >
        <h2 id="pipeline-run-title">{{ run.name }}</h2>
        <p>
          {{ run.summary.succeeded }} / {{ run.summary.total }} inputs complete
          <span>· {{ stateLabels[run.status] || run.status }}</span>
        </p>
      </div>
      <button
        type="button"
        class="pipeline-icon"
        aria-label="Close run results"
        @click="emit('close')"
      >
        <UIcon name="i-lucide-x" />
      </button>
    </header>
    <div class="pipeline-run-summary">
      <div>
        <small>Confirmed cost</small
        ><strong>{{
          formatUsd(run.summary.confirmedCostUsd) || "$0.00"
        }}</strong>
      </div>
      <div>
        <small>Outstanding</small
        ><strong
          >{{ run.summary.outstandingCount }} unpriced step{{
            run.summary.outstandingCount === 1 ? "" : "s"
          }}</strong
        >
      </div>
      <div>
        <small>Inputs</small><strong>{{ run.summary.total }} pictures</strong>
      </div>
      <div>
        <small>Progress</small
        ><strong
          >{{ run.summary.failed }} failed ·
          {{ run.summary.pending }} pending</strong
        >
      </div>
    </div>
    <div class="pipeline-run-actions">
      <a
        v-if="zipAvailable"
        class="pipeline-secondary"
        :href="`/api/pipeline-runs/${run.id}/download`"
        ><UIcon name="i-lucide-folder-down" />Download all ·
        {{ finalImages.length }} picture{{
          finalImages.length === 1 ? "" : "s"
        }}</a
      >
      <button
        v-if="active && paused && !busy"
        type="button"
        class="pipeline-primary"
        @click="emit('resume')"
      >
        <UIcon name="i-lucide-eye" />Watch progress</button
      ><button
        v-if="active"
        type="button"
        class="pipeline-secondary"
        :disabled="busy || run.cancelRequested"
        @click="emit('cancel')"
      >
        <UIcon name="i-lucide-square" />{{
          run.cancelRequested
            ? "Cancellation requested"
            : "Cancel remaining work"
        }}</button
      ><button
        v-if="retryable.length"
        type="button"
        class="pipeline-secondary"
        :disabled="busy"
        @click="openRetry"
      >
        <UIcon name="i-lucide-rotate-ccw" />Retry failed steps</button
      ><button
        type="button"
        class="pipeline-secondary"
        :disabled="busy"
        @click="emit('refresh')"
      >
        <UIcon name="i-lucide-refresh-cw" />Refresh progress</button
      ><span v-if="busy" class="pipeline-run-working" role="status"
        ><UIcon name="i-lucide-loader-circle" />Updating this run…</span
      >
    </div>
    <p v-if="error" class="pipeline-run-error" role="alert">{{ error }}</p>
    <p v-if="paused && active" class="pipeline-run-notice" role="status">
      Background work continues. Watch progress to resume updates here. You can
      close this panel or leave the page.
    </p>
    <p
      v-if="run.status === 'awaiting-price'"
      class="pipeline-run-notice"
      role="status"
    >
      Generated pictures appear and continue through the pipeline once Gateway
      confirms their exact prices.
    </p>
    <div
      class="pipeline-run-table"
      role="region"
      aria-label="Batch progress by input and step"
      tabindex="0"
    >
      <div
        class="pipeline-run-columns"
        :style="{ '--pipeline-columns': steps.length }"
      >
        <div>Batch input</div>
        <div v-for="node in steps" :key="node.id">
          <UIcon :name="pipelineNodeIcon(node.type)" /><span>{{
            node.label
          }}</span>
        </div>
      </div>
      <article
        v-for="item in run.items"
        :key="item.id"
        class="pipeline-run-item"
      >
        <div
          class="pipeline-run-row"
          :style="{ '--pipeline-columns': steps.length }"
        >
          <button
            class="pipeline-run-input"
            type="button"
            :aria-expanded="expandedItems.has(item.id)"
            :aria-controls="`pipeline-item-${item.id}`"
            @click="toggleItem(item.id)"
          >
            <img
              v-if="
                item.inputUrl &&
                ImagePathSchema.safeParse(item.inputUrl).success
              "
              :src="imagePreviewUrl(item.inputUrl, 160)"
              alt="Batch input picture"
              loading="lazy"
              decoding="async"
            /><span
              ><strong>Input {{ item.index + 1 }}</strong
              ><small>{{
                stateLabels[item.status] || item.status
              }}</small></span
            ><UIcon
              :name="
                expandedItems.has(item.id)
                  ? 'i-lucide-chevron-up'
                  : 'i-lucide-chevron-down'
              "
            />
          </button>
          <div
            v-for="node in steps"
            :key="node.id"
            class="pipeline-run-cell"
            :class="`pipeline-status-${stepFor(item, node.id)?.status ?? 'skipped'}`"
          >
            <UIcon
              :name="
                stepFor(item, node.id)?.status === 'succeeded'
                  ? 'i-lucide-check'
                  : stepFor(item, node.id)?.status === 'failed'
                    ? 'i-lucide-circle-alert'
                    : stepFor(item, node.id)?.status === 'running'
                      ? 'i-lucide-loader-circle'
                      : 'i-lucide-circle'
              "
            /><span>{{ status(stepFor(item, node.id)) }}</span>
          </div>
        </div>
        <div
          v-if="expandedItems.has(item.id)"
          :id="`pipeline-item-${item.id}`"
          class="pipeline-run-item-details"
        >
          <section
            v-for="step in item.steps.filter(
              (value) =>
                value.value?.text ||
                value.value?.images.some(visibleImage) ||
                value.error,
            )"
            :key="step.id"
            class="pipeline-step-detail"
          >
            <h3>
              <UIcon :name="pipelineNodeIcon(step.type)" />{{
                run.definition.nodes.find((node) => node.id === step.nodeId)
                  ?.label || step.type
              }}
            </h3>
            <p v-if="step.error" class="pipeline-step-error" role="status">
              {{ step.error.message }}
            </p>
            <p v-if="step.value?.text" class="pipeline-step-text">
              {{ step.value.text }}
            </p>
            <div
              v-if="step.value?.images.some(visibleImage)"
              class="pipeline-step-images"
            >
              <article
                v-for="image in step.value.images.filter(visibleImage)"
                :key="image.id"
                class="pipeline-result-card"
              >
                <img
                  :src="imagePreviewUrl(image.url, 480)"
                  :alt="image.name"
                  loading="lazy"
                  decoding="async"
                />
                <div>
                  <strong>{{ image.name }}</strong
                  ><span v-if="imagePrice(image)">{{ imagePrice(image) }}</span
                  ><small v-if="image.width && image.height"
                    >{{ image.width }} × {{ image.height }} px<span
                      v-if="image.mimeType"
                    >
                      ·
                      {{
                        image.mimeType.replace("image/", "").toUpperCase()
                      }}</span
                    ></small
                  ><a :href="imageDownloadUrl(image.url)" :download="image.name"
                    ><UIcon name="i-lucide-download" />Download original</a
                  ><NuxtLink
                    :to="{ path: '/edit', query: { source: image.url } }"
                    >Use in Edit<UIcon name="i-lucide-arrow-up-right"
                  /></NuxtLink>
                </div>
              </article>
            </div>
          </section>
          <p
            v-if="
              !item.steps.some(
                (value) =>
                  value.value?.text ||
                  value.value?.images.some(visibleImage) ||
                  value.error,
              )
            "
            class="pipeline-run-notice"
          >
            No confirmed results yet.
          </p>
        </div>
      </article>
    </div>
    <p class="pipeline-run-footnote">
      Each input has its own steps and results. Runs continue after you close
      the browser. Cancelling stops new work; accepted provider work may finish
      and be charged. The saved run uses its original pipeline revision.
    </p>
    <p v-if="finalImages.length && !zipAvailable" class="pipeline-run-notice">
      This collection exceeds the 200-picture or 256 MB archive limit. Use the
      original downloads on individual cards.
    </p>
    <div
      v-if="retryOpen"
      class="pipeline-retry-overlay"
      @click.self="retryOpen = false"
    >
      <section
        class="pipeline-retry-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pipeline-retry-title"
        @keydown.esc.stop="retryOpen = false"
      >
        <header>
          <h3 id="pipeline-retry-title">Retry failed steps</h3>
          <button
            type="button"
            class="pipeline-icon"
            aria-label="Close retry dialog"
            @click="retryOpen = false"
          >
            <UIcon name="i-lucide-x" />
          </button>
        </header>
        <p>
          Successful steps stay saved. Retrying a failed or interrupted AI step
          can create another provider charge, including when an earlier call
          completed without a saved response.
        </p>
        <label
          v-for="step in retryable"
          :key="step.id"
          class="pipeline-retry-option"
          ><input v-model="retryIds" type="checkbox" :value="step.id" /><span
            >Input {{ step.itemIndex + 1 }} ·
            {{
              run.definition.nodes.find((node) => node.id === step.nodeId)
                ?.label || step.type
            }}<small>{{ step.error?.message }}</small></span
          ></label
        ><label class="pipeline-retry-confirm"
          ><input v-model="chargeConfirmed" type="checkbox" />I understand that
          retried AI work can incur another charge.</label
        >
        <footer>
          <button
            type="button"
            class="pipeline-secondary"
            @click="retryOpen = false"
          >
            Keep this run</button
          ><button
            type="button"
            class="pipeline-primary"
            :disabled="!retryIds.length || !chargeConfirmed || busy"
            @click="retry"
          >
            Retry {{ retryIds.length }} step{{
              retryIds.length === 1 ? "" : "s"
            }}
          </button>
        </footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.pipeline-run-results {
  padding: 28px;
  color: var(--workspace-text);
  min-width: 0;
}
.pipeline-run-results > header {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: start;
}
.pipeline-eyebrow {
  color: var(--workspace-accent);
  font-size: 9px;
  letter-spacing: 1.2px;
  text-transform: uppercase;
}
.pipeline-run-results h2 {
  font-size: 23px;
  font-weight: 550;
  letter-spacing: -0.6px;
  margin-top: 7px;
}
.pipeline-run-results header p {
  font-size: 11px;
  color: var(--workspace-muted);
  margin-top: 9px;
}
.pipeline-run-results header p > span {
  color: #dbc3a6;
}
.pipeline-icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: var(--workspace-muted);
  border-radius: 7px;
  flex: none;
}
.pipeline-icon:hover {
  background: var(--workspace-surface-raised);
  color: var(--workspace-text);
}
.pipeline-icon .iconify {
  width: 15px;
  height: 15px;
}
.pipeline-run-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border: 1px solid var(--workspace-border);
  border-radius: 12px;
  margin-top: 25px;
  background: var(--workspace-surface);
}
.pipeline-run-summary > div {
  padding: 16px;
  border-right: 1px solid var(--workspace-border);
}
.pipeline-run-summary > div:last-child {
  border: 0;
}
.pipeline-run-summary small {
  font-size: 9px;
  display: block;
  color: var(--workspace-muted);
}
.pipeline-run-summary strong {
  display: block;
  font-size: 13px;
  font-weight: 550;
  margin-top: 8px;
}
.pipeline-run-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  align-items: center;
  margin: 20px 0;
}
.pipeline-primary,
.pipeline-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font-size: 10px;
  border-radius: 8px;
  padding: 10px 12px;
  line-height: 1.3;
}
.pipeline-primary {
  background: var(--workspace-accent);
  color: #231b15;
  font-weight: 550;
}
.pipeline-secondary {
  border: 1px solid var(--workspace-border);
  background: var(--workspace-surface);
  color: var(--workspace-text);
}
.pipeline-primary .iconify,
.pipeline-secondary .iconify {
  width: 13px;
  height: 13px;
}
.pipeline-run-working {
  display: flex;
  gap: 7px;
  align-items: center;
  color: #d8bd9d;
  font-size: 10px;
}
.pipeline-run-working .iconify {
  width: 13px;
  height: 13px;
  animation: pipeline-run-spin 1s linear infinite;
}
.pipeline-run-notice,
.pipeline-run-error,
.pipeline-run-footnote {
  font-size: 10px;
  color: var(--workspace-muted);
  line-height: 1.8;
  margin: 12px 0;
}
.pipeline-run-error {
  color: #efb49d;
}
.pipeline-run-footnote {
  margin-top: 25px;
}
.pipeline-run-table {
  overflow: auto;
  border: 1px solid var(--workspace-border);
  border-radius: 12px;
  background: var(--workspace-surface);
}
.pipeline-run-columns,
.pipeline-run-row {
  display: grid;
  grid-template-columns: 190px repeat(
      var(--pipeline-columns),
      minmax(160px, 1fr)
    );
  min-width: max-content;
}
.pipeline-run-columns {
  background: #302b23;
  font-size: 10px;
  color: var(--workspace-muted);
}
.pipeline-run-columns > div {
  padding: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-right: 1px solid var(--workspace-border);
  max-width: 230px;
}
.pipeline-run-columns > div span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pipeline-run-columns .iconify {
  width: 13px;
  height: 13px;
  flex: none;
}
.pipeline-run-item {
  border-top: 1px solid var(--workspace-border);
}
.pipeline-run-input {
  display: flex;
  align-items: center;
  gap: 9px;
  text-align: left;
  padding: 12px;
  border-right: 1px solid var(--workspace-border);
  min-height: 74px;
}
.pipeline-run-input img {
  width: 34px;
  height: 44px;
  object-fit: contain;
  border: 1px solid var(--workspace-border);
  border-radius: 5px;
  background: var(--workspace-bg);
}
.pipeline-run-input > span {
  flex: 1;
  min-width: 0;
}
.pipeline-run-input strong {
  font-size: 10px;
  font-weight: 500;
}
.pipeline-run-input small {
  display: block;
  font-size: 9px;
  color: var(--workspace-muted);
  margin-top: 6px;
}
.pipeline-run-input .iconify {
  width: 12px;
  height: 12px;
  color: var(--workspace-muted);
}
.pipeline-run-cell {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 13px;
  font-size: 9px;
  color: var(--workspace-muted);
  border-right: 1px solid var(--workspace-border);
}
.pipeline-run-cell .iconify {
  width: 12px;
  height: 12px;
  flex: none;
}
.pipeline-status-succeeded {
  color: #bacb9b;
}
.pipeline-status-failed,
.pipeline-status-interrupted {
  color: #e6a38a;
}
.pipeline-status-running,
.pipeline-status-awaiting-price {
  color: #e5bd91;
}
.pipeline-status-running .iconify {
  animation: pipeline-run-spin 1s linear infinite;
}
.pipeline-run-item-details {
  padding: 20px;
  border-top: 1px solid var(--workspace-border);
  background: var(--workspace-bg);
  min-width: 0;
  max-width: calc(100vw - 100px);
}
.pipeline-step-detail + .pipeline-step-detail {
  margin-top: 23px;
  border-top: 1px solid var(--workspace-border);
  padding-top: 18px;
}
.pipeline-step-detail h3 {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 11px;
  font-weight: 550;
}
.pipeline-step-detail h3 .iconify {
  width: 14px;
  height: 14px;
  color: var(--workspace-accent);
}
.pipeline-step-text {
  white-space: pre-wrap;
  font-size: 11px;
  line-height: 1.8;
  padding: 14px;
  border: 1px solid var(--workspace-border);
  background: var(--workspace-surface);
  border-radius: 8px;
  margin-top: 12px;
  max-width: 800px;
  overflow-wrap: anywhere;
}
.pipeline-step-error {
  font-size: 10px;
  color: #e9b19a;
  margin-top: 10px;
  line-height: 1.8;
  max-width: 700px;
}
.pipeline-step-images {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 14px;
}
.pipeline-result-card {
  width: 220px;
  border: 1px solid var(--workspace-border);
  border-radius: 10px;
  background: var(--workspace-surface);
  overflow: hidden;
  min-width: 0;
}
.pipeline-result-card > img {
  width: 100%;
  height: 200px;
  object-fit: contain;
  background: #1f1d1a;
  display: block;
}
.pipeline-result-card > div {
  padding: 13px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.pipeline-result-card strong {
  font-size: 10px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pipeline-result-card span {
  font-size: 9px;
  color: #e2c3a0;
}
.pipeline-result-card small {
  font-size: 9px;
  color: var(--workspace-muted);
}
.pipeline-result-card small span {
  font-size: 9px;
  color: var(--workspace-muted);
}
.pipeline-result-card a {
  font-size: 9px;
  color: var(--workspace-accent);
  display: flex;
  align-items: center;
  gap: 5px;
}
.pipeline-result-card .iconify {
  width: 12px;
  height: 12px;
}
.pipeline-retry-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: #0009;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 22px;
}
.pipeline-retry-dialog {
  width: min(580px, 100%);
  max-height: calc(100dvh - 44px);
  overflow: auto;
  padding: 25px;
  border: 1px solid var(--workspace-border);
  border-radius: 16px;
  background: var(--workspace-surface);
}
.pipeline-retry-dialog header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.pipeline-retry-dialog h3 {
  font-size: 18px;
  font-weight: 550;
}
.pipeline-retry-dialog > p {
  font-size: 11px;
  line-height: 1.8;
  color: var(--workspace-muted);
  margin: 16px 0;
}
.pipeline-retry-option {
  display: flex;
  gap: 10px;
  align-items: start;
  padding: 12px 0;
  font-size: 11px;
  border-top: 1px solid var(--workspace-border);
}
.pipeline-retry-option input,
.pipeline-retry-confirm input {
  accent-color: var(--workspace-accent);
  margin-top: 2px;
  flex: none;
}
.pipeline-retry-option small {
  display: block;
  font-size: 10px;
  color: var(--workspace-muted);
  line-height: 1.7;
  margin-top: 5px;
}
.pipeline-retry-confirm {
  display: flex;
  align-items: start;
  gap: 9px;
  font-size: 11px;
  line-height: 1.8;
  padding: 15px 0;
  color: #dfb89c;
}
.pipeline-retry-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
}
@keyframes pipeline-run-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 600px) {
  .pipeline-run-results {
    padding: 20px 16px;
  }
  .pipeline-run-summary {
    grid-template-columns: 1fr 1fr;
  }
  .pipeline-run-summary > div {
    border-bottom: 1px solid var(--workspace-border);
  }
  .pipeline-run-summary > div:nth-child(2) {
    border-right: 0;
  }
  .pipeline-run-summary > div:nth-child(3) {
    border-bottom: 0;
  }
  .pipeline-run-item-details {
    max-width: calc(100vw - 35px);
    padding: 15px;
  }
  .pipeline-result-card {
    width: 100%;
    max-width: 300px;
  }
  .pipeline-run-summary strong {
    font-size: 11px;
  }
  .pipeline-run-results h2 {
    font-size: 20px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pipeline-run-working .iconify,
  .pipeline-status-running .iconify {
    animation: none;
  }
}
</style>
