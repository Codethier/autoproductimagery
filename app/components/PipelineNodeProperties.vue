<script setup lang="ts">
import type { Component } from "vue";
import {
  getPipelineNodePorts,
  PipelineNodeSchema,
  type PipelineDefinition,
  type PipelineNode,
  type PipelineEdge,
} from "../../schemas/pipelines";
import {
  IMAGE_MODEL_PROFILES,
  SUPPORTED_IMAGE_MODEL_IDS,
  createDefaultSettings,
  type ImageModelId,
  type ImageGenerationSettings,
  type ImageModelProfile,
} from "../../schemas/image-generation";
import {
  isNewImageModel,
  orderImageModels,
} from "../../schemas/image-model-discovery";
import { BACKGROUND_REMOVAL_MODELS } from "../../schemas/background-removal-models";
import {
  PIPELINE_TEXT_MODEL_IDS,
  PIPELINE_TEXT_MODEL_PROFILES,
  GEMINI_ENHANCER_THINKING_BUDGETS,
  createPromptEnhancerConfig,
  pipelineTextSupportsTemperature,
  type PipelineTextModelId,
} from "../../schemas/pipeline-text-models";
import { useImageModelFavourites } from "../composables/useImageModelFavourites";
import { imagePreviewUrl } from "../utils/imageDelivery";
import { pipelineNodeIcon } from "../utils/pipelineTemplates";
import { pipelinePortLabel } from "../utils/pipelineEditor";
import { useModelText } from "../composables/useModelText";
import Gemini31FlashImageSettings from "./generation-settings/Gemini31FlashImageSettings.vue";
import Gemini3ProImageSettings from "./generation-settings/Gemini3ProImageSettings.vue";
import Gemini31FlashLiteImageSettings from "./generation-settings/Gemini31FlashLiteImageSettings.vue";
import Gemini25FlashImageSettings from "./generation-settings/Gemini25FlashImageSettings.vue";
import OpenAiGptImage2Settings from "./generation-settings/OpenAiGptImage2Settings.vue";
import OpenAiGptImage25Settings from "./generation-settings/OpenAiGptImage25Settings.vue";
import OpenAiGptImageLegacySettings from "./generation-settings/OpenAiGptImageLegacySettings.vue";
import CatalogImageSettings from "./generation-settings/CatalogImageSettings.vue";

const props = defineProps<{
  node: PipelineNode;
  definition: PipelineDefinition;
  models: Array<{ id: string; catalogStatus: string }>;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  update: [node: PipelineNode];
  connect: [source: string, sourcePort: "image" | "text", targetPort: string];
  disconnect: [edgeId: string];
  picker: [
    field: "images" | "referenceImages" | "maskImage" | "defaultImage",
    urls: string[],
    limit: number,
  ];
  duplicate: [];
  remove: [];
  run: [];
  close: [];
}>();
const {
  favouriteModelIds,
  favouriteSet,
  ready: favouritesReady,
  toggleFavourite,
} = useImageModelFavourites();
const { t } = useI18n();
const { modelText } = useModelText();
const label = ref(props.node.label);
const draftNode = ref<PipelineNode>(props.node);
// Shared-schema (Zod) issue text is shown as returned; the generic fallback is a
// message key so it follows a runtime language switch.
const errorState = ref<{ text: string } | null>(null);
const errorMessage = computed(() =>
  errorState.value
    ? errorState.value.text || t("pipelineEditor.properties.checkSetting")
    : "",
);
const portName = (port: { label: string }) => pipelinePortLabel(t, port);
const reasoningLabel = (level: string) =>
  t(`pipelineEditor.properties.reasoning.${level}`);
const config = computed(() => props.node.config as Record<string, unknown>);
const ai = computed(() =>
  "settings" in props.node.config && "model" in props.node.config
    ? { model: props.node.config.model, settings: props.node.config.settings }
    : null,
);
const imageProfile = computed(() =>
  ai.value ? IMAGE_MODEL_PROFILES[ai.value.model] : null,
);
const textProfile = computed(() =>
  props.node.type === "prompt-enhancer" || props.node.type === "describe-image" || props.node.type === "llm"
    ? PIPELINE_TEXT_MODEL_PROFILES[props.node.config.model] : null,
);
const textTemperatureEnabled = computed(() =>
  (props.node.type === "prompt-enhancer" || props.node.type === "describe-image" || props.node.type === "llm")
    && pipelineTextSupportsTemperature(props.node.config),
);
const ports = computed(() => getPipelineNodePorts(props.node));
const orderedModels = computed(() =>
  orderImageModels(SUPPORTED_IMAGE_MODEL_IDS, favouriteModelIds.value).map(
    (id) => ({
      id,
      profile: IMAGE_MODEL_PROFILES[id],
      available:
        props.models.some(
          (value) => value.id === id && value.catalogStatus !== "unavailable",
        ) &&
        (props.node.type === "generate-image" ||
          !IMAGE_MODEL_PROFILES[id].requiresMask),
    }),
  ),
);
const settingsComponents: Record<
  ImageModelProfile["settingsComponent"],
  Component
> = {
  Gemini31FlashImageSettings,
  Gemini3ProImageSettings,
  Gemini31FlashLiteImageSettings,
  Gemini25FlashImageSettings,
  OpenAiGptImage2Settings,
  OpenAiGptImage25Settings,
  OpenAiGptImageLegacySettings,
  CatalogImageSettings,
};
const settingsComponent = computed(() =>
  imageProfile.value
    ? settingsComponents[imageProfile.value.settingsComponent]
    : null,
);
const connections = computed(() =>
  props.definition.edges.filter((edge) => edge.target === props.node.id),
);
const inputOptions = (portId: string) => {
  const port = ports.value.inputs.find((value) => value.id === portId);
  return props.definition.nodes
    .filter((value) => value.id !== props.node.id)
    .flatMap((value) =>
      getPipelineNodePorts(value)
        .outputs.filter(
          (output) => port?.type === "media" || output.type === port?.type,
        )
        .map((output) => ({
          value: `${value.id}:${output.id}`,
          label: `${value.label} · ${portName(output)}`,
        })),
    );
};
const edgeName = (edge: PipelineEdge) =>
  props.definition.nodes.find((value) => value.id === edge.source)?.label ??
  t("pipelineEditor.properties.removedNode");
function updateNode(
  changes: Record<string, unknown>,
  nextLabel = draftNode.value.label,
) {
  if (props.disabled) return;
  const parsed = PipelineNodeSchema.safeParse({
    ...draftNode.value,
    label: nextLabel,
    config: { ...draftNode.value.config, ...changes },
  });
  if (!parsed.success) {
    errorState.value = { text: parsed.error.issues[0]?.message ?? "" };
    return;
  }
  errorState.value = null;
  draftNode.value = parsed.data;
  emit("update", parsed.data);
}
function rename(event: Event) {
  label.value = (event.target as HTMLInputElement).value;
  updateNode({}, label.value.trim());
}
function text(key: string, event: Event) {
  updateNode({ [key]: (event.target as HTMLInputElement).value });
}
function numeric(key: string, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (value.trim()) updateNode({ [key]: Number(value) });
}
function choice(key: string, event: Event) {
  updateNode({ [key]: (event.target as HTMLSelectElement).value });
}
function boolean(key: string, event: Event) {
  updateNode({ [key]: (event.target as HTMLInputElement).checked });
}
function changeModel(event: Event) {
  const model = (event.target as HTMLSelectElement).value as ImageModelId;
  if (!SUPPORTED_IMAGE_MODEL_IDS.includes(model)) return;
  updateNode({ model, settings: createDefaultSettings(model) });
}
function changeEnhancerModel(event: Event) {
  if (props.disabled || draftNode.value.type !== "prompt-enhancer") return;
  const model = (event.target as HTMLSelectElement).value as PipelineTextModelId;
  if (!PIPELINE_TEXT_MODEL_IDS.includes(model)) return;
  const current = draftNode.value.config;
  const parsed = PipelineNodeSchema.safeParse({...draftNode.value, config: {
    ...createPromptEnhancerConfig(model), prompt: current.prompt, systemPrompt: current.systemPrompt,
  }});
  if (!parsed.success) return;
  errorState.value = null;
  draftNode.value = parsed.data;
  emit("update", parsed.data);
}
function changeEnhancerReasoning(event: Event) {
  if (props.disabled || draftNode.value.type !== "prompt-enhancer") return;
  const reasoningEffort = (event.target as HTMLSelectElement).value;
  const current = draftNode.value.config;
  const next = {...current, reasoningEffort};
  if (next.model === "openai/gpt-6-luna") {
    if (reasoningEffort !== "none") delete next.temperature;
    else next.temperature ??= 0.5;
  }
  if (next.model === "google/gemini-2.5-flash" && reasoningEffort in GEMINI_ENHANCER_THINKING_BUDGETS)
    next.maxOutputTokens = Math.max(next.maxOutputTokens,
      GEMINI_ENHANCER_THINKING_BUDGETS[reasoningEffort as keyof typeof GEMINI_ENHANCER_THINKING_BUDGETS] + 64);
  const parsed = PipelineNodeSchema.safeParse({...draftNode.value, config: next});
  if (!parsed.success) return;
  errorState.value = null;
  draftNode.value = parsed.data;
  emit("update", parsed.data);
}
function settings(value: ImageGenerationSettings) {
  updateNode({ settings: value });
}
function connect(portId: string, event: Event) {
  if (props.disabled) return;
  const value = (event.target as HTMLSelectElement).value;
  if (!value) return;
  const [source, port] = value.split(":");
  if (source && (port === "image" || port === "text"))
    emit("connect", source, port, portId);
  (event.target as HTMLSelectElement).value = "";
}
function selectImage(
  field: "images" | "referenceImages" | "maskImage" | "defaultImage",
) {
  if (props.disabled) return;
  const value = config.value[field];
  const urls = Array.isArray(value)
    ? (value as string[])
    : typeof value === "string"
      ? [value]
      : [];
  const limit =
    field === "maskImage" || field === "defaultImage"
      ? 1
      : field === "referenceImages"
        ? Math.max(0, (imageProfile.value?.maxReferenceImages ?? 1) - 1)
        : 16;
  emit("picker", field, urls, limit);
}
function removeImage(
  field: "images" | "referenceImages" | "maskImage" | "defaultImage",
  url: string,
) {
  if (props.disabled) return;
  const value = config.value[field];
  if (Array.isArray(value))
    updateNode({ [field]: value.filter((item) => item !== url) });
  else {
    const next = { ...props.node.config } as Record<string, unknown>;
    delete next[field];
    const parsed = PipelineNodeSchema.safeParse({
      ...props.node,
      config: next,
    });
    if (parsed.success) emit("update", parsed.data);
  }
}
watch(
  () => props.node,
  (node) => {
    draftNode.value = node;
  },
  { flush: "sync" },
);
watch(
  () => [props.node.id, props.node.label],
  () => {
    label.value = props.node.label;
    errorState.value = null;
  },
);
</script>

<template>
  <aside class="pipeline-inspector" :aria-label="t('pipelineEditor.properties.ariaLabel')">
    <header>
      <span class="pipeline-inspector-icon"
        ><UIcon :name="pipelineNodeIcon(node.type)"
      /></span>
      <div>
        <small>{{ t("pipelineEditor.properties.selectedStep") }}</small>
        <h2>{{ node.label }}</h2>
      </div>
      <button
        type="button"
        class="pipeline-icon"
        :aria-label="t('pipelineEditor.properties.close')"
        @click="emit('close')"
      >
        <UIcon name="i-lucide-x" />
      </button>
    </header>
    <div class="pipeline-inspector-body">
      <label class="pipeline-label" for="pipeline-node-name">{{ t("pipelineEditor.properties.stepName") }}</label
      ><input
        id="pipeline-node-name"
        :value="label"
        class="pipeline-input"
        maxlength="100"
        :disabled="disabled"
        @input="rename"
      />
      <section v-if="ports.inputs.length" class="pipeline-section">
        <h3>{{ t("pipelineEditor.properties.connections") }}</h3>
        <div
          v-for="port in ports.inputs"
          :key="port.id"
          class="pipeline-port-setting"
        >
          <label class="pipeline-label" :for="`pipeline-connect-${port.id}`"
            >{{ portName(port) }} <span v-if="port.required">{{ t("pipelineEditor.properties.required") }}</span
            ><span v-else>{{ t("pipelineEditor.properties.optional") }}</span></label
          >
          <div
            v-for="edge in connections.filter(
              (value) => value.targetPort === port.id,
            )"
            :key="edge.id"
            class="pipeline-connected"
          >
            <span
              ><i :class="`pipeline-dot-${edge.sourcePort}`" />{{
                edgeName(edge)
              }}</span
            ><button
              type="button"
              class="pipeline-icon"
              :disabled="disabled"
              :aria-label="t('pipelineEditor.properties.disconnect', { source: edgeName(edge), port: portName(port) })"
              @click="emit('disconnect', edge.id)"
            >
              <UIcon name="i-lucide-unplug" />
            </button>
          </div>
          <select
            :id="`pipeline-connect-${port.id}`"
            class="pipeline-input"
            :disabled="disabled"
            @change="connect(port.id, $event)"
          >
            <option value="">
              {{ port.multiple ? t("pipelineEditor.properties.addConnection") : t("pipelineEditor.properties.connectFrom") }}
            </option>
            <option
              v-for="option in inputOptions(port.id)"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>
      </section>
      <section class="pipeline-section">
        <h3>{{ t("pipelineEditor.properties.settings") }}</h3>
        <template v-if="node.type === 'image-input'"
          ><p class="pipeline-help">
            {{ t("pipelineEditor.properties.imageInputHelp") }}
          </p>
          <label class="pipeline-checkbox"
            ><input
              type="checkbox"
              :checked="node.config.required"
              :disabled="disabled"
              @change="boolean('required', $event)"
            />{{ t("pipelineEditor.properties.requiredInput") }}</label
          ><button
            type="button"
            class="pipeline-secondary"
            :disabled="disabled"
            @click="selectImage('defaultImage')"
          >
            <UIcon name="i-lucide-image-plus" />{{
              node.config.defaultImage
                ? t("pipelineEditor.properties.changeDefaultPicture")
                : t("pipelineEditor.properties.chooseDefaultPicture")
            }}
          </button>
          <div v-if="node.config.defaultImage" class="pipeline-reference-list">
            <img
              :src="imagePreviewUrl(node.config.defaultImage, 160)"
              :alt="t('pipelineEditor.properties.defaultInputAlt')"
              loading="lazy"
            /><button
              type="button"
              class="pipeline-icon"
              :disabled="disabled"
              :aria-label="t('pipelineEditor.properties.removeDefaultPicture')"
              @click="removeImage('defaultImage', node.config.defaultImage)"
            >
              <UIcon name="i-lucide-x" />
            </button></div
        ></template>
        <template v-if="node.type === 'text-input'"
          ><label class="pipeline-label" for="pipeline-default-text"
            >{{ t("pipelineEditor.properties.defaultValue") }}</label
          ><textarea
            id="pipeline-default-text"
            class="pipeline-input"
            :value="node.config.defaultValue"
            rows="5"
            maxlength="20000"
            :disabled="disabled"
            @input="text('defaultValue', $event)"
          /><label class="pipeline-checkbox"
            ><input
              type="checkbox"
              :checked="node.config.required"
              :disabled="disabled"
              @change="boolean('required', $event)"
            />{{ t("pipelineEditor.properties.requiredInput") }}</label
          ></template
        >
        <template v-if="node.type === 'static-text'"
          ><label class="pipeline-label" for="pipeline-static-text">{{ t("pipelineEditor.properties.text") }}</label
          ><textarea
            id="pipeline-static-text"
            class="pipeline-input"
            :value="node.config.text"
            rows="7"
            maxlength="20000"
            :disabled="disabled"
            @input="text('text', $event)"
          />
        </template>
        <template v-if="node.type === 'people-input'">
          <p class="pipeline-help">
            {{ t("pipelineEditor.properties.peopleHelp") }}
          </p>
          <button
            type="button"
            class="pipeline-secondary"
            :disabled="disabled"
            @click="selectImage('images')"
          >
            <UIcon name="i-lucide-contact-round" />{{ t("pipelineEditor.properties.choosePeople") }}
          </button>
          <div class="pipeline-reference-list">
            <div v-for="url in node.config.images" :key="url">
              <img
                :src="imagePreviewUrl(url, 160)"
                :alt="t('pipelineEditor.properties.personAlt')"
                loading="lazy"
              />
              <button
                type="button"
                class="pipeline-icon"
                :disabled="disabled"
                :aria-label="t('pipelineEditor.properties.removePerson')"
                @click="removeImage('images', url)"
              >
                <UIcon name="i-lucide-x" />
              </button>
            </div>
          </div>
          <p class="pipeline-help">
            {{ t("pipelineEditor.properties.peopleCount", { count: node.config.images.length, max: 16 }) }}
          </p>
          <button
            v-if="node.config.images.length"
            type="button"
            class="pipeline-secondary"
            :disabled="disabled"
            @click="updateNode({ images: [] })"
          >
            <UIcon name="i-lucide-x" />{{ t("pipelineEditor.properties.clearSelection") }}
          </button>
          <p class="pipeline-help">
            {{ t("pipelineEditor.properties.peopleConnectHelp") }}
          </p>
        </template>
        <template v-if="node.type === 'static-image'"
          ><p class="pipeline-help">
            {{ t("pipelineEditor.properties.staticImageHelp") }}
          </p>
          <button
            type="button"
            class="pipeline-secondary"
            :disabled="disabled"
            @click="selectImage('images')"
          >
            <UIcon name="i-lucide-images" />{{ t("pipelineEditor.properties.choosePictures") }}
          </button>
          <div class="pipeline-reference-list">
            <div v-for="url in node.config.images" :key="url">
              <img
                :src="imagePreviewUrl(url, 160)"
                :alt="t('pipelineEditor.properties.staticAlt')"
                loading="lazy"
              /><button
                type="button"
                class="pipeline-icon"
                :disabled="disabled"
                :aria-label="t('pipelineEditor.properties.removeStatic')"
                @click="removeImage('images', url)"
              >
                <UIcon name="i-lucide-x" />
              </button>
            </div>
          </div>
          <p class="pipeline-help">
            {{ t("pipelineEditor.properties.picturesCount", { count: node.config.images.length, max: 16 }) }}
          </p></template
        >
        <template
          v-if="
            ai &&
            imageProfile &&
            settingsComponent &&
            (node.type !== 'upscale' || node.config.mode === 'ai')
          "
        >
          <label class="pipeline-label" for="pipeline-image-model"
            >{{ t("pipelineEditor.properties.imageModel") }}</label
          >
          <div class="pipeline-model-select">
            <select
              id="pipeline-image-model"
              class="pipeline-input"
              :value="ai.model"
              :disabled="disabled"
              @change="changeModel"
            >
              <option
                v-for="item in orderedModels"
                :key="item.id"
                :value="item.id"
                :disabled="!item.available"
              >
                {{ favouriteSet.has(item.id) ? "♥ " : ""
                }}{{ item.profile.shortName
                }}{{ isNewImageModel(item.id) ? ` · ${t("pipelineEditor.tags.new")}` : ""
                }}{{ item.profile.supportsTransparentBackground ? ` · ${t("pipelineEditor.tags.transparent")}` : ""
                }}{{ !item.available ? ` · ${t("pipelineEditor.tags.unavailable")}` : "" }}
              </option></select
            ><button
              type="button"
              class="pipeline-icon"
              :disabled="disabled || !favouritesReady"
              :aria-pressed="favouriteSet.has(ai.model)"
              :aria-label="t(favouriteSet.has(ai.model) ? 'pipelineEditor.properties.favouriteRemove' : 'pipelineEditor.properties.favouriteAdd', { model: imageProfile.shortName })"
              @click="toggleFavourite(ai.model)"
            >
              <UIcon
                name="i-lucide-heart"
                :class="{ 'pipeline-heart': favouriteSet.has(ai.model) }"
              />
            </button>
          </div>
          <p v-if="imageProfile.requiresMask" class="pipeline-help">
            {{ t("pipelineEditor.properties.requiresMask") }}
          </p>
          <ModelGuidance :model-id="ai.model" :settings="ai.settings" context="pipeline" compact />
          <details class="pipeline-model-settings">
            <summary>
              {{ t("pipelineEditor.properties.modelSettings") }}
              <small v-if="imageProfile.supportsTransparentBackground" class="pipeline-transparency-badge model-transparent-badge" :title="t('pipelineEditor.properties.transparentTitle')" :aria-label="t('pipelineEditor.properties.transparentAria')">{{ t("pipelineEditor.tags.transparent") }}</small>
              <small v-if="isNewImageModel(ai.model)">{{ t("pipelineEditor.tags.new") }}</small>
            </summary>
            <p v-if="imageProfile.supportsTransparentBackground" class="pipeline-help pipeline-transparency-help">{{ t("pipelineEditor.properties.transparentHelp") }}</p>
            <NuxtErrorBoundary :key="ai.model"
              ><component
                :is="settingsComponent"
                :model-value="ai.settings"
                @update:model-value="settings"
              /><template #error
                ><p class="pipeline-error">
                  {{ t("pipelineEditor.properties.settingsLoadFailed") }}
                  <button
                    type="button"
                    @click="
                      updateNode({ settings: createDefaultSettings(ai!.model) })
                    "
                  >
                    {{ t("pipelineEditor.properties.restoreDefaults") }}
                  </button>
                </p></template
              ></NuxtErrorBoundary
            >
          </details>
          <SaveFormatSetting
            class="pipeline-save-format"
            compact
            :disabled="disabled"
            :model-value="config.saveFormat === 'original' || config.saveFormat === 'png' ? config.saveFormat : 'webp'"
            @update:model-value="value => updateNode({ saveFormat: value })"
          />
        </template>
        <template v-if="node.type === 'generate-image'"
          ><label class="pipeline-label" for="pipeline-generation-prompt"
            >{{ t("pipelineEditor.properties.prompt") }}</label
          ><textarea
            id="pipeline-generation-prompt"
            class="pipeline-input"
            :value="node.config.prompt"
            rows="6"
            maxlength="20000"
            :disabled="disabled"
            :placeholder="t('pipelineEditor.properties.promptPlaceholder')"
            @input="text('prompt', $event)" />
          <p class="pipeline-help">
            {{ t("pipelineEditor.properties.promptHelp") }}
          </p>
          <button
            type="button"
            class="pipeline-secondary"
            :disabled="disabled"
            @click="selectImage('referenceImages')"
          >
            <UIcon name="i-lucide-contact-round" />{{ t("pipelineEditor.properties.chooseReferences") }}
          </button>
          <div class="pipeline-reference-list">
            <div v-for="url in node.config.referenceImages" :key="url">
              <img
                :src="imagePreviewUrl(url, 160)"
                :alt="t('pipelineEditor.properties.generationReferenceAlt')"
                loading="lazy"
              /><button
                type="button"
                class="pipeline-icon"
                :disabled="disabled"
                :aria-label="t('pipelineEditor.properties.removeGenerationReference')"
                @click="removeImage('referenceImages', url)"
              >
                <UIcon name="i-lucide-x" />
              </button>
            </div>
          </div>
          <template v-if="imageProfile?.supportsMask"
            ><button
              type="button"
              class="pipeline-secondary"
              :disabled="disabled"
              @click="selectImage('maskImage')"
            >
              {{
                node.config.maskImage ? t("pipelineEditor.properties.changeMask") : t("pipelineEditor.properties.chooseMask")
              }}
            </button>
            <div v-if="node.config.maskImage" class="pipeline-reference-list">
              <img
                :src="imagePreviewUrl(node.config.maskImage, 160)"
                :alt="t('pipelineEditor.properties.maskAlt')"
                loading="lazy"
              /><button
                type="button"
                class="pipeline-icon"
                :disabled="disabled"
                :aria-label="t('pipelineEditor.properties.removeMask')"
                @click="removeImage('maskImage', node.config.maskImage)"
              >
                <UIcon name="i-lucide-x" />
              </button></div></template
        ></template>
        <template v-if="node.type === 'remove-background'"
          ><label class="pipeline-label" for="pipeline-cutout-model"
            >{{ t("pipelineEditor.properties.cpuModel") }}</label
          ><select
            id="pipeline-cutout-model"
            class="pipeline-input"
            :value="node.config.model"
            :disabled="disabled"
            @change="choice('model', $event)"
          >
            <option
              v-for="profile in BACKGROUND_REMOVAL_MODELS"
              :key="profile.id"
              :value="profile.id"
            >
              {{ modelText(profile.label) }}{{ profile.supportsTransparentBackground ? ` · ${t("pipelineEditor.tags.transparent")}` : "" }}
            </option>
          </select>
          <p class="pipeline-help">
            {{ t("pipelineEditor.properties.removalHelp") }}
          </p></template
        >
        <template v-if="node.type === 'crop' || node.type === 'resize'"
          ><div class="pipeline-field-grid">
            <div>
              <label class="pipeline-label" for="pipeline-width"
                >{{ t("pipelineEditor.properties.width") }}</label
              ><input
                id="pipeline-width"
                class="pipeline-input"
                type="number"
                min="1"
                max="8192"
                :value="node.config.width"
                :disabled="disabled"
                @input="numeric('width', $event)"
              />
            </div>
            <div>
              <label class="pipeline-label" for="pipeline-height"
                >{{ t("pipelineEditor.properties.height") }}</label
              ><input
                id="pipeline-height"
                class="pipeline-input"
                type="number"
                min="1"
                max="8192"
                :value="node.config.height"
                :disabled="disabled"
                @input="numeric('height', $event)"
              />
            </div>
          </div>
          <template v-if="node.type === 'crop'"
            ><label class="pipeline-label" for="pipeline-crop-position"
              >{{ t("pipelineEditor.properties.focusPosition") }}</label
            ><select
              id="pipeline-crop-position"
              class="pipeline-input"
              :value="node.config.position"
              :disabled="disabled"
              @change="choice('position', $event)"
            >
              <option
                v-for="value in ['centre', 'north', 'south', 'east', 'west']"
                :key="value"
                :value="value"
              >
                {{ t(`pipelineEditor.properties.positions.${value}`) }}
              </option>
            </select></template
          ><template v-else
            ><label class="pipeline-label" for="pipeline-fit">{{ t("pipelineEditor.properties.fit") }}</label
            ><select
              id="pipeline-fit"
              class="pipeline-input"
              :value="node.config.fit"
              :disabled="disabled"
              @change="choice('fit', $event)"
            >
              <option
                v-for="value in [
                  'contain',
                  'cover',
                  'inside',
                  'outside',
                  'fill',
                ]"
                :key="value"
                :value="value"
              >
                {{ t(`pipelineEditor.properties.fits.${value}`) }}
              </option></select
            ><label class="pipeline-label" for="pipeline-background-color"
              >{{ t("pipelineEditor.properties.background") }}</label
            ><input
              id="pipeline-background-color"
              class="pipeline-input"
              :value="node.config.background"
              :disabled="disabled"
              :placeholder="t('pipelineEditor.properties.backgroundPlaceholder')"
              @input="text('background', $event)"
          /></template>
          <p class="pipeline-help">
            {{ t("pipelineEditor.properties.localHelp") }}
          </p></template
        >
        <template v-if="node.type === 'upscale'"
          ><label class="pipeline-label" for="pipeline-upscale-mode"
            >{{ t("pipelineEditor.properties.method") }}</label
          ><select
            id="pipeline-upscale-mode"
            class="pipeline-input"
            :value="node.config.mode"
            :disabled="disabled"
            @change="choice('mode', $event)"
          >
            <option value="standard">{{ t("pipelineEditor.properties.upscaleStandard") }}</option>
            <option value="ai">{{ t("pipelineEditor.properties.upscaleAi") }}</option></select
          ><label class="pipeline-label" for="pipeline-upscale-factor"
            >{{ t("pipelineEditor.properties.scale") }}</label
          ><select
            id="pipeline-upscale-factor"
            class="pipeline-input"
            :value="node.config.scale"
            :disabled="disabled"
            @input="numeric('scale', $event)"
          >
            <option :value="2">2×</option>
            <option :value="4">4×</option>
          </select></template
        >
        <template v-if="node.type === 'expand'"
          ><label class="pipeline-label" for="pipeline-expand-mode"
            >{{ t("pipelineEditor.properties.expandBy") }}</label
          ><select
            id="pipeline-expand-mode"
            class="pipeline-input"
            :value="node.config.mode"
            :disabled="disabled"
            @change="choice('mode', $event)"
          >
            <option value="pixels">{{ t("pipelineEditor.properties.pixels") }}</option>
            <option value="aspect-ratio">{{ t("pipelineEditor.properties.aspectRatio") }}</option>
          </select>
          <div v-if="node.config.mode === 'pixels'" class="pipeline-field-grid">
            <div v-for="side in ['top', 'bottom', 'left', 'right']" :key="side">
              <label class="pipeline-label" :for="`pipeline-expand-${side}`"
                >{{ t(`pipelineEditor.properties.sides.${side}`) }}</label
              ><input
                :id="`pipeline-expand-${side}`"
                class="pipeline-input"
                type="number"
                min="0"
                max="4096"
                :value="config[side]"
                :disabled="disabled"
                @input="numeric(side, $event)"
              />
            </div>
          </div>
          <template v-else
            ><label class="pipeline-label" for="pipeline-expand-ratio"
              >{{ t("pipelineEditor.properties.targetAspectRatio") }}</label
            ><select
              id="pipeline-expand-ratio"
              class="pipeline-input"
              :value="node.config.aspectRatio"
              :disabled="disabled"
              @change="choice('aspectRatio', $event)"
            >
              <option
                v-for="ratio in [
                  '1:1',
                  '2:3',
                  '3:2',
                  '3:4',
                  '4:3',
                  '4:5',
                  '5:4',
                  '9:16',
                  '16:9',
                  '21:9',
                ]"
                :key="ratio"
              >
                {{ ratio }}
              </option>
            </select></template
          ><label class="pipeline-label" for="pipeline-creativity"
            >{{ t("pipelineEditor.properties.creativity", { value: node.config.creativity }) }}</label
          ><input
            id="pipeline-creativity"
            class="pipeline-range"
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="node.config.creativity"
            :disabled="disabled"
            @input="numeric('creativity', $event)"
          /><label class="pipeline-label" for="pipeline-expand-prompt"
            >{{ t("pipelineEditor.properties.sceneInstructions") }}</label
          ><textarea
            id="pipeline-expand-prompt"
            class="pipeline-input"
            rows="4"
            :value="node.config.prompt"
            maxlength="20000"
            :disabled="disabled"
            @input="text('prompt', $event)"
          />
          <p class="pipeline-help">
            {{ t("pipelineEditor.properties.expandHelp") }}
          </p></template
        >
        <template v-if="node.type === 'translate'"
          ><label class="pipeline-label" for="pipeline-language"
            >{{ t("pipelineEditor.properties.translateTo") }}</label
          ><input
            id="pipeline-language"
            class="pipeline-input"
            :value="node.config.language"
            maxlength="80"
            :disabled="disabled"
            @input="text('language', $event)"
          /><label class="pipeline-label" for="pipeline-translation-prompt"
            >{{ t("pipelineEditor.properties.designInstructions") }}</label
          ><textarea
            id="pipeline-translation-prompt"
            class="pipeline-input"
            rows="4"
            :value="node.config.prompt"
            maxlength="20000"
            :disabled="disabled"
            @input="text('prompt', $event)"
          />
        </template>
        <template
          v-if="
            node.type === 'describe-image' ||
            node.type === 'prompt-enhancer' ||
            node.type === 'llm'
          "
          >
          <template v-if="node.type === 'prompt-enhancer'">
            <label class="pipeline-label" for="pipeline-enhancer-model">{{ t("pipelineEditor.properties.enhancerModel") }}</label>
            <select id="pipeline-enhancer-model" class="pipeline-input" :value="node.config.model" :disabled="disabled" @change="changeEnhancerModel">
              <option v-for="id in PIPELINE_TEXT_MODEL_IDS" :key="id" :value="id">{{ PIPELINE_TEXT_MODEL_PROFILES[id].name }}</option>
            </select>
            <p class="pipeline-help">{{ modelText(textProfile?.description) }} {{ t("pipelineEditor.properties.enhancerHelp") }}</p>
            <label class="pipeline-label" for="pipeline-enhancer-reasoning">{{ t("pipelineEditor.properties.reasoningEffort") }}</label>
            <select id="pipeline-enhancer-reasoning" class="pipeline-input" :value="node.config.reasoningEffort ?? 'none'" :disabled="disabled" @change="changeEnhancerReasoning">
              <option v-for="level in textProfile?.reasoningLevels" :key="level" :value="level">{{ reasoningLabel(level) }}</option>
            </select>
            <p class="pipeline-help">{{ modelText(textProfile?.reasoningHelp) }}</p>
          </template>
          <p class="pipeline-help">
            {{ t("pipelineEditor.properties.gatewayHelp", { model: textProfile?.name ?? "" }) }}
          </p>
          <label class="pipeline-label" for="pipeline-system-prompt"
            >{{ t("pipelineEditor.properties.systemInstruction") }}</label
          ><textarea
            id="pipeline-system-prompt"
            class="pipeline-input"
            rows="5"
            :value="node.config.systemPrompt"
            maxlength="20000"
            :disabled="disabled"
            @input="text('systemPrompt', $event)" /><label
            class="pipeline-label"
            for="pipeline-text-prompt"
            >{{ t("pipelineEditor.properties.additionalInstruction") }}</label
          ><textarea
            id="pipeline-text-prompt"
            class="pipeline-input"
            rows="4"
            :value="node.config.prompt"
            maxlength="20000"
            :disabled="disabled"
            @input="text('prompt', $event)" />
          <div class="pipeline-field-grid">
            <div v-if="textTemperatureEnabled">
              <label class="pipeline-label" for="pipeline-temperature"
                >{{ t("pipelineEditor.properties.temperature") }}</label
              ><input
                id="pipeline-temperature"
                class="pipeline-input"
                type="number"
                min="0"
                :max="textProfile?.temperatureMax ?? 2"
                step="0.1"
                :value="node.config.temperature"
                :disabled="disabled"
                @input="numeric('temperature', $event)"
              />
            </div>
            <div>
              <label class="pipeline-label" for="pipeline-text-tokens"
                >{{ t("pipelineEditor.properties.outputTokenCap") }}</label
              ><input
                id="pipeline-text-tokens"
                class="pipeline-input"
                type="number"
                min="64"
                :max="textProfile?.maxOutputTokens ?? 4096"
                :value="node.config.maxOutputTokens"
                :disabled="disabled"
                @input="numeric('maxOutputTokens', $event)"
              />
            </div></div
        ></template>
        <template v-if="node.type === 'prompt-concatenator'"
          ><label class="pipeline-label" for="pipeline-text-separator"
            >{{ t("pipelineEditor.properties.separator") }}</label
          ><select
            id="pipeline-text-separator"
            class="pipeline-input"
            :value="node.config.separator"
            :disabled="disabled"
            @change="choice('separator', $event)"
          >
            <option value="\n">{{ t("pipelineEditor.properties.separators.newLine") }}</option>
            <option value="\n\n">{{ t("pipelineEditor.properties.separators.blankLine") }}</option>
            <option value=" ">{{ t("pipelineEditor.properties.separators.space") }}</option>
            <option value=", ">{{ t("pipelineEditor.properties.separators.comma") }}</option>
            <option value="">{{ t("pipelineEditor.properties.separators.none") }}</option>
          </select>
          <p class="pipeline-help">
            {{ t("pipelineEditor.properties.concatHelp") }}
          </p></template
        >
        <template v-if="node.type === 'output'"
          ><label class="pipeline-label" for="pipeline-output-format"
            >{{ t("pipelineEditor.properties.imageFormat") }}</label
          ><select
            id="pipeline-output-format"
            class="pipeline-input"
            :value="node.config.format"
            :disabled="disabled"
            @change="choice('format', $event)"
          >
            <option value="original">{{ t("pipelineEditor.properties.formatOriginal") }}</option>
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option></select
          ><template
            v-if="
              node.config.format === 'jpeg' || node.config.format === 'webp'
            "
            ><label class="pipeline-label" for="pipeline-output-quality"
              >{{ t("pipelineEditor.properties.quality", { value: node.config.quality }) }}</label
            ><input
              id="pipeline-output-quality"
              class="pipeline-range"
              type="range"
              min="1"
              max="100"
              :value="node.config.quality"
              :disabled="disabled"
              @input="numeric('quality', $event)"
          /></template>
          <p class="pipeline-help">
            {{ t("pipelineEditor.properties.outputHelp") }}
          </p></template
        >
        <template v-if="node.type === 'sticky-note'"
          ><label class="pipeline-label" for="pipeline-note-text">{{ t("pipelineEditor.properties.note") }}</label
          ><textarea
            id="pipeline-note-text"
            class="pipeline-input"
            rows="8"
            :value="node.config.text"
            maxlength="4000"
            :disabled="disabled"
            @input="text('text', $event)"
          /><label class="pipeline-label" for="pipeline-note-color">{{ t("pipelineEditor.properties.color") }}</label
          ><select
            id="pipeline-note-color"
            class="pipeline-input"
            :value="node.config.color"
            :disabled="disabled"
            @change="choice('color', $event)"
          >
            <option
              v-for="value in ['amber', 'rose', 'sage', 'blue']"
              :key="value"
              :value="value"
            >
              {{ t(`pipelineEditor.properties.colors.${value}`) }}
            </option>
          </select></template
        >
      </section>
      <p v-if="errorMessage" class="pipeline-error" role="alert">
        {{ errorMessage }}
      </p>
    </div>
    <footer>
      <button
        v-if="node.type !== 'sticky-note'"
        type="button"
        class="pipeline-primary"
        :disabled="disabled"
        @click="emit('run')"
      >
        <UIcon name="i-lucide-play" />{{ t("pipelineEditor.properties.runToStep") }}
      </button>
      <div>
        <button
          type="button"
          class="pipeline-secondary"
          :disabled="disabled"
          @click="emit('duplicate')"
        >
          <UIcon name="i-lucide-copy" />{{ t("pipelineEditor.properties.duplicate") }}</button
        ><button
          type="button"
          class="pipeline-secondary pipeline-danger"
          :disabled="disabled"
          @click="emit('remove')"
        >
          <UIcon name="i-lucide-trash-2" />{{ t("common.actions.delete") }}
        </button>
      </div>
    </footer>
  </aside>
</template>

<style scoped>
.pipeline-inspector {
  width: 336px;
  display: flex;
  flex-direction: column;
  background: var(--workspace-surface);
  border-left: 1px solid var(--workspace-border);
  min-height: 0;
  flex: none;
}
.pipeline-inspector > header {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 20px;
  border-bottom: 1px solid var(--workspace-border);
}
.pipeline-inspector > header > div {
  min-width: 0;
  flex: 1;
}
.pipeline-inspector h2 {
  font-size: 14px;
  font-weight: 550;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pipeline-inspector header small {
  display: block;
  font-size: 9px;
  color: var(--workspace-muted);
  margin-bottom: 5px;
}
.pipeline-inspector-icon {
  display: grid;
  place-items: center;
  flex: none;
  background: #44352a;
  border-radius: 10px;
  width: 37px;
  height: 37px;
  color: var(--workspace-accent);
}
.pipeline-inspector-icon .iconify {
  width: 18px;
  height: 18px;
}
.pipeline-inspector-body {
  overflow: auto;
  padding: 20px;
  flex: 1;
  min-height: 0;
}
.pipeline-label {
  font-size: 10px;
  color: var(--workspace-muted);
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 15px 0 8px;
}
.pipeline-label > span {
  font-size: 8px;
  color: #8e877c;
}
.pipeline-input {
  width: 100%;
  min-width: 0;
  background: var(--workspace-bg);
  border: 1px solid var(--workspace-border);
  border-radius: 8px;
  color: var(--workspace-text);
  padding: 10px 11px;
  font-size: 11px;
  line-height: 1.65;
}
.pipeline-input:focus {
  outline: 2px solid var(--workspace-accent);
  outline-offset: 2px;
}
textarea.pipeline-input {
  resize: vertical;
  min-height: 64px;
}
.pipeline-section {
  margin-top: 24px;
  border-top: 1px solid var(--workspace-border);
  padding-top: 18px;
}
.pipeline-section h3 {
  font-size: 11px;
  font-weight: 550;
  letter-spacing: 0.1px;
}
.pipeline-port-setting {
  margin-top: 15px;
}
.pipeline-connected {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  padding: 7px 9px;
  margin-bottom: 7px;
  background: var(--workspace-bg);
  border: 1px solid var(--workspace-border);
  border-radius: 7px;
  font-size: 10px;
}
.pipeline-connected > span {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  overflow: hidden;
}
.pipeline-connected i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #b8c19b;
  flex: none;
}
.pipeline-connected .pipeline-dot-text {
  background: #ccb095;
}
.pipeline-icon {
  display: grid;
  place-items: center;
  border-radius: 7px;
  width: 28px;
  height: 28px;
  flex: none;
  color: var(--workspace-muted);
}
.pipeline-icon:hover {
  background: var(--workspace-surface-raised);
  color: var(--workspace-text);
}
.pipeline-icon .iconify {
  width: 14px;
  height: 14px;
}
.pipeline-help {
  font-size: 10px;
  line-height: 1.8;
  color: var(--workspace-muted);
  margin: 11px 0 15px;
}
.pipeline-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 0;
  font-size: 10px;
  color: var(--workspace-muted);
}
.pipeline-checkbox input {
  accent-color: var(--workspace-accent);
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
  background: var(--workspace-bg);
  color: var(--workspace-text);
}
.pipeline-primary .iconify,
.pipeline-secondary .iconify {
  width: 13px;
  height: 13px;
}
.pipeline-secondary:hover {
  border-color: #776b59;
}
.pipeline-reference-list {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 12px;
  align-items: center;
}
.pipeline-reference-list > div {
  position: relative;
}
.pipeline-reference-list img {
  width: 62px;
  height: 72px;
  object-fit: contain;
  border: 1px solid var(--workspace-border);
  border-radius: 7px;
  background: var(--workspace-bg);
}
.pipeline-reference-list > div > button {
  position: absolute;
  top: 2px;
  right: 2px;
  background: #1c1b19ce;
  width: 20px;
  height: 20px;
}
.pipeline-reference-list > div .iconify {
  width: 11px;
  height: 11px;
}
.pipeline-model-select {
  display: flex;
  align-items: center;
  gap: 7px;
}
.pipeline-model-select select {
  flex: 1;
  min-width: 0;
}
.pipeline-heart {
  color: #e9a994;
}
.pipeline-model-settings {
  border: 1px solid var(--workspace-border);
  border-radius: 9px;
  padding: 12px;
  margin: 14px 0;
}
.pipeline-model-settings summary {
  font-size: 10px;
  color: var(--workspace-muted);
  cursor: pointer;
}
.pipeline-model-settings summary small {
  color: var(--workspace-accent);
  margin-left: 7px;
}
.pipeline-model-settings summary .pipeline-transparency-badge {
  display: inline-block;
  border: 1px solid var(--workspace-border);
  border-radius: 999px;
  padding: 2px 6px;
  background: var(--workspace-surface-raised);
  color: var(--workspace-text);
  font-size: 9px;
}
.pipeline-transparency-help {
  margin-bottom: 14px;
}
.pipeline-model-settings[open] summary {
  margin-bottom: 16px;
}
.pipeline-field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.pipeline-range {
  width: 100%;
  accent-color: var(--workspace-accent);
}
.pipeline-error {
  font-size: 10px;
  color: #efb49d;
  line-height: 1.8;
  margin-top: 12px;
}
.pipeline-error button {
  text-decoration: underline;
}
.pipeline-inspector > footer {
  padding: 16px 20px;
  border-top: 1px solid var(--workspace-border);
}
.pipeline-inspector > footer > .pipeline-primary {
  width: 100%;
}
.pipeline-inspector > footer > div {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.pipeline-inspector > footer > div > button {
  flex: 1;
}
.pipeline-danger {
  color: #e8ad99;
}
@media (max-width: 980px) {
  .pipeline-inspector {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    z-index: 25;
    box-shadow: -20px 0 50px #0007;
    max-width: calc(100% - 18px);
  }
}
</style>
