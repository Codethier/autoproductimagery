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
import { useImageModelFavourites } from "../composables/useImageModelFavourites";
import { imagePreviewUrl } from "../utils/imageDelivery";
import { pipelineNodeIcon } from "../utils/pipelineTemplates";
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
const label = ref(props.node.label);
const draftNode = ref<PipelineNode>(props.node);
const errorMessage = ref("");
const config = computed(() => props.node.config as Record<string, unknown>);
const ai = computed(() =>
  "settings" in props.node.config && "model" in props.node.config
    ? { model: props.node.config.model, settings: props.node.config.settings }
    : null,
);
const imageProfile = computed(() =>
  ai.value ? IMAGE_MODEL_PROFILES[ai.value.model] : null,
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
          label: `${value.label} · ${output.label}`,
        })),
    );
};
const edgeName = (edge: PipelineEdge) =>
  props.definition.nodes.find((value) => value.id === edge.source)?.label ??
  "Removed node";
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
    errorMessage.value =
      parsed.error.issues[0]?.message ?? "Check this setting.";
    return;
  }
  errorMessage.value = "";
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
function settings(value: ImageGenerationSettings) {
  updateNode({ settings: value });
}
function connect(portId: string, event: Event) {
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
    errorMessage.value = "";
  },
);
</script>

<template>
  <aside class="pipeline-inspector" aria-label="Node properties">
    <header>
      <span class="pipeline-inspector-icon"
        ><UIcon :name="pipelineNodeIcon(node.type)"
      /></span>
      <div>
        <small>Selected step</small>
        <h2>{{ node.label }}</h2>
      </div>
      <button
        type="button"
        class="pipeline-icon"
        aria-label="Close node properties"
        @click="emit('close')"
      >
        <UIcon name="i-lucide-x" />
      </button>
    </header>
    <div class="pipeline-inspector-body">
      <label class="pipeline-label" for="pipeline-node-name">Step name</label
      ><input
        id="pipeline-node-name"
        :value="label"
        class="pipeline-input"
        maxlength="100"
        :disabled="disabled"
        @input="rename"
      />
      <section v-if="ports.inputs.length" class="pipeline-section">
        <h3>Connections</h3>
        <div
          v-for="port in ports.inputs"
          :key="port.id"
          class="pipeline-port-setting"
        >
          <label class="pipeline-label" :for="`pipeline-connect-${port.id}`"
            >{{ port.label }} <span v-if="port.required">required</span
            ><span v-else>optional</span></label
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
              :aria-label="`Disconnect ${edgeName(edge)} from ${port.label}`"
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
              {{ port.multiple ? "Add a connection…" : "Connect from…" }}
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
        <h3>Settings</h3>
        <template v-if="node.type === 'image-input'"
          ><p class="pipeline-help">
            Choose this input when running a batch. Each selected picture runs
            through the pipeline independently.
          </p>
          <label class="pipeline-checkbox"
            ><input
              type="checkbox"
              :checked="node.config.required"
              :disabled="disabled"
              @change="boolean('required', $event)"
            />Required input</label
          ><button
            type="button"
            class="pipeline-secondary"
            :disabled="disabled"
            @click="selectImage('defaultImage')"
          >
            <UIcon name="i-lucide-image-plus" />{{
              node.config.defaultImage
                ? "Change default picture"
                : "Choose default picture"
            }}
          </button>
          <div v-if="node.config.defaultImage" class="pipeline-reference-list">
            <img
              :src="imagePreviewUrl(node.config.defaultImage, 160)"
              alt="Default input"
              loading="lazy"
            /><button
              type="button"
              class="pipeline-icon"
              :disabled="disabled"
              aria-label="Remove default picture"
              @click="removeImage('defaultImage', node.config.defaultImage)"
            >
              <UIcon name="i-lucide-x" />
            </button></div
        ></template>
        <template v-if="node.type === 'text-input'"
          ><label class="pipeline-label" for="pipeline-default-text"
            >Default value</label
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
            />Required input</label
          ></template
        >
        <template v-if="node.type === 'static-text'"
          ><label class="pipeline-label" for="pipeline-static-text">Text</label
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
        <template v-if="node.type === 'static-image'"
          ><p class="pipeline-help">
            Reuse pictures from your Library, shared files or People.
          </p>
          <button
            type="button"
            class="pipeline-secondary"
            :disabled="disabled"
            @click="selectImage('images')"
          >
            <UIcon name="i-lucide-images" />Choose pictures
          </button>
          <div class="pipeline-reference-list">
            <div v-for="url in node.config.images" :key="url">
              <img
                :src="imagePreviewUrl(url, 160)"
                alt="Static reference"
                loading="lazy"
              /><button
                type="button"
                class="pipeline-icon"
                :disabled="disabled"
                aria-label="Remove static reference"
                @click="removeImage('images', url)"
              >
                <UIcon name="i-lucide-x" />
              </button>
            </div>
          </div>
          <p class="pipeline-help">
            {{ node.config.images.length }} / 16 pictures
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
            >Image model</label
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
                }}{{ isNewImageModel(item.id) ? " · New" : ""
                }}{{ item.profile.supportsTransparentBackground ? " · Transparent" : ""
                }}{{ !item.available ? " · unavailable" : "" }}
              </option></select
            ><button
              type="button"
              class="pipeline-icon"
              :disabled="disabled || !favouritesReady"
              :aria-pressed="favouriteSet.has(ai.model)"
              :aria-label="`${favouriteSet.has(ai.model) ? 'Remove' : 'Add'} ${imageProfile.shortName} ${favouriteSet.has(ai.model) ? 'from' : 'to'} favourites`"
              @click="toggleFavourite(ai.model)"
            >
              <UIcon
                name="i-lucide-heart"
                :class="{ 'pipeline-heart': favouriteSet.has(ai.model) }"
              />
            </button>
          </div>
          <p v-if="imageProfile.requiresMask" class="pipeline-help">
            This model requires a connected mask or a selected mask picture.
          </p>
          <details class="pipeline-model-settings">
            <summary>
              Model settings
              <small v-if="imageProfile.supportsTransparentBackground" class="pipeline-transparency-badge model-transparent-badge" title="Supports transparent image output; enable it in model settings." aria-label="Supports transparent image output">Transparent</small>
              <small v-if="isNewImageModel(ai.model)">New</small>
            </summary>
            <p v-if="imageProfile.supportsTransparentBackground" class="pipeline-help pipeline-transparency-help">For a transparent image, choose Background → Transparent and use PNG or WebP.</p>
            <NuxtErrorBoundary :key="ai.model"
              ><component
                :is="settingsComponent"
                :model-value="ai.settings"
                @update:model-value="settings"
              /><template #error
                ><p class="pipeline-error">
                  Settings could not load.
                  <button
                    type="button"
                    @click="
                      updateNode({ settings: createDefaultSettings(ai!.model) })
                    "
                  >
                    Restore defaults
                  </button>
                </p></template
              ></NuxtErrorBoundary
            >
          </details>
        </template>
        <template v-if="node.type === 'generate-image'"
          ><label class="pipeline-label" for="pipeline-generation-prompt"
            >Prompt</label
          ><textarea
            id="pipeline-generation-prompt"
            class="pipeline-input"
            :value="node.config.prompt"
            rows="6"
            maxlength="20000"
            :disabled="disabled"
            placeholder="Describe the picture, or connect a text step."
            @input="text('prompt', $event)" />
          <p class="pipeline-help">
            A connected prompt is combined with these instructions. The input
            picture and references use the selected model’s limits.
          </p>
          <button
            type="button"
            class="pipeline-secondary"
            :disabled="disabled"
            @click="selectImage('referenceImages')"
          >
            <UIcon name="i-lucide-contact-round" />Choose identity & style
            references
          </button>
          <div class="pipeline-reference-list">
            <div v-for="url in node.config.referenceImages" :key="url">
              <img
                :src="imagePreviewUrl(url, 160)"
                alt="Generation reference"
                loading="lazy"
              /><button
                type="button"
                class="pipeline-icon"
                :disabled="disabled"
                aria-label="Remove generation reference"
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
                node.config.maskImage ? "Change mask" : "Choose mask picture"
              }}
            </button>
            <div v-if="node.config.maskImage" class="pipeline-reference-list">
              <img
                :src="imagePreviewUrl(node.config.maskImage, 160)"
                alt="Mask"
                loading="lazy"
              /><button
                type="button"
                class="pipeline-icon"
                :disabled="disabled"
                aria-label="Remove mask"
                @click="removeImage('maskImage', node.config.maskImage)"
              >
                <UIcon name="i-lucide-x" />
              </button></div></template
        ></template>
        <template v-if="node.type === 'remove-background'"
          ><label class="pipeline-label" for="pipeline-cutout-model"
            >CPU model</label
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
              {{ profile.label }}{{ profile.supportsTransparentBackground ? " · Transparent" : "" }}
            </option>
          </select>
          <p class="pipeline-help">
            $0 provider charge. One inference runs at a time. Full BiRefNet
            takes longer and needs more memory.
          </p></template
        >
        <template v-if="node.type === 'crop' || node.type === 'resize'"
          ><div class="pipeline-field-grid">
            <div>
              <label class="pipeline-label" for="pipeline-width"
                >Width (px)</label
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
                >Height (px)</label
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
              >Focus position</label
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
                {{ value }}
              </option>
            </select></template
          ><template v-else
            ><label class="pipeline-label" for="pipeline-fit">Fit</label
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
                {{ value }}
              </option></select
            ><label class="pipeline-label" for="pipeline-background-color"
              >Background</label
            ><input
              id="pipeline-background-color"
              class="pipeline-input"
              :value="node.config.background"
              :disabled="disabled"
              placeholder="transparent or #ffffff"
              @input="text('background', $event)"
          /></template>
          <p class="pipeline-help">
            Local image processing has $0 provider charge. Outputs are limited
            to 40 megapixels.
          </p></template
        >
        <template v-if="node.type === 'upscale'"
          ><label class="pipeline-label" for="pipeline-upscale-mode"
            >Method</label
          ><select
            id="pipeline-upscale-mode"
            class="pipeline-input"
            :value="node.config.mode"
            :disabled="disabled"
            @change="choice('mode', $event)"
          >
            <option value="standard">Standard · $0 provider charge</option>
            <option value="ai">AI detail · image model</option></select
          ><label class="pipeline-label" for="pipeline-upscale-factor"
            >Scale</label
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
            >Expand by</label
          ><select
            id="pipeline-expand-mode"
            class="pipeline-input"
            :value="node.config.mode"
            :disabled="disabled"
            @change="choice('mode', $event)"
          >
            <option value="pixels">Pixels</option>
            <option value="aspect-ratio">Aspect ratio</option>
          </select>
          <div v-if="node.config.mode === 'pixels'" class="pipeline-field-grid">
            <div v-for="side in ['top', 'bottom', 'left', 'right']" :key="side">
              <label class="pipeline-label" :for="`pipeline-expand-${side}`"
                >{{ side }} (px)</label
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
              >Target aspect ratio</label
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
            >Creativity · {{ node.config.creativity }}</label
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
            >Scene instructions</label
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
            AI expansion uses the selected image model and its final confirmed
            price.
          </p></template
        >
        <template v-if="node.type === 'translate'"
          ><label class="pipeline-label" for="pipeline-language"
            >Translate to</label
          ><input
            id="pipeline-language"
            class="pipeline-input"
            :value="node.config.language"
            maxlength="80"
            :disabled="disabled"
            @input="text('language', $event)"
          /><label class="pipeline-label" for="pipeline-translation-prompt"
            >Design instructions</label
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
          ><p class="pipeline-help">
            Gemini 2.5 Flash through AI Gateway. Text steps have confirmed usage
            costs too.
          </p>
          <label class="pipeline-label" for="pipeline-system-prompt"
            >System instruction</label
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
            >Additional instruction</label
          ><textarea
            id="pipeline-text-prompt"
            class="pipeline-input"
            rows="4"
            :value="node.config.prompt"
            maxlength="20000"
            :disabled="disabled"
            @input="text('prompt', $event)" />
          <div class="pipeline-field-grid">
            <div>
              <label class="pipeline-label" for="pipeline-temperature"
                >Temperature</label
              ><input
                id="pipeline-temperature"
                class="pipeline-input"
                type="number"
                min="0"
                max="2"
                step="0.1"
                :value="node.config.temperature"
                :disabled="disabled"
                @input="numeric('temperature', $event)"
              />
            </div>
            <div>
              <label class="pipeline-label" for="pipeline-text-tokens"
                >Max tokens</label
              ><input
                id="pipeline-text-tokens"
                class="pipeline-input"
                type="number"
                min="64"
                max="4096"
                :value="node.config.maxOutputTokens"
                :disabled="disabled"
                @input="numeric('maxOutputTokens', $event)"
              />
            </div></div
        ></template>
        <template v-if="node.type === 'prompt-concatenator'"
          ><label class="pipeline-label" for="pipeline-text-separator"
            >Separator</label
          ><select
            id="pipeline-text-separator"
            class="pipeline-input"
            :value="node.config.separator"
            :disabled="disabled"
            @change="choice('separator', $event)"
          >
            <option value="\n">New line</option>
            <option value="\n\n">Blank line</option>
            <option value=" ">Space</option>
            <option value=", ">Comma</option>
            <option value="">None</option>
          </select>
          <p class="pipeline-help">
            Text is joined in the order the connections were added.
          </p></template
        >
        <template v-if="node.type === 'output'"
          ><label class="pipeline-label" for="pipeline-output-format"
            >Image format</label
          ><select
            id="pipeline-output-format"
            class="pipeline-input"
            :value="node.config.format"
            :disabled="disabled"
            @change="choice('format', $event)"
          >
            <option value="original">Original</option>
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option></select
          ><template
            v-if="
              node.config.format === 'jpeg' || node.config.format === 'webp'
            "
            ><label class="pipeline-label" for="pipeline-output-quality"
              >Quality · {{ node.config.quality }}%</label
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
            Outputs stay private in your Library. Download links always serve
            their original full-size files.
          </p></template
        >
        <template v-if="node.type === 'sticky-note'"
          ><label class="pipeline-label" for="pipeline-note-text">Note</label
          ><textarea
            id="pipeline-note-text"
            class="pipeline-input"
            rows="8"
            :value="node.config.text"
            maxlength="4000"
            :disabled="disabled"
            @input="text('text', $event)"
          /><label class="pipeline-label" for="pipeline-note-color">Color</label
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
            >
              {{ value }}
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
        <UIcon name="i-lucide-play" />Run to this step
      </button>
      <div>
        <button
          type="button"
          class="pipeline-secondary"
          :disabled="disabled"
          @click="emit('duplicate')"
        >
          <UIcon name="i-lucide-copy" />Duplicate</button
        ><button
          type="button"
          class="pipeline-secondary pipeline-danger"
          :disabled="disabled"
          @click="emit('remove')"
        >
          <UIcon name="i-lucide-trash-2" />Delete
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
