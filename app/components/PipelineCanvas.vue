<script setup lang="ts">
import {
  getPipelineNodePorts,
  PIPELINE_LIMITS,
  type PipelineDefinition,
  type PipelineNode,
  type PipelineNodeType,
  type PipelineRunDTO,
} from "../../schemas/pipelines";
import { ImagePathSchema } from "../../schemas/image-generation";
import { hasConfirmedGenerationPrice } from "../../schemas/generation-billing";
import {
  PIPELINE_PALETTE,
  pipelineNodeDescription,
  pipelineNodeIcon,
} from "../utils/pipelineTemplates";
import {
  canvasPoint,
  clampCanvasPoint,
  connectionPath,
  fitCanvas,
  minimapBounds,
  PIPELINE_NODE_WIDTH,
  PIPELINE_PORT_SPACING,
  PIPELINE_PORT_TOP,
  zoomCanvas,
  type CanvasView,
  type CanvasPoint,
} from "../utils/pipelineEditor";
import { imagePreviewUrl } from "../utils/imageDelivery";
const props = defineProps<{
  definition: PipelineDefinition;
  selectedId: string | null;
  selectedEdgeId?: string | null;
  disabled?: boolean;
  run?: PipelineRunDTO | null;
}>();
const emit = defineEmits<{
  select: [id: string | null];
  "select-edge": [id: string | null];
  move: [id: string, position: CanvasPoint];
  add: [type: PipelineNodeType, position: CanvasPoint];
  connect: [
    source: string,
    sourcePort: "image" | "text",
    target: string,
    targetPort: string,
  ];
  duplicate: [id: string];
  remove: [id: string];
  "disconnect-node": [id: string];
  "remove-edge": [id: string];
  run: [id: string];
}>();
const canvas = ref<HTMLElement>();
const view = ref<CanvasView>({ x: 65, y: 65, zoom: 1 });
const paletteOpen = ref(false);
const paletteSearch = ref("");
const pendingSource = ref<{ id: string; port: "image" | "text" } | null>(null);
const draftPosition = ref<{ id: string; position: CanvasPoint } | null>(null);
const announcement = ref("");
const palette = computed(() =>
  PIPELINE_PALETTE.filter((item) =>
    `${item.group} ${item.description} ${item.type}`
      .toLowerCase()
      .includes(paletteSearch.value.toLowerCase()),
  ),
);
const groups = computed(() => [
  ...new Set(palette.value.map((item) => item.group)),
]);
const mapBounds = computed(() =>
  minimapBounds(props.definition.nodes.map((node) => position(node))),
);
const selectedNode = computed(() =>
  props.definition.nodes.find((node) => node.id === props.selectedId),
);
const pendingSourceLabel = computed(
  () =>
    props.definition.nodes.find((node) => node.id === pendingSource.value?.id)
      ?.label ?? "step",
);
let drag: {
  id: string;
  pointer: number;
  start: CanvasPoint;
  original: CanvasPoint;
} | null = null;
let pan: { pointer: number; start: CanvasPoint; original: CanvasView } | null =
  null;
function position(node: PipelineNode) {
  return draftPosition.value?.id === node.id
    ? draftPosition.value.position
    : node.position;
}
function portAnchor(node: PipelineNode, portId: string, output: boolean) {
  const ports = getPipelineNodePorts(node)[output ? "outputs" : "inputs"];
  const point = position(node);
  return {
    x: point.x + (output ? PIPELINE_NODE_WIDTH : 0),
    y:
      point.y +
      PIPELINE_PORT_TOP +
      Math.max(
        0,
        ports.findIndex((port) => port.id === portId),
      ) *
        PIPELINE_PORT_SPACING,
  };
}
function edgePath(edge: PipelineDefinition["edges"][number]) {
  const source = props.definition.nodes.find((node) => node.id === edge.source),
    target = props.definition.nodes.find((node) => node.id === edge.target);
  return source && target
    ? connectionPath(
        portAnchor(source, edge.sourcePort, true),
        portAnchor(target, edge.targetPort, false),
      )
    : "";
}
function select(id: string | null) {
  emit("select", id);
  emit("select-edge", null);
}
function add(type: PipelineNodeType) {
  if (props.disabled || props.definition.nodes.length >= PIPELINE_LIMITS.nodes)
    return;
  const bounds = canvas.value?.getBoundingClientRect();
  const point = canvasPoint(
    {
      x: (bounds?.left ?? 0) + (bounds?.width ?? 900) / 2,
      y: (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2,
    },
    bounds ?? { left: 0, top: 0 },
    view.value,
  );
  emit("add", type, clampCanvasPoint(point));
  paletteOpen.value = false;
  paletteSearch.value = "";
  announcement.value = `Added ${PIPELINE_PALETTE.find((value) => value.type === type)?.type.replaceAll("-", " ")}`;
}
function startMove(node: PipelineNode, event: PointerEvent) {
  if (props.disabled || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  select(node.id);
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  drag = {
    id: node.id,
    pointer: event.pointerId,
    start: { x: event.clientX, y: event.clientY },
    original: { ...node.position },
  };
  draftPosition.value = { id: node.id, position: { ...node.position } };
}
function move(event: PointerEvent) {
  if (drag && event.pointerId === drag.pointer) {
    draftPosition.value = {
      id: drag.id,
      position: clampCanvasPoint({
        x: drag.original.x + (event.clientX - drag.start.x) / view.value.zoom,
        y: drag.original.y + (event.clientY - drag.start.y) / view.value.zoom,
      }),
    };
  } else if (pan && event.pointerId === pan.pointer) {
    view.value = {
      ...view.value,
      x: pan.original.x + event.clientX - pan.start.x,
      y: pan.original.y + event.clientY - pan.start.y,
    };
  }
}
function endMove(event: PointerEvent) {
  if (drag && event.pointerId === drag.pointer) {
    if (draftPosition.value)
      emit("move", drag.id, draftPosition.value.position);
    drag = null;
    draftPosition.value = null;
  } else if (pan && event.pointerId === pan.pointer) pan = null;
}
function beginPan(event: PointerEvent) {
  if (event.button !== 0 || event.target !== event.currentTarget) return;
  pan = {
    pointer: event.pointerId,
    start: { x: event.clientX, y: event.clientY },
    original: { ...view.value },
  };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  select(null);
  pendingSource.value = null;
}
function moveKey(node: PipelineNode, event: KeyboardEvent) {
  if (props.disabled) return;
  const amount = event.shiftKey ? 100 : 20;
  const directions: Record<string, CanvasPoint> = {
    ArrowLeft: { x: -amount, y: 0 },
    ArrowRight: { x: amount, y: 0 },
    ArrowUp: { x: 0, y: -amount },
    ArrowDown: { x: 0, y: amount },
  };
  const direction = directions[event.key];
  if (direction) {
    event.preventDefault();
    emit(
      "move",
      node.id,
      clampCanvasPoint({
        x: node.position.x + direction.x,
        y: node.position.y + direction.y,
      }),
    );
    announcement.value = `Moved ${node.label}`;
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    select(node.id);
  } else if (event.key === "Delete") {
    event.preventDefault();
    emit("disconnect-node", node.id);
    announcement.value = `Disconnected ${node.label}`;
  }
}
function outputPort(node: PipelineNode, port: "image" | "text") {
  if (props.disabled) return;
  pendingSource.value =
    pendingSource.value?.id === node.id && pendingSource.value.port === port
      ? null
      : { id: node.id, port };
  announcement.value = pendingSource.value
    ? `Choose a compatible input for ${node.label}`
    : "Connection cancelled";
}
function inputPort(node: PipelineNode, port: string) {
  if (props.disabled) return;
  if (!pendingSource.value) {
    select(node.id);
    announcement.value =
      "Choose a source in Connections or click an output first.";
    return;
  }
  emit(
    "connect",
    pendingSource.value.id,
    pendingSource.value.port,
    node.id,
    port,
  );
  pendingSource.value = null;
}
function zoom(amount: number) {
  const bounds = canvas.value?.getBoundingClientRect();
  view.value = zoomCanvas(view.value, view.value.zoom + amount, {
    x: (bounds?.width ?? 900) / 2,
    y: (bounds?.height ?? 600) / 2,
  });
}
function wheel(event: WheelEvent) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const bounds = canvas.value?.getBoundingClientRect();
  view.value = zoomCanvas(
    view.value,
    view.value.zoom + (event.deltaY > 0 ? -0.08 : 0.08),
    {
      x: event.clientX - (bounds?.left ?? 0),
      y: event.clientY - (bounds?.top ?? 0),
    },
  );
}
function fit() {
  const bounds = canvas.value?.getBoundingClientRect();
  view.value = fitCanvas(
    props.definition.nodes.map((node) => node.position),
    bounds?.width ?? 1000,
    bounds?.height ?? 650,
  );
}
function image(node: PipelineNode) {
  const value = props.run?.items[0]?.steps
    .find((step) => step.nodeId === node.id)
    ?.value?.images.find(
      (value) =>
        ImagePathSchema.safeParse(value.url).success &&
        (value.generationId === undefined ||
          hasConfirmedGenerationPrice(value)),
    );
  if (value) return value.url;
  if (node.type === "image-input") return node.config.defaultImage;
  if (node.type === "static-image" || node.type === "people-input")
    return node.config.images[0];
  return null;
}
function stepState(node: PipelineNode) {
  return props.run?.items[0]?.steps.find((step) => step.nodeId === node.id)
    ?.status;
}
function canvasKey(event: KeyboardEvent) {
  if (event.target !== event.currentTarget) return;
  if (event.key === "Escape") {
    pendingSource.value = null;
    paletteOpen.value = false;
    select(null);
  }
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoom(0.1);
  }
  if (event.key === "-") {
    event.preventDefault();
    zoom(-0.1);
  }
  if (event.key === "0") {
    event.preventDefault();
    fit();
  }
}
watch(
  () => props.definition.nodes.length,
  () => {
    if (
      !props.definition.nodes.some(
        (node) => node.id === pendingSource.value?.id,
      )
    )
      pendingSource.value = null;
  },
);
defineExpose({ fit, view, paletteOpen, pendingSource, add });
</script>

<template>
  <div class="pipeline-canvas-shell">
    <div
      ref="canvas"
      class="pipeline-canvas"
      role="region"
      aria-label="Pipeline node canvas"
      tabindex="0"
      :style="{
        '--pipeline-grid-size': `${28 * view.zoom}px`,
        '--pipeline-grid-x': `${view.x}px`,
        '--pipeline-grid-y': `${view.y}px`,
      }"
      @pointerdown="beginPan"
      @pointermove="move"
      @pointerup="endMove"
      @pointercancel="endMove"
      @wheel="wheel"
      @keydown="canvasKey"
    >
      <div
        class="pipeline-canvas-world"
        :style="{
          transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})`,
        }"
      >
        <svg class="pipeline-connections" aria-hidden="true">
          <g v-for="edge in definition.edges" :key="edge.id">
            <path
              class="pipeline-edge-hit"
              :d="edgePath(edge)"
              @click.stop="
                emit('select-edge', edge.id);
                emit('select', null);
              "
            />
            <path
              class="pipeline-edge"
              :class="[
                `pipeline-edge-${edge.sourcePort}`,
                { 'is-selected': selectedEdgeId === edge.id },
              ]"
              :d="edgePath(edge)"
            />
          </g>
        </svg>
        <article
          v-for="node in definition.nodes"
          :key="node.id"
          class="pipeline-node"
          :class="[
            {
              'is-selected': selectedId === node.id,
              'is-sticky': node.type === 'sticky-note',
            },
            node.type === 'sticky-note'
              ? `pipeline-note-${node.config.color}`
              : '',
            stepState(node) ? `pipeline-node-${stepState(node)}` : '',
          ]"
          :style="{
            left: `${position(node).x}px`,
            top: `${position(node).y}px`,
          }"
          :aria-label="`${node.label}, ${node.type.replaceAll('-', ' ')}`"
          @click.stop="select(node.id)"
        >
          <header
            class="pipeline-node-header"
            role="button"
            tabindex="0"
            :aria-label="`Select or move ${node.label}. Arrow keys move; Shift moves farther. Delete disconnects.`"
            @pointerdown="startMove(node, $event)"
            @pointermove="move"
            @pointerup="endMove"
            @pointercancel="endMove"
            @keydown.stop="moveKey(node, $event)"
          >
            <span class="pipeline-node-icon"
              ><UIcon :name="pipelineNodeIcon(node.type)" /></span
            ><span>{{ node.label }}</span
            ><UIcon name="i-lucide-grip" class="pipeline-node-grip" />
          </header>
          <p class="pipeline-node-description">
            {{ pipelineNodeDescription(node) }}
          </p>
          <div class="pipeline-node-ports">
            <div>
              <button
                v-for="port in getPipelineNodePorts(node).inputs"
                :key="port.id"
                class="pipeline-port pipeline-port-input"
                type="button"
                :class="`pipeline-port-${port.type}`"
                :disabled="disabled"
                :aria-label="`Connect ${node.label} ${port.label} input`"
                @click.stop="inputPort(node, port.id)"
              >
                <i /><span>{{ port.label }}</span
                ><small v-if="port.required">*</small>
              </button>
            </div>
            <div>
              <button
                v-for="port in getPipelineNodePorts(node).outputs"
                :key="port.id"
                class="pipeline-port pipeline-port-output"
                type="button"
                :class="[
                  `pipeline-port-${port.type}`,
                  {
                    'is-connecting':
                      pendingSource?.id === node.id &&
                      pendingSource?.port === port.id,
                  },
                ]"
                :disabled="disabled"
                :aria-pressed="
                  pendingSource?.id === node.id &&
                  pendingSource?.port === port.id
                "
                :aria-label="`Connect from ${node.label} ${port.label} output`"
                @click.stop="outputPort(node, port.id as 'image' | 'text')"
              >
                <span>{{ port.label }}</span
                ><i />
              </button>
            </div>
          </div>
          <div v-if="image(node)" class="pipeline-node-preview">
            <img
              :src="imagePreviewUrl(image(node)!, 160)"
              :alt="`${node.label} preview`"
              loading="lazy"
              decoding="async"
            />
          </div>
          <footer v-if="node.type !== 'sticky-note'">
            <button
              type="button"
              :disabled="disabled"
              :aria-label="`Run to ${node.label}`"
              @click.stop="emit('run', node.id)"
            >
              <UIcon name="i-lucide-play" />Run step</button
            ><span v-if="stepState(node)" class="pipeline-node-state">{{
              stepState(node)?.replaceAll("-", " ")
            }}</span
            ><button
              class="pipeline-node-delete"
              type="button"
              :disabled="disabled"
              :aria-label="`Delete ${node.label}`"
              @click.stop="emit('remove', node.id)"
            >
              <UIcon name="i-lucide-trash-2" />
            </button>
          </footer>
        </article>
      </div>
    </div>
    <div class="pipeline-canvas-top">
      <button
        type="button"
        class="pipeline-add-step"
        :disabled="disabled || definition.nodes.length >= PIPELINE_LIMITS.nodes"
        :aria-expanded="paletteOpen"
        aria-controls="pipeline-node-palette"
        @click="paletteOpen = !paletteOpen"
      >
        <UIcon name="i-lucide-plus" />Add step</button
      ><span class="pipeline-canvas-hint"
        >Connect an output dot to an input · drag the background to pan</span
      >
    </div>
    <aside
      v-if="paletteOpen"
      id="pipeline-node-palette"
      class="pipeline-node-palette"
      aria-label="Add a pipeline step"
    >
      <header>
        <strong>Choose a step</strong
        ><button
          type="button"
          class="pipeline-icon"
          aria-label="Close step palette"
          @click="paletteOpen = false"
        >
          <UIcon name="i-lucide-x" />
        </button>
      </header>
      <input
        v-model="paletteSearch"
        class="pipeline-palette-search"
        placeholder="Search tools…"
        aria-label="Search pipeline steps"
      />
      <section v-for="group in groups" :key="group">
        <h3>{{ group }}</h3>
        <button
          v-for="item in palette.filter((value) => value.group === group)"
          :key="item.type"
          type="button"
          @click="add(item.type)"
        >
          <UIcon :name="item.icon" /><span
            ><strong>{{
              item.type === "llm"
                ? "LLM"
                : item.type
                    .split("-")
                    .map((word) => word[0]!.toUpperCase() + word.slice(1))
                    .join(" ")
            }}</strong
            ><small>{{ item.description }}</small></span
          >
        </button>
      </section>
      <p v-if="!palette.length">No matching tools.</p>
    </aside>
    <div v-if="pendingSource" class="pipeline-connection-notice" role="status">
      Connecting {{ pendingSourceLabel }}. Choose an input dot.<button
        type="button"
        @click="pendingSource = null"
      >
        Cancel
      </button>
    </div>
    <div v-if="selectedEdgeId" class="pipeline-edge-tools">
      <span>Connection selected</span
      ><button
        type="button"
        :disabled="disabled"
        @click="emit('remove-edge', selectedEdgeId!)"
      >
        <UIcon name="i-lucide-unplug" />Remove
      </button>
    </div>
    <div class="pipeline-canvas-bottom">
      <div class="pipeline-canvas-controls">
        <button type="button" aria-label="Zoom out" @click="zoom(-0.1)">
          <UIcon name="i-lucide-minus" /></button
        ><span>{{ Math.round(view.zoom * 100) }}%</span
        ><button type="button" aria-label="Zoom in" @click="zoom(0.1)">
          <UIcon name="i-lucide-plus" /></button
        ><button type="button" aria-label="Fit pipeline to canvas" @click="fit">
          <UIcon name="i-lucide-expand" /></button
        ><button
          type="button"
          aria-label="Reset canvas zoom"
          @click="view = { x: 65, y: 65, zoom: 1 }"
        >
          <UIcon name="i-lucide-locate-fixed" />
        </button>
      </div>
      <svg
        v-if="definition.nodes.length"
        class="pipeline-minimap"
        :viewBox="`${mapBounds.left} ${mapBounds.top} ${mapBounds.width} ${mapBounds.height}`"
        role="img"
        aria-label="Pipeline overview"
      >
        <rect
          v-for="node in definition.nodes"
          :key="node.id"
          :x="position(node).x"
          :y="position(node).y"
          :width="PIPELINE_NODE_WIDTH"
          :height="176"
          :class="{ 'is-selected': selectedId === node.id }"
        />
        <rect
          class="pipeline-minimap-viewport"
          :x="-view.x / view.zoom"
          :y="-view.y / view.zoom"
          :width="(canvas?.clientWidth ?? 900) / view.zoom"
          :height="(canvas?.clientHeight ?? 600) / view.zoom"
        />
      </svg>
    </div>
    <p class="pipeline-sr-only" aria-live="polite">{{ announcement }}</p>
    <div v-if="!definition.nodes.length" class="pipeline-empty-canvas">
      <UIcon name="i-lucide-workflow" />
      <h2>A blank canvas, a repeatable process</h2>
      <p>Add an input and connect it to your first tool.</p>
      <button
        type="button"
        class="pipeline-add-step"
        :disabled="disabled"
        @click="paletteOpen = true"
      >
        Add your first step
      </button>
    </div>
  </div>
</template>

<style scoped>
.pipeline-canvas-shell {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #1d1b18;
}
.pipeline-canvas {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: none;
  background-image: radial-gradient(#5e554638 0.8px, transparent 0.8px);
  background-size: var(--pipeline-grid-size) var(--pipeline-grid-size);
  background-position: var(--pipeline-grid-x) var(--pipeline-grid-y);
  cursor: grab;
}
.pipeline-canvas:active {
  cursor: grabbing;
}
.pipeline-canvas-world {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  transform-origin: 0 0;
}
.pipeline-connections {
  position: absolute;
  left: 0;
  top: 0;
  width: 1px;
  height: 1px;
  overflow: visible;
  pointer-events: none;
}
.pipeline-edge {
  fill: none;
  stroke: #9d9878;
  stroke-width: 2;
  pointer-events: none;
}
.pipeline-edge-text {
  stroke: #a78665;
}
.pipeline-edge.is-selected {
  stroke: var(--workspace-accent);
  stroke-width: 3;
}
.pipeline-edge-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 18;
  pointer-events: stroke;
  cursor: pointer;
}
.pipeline-node {
  position: absolute;
  width: 246px;
  background: var(--workspace-surface);
  border: 1px solid #4d463a;
  border-radius: 13px;
  box-shadow: 0 9px 25px #0003;
  cursor: default;
  user-select: none;
}
.pipeline-node.is-selected {
  border-color: var(--workspace-accent);
  box-shadow:
    0 0 0 1px var(--workspace-accent),
    0 10px 28px #0004;
}
.pipeline-node-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 14px;
  touch-action: none;
  cursor: grab;
  border-radius: 13px 13px 0 0;
}
.pipeline-node-header > span:nth-child(2) {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  font-weight: 550;
}
.pipeline-node-icon {
  width: 27px;
  height: 27px;
  border-radius: 7px;
  background: #42352b;
  display: grid;
  place-items: center;
  flex: none;
  color: var(--workspace-accent);
}
.pipeline-node-icon .iconify {
  width: 14px;
  height: 14px;
}
.pipeline-node-grip {
  color: #716856;
  width: 12px;
  height: 12px;
  flex: none;
}
.pipeline-node-description {
  font-size: 9px;
  line-height: 1.7;
  color: var(--workspace-muted);
  padding: 0 15px;
  height: 31px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.pipeline-node-ports {
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin: 13px 0 15px;
  min-height: 28px;
  gap: 3px;
}
.pipeline-node-ports > div:last-child {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.pipeline-port {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 28px;
  font-size: 9px;
  color: #b3ac9c;
  position: relative;
  min-width: 0;
}
.pipeline-port small {
  font-size: 9px;
  color: #cbb895;
}
.pipeline-port-input {
  justify-content: flex-start;
  padding-left: 14px;
}
.pipeline-port-output {
  justify-content: flex-end;
  padding-right: 14px;
}
.pipeline-port i {
  position: absolute;
  width: 10px;
  height: 10px;
  border: 2px solid #a8b085;
  border-radius: 50%;
  background: #26251e;
  flex: none;
  box-shadow: 0 0 0 3px #25231f;
}
.pipeline-port-input i {
  left: -6px;
}
.pipeline-port-output i {
  right: -6px;
}
.pipeline-port-text i {
  border-color: #d0a37c;
}
.pipeline-port-media i {
  border-color: #c4b694;
}
.pipeline-port:hover i,
.pipeline-port.is-connecting i {
  background: var(--workspace-accent);
  border-color: var(--workspace-accent);
}
.pipeline-node > footer {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 13px;
  border-top: 1px solid var(--workspace-border);
  background: #211f1b75;
  border-radius: 0 0 13px 13px;
}
.pipeline-node > footer > button {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 9px;
  color: var(--workspace-muted);
}
.pipeline-node > footer .iconify {
  width: 11px;
  height: 11px;
}
.pipeline-node > footer > .pipeline-node-delete {
  margin-left: auto;
  display: grid;
  place-items: center;
  flex: none;
}
.pipeline-node-state {
  font-size: 8px;
  color: #d5b494;
  margin-left: auto;
}
.pipeline-node-succeeded .pipeline-node-state {
  color: #b8c89b;
}
.pipeline-node-preview {
  height: 82px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 13px 13px;
  border: 1px solid var(--workspace-border);
  background: var(--workspace-bg);
  border-radius: 7px;
}
.pipeline-node-preview img {
  max-width: 100%;
  height: 100%;
  object-fit: contain;
}
.pipeline-node.is-sticky {
  background: #493d26;
  border-color: #6f5e36;
  min-height: 170px;
}
.pipeline-node.is-sticky .pipeline-node-icon {
  background: transparent;
  color: #d2b66f;
}
.pipeline-node.is-sticky .pipeline-node-description {
  height: auto;
  min-height: 80px;
  display: block;
  white-space: pre-wrap;
  padding-bottom: 17px;
  color: #dac9a6;
}
.pipeline-note-rose.is-sticky {
  background: #493031;
  border-color: #724849;
}
.pipeline-note-sage.is-sticky {
  background: #303c2d;
  border-color: #526646;
}
.pipeline-note-blue.is-sticky {
  background: #2e3a43;
  border-color: #476172;
}
.pipeline-canvas-top {
  position: absolute;
  left: 22px;
  top: 20px;
  display: flex;
  align-items: center;
  gap: 15px;
  pointer-events: none;
  max-width: calc(100% - 44px);
}
.pipeline-add-step {
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font-size: 10px;
  padding: 10px 13px;
  border-radius: 9px;
  border: 1px solid #6e5942;
  color: #edc4a0;
  background: #352b22;
  box-shadow: 0 4px 15px #0002;
}
.pipeline-add-step .iconify {
  width: 13px;
  height: 13px;
}
.pipeline-canvas-hint {
  font-size: 9px;
  color: #8d8475;
  pointer-events: none;
  line-height: 1.6;
}
.pipeline-node-palette {
  position: absolute;
  top: 67px;
  left: 22px;
  width: 316px;
  max-width: calc(100% - 44px);
  max-height: calc(100% - 160px);
  overflow: auto;
  z-index: 22;
  border: 1px solid var(--workspace-border);
  background: var(--workspace-surface);
  border-radius: 12px;
  padding: 15px;
  box-shadow: 0 18px 60px #0008;
}
.pipeline-node-palette header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.pipeline-node-palette header strong {
  font-size: 12px;
  font-weight: 550;
}
.pipeline-icon {
  display: grid;
  place-items: center;
  color: var(--workspace-muted);
  width: 26px;
  height: 26px;
  border-radius: 6px;
}
.pipeline-icon .iconify {
  width: 13px;
  height: 13px;
}
.pipeline-palette-search {
  width: 100%;
  border: 1px solid var(--workspace-border);
  border-radius: 7px;
  background: var(--workspace-bg);
  padding: 10px;
  font-size: 10px;
}
.pipeline-node-palette section {
  margin-top: 18px;
}
.pipeline-node-palette h3 {
  font-size: 9px;
  color: var(--workspace-muted);
  letter-spacing: 0.6px;
  text-transform: uppercase;
  margin-bottom: 8px;
}
.pipeline-node-palette section > button {
  display: flex;
  width: 100%;
  align-items: start;
  gap: 11px;
  text-align: left;
  padding: 10px 7px;
  border-radius: 8px;
}
.pipeline-node-palette section > button:hover {
  background: var(--workspace-surface-raised);
}
.pipeline-node-palette section > button > .iconify {
  width: 16px;
  height: 16px;
  color: var(--workspace-accent);
  margin-top: 2px;
  flex: none;
}
.pipeline-node-palette button strong {
  font-size: 11px;
  font-weight: 500;
}
.pipeline-node-palette button small {
  display: block;
  font-size: 9px;
  color: var(--workspace-muted);
  line-height: 1.7;
  margin-top: 4px;
}
.pipeline-node-palette > p {
  font-size: 11px;
  color: var(--workspace-muted);
  padding: 15px 0;
}
.pipeline-canvas-bottom {
  position: absolute;
  bottom: 20px;
  left: 22px;
  right: 22px;
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 15px;
  pointer-events: none;
}
.pipeline-canvas-controls {
  display: flex;
  align-items: center;
  border: 1px solid var(--workspace-border);
  border-radius: 9px;
  padding: 4px;
  background: var(--workspace-surface);
  box-shadow: 0 5px 20px #0003;
  pointer-events: auto;
}
.pipeline-canvas-controls button {
  display: grid;
  place-items: center;
  width: 29px;
  height: 29px;
  color: var(--workspace-muted);
  border-radius: 5px;
}
.pipeline-canvas-controls button:hover {
  background: var(--workspace-surface-raised);
  color: var(--workspace-text);
}
.pipeline-canvas-controls .iconify {
  width: 14px;
  height: 14px;
}
.pipeline-canvas-controls span {
  font-size: 9px;
  color: var(--workspace-muted);
  width: 40px;
  text-align: center;
}
.pipeline-minimap {
  width: 160px;
  height: 90px;
  background: #25231fdd;
  border: 1px solid #494234;
  border-radius: 8px;
  pointer-events: none;
}
.pipeline-minimap rect {
  fill: #827054;
  stroke: #ba9a71;
  stroke-width: 7;
}
.pipeline-minimap rect.is-selected {
  fill: #e3ad7e;
}
.pipeline-minimap .pipeline-minimap-viewport {
  fill: #f4ddbb0d;
  stroke: #d2b38e;
  stroke-width: 8;
}
.pipeline-connection-notice,
.pipeline-edge-tools {
  position: absolute;
  bottom: 75px;
  left: 22px;
  display: flex;
  gap: 12px;
  align-items: center;
  border: 1px solid #756046;
  border-radius: 8px;
  padding: 10px 12px;
  background: #3c3025;
  font-size: 10px;
  color: #e8c6a2;
  max-width: calc(100% - 44px);
  line-height: 1.6;
}
.pipeline-connection-notice button,
.pipeline-edge-tools button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--workspace-accent);
  white-space: nowrap;
}
.pipeline-edge-tools .iconify {
  width: 12px;
  height: 12px;
}
.pipeline-empty-canvas {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
  max-width: 400px;
  width: 80%;
  pointer-events: none;
}
.pipeline-empty-canvas > .iconify {
  width: 32px;
  height: 32px;
  color: var(--workspace-accent);
}
.pipeline-empty-canvas h2 {
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.5px;
  margin-top: 18px;
}
.pipeline-empty-canvas p {
  font-size: 11px;
  line-height: 1.8;
  color: var(--workspace-muted);
  margin: 12px 0 22px;
}
.pipeline-empty-canvas button {
  margin: auto;
  pointer-events: auto;
}
.pipeline-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 700px) {
  .pipeline-canvas-hint {
    display: none;
  }
  .pipeline-canvas-top {
    left: 15px;
    top: 15px;
  }
  .pipeline-canvas-bottom {
    left: 15px;
    right: 15px;
    bottom: 15px;
  }
  .pipeline-minimap {
    width: 95px;
    height: 60px;
  }
  .pipeline-node-palette {
    left: 15px;
    top: 60px;
  }
  .pipeline-connection-notice,
  .pipeline-edge-tools {
    left: 15px;
    bottom: 67px;
    font-size: 9px;
  }
}
</style>
