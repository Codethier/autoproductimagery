<script setup lang="ts">
import {
  getPipelineExecutionNodes,
  getPipelineNodePorts,
  createPipelineNode,
  PipelineDefinitionSchema,
  PipelineNodeSchema,
  pipelineRunIssues,
  SavePipelineSchema,
  StartPipelineRunSchema,
  PIPELINE_LIMITS,
  type PipelineDefinition,
  type PipelineNode,
  type PipelineNodeType,
  type PipelineDTO,
  type PipelineListDTO,
  type PipelineRunDTO,
  type PipelineRunListDTO,
} from "../../schemas/pipelines";
import {getPipelineDisplayNodes} from '../../schemas/pipeline-display';
import {serverlessFetchOptions} from '../utils/serverlessRequests';
import {
  ImagePathSchema,
  IMAGE_MODEL_PROFILES,
} from "../../schemas/image-generation";
import type { SelectableFile } from "../../schemas/main.dto";
import { parseUsdUnits } from "../../schemas/account-billing";
import { formatBalanceUsd, formatUsd } from "../utils/generationPrice";
import { imagePreviewUrl } from "../utils/imageDelivery";
import {pipelineNodeUsesCredit, pipelineRetryUsesCredit, pipelineRerunUsesCredit, pipelineJobRerunBlockedReason} from '../utils/pipelineCredit';
import {
  PIPELINE_TEMPLATES,
  pipelineNodeIcon,
  pipelineNodeLabel,
  pipelineTemplateText,
  type PipelineTemplate,
  type PipelineTranslate,
} from "../utils/pipelineTemplates";
import type { Ref } from "vue";
import {
  copyPipeline,
  createPipelineHistory,
  createsPipelineCycle,
  pipelineFingerprint,
  clampCanvasPoint,
  type CanvasPoint,
} from "../utils/pipelineEditor";
import PipelineCanvas from "./PipelineCanvas.vue";
import PipelineNodeProperties from "./PipelineNodeProperties.vue";
import PipelineRunResults from "./PipelineRunResults.vue";

const account = useAccount(),
  balance = useAccountBalance(),
  generationCredit = useGenerationCredit(),
  requestFetch = useRequestFetch(),
  route = useRoute();
const { t, locale } = useI18n();
const translate: PipelineTranslate = (key, params) => t(key, params ?? {});
type UiMessage = { key: string; params?: Record<string, unknown> };
// Messages kept in refs are stored as translated text (callers and child
// components read strings), and re-translated when the language changes as
// long as the ref still shows the message this component wrote.
const localizedMessages = new Map<Ref<string>, UiMessage & { text: string }>();
function say(target: Ref<string>, value: UiMessage) {
  const text = t(value.key, value.params ?? {});
  localizedMessages.set(target, { ...value, text });
  target.value = text;
}
watch(locale, () => {
  for (const [target, entry] of localizedMessages) {
    if (target.value !== entry.text) {
      localizedMessages.delete(target);
      continue;
    }
    entry.text = t(entry.key, entry.params ?? {});
    target.value = entry.text;
  }
});
const pipelines = ref<PipelineDTO[]>([]),
  nextCursor = ref<string | null>(null),
  search = ref(""),
  keyword = ref("");
const loading = ref(false),
  loadingMore = ref(false),
  editorLoading = ref(false),
  saving = ref(false),
  creating = ref(false);
const errorMessage = ref(""),
  saveError = ref(""),
  runError = ref(""),
  runWakeNotice = ref(""),
  notice = ref("");
const pipeline = ref<PipelineDTO | null>(null),
  definition = ref<PipelineDefinition>({ version: 1, nodes: [], edges: [] });
const name = ref(t("pipelines.untitled")),
  description = ref(""),
  editing = ref(false),
  metadataOpen = ref(false);
const selectedId = ref<string | null>(null),
  selectedEdgeId = ref<string | null>(null),
  copiedNode = ref<PipelineNode | null>(null);
const savedFingerprint = ref(""),
  conflict = ref(false),
  importInput = ref<HTMLInputElement>(),
  canvasComponent = ref<InstanceType<typeof PipelineCanvas>>();
const models = ref<Array<{ id: string; catalogStatus: string }>>([]);
const picker = ref<{
  nodeId: string;
  field:
    | "images"
    | "referenceImages"
    | "maskImage"
    | "defaultImage"
    | "batch"
    | "run-input";
  urls: string[];
  limit: number;
} | null>(null);
const pickerTab = ref<"library" | "people">("library"),
  pickerUrls = ref<string[]>([]);
const peopleOnlyPicker = computed(
  () =>
    picker.value?.field === "images" &&
    definition.value.nodes.some(
      (node) => node.id === picker.value?.nodeId && node.type === "people-input",
    ),
);
const runMode = ref<"prepare" | "results" | "history" | null>(null),
  runTarget = ref<string | null>(null),
  batchInput = ref(""),
  batchImages = ref<string[]>([]),
  runInputs = ref<Record<string, string>>({});
const starting = ref(false),
  activeRun = ref<PipelineRunDTO | null>(null),
  runRefreshing = ref(false),
  runMutating = ref(false),
  pollingPaused = ref(false);
const runHistory = ref<PipelineRunListDTO["runs"]>([]),
  runCursor = ref<string | null>(null),
  historyLoading = ref(false);
const deleteOpen = ref(false),
  deleting = ref(false),
  discardOpen = ref(false);
let revision = 0,
  listNumber = 0,
  detailNumber = 0,
  editorVersion = 0,
  runNumber = 0,
  prepareVersion = 0,
  pollAttempts = 0,
  mounted = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined,
  saveTimer: ReturnType<typeof setTimeout> | undefined,
  pollTimer: ReturnType<typeof setTimeout> | undefined;
let savePromise: Promise<PipelineDTO | null> | null = null;
const requests = new Set<AbortController>();
let focusBeforeDialog: HTMLElement | null = null;
const history = createPipelineHistory<PipelineDefinition>(definition.value);
const historyVersion = ref(0);
const selectedNode = computed(
  () =>
    definition.value.nodes.find((node) => node.id === selectedId.value) ?? null,
);
const body = computed(() => ({
  name: name.value.trim(),
  description: description.value.trim(),
  definition: definition.value,
}));
const dirty = computed(
  () =>
    editing.value && pipelineFingerprint(body.value) !== savedFingerprint.value,
);
const canUndo = computed(() => {
    void historyVersion.value;
    return history.canUndo;
  }),
  canRedo = computed(() => {
    void historyVersion.value;
    return history.canRedo;
  });
const executionNodes = computed(() =>
  getPipelineDisplayNodes(getPipelineExecutionNodes(definition.value, runTarget.value ?? undefined)),
);
const inputNodes = computed(() =>
  executionNodes.value.filter(
    (node) => node.type === "image-input" || node.type === "text-input",
  ),
);
const imageInputs = computed(() =>
  inputNodes.value.filter((node) => node.type === "image-input"),
);
const isRunActive = computed(
  () =>
    activeRun.value &&
    ["queued", "running", "awaiting-price"].includes(activeRun.value.status),
);
type RunResponse = {run: PipelineRunDTO; workerWake?: 'accepted' | 'unavailable' | 'not-configured'};
function applyRunResponse(response: RunResponse) {
  if (activeRun.value?.id !== response.run.id) runWakeNotice.value = '';
  activeRun.value = response.run;
  if (!isRunActive.value || response.workerWake === 'accepted') runWakeNotice.value = '';
  else if (response.workerWake === 'unavailable') say(runWakeNotice, {key: 'pipelines.run.wakeUnavailable'});
  else if (response.workerWake === 'not-configured') say(runWakeNotice, {key: 'pipelines.run.wakeNotConfigured'});
}
const runIssues = computed(() => [
  ...pipelineRunIssues(definition.value, runTarget.value ?? undefined),
  ...executionNodes.value.flatMap((node) => {
    if (node.type === "upscale" && node.config.mode === "standard") return [];
    if (!("settings" in node.config) || !("model" in node.config)) return [];
    const selectedModel = node.config.model;
    const profile = IMAGE_MODEL_PROFILES[selectedModel];
    if (profile.requiresMask && node.type !== "generate-image")
      return [t("pipelines.run.issueMaskModel", { label: node.label })];
    if (
      models.value.length &&
      !models.value.some(
        (value) =>
          value.id === selectedModel && value.catalogStatus !== "unavailable",
      )
    )
      return [t("pipelines.run.issueModelUnavailable", { label: node.label })];
    return [];
  }),
]);
const paidWork = computed(() =>
  executionNodes.value.some(pipelineNodeUsesCredit),
);
const creditBlockReason = computed(() => {
  const value = balance.balance.value;
  if (!paidWork.value || !value || value.unlimited) return "";
  if (
    !value.actualBalanceUsd ||
    value.actualBalanceUsd.startsWith("-") ||
    parseUsdUnits(value.actualBalanceUsd) === 0n
  )
    return t("pipelines.run.creditExhausted");
  if (value.generationBlockedByOutstanding ?? value.outstandingCount > 0)
    return t("pipelines.run.creditOutstanding");
  return "";
});
const canStart = computed(
  () =>
    !starting.value &&
    !saving.value &&
    !conflict.value &&
    !runIssues.value.length &&
    !generationCredit.checking.value &&
    !(paidWork.value && generationCredit.outstandingBlocked.value) &&
    inputNodes.value.every((node) => {
      if (node.type === "image-input")
        return (
          !node.config.required ||
          (node.id === batchInput.value && batchImages.value.length > 0) ||
          Boolean(runInputs.value[node.id] || node.config.defaultImage)
        );
      if (node.type === "text-input")
        return (
          !node.config.required ||
          Boolean((runInputs.value[node.id] ?? node.config.defaultValue).trim())
        );
      return true;
    }),
);
function snapshot() {
  return {
    epoch: account.epoch.value,
    identity: account.identity.value,
    revision,
  };
}
function current(value: ReturnType<typeof snapshot>) {
  return (
    value.epoch === account.epoch.value &&
    value.identity === account.identity.value &&
    value.revision === revision
  );
}
async function request<T>(
  url: string,
  options: {
    method?: "POST" | "PATCH" | "DELETE";
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
    timeout?: number;
  } = {},
) {
  const controller = new AbortController();
  requests.add(controller);
  try {
    return await requestFetch<T>(url, serverlessFetchOptions({
      ...options,
      signal: controller.signal,
    }, account.epoch.value));
  } finally {
    requests.delete(controller);
  }
}
function statusCode(error: unknown) {
  return (
    (error as { statusCode?: number; status?: number })?.statusCode ??
    (error as { status?: number })?.status
  );
}
function message(error: unknown, fallbackKey: string): UiMessage {
  const code = statusCode(error);
  if (code === 429) return { key: "pipelines.errors.queueFull" };
  if (code === 403 || code === 404)
    return { key: "pipelines.errors.unavailable" };
  if (code === 409) return { key: "pipelines.errors.conflict" };
  return { key: fallbackKey };
}
function stopRequests() {
  revision += 1;
  clearTimeout(saveTimer);
  clearTimeout(pollTimer);
  clearTimeout(searchTimer);
  saveTimer = undefined;
  pollTimer = undefined;
  for (const controller of requests) controller.abort();
  requests.clear();
}
async function loadModels() {
  const value = snapshot();
  try {
    const response = await request<{ items: typeof models.value }>(
      "/api/image-models",
    );
    if (current(value)) models.value = response.items;
  } catch {
    if (current(value))
      say(notice, { key: "pipelines.notices.modelsFailed" });
  }
}
async function loadPipelines(more = false) {
  if (more && (!nextCursor.value || loadingMore.value)) return;
  const number = ++listNumber,
    value = snapshot();
  if (more) loadingMore.value = true;
  else {
    loading.value = true;
    pipelines.value = [];
    nextCursor.value = null;
  }
  errorMessage.value = "";
  try {
    const response = await request<PipelineListDTO>("/api/pipelines", {
      query: {
        limit: 20,
        search: keyword.value,
        ...(more ? { cursor: nextCursor.value } : {}),
      },
    });
    if (!current(value) || number !== listNumber) return;
    pipelines.value = more
      ? [
          ...pipelines.value,
          ...response.pipelines.filter(
            (item) => !pipelines.value.some((known) => known.id === item.id),
          ),
        ]
      : response.pipelines;
    nextCursor.value = response.nextCursor;
  } catch (error) {
    if (current(value) && number === listNumber)
      say(errorMessage, message(error, "pipelines.errors.loadList"));
  } finally {
    if (current(value) && number === listNumber) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}
function install(value: PipelineDTO) {
  editorVersion += 1;
  saving.value = false;
  pipeline.value = value;
  name.value = value.name;
  description.value = value.description;
  definition.value = copyPipeline(value.definition);
  savedFingerprint.value = pipelineFingerprint({
    name: value.name,
    description: value.description,
    definition: value.definition,
  });
  history.reset(value.definition);
  historyVersion.value += 1;
  editing.value = true;
  selectedId.value = null;
  selectedEdgeId.value = null;
  conflict.value = false;
  saveError.value = "";
  void nextTick(() => canvasComponent.value?.fit());
}
async function openPipeline(id: string) {
  const number = ++detailNumber,
    value = snapshot();
  editorLoading.value = true;
  errorMessage.value = "";
  try {
    const response = await request<{ pipeline: PipelineDTO }>(
      `/api/pipelines/${encodeURIComponent(id)}`,
    );
    if (!current(value) || number !== detailNumber) return;
    install(response.pipeline);
    if (route.query.id !== response.pipeline.id)
      await navigateTo(
        { path: "/pipelines", query: { id: response.pipeline.id } },
        { replace: true },
      );
  } catch (error) {
    if (current(value) && number === detailNumber)
      say(errorMessage, message(error, "pipelines.errors.open"));
  } finally {
    if (current(value) && number === detailNumber) editorLoading.value = false;
  }
}
function useTemplate(template: PipelineTemplate) {
  editorVersion += 1;
  detailNumber += 1;
  saving.value = false;
  pipeline.value = null;
  const text = pipelineTemplateText(template, translate);
  name.value = template.id === "blank" ? t("pipelines.untitled") : text.name;
  description.value = template.id === "blank" ? "" : text.description;
  definition.value = template.definition(translate);
  savedFingerprint.value = "";
  history.reset(definition.value);
  historyVersion.value += 1;
  editing.value = true;
  selectedId.value = null;
  selectedEdgeId.value = null;
  conflict.value = false;
  saveError.value = "";
  notice.value = "";
  if (route.query.id) void navigateTo("/pipelines", { replace: true });
  void nextTick(() => canvasComponent.value?.fit());
}
function commit(next: PipelineDefinition) {
  if (history.push(next)) {
    definition.value = copyPipeline(next);
    historyVersion.value += 1;
  }
}
function addNode(type: PipelineNodeType, position: CanvasPoint) {
  if (definition.value.nodes.length >= PIPELINE_LIMITS.nodes) return;
  const node = createPipelineNode(
    type,
    `node_${crypto.randomUUID().replaceAll("-", "")}`,
    position,
  );
  node.label = pipelineNodeLabel(type, translate);
  commit({ ...definition.value, nodes: [...definition.value.nodes, node] });
  selectedId.value = node.id;
  selectedEdgeId.value = null;
}
function updateNode(node: PipelineNode) {
  const next = copyPipeline(definition.value);
  next.nodes = next.nodes.map((value) => (value.id === node.id ? node : value));
  next.edges = next.edges.filter((edge) => {
    const source = next.nodes.find((value) => value.id === edge.source),
      target = next.nodes.find((value) => value.id === edge.target);
    return (
      source &&
      target &&
      getPipelineNodePorts(source).outputs.some(
        (port) => port.id === edge.sourcePort,
      ) &&
      getPipelineNodePorts(target).inputs.some(
        (port) =>
          port.id === edge.targetPort &&
          (port.type === "media" || port.type === edge.sourcePort),
      )
    );
  });
  commit(next);
}
function moveNode(id: string, position: CanvasPoint) {
  const node = definition.value.nodes.find((value) => value.id === id);
  if (node) updateNode({ ...node, position: clampCanvasPoint(position) });
}
function removeNode(id: string) {
  commit({
    ...definition.value,
    nodes: definition.value.nodes.filter((node) => node.id !== id),
    edges: definition.value.edges.filter(
      (edge) => edge.source !== id && edge.target !== id,
    ),
  });
  if (selectedId.value === id) selectedId.value = null;
  selectedEdgeId.value = null;
}
function duplicateNode(id: string) {
  const node = definition.value.nodes.find((value) => value.id === id);
  if (!node || definition.value.nodes.length >= PIPELINE_LIMITS.nodes) return;
  const duplicate = copyPipeline(node);
  duplicate.id = `node_${crypto.randomUUID().replaceAll("-", "")}`;
  const suffixLength = t("pipelines.editor.duplicateLabel", { label: "" }).length;
  duplicate.label = t("pipelines.editor.duplicateLabel", {
    label: node.label.slice(0, Math.max(1, 100 - suffixLength)),
  }).slice(0, 100);
  duplicate.position = clampCanvasPoint({
    x: node.position.x + 70,
    y: node.position.y + 80,
  });
  commit({
    ...definition.value,
    nodes: [...definition.value.nodes, duplicate],
  });
  selectedId.value = duplicate.id;
}
function copyNode() {
  if (selectedNode.value) {
    copiedNode.value = copyPipeline(selectedNode.value);
    say(notice, {
      key: "pipelines.notices.copied",
      params: { label: selectedNode.value.label },
    });
  }
}
function pasteNode() {
  if (
    !copiedNode.value ||
    definition.value.nodes.length >= PIPELINE_LIMITS.nodes
  )
    return;
  const node = copyPipeline(copiedNode.value);
  node.id = `node_${crypto.randomUUID().replaceAll("-", "")}`;
  node.position = clampCanvasPoint({
    x: node.position.x + 90,
    y: node.position.y + 90,
  });
  commit({ ...definition.value, nodes: [...definition.value.nodes, node] });
  selectedId.value = node.id;
}
function disconnect(id: string) {
  commit({
    ...definition.value,
    edges: definition.value.edges.filter((edge) => edge.id !== id),
  });
  selectedEdgeId.value = null;
}
function disconnectNode(id: string) {
  const node = definition.value.nodes.find((value) => value.id === id);
  if (!node) return;
  commit({
    ...definition.value,
    edges: definition.value.edges.filter(
      (edge) => edge.source !== id && edge.target !== id,
    ),
  });
  selectedEdgeId.value = null;
  say(notice, { key: "pipelines.notices.disconnected", params: { label: node.label } });
}
function connect(
  sourceId: string,
  sourcePort: "image" | "text",
  targetId: string,
  targetPort: string,
) {
  const source = definition.value.nodes.find((node) => node.id === sourceId),
    target = definition.value.nodes.find((node) => node.id === targetId),
    port =
      target &&
      getPipelineNodePorts(target).inputs.find(
        (value) => value.id === targetPort,
      );
  if (
    !source ||
    !target ||
    !port ||
    !getPipelineNodePorts(source).outputs.some(
      (value) => value.id === sourcePort,
    ) ||
    (port.type !== "media" && port.type !== sourcePort)
  ) {
    say(notice, { key: "pipelines.notices.typeMismatch" });
    return;
  }
  const existing = definition.value.edges.find(
    (edge) =>
      edge.source === sourceId &&
      edge.sourcePort === sourcePort &&
      edge.target === targetId &&
      edge.targetPort === targetPort,
  );
  if (existing) {
    disconnect(existing.id);
    notice.value = "";
    return;
  }
  let edges = definition.value.edges.filter(
    (edge) =>
      port.multiple ||
      edge.target !== targetId ||
      edge.targetPort !== targetPort,
  );
  if (createsPipelineCycle(edges, sourceId, targetId)) {
    say(notice, { key: "pipelines.notices.cycle" });
    return;
  }
  if (edges.length >= PIPELINE_LIMITS.edges) {
    say(notice, {
      key: "pipelines.notices.edgeLimit",
      params: { count: PIPELINE_LIMITS.edges },
    });
    return;
  }
  edges = [
    ...edges,
    {
      id: `edge_${crypto.randomUUID().replaceAll("-", "")}`,
      source: sourceId,
      sourcePort,
      target: targetId,
      targetPort,
    },
  ];
  commit({ ...definition.value, edges });
  notice.value = "";
  selectedEdgeId.value = null;
}
function undo() {
  const next = history.undo();
  if (next) {
    definition.value = next;
    historyVersion.value += 1;
    selectedId.value = null;
    selectedEdgeId.value = null;
  }
}
function redo() {
  const next = history.redo();
  if (next) {
    definition.value = next;
    historyVersion.value += 1;
    selectedId.value = null;
    selectedEdgeId.value = null;
  }
}
function scheduleSave() {
  clearTimeout(saveTimer);
  if (
    !mounted ||
    !pipeline.value ||
    !dirty.value ||
    conflict.value ||
    editorLoading.value
  )
    return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void save();
  }, 1000);
}
async function save(): Promise<PipelineDTO | null> {
  if (savePromise) {
    await savePromise;
    if (dirty.value && !conflict.value) return save();
    return pipeline.value;
  }
  if (!dirty.value && pipeline.value) return pipeline.value;
  if (conflict.value) return null;
  let parsed: ReturnType<typeof SavePipelineSchema.parse>;
  try {
    parsed = SavePipelineSchema.parse(copyPipeline(body.value));
  } catch (error) {
    say(saveError, { key: "pipelines.errors.invalidSave" });
    return null;
  }
  const value = snapshot(),
    editor = editorVersion,
    id = pipeline.value?.id,
    expected = pipeline.value?.revision;
  clearTimeout(saveTimer);
  saving.value = true;
  saveError.value = "";
  savePromise = (async () => {
    try {
      const response = await request<{ pipeline: PipelineDTO }>(
        id ? `/api/pipelines/${id}` : "/api/pipelines",
        {
          method: id ? "PATCH" : "POST",
          body: id ? { ...parsed, revision: expected } : parsed,
        },
      );
      if (!current(value) || editor !== editorVersion) return null;
      pipeline.value = response.pipeline;
      savedFingerprint.value = pipelineFingerprint(parsed);
      if (!id)
        if (route.query.id !== response.pipeline.id)
          await navigateTo(
            { path: "/pipelines", query: { id: response.pipeline.id } },
            { replace: true },
          );
      return response.pipeline;
    } catch (error) {
      if (current(value) && editor === editorVersion) {
        conflict.value = statusCode(error) === 409;
        say(saveError, message(error, "pipelines.errors.save"));
      }
      return null;
    } finally {
      if (current(value) && editor === editorVersion) saving.value = false;
    }
  })();
  const inFlight = savePromise;
  let saved: PipelineDTO | null = null;
  try {
    saved = await inFlight;
  } finally {
    if (savePromise === inFlight) savePromise = null;
  }
  if (
    saved &&
    current(value) &&
    editor === editorVersion &&
    dirty.value &&
    !conflict.value
  )
    return save();
  return saved;
}
async function duplicatePipeline() {
  const saved = await save();
  if (!saved) return;
  const value = snapshot();
  creating.value = true;
  try {
    const response = await request<{ pipeline: PipelineDTO }>(
      `/api/pipelines/${saved.id}/duplicate`,
      { method: "POST", body: {} },
    );
    if (current(value)) {
      install(response.pipeline);
      if (route.query.id !== response.pipeline.id)
        await navigateTo(
          { path: "/pipelines", query: { id: response.pipeline.id } },
          { replace: true },
        );
    }
  } catch (error) {
    if (current(value))
      say(saveError, message(error, "pipelines.errors.duplicate"));
  } finally {
    if (current(value)) creating.value = false;
  }
}
async function removePipeline() {
  if (!pipeline.value || deleting.value) return;
  const value = snapshot(),
    id = pipeline.value.id;
  deleting.value = true;
  try {
    await request(`/api/pipelines/${id}`, { method: "DELETE" });
    if (current(value)) {
      deleteOpen.value = false;
      leaveEditor();
      void loadPipelines();
    }
  } catch (error) {
    if (current(value))
      say(saveError, message(error, "pipelines.errors.delete"));
  } finally {
    if (current(value)) deleting.value = false;
  }
}
function back() {
  if (dirty.value && !saving.value) {
    discardOpen.value = true;
    return;
  }
  leaveEditor();
}
function leaveEditor() {
  editorVersion += 1;
  detailNumber += 1;
  saving.value = false;
  clearTimeout(saveTimer);
  definition.value = { version: 1, nodes: [], edges: [] };
  history.reset(definition.value);
  historyVersion.value += 1;
  pipeline.value = null;
  editing.value = false;
  runMode.value = null;
  selectedId.value = null;
  copiedNode.value = null;
  picker.value = null;
  discardOpen.value = false;
  conflict.value = false;
  void navigateTo("/pipelines", { replace: true });
  void loadPipelines();
}
function exportPipeline() {
  const parsed = SavePipelineSchema.safeParse(copyPipeline(body.value));
  if (!parsed.success) {
    say(saveError, { key: "pipelines.errors.invalidExport" });
    return;
  }
  const blob = new Blob([JSON.stringify(parsed.data, null, 2)], {
      type: "application/json",
    }),
    url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = `${name.value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 70) || "pipeline"}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
async function importPipeline(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  (event.target as HTMLInputElement).value = "";
  if (!file) return;
  const value = snapshot();
  if (file.size > 1_000_000) {
    say(errorMessage, { key: "pipelines.errors.importTooLarge" });
    return;
  }
  try {
    const parsed = SavePipelineSchema.parse(JSON.parse(await file.text()));
    if (!current(value)) return;
    editorVersion += 1;
    detailNumber += 1;
    saving.value = false;
    pipeline.value = null;
    name.value = parsed.name;
    description.value = parsed.description;
    definition.value = parsed.definition;
    savedFingerprint.value = "";
    history.reset(definition.value);
    historyVersion.value += 1;
    editing.value = true;
    selectedId.value = null;
    selectedEdgeId.value = null;
    conflict.value = false;
    say(notice, { key: "pipelines.notices.imported" });
    void nextTick(() => canvasComponent.value?.fit());
  } catch {
    if (current(value))
      say(errorMessage, { key: "pipelines.errors.importInvalid" });
  }
}
function openPicker(
  nodeId: string,
  field:
    | "images"
    | "referenceImages"
    | "maskImage"
    | "defaultImage"
    | "batch"
    | "run-input",
  urls: string[],
  limit: number,
) {
  picker.value = { nodeId, field, urls: [...urls], limit };
  pickerUrls.value = [...urls];
  pickerTab.value = peopleOnlyPicker.value ? "people" : "library";
}
function confirmPicker(urls: string[]) {
  const target = picker.value;
  if (!target) return;
  const valid = [...new Set(urls)]
    .filter((url) => ImagePathSchema.safeParse(url).success)
    .slice(0, target.limit);
  if (target.field === "batch") batchImages.value = valid;
  else if (target.field === "run-input")
    runInputs.value = { ...runInputs.value, [target.nodeId]: valid[0] ?? "" };
  else {
    const node = definition.value.nodes.find(
      (value) => value.id === target.nodeId,
    );
    if (node) {
      const config = { ...node.config } as Record<string, unknown>;
      if (target.field === "maskImage" || target.field === "defaultImage") {
        if (valid[0]) config[target.field] = valid[0];
        else delete config[target.field];
      } else config[target.field] = valid;
      const parsed = PipelineNodeSchema.safeParse({ ...node, config });
      if (parsed.success) updateNode(parsed.data);
    }
  }
  picker.value = null;
  pickerUrls.value = [];
}
function confirmFiles(files: SelectableFile[]) {
  confirmPicker(files.map((file) => file.url));
}
async function prepareRun(targetId?: string) {
  prepareVersion += 1;
  runTarget.value = targetId ?? null;
  runError.value = "";
  batchImages.value = [];
  runInputs.value = {};
  batchInput.value =
    getPipelineDisplayNodes(getPipelineExecutionNodes(definition.value, targetId)).find(
      (node) => node.type === "image-input",
    )?.id ?? "";
  for (const node of getPipelineExecutionNodes(definition.value, targetId)) {
    if (node.type === "text-input")
      runInputs.value[node.id] = node.config.defaultValue;
    if (node.type === "image-input" && node.config.defaultImage)
      runInputs.value[node.id] = node.config.defaultImage;
  }
  runMode.value = "prepare";
  await balance.refresh();
}
const runAttemptKeys = new Map<string, string>();
async function startRun() {
  if (!canStart.value) return;
  starting.value = true;
  runError.value = "";
  const value = snapshot(),
    prepared = prepareVersion,
    editor = editorVersion,
    draftRun = {
      inputImages: [...batchImages.value],
      inputs: { ...runInputs.value },
      ...(batchInput.value ? { batchInputNodeId: batchInput.value } : {}),
      ...(runTarget.value ? { targetNodeId: runTarget.value } : {}),
    };
  try {
    const saved = await save();
    if (
      !saved ||
      !current(value) ||
      editor !== editorVersion ||
      prepared !== prepareVersion
    )
      return;
    const requestBody = { revision: saved.revision, ...draftRun };
    if (getPipelineExecutionNodes(saved.definition, draftRun.targetNodeId).some(pipelineNodeUsesCredit)) {
      if (!await generationCredit.ensureCredit()) {
        if (current(value) && !generationCredit.open.value) runError.value = generationCredit.blockedReason.value;
        return;
      }
      if (!current(value) || editor !== editorVersion || prepared !== prepareVersion) return;
    }
    const fingerprint = JSON.stringify({ id: saved.id, ...requestBody });
    let key = runAttemptKeys.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      runAttemptKeys.set(fingerprint, key);
    }
    const parsed = StartPipelineRunSchema.parse({
      ...requestBody,
      idempotencyKey: key,
    });
    const response = await request<RunResponse>(
      `/api/pipelines/${saved.id}/runs`,
      { method: "POST", body: parsed, timeout: 40_000 },
    );
    if (!current(value)) return;
    runAttemptKeys.delete(fingerprint);
    applyRunResponse(response);
    if (prepared === prepareVersion && runMode.value === "prepare")
      runMode.value = "results";
    pollAttempts = 0;
    pollingPaused.value = false;
    schedulePoll();
    await balance.refresh();
  } catch (error) {
    if (!current(value)) return;
    if (await generationCredit.handleError(error)) { if (current(value)) runError.value = ''; return; }
    if (current(value))
      say(runError, message(error, "pipelines.errors.start"));
  } finally {
    if (current(value)) starting.value = false;
  }
}
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = undefined;
  if (
    !mounted ||
    !isRunActive.value ||
    runMode.value !== "results" ||
    runRefreshing.value ||
    runMutating.value
  )
    return;
  if (pollAttempts >= 120) {
    pollingPaused.value = true;
    return;
  }
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    if (document.visibilityState === "visible") void refreshRun(true);
    else schedulePoll();
  }, 5000);
}
async function refreshRun(poll = false) {
  if (!activeRun.value || runRefreshing.value || runMutating.value) return;
  const value = snapshot(),
    id = activeRun.value.id,
    number = ++runNumber;
  runRefreshing.value = true;
  if (poll) pollAttempts += 1;
  try {
    const response = await request<RunResponse>(
      `/api/pipeline-runs/${id}`,
    );
    if (current(value) && activeRun.value?.id === id && number === runNumber) {
      applyRunResponse(response);
      runError.value = "";
      if (!isRunActive.value) await balance.refresh();
    }
  } catch (error) {
    if (current(value) && activeRun.value?.id === id && number === runNumber)
      say(runError, message(error, "pipelines.errors.refresh"));
  } finally {
    if (current(value) && number === runNumber) {
      runRefreshing.value = false;
      schedulePoll();
    }
  }
}
async function resumeRun() {
  pollAttempts = 0;
  pollingPaused.value = false;
  await refreshRun();
  schedulePoll();
}
async function cancelRun() {
  if (!activeRun.value || runMutating.value || runRefreshing.value) return;
  const value = snapshot(),
    id = activeRun.value.id;
  runMutating.value = true;
  try {
    const response = await request<RunResponse>(
      `/api/pipeline-runs/${id}/cancel`,
      { method: "POST", body: {} },
    );
    if (current(value) && activeRun.value?.id === id) {
      applyRunResponse(response);
      runError.value = "";
      await balance.refresh();
    }
  } catch (error) {
    if (current(value))
      say(runError, message(error, "pipelines.errors.cancel"));
  } finally {
    if (current(value)) {
      runMutating.value = false;
      schedulePoll();
    }
  }
}
async function retryRun(stepIds: string[]) {
  if (!activeRun.value || runMutating.value || runRefreshing.value || generationCredit.checking.value) return;
  const value = snapshot(),
    id = activeRun.value.id,
    usesCredit = pipelineRetryUsesCredit(activeRun.value, stepIds);
  runMutating.value = true;
  runError.value = '';
  clearTimeout(pollTimer);
  pollTimer = undefined;
  try {
    if (usesCredit && !await generationCredit.ensureCredit()) {
      if (current(value) && !generationCredit.open.value) runError.value = generationCredit.blockedReason.value;
      return;
    }
    if (!current(value) || activeRun.value?.id !== id) return;
    const response = await request<RunResponse>(
      `/api/pipeline-runs/${id}/retry`,
      { method: "POST", body: { stepIds, confirmPossibleCharge: true } },
    );
    if (current(value) && activeRun.value?.id === id) {
      applyRunResponse(response);
      runError.value = "";
      pollAttempts = 0;
      pollingPaused.value = false;
      await balance.refresh();
    }
  } catch (error) {
    if (!current(value)) return;
    if (await generationCredit.handleError(error)) { if (current(value)) runError.value = ''; return; }
    if (current(value))
      say(runError, message(error, "pipelines.errors.retry"));
  } finally {
    if (current(value)) {
      runMutating.value = false;
      schedulePoll();
    }
  }
}
async function rerunJob(itemId: string) {
  const savedRun = activeRun.value;
  if (!savedRun || runMutating.value || runRefreshing.value || generationCredit.checking.value) return;
  const reason = pipelineJobRerunBlockedReason(savedRun, itemId);
  if (reason) { runError.value = reason; return; }
  const item = savedRun.items.find(value => value.id === itemId)!;
  const value = snapshot(), id = savedRun.id,
    expectedStepIds = item.steps.map(step => step.id),
    usesCredit = pipelineRerunUsesCredit(savedRun, itemId);
  runMutating.value = true;
  runError.value = '';
  clearTimeout(pollTimer);
  pollTimer = undefined;
  try {
    if (usesCredit && !await generationCredit.ensureCredit()) {
      if (current(value) && !generationCredit.open.value) runError.value = generationCredit.blockedReason.value;
      return;
    }
    if (!current(value) || activeRun.value?.id !== id) return;
    const response = await request<RunResponse>(`/api/pipeline-runs/${id}/rerun`, {
      method: 'POST',
      body: {itemIds: [itemId], expectedStepIds, confirmPossibleCharge: usesCredit},
    });
    if (current(value) && activeRun.value?.id === id) {
      applyRunResponse(response);
      runError.value = '';
      pollAttempts = 0;
      pollingPaused.value = false;
      await balance.refresh();
    }
  } catch (error) {
    if (!current(value)) return;
    if (await generationCredit.handleError(error)) { if (current(value)) runError.value = ''; return; }
    if (current(value)) say(runError, statusCode(error) === 409
      ? {key: 'pipelines.errors.rerunBlocked'}
      : message(error, 'pipelines.errors.rerun'));
  } finally {
    if (current(value)) { runMutating.value = false; schedulePoll(); }
  }
}
const shownCreditFailures = new Set<string>();
watch([account.identity, account.epoch], () => shownCreditFailures.clear(), {flush: 'sync'});
watch(() => activeRun.value?.items.flatMap(item => item.steps.filter(step => step.error?.code === 'CREDIT_EXHAUSTED').map(step => `${activeRun.value!.id}:${step.id}`)) ?? [], failures => {
  const unseen = failures.filter(key => !shownCreditFailures.has(key));
  if (!unseen.length) return;
  for (const key of unseen) shownCreditFailures.add(key);
  // A saved failure describes the credit at execution time. Recheck the live
  // balance so an old run does not ask for credit after a top-up or Unlimited.
  void generationCredit.ensureCredit();
}, {flush: 'post'});
async function loadRuns(more = false) {
  if (historyLoading.value || (more && !runCursor.value)) return;
  const value = snapshot();
  historyLoading.value = true;
  runError.value = "";
  try {
    const response = await request<PipelineRunListDTO>("/api/pipeline-runs", {
      query: { limit: 20, ...(more ? { cursor: runCursor.value } : {}) },
    });
    if (current(value)) {
      runHistory.value = more
        ? [
            ...runHistory.value,
            ...response.runs.filter(
              (item) => !runHistory.value.some((known) => known.id === item.id),
            ),
          ]
        : response.runs;
      runCursor.value = response.nextCursor;
    }
  } catch (error) {
    if (current(value))
      say(runError, message(error, "pipelines.errors.loadRuns"));
  } finally {
    if (current(value)) historyLoading.value = false;
  }
}
function openRuns() {
  runMode.value = "history";
  clearTimeout(pollTimer);
  void loadRuns();
}
async function openRun(id: string) {
  const value = snapshot(),
    number = ++runNumber;
  runRefreshing.value = true;
  runError.value = "";
  try {
    const response = await request<RunResponse>(
      `/api/pipeline-runs/${id}`,
    );
    if (current(value) && number === runNumber) {
      applyRunResponse(response);
      runMode.value = "results";
      pollAttempts = 0;
      pollingPaused.value = false;
      schedulePoll();
    }
  } catch (error) {
    if (current(value) && number === runNumber)
      say(runError, message(error, "pipelines.errors.openRun"));
  } finally {
    if (current(value) && number === runNumber) {
      runRefreshing.value = false;
      schedulePoll();
    }
  }
}
function runStatusText(status: string) {
  const key = `pipelines.history.status.${status.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())}`;
  const text = t(key);
  return text && text !== key ? text : status.replaceAll("-", " ");
}
function closeRun() {
  prepareVersion += 1;
  runMode.value = null;
  clearTimeout(pollTimer);
  pollTimer = undefined;
  runError.value = "";
}
function visibilityChanged() {
  if (
    document.visibilityState === "visible" &&
    isRunActive.value &&
    !pollingPaused.value
  )
    schedulePoll();
}
function keyboard(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  if (trapDialogTab(event)) return;
  const target = event.target as HTMLElement | null;
  if (event.key === "Escape") {
    if (picker.value) picker.value = null;
    else if (metadataOpen.value) metadataOpen.value = false;
    else if (deleteOpen.value) deleteOpen.value = false;
    else if (discardOpen.value) discardOpen.value = false;
    else if (runMode.value) closeRun();
    else selectedId.value = null;
    return;
  }
  if (target?.matches("input,textarea,select") || target?.isContentEditable)
    return;
  if (event.key === "Delete") {
    if (
      !editing.value ||
      picker.value ||
      runMode.value ||
      metadataOpen.value ||
      deleteOpen.value ||
      discardOpen.value
    )
      return;
    if (selectedEdgeId.value) {
      event.preventDefault();
      disconnect(selectedEdgeId.value);
    } else if (selectedId.value) {
      event.preventDefault();
      disconnectNode(selectedId.value);
    }
    return;
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "s" &&
    editing.value
  ) {
    event.preventDefault();
    void save();
  } else if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "z" &&
    editing.value
  ) {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
  } else if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "y" &&
    editing.value
  ) {
    event.preventDefault();
    redo();
  } else if (event.key === "Escape") {
    picker.value = null;
    metadataOpen.value = false;
    deleteOpen.value = false;
    discardOpen.value = false;
    if (runMode.value) closeRun();
  }
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
function topDialog() {
  return (
    [
      ...document.querySelectorAll<HTMLElement>(
        '.pipelines-workspace [role="dialog"]',
      ),
    ].at(-1) ?? null
  );
}
function trapDialogTab(event: KeyboardEvent) {
  const dialog = topDialog();
  if (!dialog || event.key !== "Tab") return false;
  const values = [
    ...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
    ),
  ].filter((value) => !value.closest("[hidden]"));
  if (!values.length) return false;
  const first = values[0]!,
    last = values.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
function pickerTabKey(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  pickerTab.value =
    peopleOnlyPicker.value
      ? "people"
      : event.key === "Home"
      ? "library"
      : event.key === "End"
        ? "people"
        : pickerTab.value === "library"
          ? "people"
          : "library";
  void nextTick(() =>
    document
      .getElementById(
        pickerTab.value === "library"
          ? "pipeline-library-tab"
          : "pipeline-people-tab",
      )
      ?.focus(),
  );
}
watch(search, (value) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    keyword.value = value.trim();
    void loadPipelines();
  }, 250);
});
watch([name, description, definition], scheduleSave, { deep: true });
watch([picker, runMode, metadataOpen, deleteOpen, discardOpen], async () => {
  if (!mounted) return;
  const open = Boolean(
    picker.value ||
      runMode.value ||
      metadataOpen.value ||
      deleteOpen.value ||
      discardOpen.value,
  );
  if (open && !focusBeforeDialog)
    focusBeforeDialog =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  await nextTick();
  if (open)
    topDialog()
      ?.querySelector<HTMLElement>(
        "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)",
      )
      ?.focus();
  else {
    if (focusBeforeDialog?.isConnected) focusBeforeDialog.focus();
    focusBeforeDialog = null;
  }
});
watch(
  [account.epoch, account.identity],
  () => {
    stopRequests();
    listNumber += 1;
    detailNumber += 1;
    runNumber += 1;
    pipeline.value = null;
    definition.value = { version: 1, nodes: [], edges: [] };
    name.value = t("pipelines.untitled");
    description.value = "";
    savedFingerprint.value = "";
    history.reset(definition.value);
    historyVersion.value += 1;
    editing.value = false;
    pipelines.value = [];
    models.value = [];
    selectedId.value = null;
    selectedEdgeId.value = null;
    copiedNode.value = null;
    picker.value = null;
    pickerUrls.value = [];
    batchImages.value = [];
    runInputs.value = {};
    runMode.value = null;
    activeRun.value = null;
    runHistory.value = [];
    runAttemptKeys.clear();
    errorMessage.value = "";
    saveError.value = "";
    runError.value = "";
    runWakeNotice.value = "";
    saving.value = false;
    loading.value = false;
    loadingMore.value = false;
    editorLoading.value = false;
    starting.value = false;
    runRefreshing.value = false;
    runMutating.value = false;
    historyLoading.value = false;
    conflict.value = false;
    notice.value = "";
    deleteOpen.value = false;
    discardOpen.value = false;
    metadataOpen.value = false;
  },
  { flush: "sync" },
);
onMounted(() => {
  mounted = true;
  void loadModels();
  void balance.refresh();
  const id = typeof route.query.id === "string" ? route.query.id : "";
  if (id) void openPipeline(id);
  else void loadPipelines();
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("keydown", keyboard);
  window.addEventListener("beforeunload", beforeUnload);
});
onBeforeUnmount(() => {
  mounted = false;
  stopRequests();
  document.removeEventListener("visibilitychange", visibilityChanged);
  window.removeEventListener("keydown", keyboard);
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>

<template>
  <div class="pipelines-workspace">
    <input
      ref="importInput"
      class="pipeline-hidden-input"
      type="file"
      accept="application/json,.json"
      :aria-label="t('pipelines.library.importLabel')"
      @change="importPipeline"
    />
    <section v-if="!editing" class="pipeline-library">
      <header>
        <div>
          <span class="pipeline-eyebrow">{{ t("pipelines.library.eyebrow") }}</span>
          <h1>{{ t("pipelines.library.title") }}</h1>
          <p>{{ t("pipelines.library.intro") }}</p>
        </div>
        <div class="pipeline-library-actions">
          <button type="button" class="pipeline-secondary" @click="openRuns">
            <UIcon name="i-lucide-history" />{{ t("pipelines.library.savedRuns") }}</button
          ><button
            type="button"
            class="pipeline-secondary"
            @click="importInput?.click()"
          >
            <UIcon name="i-lucide-upload" />{{ t("pipelines.library.importJson") }}</button
          ><button
            type="button"
            class="pipeline-primary"
            @click="useTemplate(PIPELINE_TEMPLATES[0]!)"
          >
            <UIcon name="i-lucide-plus" />{{ t("pipelines.library.newPipeline") }}
          </button>
        </div>
      </header>
      <section class="pipeline-template-section">
        <div class="pipeline-section-heading">
          <h2>{{ t("pipelines.library.templatesTitle") }}</h2>
          <span>{{ t("pipelines.library.templatesHint") }}</span>
        </div>
        <div class="pipeline-template-grid">
          <button
            v-for="template in PIPELINE_TEMPLATES.slice(1)"
            :key="template.id"
            type="button"
            class="pipeline-template-card"
            @click="useTemplate(template)"
          >
            <span class="pipeline-template-icon"
              ><UIcon :name="template.icon" /></span
            ><span class="pipeline-template-trail"
              ><i /><i /><i /><UIcon name="i-lucide-arrow-right" /></span
            ><strong>{{ t(template.nameKey) }}</strong>
            <p>{{ t(template.descriptionKey) }}</p>
            <span class="pipeline-template-open"
              >{{ t("pipelines.library.useTemplate") }} <UIcon name="i-lucide-arrow-up-right"
            /></span>
          </button>
        </div>
      </section>
      <section class="pipeline-personal-section">
        <div class="pipeline-section-heading">
          <h2>
            {{ t("pipelines.library.yourPipelines") }}
            <span v-if="pipelines.length"
              >{{ pipelines.length }}{{ nextCursor ? "+" : "" }}</span
            >
          </h2>
          <div class="pipeline-search">
            <UIcon name="i-lucide-search" /><input
              v-model="search"
              :aria-label="t('pipelines.library.searchLabel')"
              :placeholder="t('pipelines.library.searchPlaceholder')"
            />
          </div>
        </div>
        <p
          v-if="loading || editorLoading"
          class="pipeline-status"
          role="status"
        >
          {{
            editorLoading
              ? t("pipelines.library.opening")
              : t("pipelines.library.loading")
          }}
        </p>
        <p v-if="errorMessage" class="pipeline-error" role="alert">
          {{ errorMessage }}
          <button type="button" @click="loadPipelines()">
            {{ t("common.actions.retry") }}
          </button>
        </p>
        <div class="pipeline-saved-grid">
          <button
            v-for="item in pipelines"
            :key="item.id"
            type="button"
            class="pipeline-saved-card"
            @click="openPipeline(item.id)"
          >
            <span class="pipeline-saved-node-row"
              ><span
                v-for="node in item.definition.nodes
                  .filter((value) => value.type !== 'sticky-note')
                  .slice(0, 4)"
                :key="node.id"
                ><UIcon :name="pipelineNodeIcon(node.type)" /></span
              ><i v-if="item.definition.nodes.length > 4"
                >+{{ item.definition.nodes.length - 4 }}</i
              ></span
            ><strong>{{ item.name }}</strong>
            <p>
              {{
                item.description ||
                t(
                  item.definition.nodes.length === 1
                    ? "pipelines.library.stepsOne"
                    : "pipelines.library.stepsOther",
                  { count: item.definition.nodes.length },
                )
              }}
            </p>
            <footer>
              <span>{{
                t("pipelines.library.revision", { revision: item.revision })
              }}</span
              ><span
                >{{ t("pipelines.library.openEditor")
                }}<UIcon name="i-lucide-arrow-up-right"
              /></span>
            </footer>
          </button>
        </div>
        <div
          v-if="!loading && !pipelines.length && !errorMessage"
          class="pipeline-library-empty"
        >
          <UIcon name="i-lucide-workflow" />
          <h3>
            {{
              keyword
                ? t("pipelines.library.emptyMatchTitle")
                : t("pipelines.library.emptyTitle")
            }}
          </h3>
          <p>
            {{
              keyword
                ? t("pipelines.library.emptyMatchHint")
                : t("pipelines.library.emptyHint")
            }}
          </p>
        </div>
        <button
          v-if="nextCursor"
          type="button"
          class="pipeline-secondary pipeline-load-more"
          :disabled="loadingMore"
          @click="loadPipelines(true)"
        >
          {{
            loadingMore
              ? t("common.states.loading")
              : t("pipelines.library.loadMore")
          }}
        </button>
      </section>
    </section>
    <section
      v-else
      class="pipeline-editor"
      :aria-label="t('pipelines.editor.label')"
    >
      <header class="pipeline-editor-toolbar">
        <button
          type="button"
          class="pipeline-icon"
          :aria-label="t('pipelines.editor.back')"
          @click="back"
        >
          <UIcon name="i-lucide-arrow-left" />
        </button>
        <div class="pipeline-title">
          <input
            v-model="name"
            maxlength="100"
            :aria-label="t('pipelines.editor.nameLabel')"
          /><span v-if="conflict" class="pipeline-conflict">{{
            t("pipelines.editor.saveConflict")
          }}</span
          ><span v-else>{{
            saving
              ? t("common.actions.saving")
              : dirty
                ? t("pipelines.editor.unsaved")
                : t("pipelines.editor.saved", {
                    revision: pipeline?.revision ?? 1,
                  })
          }}</span>
        </div>
        <div class="pipeline-toolbar-history">
          <button
            type="button"
            class="pipeline-icon"
            :disabled="!canUndo"
            :aria-label="t('pipelines.editor.undo')"
            @click="undo"
          >
            <UIcon name="i-lucide-undo-2" /></button
          ><button
            type="button"
            class="pipeline-icon"
            :disabled="!canRedo"
            :aria-label="t('pipelines.editor.redo')"
            @click="redo"
          >
            <UIcon name="i-lucide-redo-2" />
          </button>
        </div>
        <div class="pipeline-toolbar-actions">
          <button
            type="button"
            class="pipeline-secondary pipeline-toolbar-saved-runs"
            @click="openRuns"
          >
            <UIcon name="i-lucide-history" />{{ t("pipelines.editor.runs") }}</button
          ><button
            type="button"
            class="pipeline-icon"
            :aria-label="t('pipelines.editor.settingsLabel')"
            :aria-expanded="metadataOpen"
            @click="metadataOpen = !metadataOpen"
          >
            <UIcon name="i-lucide-settings-2" /></button
          ><button
            type="button"
            class="pipeline-secondary"
            :disabled="saving || !dirty || conflict"
            @click="save"
          >
            <UIcon name="i-lucide-save" />{{ t("common.actions.save") }}</button
          ><button
            type="button"
            class="pipeline-primary"
            :disabled="starting || saving || conflict"
            @click="prepareRun()"
          >
            <UIcon name="i-lucide-play" />{{ t("pipelines.editor.runPipeline") }}
          </button>
        </div>
      </header>
      <div
        v-if="saveError || notice"
        class="pipeline-editor-notice"
        :class="{ 'is-error': saveError }"
        role="status"
      >
        <span>{{ saveError || notice }}</span
        ><button
          v-if="conflict && pipeline"
          type="button"
          @click="openPipeline(pipeline.id)"
        >
          {{ t("pipelines.editor.reloadSaved") }}</button
        ><button
          v-else
          type="button"
          class="pipeline-icon"
          :aria-label="t('pipelines.editor.dismissNotice')"
          @click="
            notice = '';
            saveError = '';
          "
        >
          <UIcon name="i-lucide-x" />
        </button>
      </div>
      <div class="pipeline-editor-body">
        <PipelineCanvas
          ref="canvasComponent"
          :definition="definition"
          :selected-id="selectedId"
          :selected-edge-id="selectedEdgeId"
          :run="activeRun?.pipelineId === pipeline?.id ? activeRun : null"
          @select="selectedId = $event"
          @select-edge="selectedEdgeId = $event"
          @add="addNode"
          @move="moveNode"
          @connect="connect"
          @disconnect-node="disconnectNode"
          @remove="removeNode"
          @duplicate="duplicateNode"
          @remove-edge="disconnect"
          @run="prepareRun"
        /><PipelineNodeProperties
          v-if="selectedNode"
          :key="selectedNode.id"
          :node="selectedNode"
          :definition="definition"
          :models="models"
          @update="updateNode"
          @connect="
            (source, port, target) =>
              connect(source, port, selectedNode!.id, target)
          "
          @disconnect="disconnect"
          @picker="
            (field, urls, limit) =>
              openPicker(selectedNode!.id, field, urls, limit)
          "
          @duplicate="duplicateNode(selectedNode!.id)"
          @remove="removeNode(selectedNode!.id)"
          @run="prepareRun(selectedNode!.id)"
          @close="selectedId = null"
        />
      </div>
      <footer class="pipeline-editor-footer">
        <span
          ><i class="pipeline-dot-image" />{{ t("pipelines.editor.legendImage") }}
          <i class="pipeline-dot-text" />{{ t("pipelines.editor.legendText") }}
          <small>{{
            t("pipelines.editor.stepCount", {
              count: definition.nodes.length,
              limit: PIPELINE_LIMITS.nodes,
            })
          }}</small></span
        >
        <div>
          <button v-if="selectedNode" type="button" @click="copyNode">
            <UIcon name="i-lucide-copy" />{{ t("pipelines.editor.copyStep") }}</button
          ><button v-if="copiedNode" type="button" @click="pasteNode">
            <UIcon name="i-lucide-clipboard-paste" />{{ t("pipelines.editor.pasteStep") }}</button
          ><span
            >{{ t("pipelines.editor.shortcuts") }}
            <small>{{ t("pipelines.editor.shortcutsDetail") }}</small></span
          >
        </div>
      </footer>
    </section>
    <div
      v-if="metadataOpen"
      class="pipeline-overlay"
      @click.self="metadataOpen = false"
    >
      <section
        class="pipeline-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pipeline-settings-title"
        @keydown.esc.stop="metadataOpen = false"
      >
        <header>
          <h2 id="pipeline-settings-title">
            {{ t("pipelines.settings.title") }}
          </h2>
          <button
            type="button"
            class="pipeline-icon"
            :aria-label="t('pipelines.settings.close')"
            @click="metadataOpen = false"
          >
            <UIcon name="i-lucide-x" />
          </button>
        </header>
        <label class="pipeline-label" for="pipeline-description">{{
          t("pipelines.settings.description")
        }}</label
        ><textarea
          id="pipeline-description"
          v-model="description"
          rows="5"
          maxlength="4000"
          class="pipeline-input"
          :placeholder="t('pipelines.settings.descriptionPlaceholder')"
        />
        <p class="pipeline-help">{{ t("pipelines.settings.privacy") }}</p>
        <div class="pipeline-settings-actions">
          <button
            id="pipeline-settings-runs"
            type="button"
            class="pipeline-secondary"
            @click="
              metadataOpen = false;
              openRuns();
            "
          >
            <UIcon name="i-lucide-history" />{{ t("pipelines.library.savedRuns") }}
          </button>
          <button
            type="button"
            class="pipeline-secondary"
            :disabled="creating || saving"
            @click="
              duplicatePipeline();
              metadataOpen = false;
            "
          >
            <UIcon name="i-lucide-copy-plus" />{{ t("pipelines.settings.duplicate") }}</button
          ><button
            type="button"
            class="pipeline-secondary"
            @click="exportPipeline"
          >
            <UIcon name="i-lucide-download" />{{ t("pipelines.settings.exportJson") }}</button
          ><button
            type="button"
            class="pipeline-secondary"
            @click="
              importInput?.click();
              metadataOpen = false;
            "
          >
            <UIcon name="i-lucide-upload" />{{ t("pipelines.library.importJson") }}</button
          ><button
            v-if="pipeline"
            type="button"
            class="pipeline-secondary pipeline-danger"
            @click="
              metadataOpen = false;
              deleteOpen = true;
            "
          >
            <UIcon name="i-lucide-trash-2" />{{ t("pipelines.settings.delete") }}
          </button>
        </div>
      </section>
    </div>
    <div
      v-if="picker"
      class="pipeline-overlay pipeline-picker-overlay"
      @click.self="picker = null"
    >
      <section
        class="pipeline-picker-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('pipelines.picker.label')"
      >
        <header>
          <div>
            <h2>
              {{
                peopleOnlyPicker
                  ? t("pipelines.picker.peopleTitle")
                  : picker.field === "batch"
                  ? t("pipelines.picker.batchTitle")
                  : t("pipelines.picker.referenceTitle")
              }}
            </h2>
            <p>
              {{
                t("pipelines.picker.selected", {
                  count: pickerUrls.length,
                  limit: picker.limit,
                })
              }}
            </p>
          </div>
          <button
            type="button"
            class="pipeline-icon"
            :aria-label="t('pipelines.picker.close')"
            @click="
              picker = null;
              pickerUrls = [];
            "
          >
            <UIcon name="i-lucide-x" />
          </button>
        </header>
        <div
          class="pipeline-picker-tabs"
          role="tablist"
          :aria-label="t('pipelines.picker.source')"
          @keydown="pickerTabKey"
        >
          <button
            v-if="!peopleOnlyPicker"
            id="pipeline-library-tab"
            type="button"
            role="tab"
            :aria-selected="pickerTab === 'library'"
            :tabindex="pickerTab === 'library' ? 0 : -1"
            aria-controls="pipeline-picker-content"
            @click="pickerTab = 'library'"
          >
            {{ t("pipelines.picker.libraryTab") }}</button
          ><button
            id="pipeline-people-tab"
            type="button"
            role="tab"
            :aria-selected="pickerTab === 'people'"
            :tabindex="pickerTab === 'people' ? 0 : -1"
            aria-controls="pipeline-picker-content"
            @click="pickerTab = 'people'"
          >
            {{ t("pipelines.picker.peopleTab") }}
          </button>
        </div>
        <div
          id="pipeline-picker-content"
          class="pipeline-picker-content"
          role="tabpanel"
          :aria-labelledby="
            !peopleOnlyPicker && pickerTab === 'library'
              ? 'pipeline-library-tab'
              : 'pipeline-people-tab'
          "
        >
          <AssetBrowser
            v-if="!peopleOnlyPicker && pickerTab === 'library'"
            :key="`assets-${picker.nodeId}-${picker.field}`"
            v-model:selected-urls="pickerUrls"
            selection-mode="multiple"
            :max-selection="picker.limit"
            :selection-cap="
              picker.field === 'batch' ? PIPELINE_LIMITS.batchImages : 20
            "
            :title="t('pipelines.picker.browserTitle')"
            @confirm="confirmFiles"
          /><PeopleBrowser
            v-else
            v-model:selected-urls="pickerUrls"
            selection-mode="multiple"
            :max-selection="picker.limit"
            :selection-cap="
              picker.field === 'batch' ? PIPELINE_LIMITS.batchImages : 16
            "
            :selection-label="
              picker.field === 'batch' ? 'pictures' : 'references'
            "
            @confirm="confirmPicker"
          />
        </div>
        <footer>
          <button
            type="button"
            class="pipeline-secondary"
            @click="pickerUrls = []"
          >
            {{ t("pipelines.picker.clear") }}</button
          ><button
            type="button"
            class="pipeline-primary"
            @click="confirmPicker(pickerUrls)"
          >
            {{
              t(
                pickerUrls.length === 1
                  ? "pipelines.picker.useOne"
                  : "pipelines.picker.useOther",
                { count: pickerUrls.length },
              )
            }}
          </button>
        </footer>
      </section>
    </div>
    <div
      v-if="runMode"
      class="pipeline-overlay pipeline-run-overlay"
      @click.self="closeRun"
    >
      <section
        class="pipeline-run-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="
          runMode === 'prepare'
            ? t('pipelines.run.dialogPrepare')
            : runMode === 'history'
              ? t('pipelines.run.dialogHistory')
              : t('pipelines.run.dialogResults')
        "
      >
        <section v-if="runMode === 'prepare'" class="pipeline-run-prepare">
          <header>
            <div>
              <span class="pipeline-eyebrow">{{
                runTarget
                  ? t("pipelines.run.eyebrowBranch")
                  : t("pipelines.run.eyebrowCollection")
              }}</span>
              <h2>
                {{
                  runTarget
                    ? t("pipelines.run.runTo", {
                        label: definition.nodes.find(
                          (node) => node.id === runTarget,
                        )?.label,
                      })
                    : t("pipelines.run.title")
                }}
              </h2>
            </div>
            <button
              type="button"
              class="pipeline-icon"
              :aria-label="t('pipelines.run.closeSetup')"
              @click="closeRun"
            >
              <UIcon name="i-lucide-x" />
            </button>
          </header>
          <p class="pipeline-help">{{ t("pipelines.run.help") }}</p>
          <div class="pipeline-run-steps">
            <span v-for="node in executionNodes" :key="node.id"
              ><UIcon :name="pipelineNodeIcon(node.type)" />{{
                node.label
              }}</span
            >
          </div>
          <section v-if="imageInputs.length" class="pipeline-run-input-section">
            <label class="pipeline-label" for="pipeline-batch-input">{{
              t("pipelines.run.batchInput")
            }}</label
            ><select
              id="pipeline-batch-input"
              v-model="batchInput"
              class="pipeline-input"
              :disabled="starting"
              @change="batchImages = []"
            >
              <option
                v-for="node in imageInputs"
                :key="node.id"
                :value="node.id"
              >
                {{ node.label }}
              </option>
            </select>
            <div class="pipeline-batch-choose">
              <div>
                <strong>{{
                  batchImages.length
                    ? t(
                        batchImages.length === 1
                          ? "pipelines.run.batchSelectedOne"
                          : "pipelines.run.batchSelectedOther",
                        { count: batchImages.length },
                      )
                    : t("pipelines.run.batchEmpty")
                }}</strong
                ><small>{{
                  t("pipelines.run.batchLimit", {
                    count: PIPELINE_LIMITS.batchImages,
                  })
                }}</small>
              </div>
              <button
                type="button"
                class="pipeline-secondary"
                :disabled="starting"
                @click="
                  openPicker(
                    batchInput,
                    'batch',
                    batchImages,
                    PIPELINE_LIMITS.batchImages,
                  )
                "
              >
                <UIcon name="i-lucide-images" />{{ t("pipelines.run.choosePictures") }}
              </button>
            </div>
            <div v-if="batchImages.length" class="pipeline-batch-thumbnails">
              <button
                v-for="url in batchImages"
                :key="url"
                type="button"
                :aria-label="
                  t('pipelines.run.removePicture', {
                    name: url.split('/').at(-1),
                  })
                "
                :disabled="starting"
                @click="
                  batchImages = batchImages.filter((value) => value !== url)
                "
              >
                <img
                  :src="imagePreviewUrl(url, 160)"
                  :alt="t('pipelines.run.selectedAlt')"
                  loading="lazy"
                  decoding="async"
                /><UIcon name="i-lucide-x" />
              </button>
            </div>
            <p v-else class="pipeline-help">
              {{ t("pipelines.run.defaultHint") }}
            </p>
          </section>
          <section
            v-for="node in inputNodes"
            :key="node.id"
            class="pipeline-run-input-section"
          >
            <template v-if="node.type === 'text-input'"
              ><label
                class="pipeline-label"
                :for="`pipeline-run-text-${node.id}`"
                >{{ node.label }}
                <span>{{
                  node.config.required ? t("pipelines.run.required") : t("pipelines.run.optional")
                }}</span></label
              ><textarea
                :id="`pipeline-run-text-${node.id}`"
                v-model="runInputs[node.id]"
                class="pipeline-input"
                rows="4"
                maxlength="20000"
                :disabled="starting"
              /></template
            ><template
              v-else-if="node.type === 'image-input' && node.id !== batchInput"
              ><label class="pipeline-label"
                >{{ node.label }}
                <span>{{
                  node.config.required ? t("pipelines.run.required") : t("pipelines.run.optional")
                }}</span></label
              ><button
                type="button"
                class="pipeline-secondary"
                :disabled="starting"
                @click="
                  openPicker(
                    node.id,
                    'run-input',
                    runInputs[node.id] ? [runInputs[node.id]!] : [],
                    1,
                  )
                "
              >
                <UIcon name="i-lucide-image-plus" />{{ t("pipelines.run.choosePicture") }}</button
              ><img
                v-if="runInputs[node.id]"
                class="pipeline-run-single-input"
                :src="imagePreviewUrl(runInputs[node.id]!, 160)"
                :alt="node.label"
                loading="lazy"
            /></template>
          </section>
          <div v-if="runIssues.length" class="pipeline-run-issues" role="alert">
            <strong>{{ t("pipelines.run.issuesTitle") }}</strong>
            <ul>
              <li v-for="issue in runIssues" :key="issue">{{ issue }}</li>
            </ul>
          </div>
          <p
            v-if="runError || creditBlockReason"
            class="pipeline-error"
            role="alert"
          >
            {{ runError || creditBlockReason }}
          </p>
          <footer>
            <div>
              <strong>{{
                t(
                  (batchImages.length || 1) === 1
                    ? "pipelines.run.inputsOne"
                    : "pipelines.run.inputsOther",
                  { count: batchImages.length || 1 },
                )
              }}</strong
              ><span>{{
                t("pipelines.run.availableCredit", {
                  amount: balance.balance.value
                    ? balance.balance.value.unlimited
                      ? t("pipelines.run.unlimited")
                      : formatBalanceUsd(balance.balance.value.actualBalanceUsd)
                    : t("pipelines.run.creditLoading"),
                })
              }}</span
              ><small>{{ t("pipelines.run.costHint") }}</small>
            </div>
            <button
              type="button"
              class="pipeline-primary"
              :disabled="!canStart"
              @click="startRun"
            >
              <UIcon
                :name="starting ? 'i-lucide-loader-circle' : 'i-lucide-play'"
              />{{
                starting ? t("pipelines.run.starting") : t("pipelines.run.start")
              }}
            </button>
          </footer>
        </section>
        <PipelineRunResults
          v-else-if="runMode === 'results' && activeRun"
          :key="activeRun.id"
          :run="activeRun"
          :busy="runMutating || runRefreshing || generationCredit.checking.value"
          :error="runError"
          :notice="runWakeNotice"
          :paused="pollingPaused"
          @close="closeRun"
          @refresh="resumeRun"
          @resume="resumeRun"
          @cancel="cancelRun"
          @retry="retryRun"
          @rerun="rerunJob"
        />
        <section v-else-if="runMode === 'history'" class="pipeline-run-history">
          <header>
            <div>
              <span class="pipeline-eyebrow">{{
                t("pipelines.history.eyebrow")
              }}</span>
              <h2>{{ t("pipelines.history.title") }}</h2>
              <p>{{ t("pipelines.history.intro") }}</p>
            </div>
            <button
              type="button"
              class="pipeline-icon"
              :aria-label="t('pipelines.history.close')"
              @click="closeRun"
            >
              <UIcon name="i-lucide-x" />
            </button>
          </header>
          <p v-if="runError" class="pipeline-error" role="alert">
            {{ runError }}
          </p>
          <p v-if="historyLoading" class="pipeline-status" role="status">
            {{ t("pipelines.history.loading") }}
          </p>
          <button
            v-for="item in runHistory"
            :key="item.id"
            type="button"
            class="pipeline-run-history-item"
            @click="openRun(item.id)"
          >
            <UIcon name="i-lucide-workflow" /><span
              ><strong>{{ item.name }}</strong
              ><small>{{
                t(
                  item.summary.total === 1
                    ? "pipelines.history.summaryOne"
                    : "pipelines.history.summaryOther",
                  {
                    revision: item.revision,
                    count: item.summary.total,
                    date: new Date(item.createdAt).toLocaleString(locale),
                  },
                )
              }}</small></span
            ><span
              ><strong>{{
                formatUsd(item.summary.confirmedCostUsd) || "$0.00"
              }}</strong
              ><small>{{
                item.summary.outstandingCount
                  ? t("pipelines.history.statusOutstanding", {
                      status: runStatusText(item.status),
                    })
                  : runStatusText(item.status)
              }}</small></span
            ><UIcon name="i-lucide-chevron-right" />
          </button>
          <p v-if="!historyLoading && !runHistory.length" class="pipeline-help">
            {{ t("pipelines.history.empty") }}
          </p>
          <button
            v-if="runCursor"
            type="button"
            class="pipeline-secondary"
            :disabled="historyLoading"
            @click="loadRuns(true)"
          >
            {{ t("pipelines.history.loadMore") }}
          </button>
        </section>
      </section>
    </div>
    <div
      v-if="deleteOpen || discardOpen"
      class="pipeline-overlay"
      @click.self="
        deleteOpen = false;
        discardOpen = false;
      "
    >
      <section
        class="pipeline-dialog pipeline-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pipeline-confirm-title"
      >
        <header>
          <h2 id="pipeline-confirm-title">
            {{
              deleteOpen
                ? t("pipelines.confirm.deleteTitle")
                : t("pipelines.confirm.discardTitle")
            }}
          </h2>
          <button
            type="button"
            class="pipeline-icon"
            :aria-label="t('pipelines.confirm.close')"
            @click="
              deleteOpen = false;
              discardOpen = false;
            "
          >
            <UIcon name="i-lucide-x" />
          </button>
        </header>
        <p class="pipeline-help">
          {{
            deleteOpen
              ? t("pipelines.confirm.deleteBody")
              : t("pipelines.confirm.discardBody")
          }}
        </p>
        <footer>
          <button
            type="button"
            class="pipeline-secondary"
            @click="
              deleteOpen = false;
              discardOpen = false;
            "
          >
            {{ t("pipelines.confirm.keepEditing") }}</button
          ><button
            type="button"
            class="pipeline-primary"
            :disabled="deleting"
            @click="deleteOpen ? removePipeline() : leaveEditor()"
          >
            {{
              deleting
                ? t("pipelines.confirm.deleting")
                : deleteOpen
                  ? t("pipelines.confirm.delete")
                  : t("pipelines.confirm.discard")
            }}
          </button>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.pipelines-workspace {
  color: var(--workspace-text);
  font-size: 12px;
}
.pipeline-hidden-input {
  display: none;
}
.pipeline-library {
  max-width: 1500px;
  padding: 48px 46px;
  margin: auto;
}
.pipeline-library > header {
  display: flex;
  justify-content: space-between;
  gap: 30px;
  align-items: center;
}
.pipeline-eyebrow {
  font-size: 9px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--workspace-accent);
}
.pipeline-library h1 {
  font-size: 38px;
  letter-spacing: -1.3px;
  font-weight: 500;
  margin-top: 11px;
}
.pipeline-library > header p {
  font-size: 12px;
  line-height: 1.9;
  color: var(--workspace-muted);
  margin-top: 14px;
  max-width: 540px;
}
.pipeline-library-actions {
  display: flex;
  gap: 9px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.pipeline-primary,
.pipeline-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  white-space: nowrap;
  font-size: 10px;
  border-radius: 8px;
  padding: 11px 13px;
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
.pipeline-secondary:hover {
  border-color: #776b59;
}
.pipeline-template-section {
  margin-top: 50px;
}
.pipeline-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
}
.pipeline-section-heading h2 {
  font-size: 14px;
  letter-spacing: -0.2px;
  font-weight: 550;
  display: flex;
  align-items: center;
  gap: 10px;
}
.pipeline-section-heading h2 > span {
  font-size: 9px;
  font-weight: 400;
  padding: 3px 6px;
  border: 1px solid var(--workspace-border);
  border-radius: 4px;
  color: var(--workspace-muted);
}
.pipeline-section-heading > span {
  font-size: 10px;
  color: var(--workspace-muted);
}
.pipeline-template-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}
.pipeline-template-card {
  border: 1px solid var(--workspace-border);
  background: var(--workspace-surface);
  border-radius: 15px;
  text-align: left;
  padding: 22px;
  position: relative;
  overflow: hidden;
  transition:
    border-color 0.15s,
    transform 0.15s;
}
.pipeline-template-card:hover {
  border-color: #9b7753;
  transform: translateY(-2px);
}
.pipeline-template-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: #41342a;
  color: var(--workspace-accent);
  margin-bottom: 34px;
}
.pipeline-template-icon .iconify {
  width: 19px;
  height: 19px;
}
.pipeline-template-trail {
  position: absolute;
  right: 20px;
  top: 35px;
  display: flex;
  gap: 8px;
  align-items: center;
  opacity: 0.5;
}
.pipeline-template-trail i {
  width: 15px;
  height: 21px;
  border: 1px solid #9d8060;
  border-radius: 4px;
  position: relative;
}
.pipeline-template-trail i + i:before {
  content: "";
  position: absolute;
  left: -9px;
  top: 9px;
  width: 8px;
  border-top: 1px solid #9d8060;
}
.pipeline-template-trail .iconify {
  width: 12px;
  height: 12px;
  color: #bd9a72;
}
.pipeline-template-card > strong {
  font-size: 13px;
  letter-spacing: -0.2px;
  font-weight: 500;
}
.pipeline-template-card > p {
  font-size: 10px;
  line-height: 1.8;
  color: var(--workspace-muted);
  margin-top: 10px;
  min-height: 54px;
}
.pipeline-template-open {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #e1b792;
  font-size: 9px;
  margin-top: 22px;
}
.pipeline-template-open .iconify {
  width: 12px;
  height: 12px;
}
.pipeline-personal-section {
  margin-top: 47px;
}
.pipeline-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border: 1px solid var(--workspace-border);
  border-radius: 8px;
  background: var(--workspace-surface);
  width: 230px;
}
.pipeline-search .iconify {
  width: 13px;
  height: 13px;
  color: var(--workspace-muted);
}
.pipeline-search input {
  width: 100%;
  min-width: 0;
  background: transparent;
  outline: 0;
  border: 0;
  font-size: 10px;
}
.pipeline-saved-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.pipeline-saved-card {
  padding: 22px;
  border: 1px solid var(--workspace-border);
  background: #24211c;
  border-radius: 13px;
  text-align: left;
  min-width: 0;
}
.pipeline-saved-card:hover {
  border-color: #8d7152;
}
.pipeline-saved-node-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 20px;
}
.pipeline-saved-node-row > span {
  display: grid;
  place-items: center;
  width: 31px;
  height: 31px;
  border: 1px solid #594b38;
  border-radius: 8px;
  background: #332b21;
}
.pipeline-saved-node-row .iconify {
  width: 14px;
  height: 14px;
  color: #cfad85;
}
.pipeline-saved-node-row i {
  font-size: 9px;
  color: var(--workspace-muted);
  font-style: normal;
  margin-left: 5px;
}
.pipeline-saved-card > strong {
  font-size: 14px;
  font-weight: 500;
  letter-spacing: -0.2px;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pipeline-saved-card > p {
  font-size: 10px;
  color: var(--workspace-muted);
  line-height: 1.8;
  height: 36px;
  overflow: hidden;
  margin-top: 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.pipeline-saved-card footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--workspace-border);
  padding-top: 15px;
  margin-top: 21px;
  color: var(--workspace-muted);
  font-size: 9px;
}
.pipeline-saved-card footer > span:last-child {
  display: flex;
  gap: 5px;
  align-items: center;
  color: #d0ae88;
}
.pipeline-saved-card footer .iconify {
  width: 12px;
  height: 12px;
}
.pipeline-library-empty {
  text-align: center;
  padding: 55px 20px;
  border: 1px dashed var(--workspace-border);
  border-radius: 14px;
}
.pipeline-library-empty > .iconify {
  width: 28px;
  height: 28px;
  color: #b79a73;
}
.pipeline-library-empty h3 {
  font-size: 16px;
  font-weight: 500;
  margin-top: 17px;
}
.pipeline-library-empty p {
  font-size: 11px;
  color: var(--workspace-muted);
  margin-top: 10px;
  line-height: 1.8;
}
.pipeline-load-more {
  margin-top: 20px;
}
.pipeline-status,
.pipeline-help {
  color: var(--workspace-muted);
  font-size: 10px;
  line-height: 1.8;
  margin: 13px 0;
}
.pipeline-error {
  font-size: 10px;
  color: #eab098;
  line-height: 1.8;
  margin: 15px 0;
}
.pipeline-error button {
  text-decoration: underline;
}
.pipeline-editor {
  display: flex;
  flex-direction: column;
  height: calc(100dvh - 86px);
  min-height: 520px;
}
.pipeline-editor-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 22px;
  border-bottom: 1px solid var(--workspace-border);
  background: #25221d;
  flex: none;
}
.pipeline-icon {
  display: grid;
  place-items: center;
  width: 29px;
  height: 29px;
  flex: none;
  color: var(--workspace-muted);
  border-radius: 7px;
}
.pipeline-icon:hover {
  background: var(--workspace-surface-raised);
  color: var(--workspace-text);
}
.pipeline-icon .iconify {
  width: 15px;
  height: 15px;
}
.pipeline-title {
  min-width: 0;
  flex: 1;
}
.pipeline-title input {
  display: block;
  max-width: 380px;
  width: 100%;
  background: transparent;
  border: 0;
  padding: 0;
  font-size: 13px;
  font-weight: 550;
  letter-spacing: -0.2px;
}
.pipeline-title > span {
  display: block;
  font-size: 8px;
  color: var(--workspace-muted);
  margin-top: 6px;
}
.pipeline-title > .pipeline-conflict {
  color: #e5aa8f;
}
.pipeline-toolbar-history {
  display: flex;
  gap: 3px;
  border-right: 1px solid var(--workspace-border);
  padding-right: 14px;
}
.pipeline-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pipeline-editor-body {
  display: flex;
  position: relative;
  min-height: 0;
  flex: 1;
}
.pipeline-editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  padding: 10px 22px;
  border-top: 1px solid var(--workspace-border);
  background: #25221d;
  font-size: 8px;
  color: #928878;
}
.pipeline-editor-footer > span {
  display: flex;
  align-items: center;
  gap: 7px;
}
.pipeline-editor-footer small {
  font-size: 8px;
  margin-left: 13px;
  color: #716858;
}
.pipeline-editor-footer i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #b0b18a;
  display: block;
}
.pipeline-editor-footer .pipeline-dot-text {
  background: #c09a73;
  margin-left: 7px;
}
.pipeline-editor-footer > div {
  display: flex;
  align-items: center;
  gap: 15px;
}
.pipeline-editor-footer button {
  display: flex;
  align-items: center;
  gap: 5px;
  color: #c0aa8d;
}
.pipeline-editor-footer .iconify {
  width: 10px;
  height: 10px;
}
.pipeline-editor-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 23px;
  font-size: 10px;
  color: #ddbf99;
  background: #3a3023;
  border-bottom: 1px solid #5f4b30;
  line-height: 1.7;
}
.pipeline-editor-notice.is-error {
  background: #3a2921;
  color: #efb299;
  border-color: #704837;
}
.pipeline-editor-notice > button:not(.pipeline-icon) {
  color: var(--workspace-accent);
  text-decoration: underline;
  flex: none;
}
.pipeline-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: #0009;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow: hidden;
}
.pipeline-dialog {
  width: min(600px, 100%);
  max-height: calc(100dvh - 48px);
  overflow: auto;
  padding: 27px;
  border: 1px solid var(--workspace-border);
  border-radius: 17px;
  background: var(--workspace-surface);
  box-shadow: 0 22px 90px #0008;
}
.pipeline-dialog > header,
.pipeline-run-prepare > header,
.pipeline-run-history > header {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 20px;
}
.pipeline-dialog h2 {
  font-size: 20px;
  font-weight: 550;
  letter-spacing: -0.5px;
}
.pipeline-label {
  font-size: 10px;
  color: var(--workspace-muted);
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 18px 0 9px;
}
.pipeline-label > span {
  font-size: 9px;
  color: #958979;
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
  line-height: 1.7;
}
.pipeline-input:focus {
  outline: 2px solid var(--workspace-accent);
  outline-offset: 2px;
}
.pipeline-settings-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 24px;
}
.pipeline-danger {
  color: #e8ad99;
}
.pipeline-confirm-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  margin-top: 23px;
}
.pipeline-picker-overlay {
  z-index: 110;
  padding: 30px;
}
.pipeline-picker-dialog {
  background: var(--workspace-bg);
  border: 1px solid var(--workspace-border);
  border-radius: 16px;
  width: min(1380px, 100%);
  height: min(850px, calc(100dvh - 60px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pipeline-picker-dialog > header {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 19px 24px;
  background: var(--workspace-surface);
  border-bottom: 1px solid var(--workspace-border);
  flex: none;
}
.pipeline-picker-dialog > header h2 {
  font-size: 16px;
  font-weight: 500;
}
.pipeline-picker-dialog > header p {
  font-size: 9px;
  color: var(--workspace-muted);
  margin-top: 7px;
}
.pipeline-picker-tabs {
  display: flex;
  gap: 18px;
  padding: 0 24px;
  background: var(--workspace-surface);
  border-bottom: 1px solid var(--workspace-border);
  flex: none;
}
.pipeline-picker-tabs > button {
  padding: 13px 0;
  font-size: 10px;
  color: var(--workspace-muted);
  border-bottom: 2px solid transparent;
}
.pipeline-picker-tabs > button[aria-selected="true"] {
  border-color: var(--workspace-accent);
  color: var(--workspace-text);
}
.pipeline-picker-content {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.pipeline-picker-dialog > footer {
  display: flex;
  justify-content: space-between;
  gap: 15px;
  padding: 14px 24px;
  background: var(--workspace-surface);
  border-top: 1px solid var(--workspace-border);
  flex: none;
}
.pipeline-run-dialog {
  width: min(1450px, 100%);
  max-height: calc(100dvh - 48px);
  overflow: auto;
  border: 1px solid var(--workspace-border);
  border-radius: 17px;
  background: var(--workspace-bg);
  box-shadow: 0 22px 90px #0008;
  min-width: 0;
}
.pipeline-run-prepare {
  padding: 28px;
  width: min(760px, 100%);
  margin: auto;
}
.pipeline-run-prepare h2,
.pipeline-run-history h2 {
  font-size: 23px;
  font-weight: 550;
  letter-spacing: -0.6px;
  margin-top: 8px;
}
.pipeline-run-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 17px 0;
  border-top: 1px solid var(--workspace-border);
  border-bottom: 1px solid var(--workspace-border);
  margin: 20px 0;
}
.pipeline-run-steps > span {
  display: flex;
  align-items: center;
  gap: 5px;
  border: 1px solid #514431;
  border-radius: 5px;
  padding: 5px 7px;
  background: #30271d;
  color: #d5b993;
  font-size: 8px;
}
.pipeline-run-steps .iconify {
  width: 10px;
  height: 10px;
}
.pipeline-run-input-section {
  margin-top: 20px;
}
.pipeline-batch-choose {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--workspace-border);
  border-radius: 11px;
  background: var(--workspace-surface);
  margin-top: 13px;
}
.pipeline-batch-choose strong {
  font-size: 11px;
  font-weight: 500;
}
.pipeline-batch-choose small {
  display: block;
  color: var(--workspace-muted);
  font-size: 9px;
  margin-top: 7px;
}
.pipeline-batch-thumbnails {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 12px;
}
.pipeline-batch-thumbnails button {
  position: relative;
  flex: none;
  width: 54px;
  height: 65px;
  background: var(--workspace-surface);
  border: 1px solid var(--workspace-border);
  border-radius: 7px;
  overflow: hidden;
}
.pipeline-batch-thumbnails img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.pipeline-batch-thumbnails .iconify {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 13px;
  height: 13px;
  color: white;
  background: #0008;
  border-radius: 3px;
}
.pipeline-run-single-input {
  width: 64px;
  height: 75px;
  object-fit: contain;
  background: var(--workspace-surface);
  border: 1px solid var(--workspace-border);
  border-radius: 7px;
  display: block;
  margin-top: 12px;
}
.pipeline-run-issues {
  padding: 13px 15px;
  border: 1px solid #79553b;
  border-radius: 9px;
  color: #e7b797;
  background: #3b2c2250;
  margin-top: 22px;
  font-size: 10px;
  line-height: 1.8;
}
.pipeline-run-issues strong {
  font-weight: 550;
}
.pipeline-run-issues ul {
  list-style: disc;
  margin: 9px 0 0 16px;
}
.pipeline-run-prepare > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-top: 27px;
  padding-top: 22px;
  border-top: 1px solid var(--workspace-border);
}
.pipeline-run-prepare footer strong {
  font-size: 12px;
  font-weight: 550;
}
.pipeline-run-prepare footer span,
.pipeline-run-prepare footer small {
  display: block;
  color: var(--workspace-muted);
  font-size: 9px;
  margin-top: 7px;
  line-height: 1.6;
}
.pipeline-run-history {
  padding: 28px;
}
.pipeline-run-history header p {
  font-size: 10px;
  color: var(--workspace-muted);
  line-height: 1.8;
  margin: 12px 0 22px;
}
.pipeline-run-history-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 15px;
  padding: 17px;
  border: 1px solid var(--workspace-border);
  border-radius: 10px;
  background: var(--workspace-surface);
  margin: 10px 0;
  text-align: left;
}
.pipeline-run-history-item > .iconify:first-child {
  width: 21px;
  height: 21px;
  color: var(--workspace-accent);
  flex: none;
}
.pipeline-run-history-item > span {
  flex: 1;
  min-width: 0;
}
.pipeline-run-history-item > span:nth-last-child(2) {
  flex: none;
  text-align: right;
}
.pipeline-run-history-item strong {
  font-size: 11px;
  font-weight: 500;
}
.pipeline-run-history-item small {
  display: block;
  font-size: 9px;
  color: var(--workspace-muted);
  margin-top: 7px;
  line-height: 1.6;
}
.pipeline-run-history-item > .iconify:last-child {
  width: 14px;
  height: 14px;
  flex: none;
  color: var(--workspace-muted);
}
@media (max-width: 1200px) {
  .pipeline-library {
    padding: 38px 30px;
  }
  .pipeline-template-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .pipeline-template-card > p {
    min-height: 36px;
  }
  .pipeline-saved-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 760px) {
  .pipeline-library {
    padding: 30px 20px;
  }
  .pipeline-library > header {
    align-items: start;
    flex-direction: column;
    gap: 21px;
  }
  .pipeline-library-actions {
    justify-content: flex-start;
  }
  .pipeline-library h1 {
    font-size: 32px;
  }
  .pipeline-template-section {
    margin-top: 37px;
  }
  .pipeline-template-grid {
    gap: 11px;
  }
  .pipeline-template-card {
    padding: 17px;
  }
  .pipeline-template-card > strong {
    font-size: 12px;
  }
  .pipeline-template-trail {
    display: none;
  }
  .pipeline-section-heading > span {
    display: none;
  }
  .pipeline-template-icon {
    margin-bottom: 25px;
    width: 32px;
    height: 32px;
  }
  .pipeline-template-icon .iconify {
    width: 17px;
    height: 17px;
  }
  .pipeline-template-card > p {
    font-size: 9px;
    min-height: 49px;
  }
  .pipeline-saved-grid {
    grid-template-columns: 1fr;
  }
  .pipeline-search {
    width: 185px;
  }
  .pipeline-editor {
    height: calc(100dvh - 73px);
  }
  .pipeline-editor-toolbar {
    padding: 13px 14px;
    gap: 8px;
    flex-wrap: wrap;
  }
  .pipeline-title {
    min-width: 110px;
  }
  .pipeline-title input {
    font-size: 11px;
  }
  .pipeline-toolbar-history {
    padding-right: 7px;
  }
  .pipeline-toolbar-actions {
    gap: 5px;
  }
  .pipeline-toolbar-actions .pipeline-primary,
  .pipeline-toolbar-actions .pipeline-secondary {
    font-size: 9px;
    padding: 9px;
  }
  .pipeline-toolbar-saved-runs {
    display: none;
  }
  .pipeline-toolbar-actions .pipeline-icon {
    width: 24px;
  }
  .pipeline-editor-footer {
    padding: 9px 14px;
  }
  .pipeline-editor-footer > div > span {
    display: none;
  }
  .pipeline-overlay {
    padding: 12px;
  }
  .pipeline-run-dialog {
    max-height: calc(100dvh - 24px);
  }
  .pipeline-picker-dialog {
    height: calc(100dvh - 24px);
  }
  .pipeline-picker-overlay {
    padding: 12px;
  }
  .pipeline-picker-dialog > header,
  .pipeline-picker-dialog > footer {
    padding: 15px;
  }
  .pipeline-picker-tabs {
    padding: 0 15px;
  }
  .pipeline-run-prepare,
  .pipeline-run-history {
    padding: 22px 17px;
  }
  .pipeline-batch-choose {
    align-items: start;
    flex-direction: column;
  }
  .pipeline-batch-choose > button {
    width: 100%;
  }
  .pipeline-run-prepare > footer {
    align-items: stretch;
    flex-direction: column;
  }
  .pipeline-run-history-item {
    gap: 10px;
    padding: 13px;
  }
  .pipeline-run-history-item > span:nth-last-child(2) {
    max-width: 115px;
  }
  .pipeline-run-history-item > .iconify:first-child {
    display: none;
  }
  .pipeline-dialog {
    padding: 23px;
  }
  .pipeline-editor-notice {
    padding: 9px 14px;
    font-size: 9px;
  }
  .pipeline-personal-section {
    margin-top: 35px;
  }
}
@media (max-width: 390px) {
  .pipeline-template-grid {
    grid-template-columns: 1fr;
  }
  .pipeline-template-card > p {
    min-height: 0;
  }
  .pipeline-search {
    width: 145px;
  }
  .pipeline-toolbar-history {
    display: none;
  }
  .pipeline-toolbar-actions {
    margin-left: auto;
  }
  .pipeline-editor-toolbar > .pipeline-icon {
    width: 22px;
  }
}
</style>
