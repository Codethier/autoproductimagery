import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import { computed, createRenderer, createSSRApp, h, nextTick, ref } from "vue";
import {
  createPipelineNode,
  PipelineDefinitionSchema,
  type PipelineDTO,
  type PipelineRunDTO,
} from "../schemas/pipelines.ts";
import {
  IMAGE_MODEL_PROFILES,
  SUPPORTED_IMAGE_MODEL_IDS,
  createDefaultSettings,
  type ImageModelId,
} from "../schemas/image-generation.ts";
import {
  PIPELINE_PALETTE,
  PIPELINE_TEMPLATES,
} from "../app/utils/pipelineTemplates.ts";
import {createGenerationCreditController, initialGenerationCreditState} from '../app/utils/generationCredit.ts';
import {pipelineRerunUsesCredit, pipelineJobRerunBlockedReason} from '../app/utils/pipelineCredit.ts';

const root = new URL("../", import.meta.url),
  key = "__pipelineUi";
const workspace = new URL("app/components/PipelinesWorkspace.vue", root).href;
const properties = new URL("app/components/PipelineNodeProperties.vue", root)
  .href;
const canvas = new URL("app/components/PipelineCanvas.vue", root).href;
const results = new URL("app/components/PipelineRunResults.vue", root).href;
const favourites = new URL("app/composables/useImageModelFavourites.ts", root)
  .href;
const exposures: Record<string, string> = {
  [workspace]:
    "pipelines,pipeline,definition,name,description,editing,selectedId,selectedEdgeId,models,dirty,conflict,saveError,notice,useTemplate,addNode,updateNode,moveNode,removeNode,duplicateNode,copyNode,pasteNode,connect,disconnect,disconnectNode,undo,redo,canUndo,canRedo,loadPipelines,openPipeline,save,prepareRun,runTarget,batchInput,batchImages,runInputs,inputNodes,executionNodes,canStart,runIssues,creditBlockReason,startRun,runMode,activeRun,runError,starting,picker,pickerUrls,pickerTab,peopleOnlyPicker,pickerTabKey,openPicker,confirmPicker,refreshRun,resumeRun,cancelRun,retryRun,rerunJob,closeRun,loadRuns,runHistory,keyboard,metadataOpen,deleteOpen,discardOpen,openRuns",
  [properties]:
    "updateNode,changeModel,settings,orderedModels,ai,imageProfile,connect,selectImage,errorMessage",
  [results]:
    "expandedItems,retryIds,retryOpen,chargeConfirmed,visibleImage,openRetry,retry,rerun,steps,orderedItemSteps,rerunReason",
  [canvas]:
    "view,paletteOpen,pendingSource,add,outputPort,inputPort,moveKey,fit",
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("~~/"))
      return next(new URL(`${specifier.slice(3)}.ts`, root).href, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === favourites)
      return {
        format: "module",
        shortCircuit: true,
        source: `export const useImageModelFavourites=()=>globalThis.${key}.favourites;`,
      };
    if (
      (exposures[url] ||
        url.startsWith(
          new URL("app/components/generation-settings/", root).href,
        )) &&
      url.endsWith(".vue")
    ) {
      const filename = fileURLToPath(url);
      let source = readFileSync(filename, "utf8");
      if (exposures[url])
        source = source
          .replace(/defineExpose\(\{[\s\S]*?\}\);?/g, "")
          .replace("</script>", `defineExpose({${exposures[url]}})\n</script>`);
      const { descriptor } = parse(source, { filename });
      const compiled = compileScript(descriptor, {
        id: filename,
        inlineTemplate: true,
      });
      return {
        format: "module",
        shortCircuit: true,
        source: stripTypeScriptTypes(
          `import {computed,ref,watch,onMounted,onBeforeUnmount,onServerPrefetch,nextTick,toRaw} from 'vue';const useAccount=()=>globalThis.${key}.account;const useAccountBalance=()=>globalThis.${key}.balance;const useGenerationCredit=()=>globalThis.${key}.credit ??= globalThis.${key}.createCredit();const useRequestFetch=()=>(...args)=>globalThis.${key}.fetch(...args);const useRoute=()=>globalThis.${key}.route;const navigateTo=(...args)=>globalThis.${key}.navigate(...args);${compiled.content}`,
        ),
      };
    }
    return next(url, context);
  },
});
const source =
  "/images/organizations/org/users/alice/objects/product/product.png";
function saved(): PipelineDTO {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Product collection",
    description: "One scene for every product",
    revision: 1,
    definition: PIPELINE_TEMPLATES.find(
      (value) => value.id === "product-photo",
    )!.definition(),
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
  };
}
function reordered<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reordered) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, value]) => [key, reordered(value)]),
    ) as T;
  return value;
}
function run(): PipelineRunDTO {
  const p = saved();
  return {
    id: "22222222-2222-4222-8222-222222222222",
    pipelineId: p.id,
    name: p.name,
    revision: 1,
    status: "queued",
    definition: p.definition,
    targetNodeId: null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    completedAt: null,
    cancelRequested: false,
    summary: {
      total: 1,
      succeeded: 0,
      failed: 0,
      pending: 1,
      confirmedCostUsd: "0",
      outstandingCount: 0,
    },
    items: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        index: 0,
        inputUrl: source,
        status: "queued",
        steps: p.definition.nodes.map((node, index) => ({
          id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
          nodeId: node.id,
          type: node.type,
          status: "queued",
          attempt: 1,
          value: null,
          error: null,
          generationIds: [],
          backgroundRemovalJobId: null,
          startedAt: null,
          completedAt: null,
        })),
      },
    ],
  };
}
function environment(fetch?: (url: string, options: any) => unknown) {
  const calls: Array<{ url: string; options: any }> = [],
    navigations: unknown[] = [],
    ids = ref<ImageModelId[]>([]);
  const models = SUPPORTED_IMAGE_MODEL_IDS.map((id) => ({
    id,
    catalogStatus: "available",
  }));
  const env: any = {
    calls,
    navigations,
    models,
    route: { query: {} as Record<string, string> },
    account: {
      epoch: ref(1),
      identity: ref("org.alice"),
      account: ref({ userId: "alice", organizationId: "org" }),
    },
    balance: {
      balance: ref({
        unlimited: true,
        actualBalanceUsd: null as string | null,
        outstandingCount: 0,
      }),
      refresh: async function () {return this.balance.value},
    },
    favourites: {
      favouriteModelIds: ids,
      favouriteSet: computed(() => new Set(ids.value)),
      ready: ref(true),
      persistent: ref(true),
      toggleFavourite(id: ImageModelId) {
        ids.value = ids.value.includes(id)
          ? ids.value.filter((value) => value !== id)
          : [...ids.value, id];
      },
    },
    navigate: async (value: unknown) => {
      navigations.push(value);
    },
    fetch: async (url: string, options: any = {}) => {
      calls.push({ url, options });
      if (fetch) return fetch(url, options);
      if (url === "/api/image-models") return { items: models };
      if (url === "/api/pipelines")
        return options.method === "POST"
          ? { pipeline: { ...saved(), ...options.body } }
          : { pipelines: [saved()], nextCursor: null };
      if (url.endsWith("/runs")) return { run: run() };
      if (url === "/api/pipeline-runs") return { runs: [], nextCursor: null };
      if (url.startsWith("/api/pipeline-runs/")) return { run: run() };
      return { pipeline: saved() };
    },
  };
  env.createCredit = () => createGenerationCreditController(env.account, env.balance, ref(initialGenerationCreditState()));
  return env;
}
function components(app: any) {
  app.component("UIcon", {
    render: () => h("span", { "aria-hidden": "true" }),
  });
  app.component("NuxtErrorBoundary", {
    render(this: any) {
      return this.$slots.default?.();
    },
  });
  app.component("UCheckbox", {
    render: () => h("input", { type: "checkbox" }),
  });
  app.component("AssetBrowser", { render: () => h("div") });
  app.component("PeopleBrowser", { render: () => h("div") });
  app.component("ModelGuidance", { props: ["modelId", "settings", "context"], setup: (props: any) => () => h("aside", {"data-model-guidance": props.modelId, "data-guidance-context": props.context}) });
  app.component("NuxtLink", {
    props: ["to"],
    render(this: any) {
      return h(
        "a",
        { href: typeof this.to === "string" ? this.to : this.to?.path },
        this.$slots.default?.(),
      );
    },
  });
}
async function render(
  url: string,
  props: Record<string, unknown> = {},
  initialize?: (state: any) => void,
) {
  const env = environment();
  (globalThis as any)[key] = env;
  const { default: component } = await import(url);
  let exposed: any;
  const actual = {
    ...component,
    setup(value: any, context: any) {
      return component.setup(value, {
        ...context,
        expose(state: any) {
          exposed = state;
          initialize?.(state);
          context.expose(state);
        },
      });
    },
  };
  const events: Array<{ name: string; value: any }> = [];
  const app = createSSRApp({
    render: () =>
      h(actual, {
        ...props,
        onUpdate: (value: any) => events.push({ name: "update", value }),
        onRetry: (value: any) => events.push({ name: "retry", value }),
        onRerun: (value: any) => events.push({ name: "rerun", value }),
      }),
  });
  components(app);
  const warnings: string[] = [];
  app.config.warnHandler = (message) => warnings.push(message);
  const html = await renderToString(app);
  assert.deepEqual(warnings, []);
  return { env, html, exposed, events };
}
type Node = {
  tag: string;
  text: string;
  children: Node[];
  parent: Node | null;
  props: Record<string, any>;
  [key: string]: any;
};
function node(tag: string, text = ""): Node {
  const value: Node = {
    tag,
    text,
    children: [],
    parent: null,
    props: {},
    tagName: tag.toUpperCase(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    getRootNode: () => (globalThis as any).document,
    getAttribute: (name: string) => value.props[name],
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 650,
    }),
    clientWidth: 1000,
    clientHeight: 650,
    multiple: false,
  };
  Object.defineProperty(value, "options", {
    get: () => value.children.filter((child) => child.tag === "option"),
  });
  return value;
}
const renderer = createRenderer<Node, Node>({
  createElement: (tag) => node(tag),
  createText: (text) => node("#text", text),
  createComment: (text) => node("#comment", text),
  insert(value, parent, anchor) {
    if (value.parent)
      value.parent.children.splice(value.parent.children.indexOf(value), 1);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(value);
    else parent.children.splice(index, 0, value);
    value.parent = parent;
  },
  remove(value) {
    if (value.parent)
      value.parent.children.splice(value.parent.children.indexOf(value), 1);
    value.parent = null;
  },
  setText(value, text) {
    value.text = text;
  },
  setElementText(value, text) {
    value.text = text;
    value.children = [];
  },
  parentNode: (value) => value.parent,
  nextSibling: (value) =>
    value.parent?.children[value.parent.children.indexOf(value) + 1] ?? null,
  patchProp(value, name, _previous, next) {
    value.props[name] = next;
    value[name] = next;
  },
});
async function flush() {
  for (let index = 0; index < 6; index++) await nextTick();
  await new Promise((resolve) => setImmediate(resolve));
  await nextTick();
}
async function mount(env = environment()) {
  (globalThis as any)[key] = env;
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).Document = class {};
  (globalThis as any).ShadowRoot = class {};
  (globalThis as any).document = {
    activeElement: null,
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
  };
  (globalThis as any).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const { default: component } = await import(workspace);
  let exposed: any;
  const actual = {
    ...component,
    setup(value: any, context: any) {
      return component.setup(value, {
        ...context,
        expose(state: any) {
          exposed = state;
          context.expose(state);
        },
      });
    },
  };
  const app = renderer.createApp({ render: () => h(actual) });
  components(app);
  const warnings: string[] = [];
  app.config.warnHandler = (message) => warnings.push(message);
  const tree = node("root");
  app.mount(tree);
  await flush();
  assert.deepEqual(warnings, []);
  return { app, exposed, env, tree };
}
function findElement(tree: Node, id: string): Node | undefined {
  if (tree.props.id === id) return tree;
  for (const child of tree.children) {
    const value = findElement(child, id);
    if (value) return value;
  }
}
function findByLabel(tree: Node, label: string): Node | undefined {
  if (tree.props["aria-label"] === label) return tree;
  return tree.children.map(child => findByLabel(child, label)).find(Boolean);
}
function completedRun(): PipelineRunDTO {
  const value = run();
  value.status = 'succeeded'; value.summary.succeeded = 1; value.summary.pending = 0;
  value.items.forEach(item => {item.status = 'succeeded'; item.steps.forEach(step => {step.status = 'succeeded'; step.completedAt = value.updatedAt;})});
  return value;
}

test("all editable templates validate and the palette contains every supported image-only node", () => {
  assert.equal(PIPELINE_PALETTE.length, 18);
  for (const template of PIPELINE_TEMPLATES)
    assert.equal(
      PipelineDefinitionSchema.safeParse(template.definition()).success,
      true,
      template.id,
    );
  assert.equal(
    PIPELINE_PALETTE.some((value) => /video|audio/i.test(value.description)),
    false,
  );
});
test("new drafts on the library route remain in the editor without redundant navigation", async () => {
  const value = await mount();
  try {
    value.exposed.useTemplate(PIPELINE_TEMPLATES[0]);
    await flush();
    assert.equal(value.exposed.editing.value, true);
    assert.equal(value.exposed.definition.value.nodes.length, 2);
    assert.deepEqual(value.env.navigations, []);
    assert.equal(value.exposed.name.value, "Untitled pipeline");
  } finally {
    value.app.unmount();
  }
});
test("pipeline settings expose saved run history even when compact toolbar controls are hidden", async () => {
  const value = await mount();
  try {
    const s = value.exposed;
    s.useTemplate(PIPELINE_TEMPLATES[0]);
    s.metadataOpen.value = true;
    await flush();
    const button = findElement(value.tree, "pipeline-settings-runs")!;
    assert.ok(button);
    button.props.onClick();
    await flush();
    assert.equal(s.metadataOpen.value, false);
    assert.equal(s.runMode.value, "history");
    assert.equal(
      value.env.calls.some((call) => call.url === "/api/pipeline-runs"),
      true,
    );
  } finally {
    value.app.unmount();
  }
});
test("pipeline library renders its own warm design, templates and personal saved workflows", async () => {
  const value = await render(workspace, {}, (state) => {
    state.pipelines.value = [saved()];
  });
  assert.match(value.html, /Product photography/);
  assert.match(value.html, /On-model collection/);
  assert.match(value.html, /Product collection/);
  assert.match(value.html, /Import JSON/);
  assert.doesNotMatch(value.html, /pixelcut|Video Studio|API key/i);
});
test("canvas adds real tools and exposes accessible ports, keyboard movement, zoom and minimap", async () => {
  const value = await render(canvas, {
    definition: saved().definition,
    selectedId: "generate",
  });
  assert.match(value.html, /Pipeline node canvas/);
  assert.match(value.html, /Arrow keys move/);
  assert.match(value.html, /Connect from Product picture Image output/);
  assert.match(value.html, /Zoom in/);
  assert.match(value.html, /Pipeline overview/);
  assert.match(value.html, /Run to Generate Image/);
});
test("graph editing replaces single input connections, rejects type mismatch and cycles, and supports undo", async () => {
  const value = await mount();
  try {
    const s = value.exposed;
    s.useTemplate(PIPELINE_TEMPLATES[1]);
    s.addNode("static-text", { x: 50, y: 400 });
    const textNode = s.definition.value.nodes.at(-1);
    s.connect(textNode.id, "text", "generate", "prompt");
    assert.equal(s.definition.value.edges.length, 3);
    s.connect("product", "image", "generate", "prompt");
    assert.match(s.notice.value, /image to image/);
    assert.equal(s.definition.value.edges.length, 3);
    s.addNode("generate-image", { x: 900, y: 400 });
    const generated = s.definition.value.nodes.at(-1);
    s.connect("generate", "image", generated.id, "image");
    s.connect(generated.id, "image", "generate", "image");
    assert.match(s.notice.value, /loop/);
    assert.equal(
      s.definition.value.edges.some(
        (edge: any) =>
          edge.source === generated.id && edge.target === "generate",
      ),
      false,
    );
    s.undo();
    assert.equal(
      s.definition.value.edges.some(
        (edge: any) => edge.target === generated.id,
      ),
      false,
    );
    s.redo();
    assert.equal(
      s.definition.value.edges.some(
        (edge: any) => edge.target === generated.id,
      ),
      true,
    );
    s.duplicateNode("product");
    assert.equal(
      s.definition.value.nodes.filter(
        (node: any) => node.type === "image-input",
      ).length,
      2,
    );
  } finally {
    value.app.unmount();
  }
});
test("reselecting an exact connection toggles single and multiple inputs without touching siblings", async () => {
  const value = await mount();
  try {
    const s = value.exposed;
    s.useTemplate(PIPELINE_TEMPLATES[1]);
    const nodes = JSON.parse(JSON.stringify(s.definition.value.nodes));
    const original = JSON.parse(JSON.stringify(s.definition.value.edges));
    s.connect("product", "image", "generate", "image");
    assert.equal(s.definition.value.edges.length, original.length - 1);
    assert.deepEqual(s.definition.value.nodes, nodes);
    s.undo();
    assert.deepEqual(s.definition.value.edges, original);
    s.redo();
    assert.equal(s.definition.value.edges.length, original.length - 1);
    s.connect("product", "image", "generate", "image");
    s.addNode("people-input", { x: 0, y: 600 });
    const person = s.definition.value.nodes.at(-1);
    s.connect(person.id, "image", "generate", "references");
    s.connect("product", "image", "generate", "references");
    const withReferences = JSON.parse(JSON.stringify(s.definition.value.edges));
    s.connect(person.id, "image", "generate", "references");
    assert.deepEqual(
      s.definition.value.edges,
      withReferences.filter((edge: any) => edge.source !== person.id),
    );
    s.undo();
    assert.deepEqual(s.definition.value.edges, withReferences);
    s.redo();
    assert.equal(s.definition.value.edges.some((edge: any) => edge.source === person.id), false);
    s.connect(person.id, "image", "generate", "image");
    assert.equal(s.definition.value.edges.filter((edge: any) => edge.target === "generate" && edge.targetPort === "image").length, 1);
    assert.equal(s.definition.value.edges.find((edge: any) => edge.target === "generate" && edge.targetPort === "image").source, person.id);
  } finally {
    value.app.unmount();
  }
});

test("Delete disconnects the selected node or edge, preserves nodes, and ignores fields and dialogs", async () => {
  const value = await mount();
  try {
    const s = value.exposed;
    s.useTemplate(PIPELINE_TEMPLATES[1]);
    const nodes = JSON.parse(JSON.stringify(s.definition.value.nodes));
    const edges = JSON.parse(JSON.stringify(s.definition.value.edges));
    const key = (extras: any = {}) => ({ key: "Delete", target: { matches: () => false }, preventDefault() {}, ...extras });
    s.selectedId.value = "generate";
    for (const extras of [
      { target: { matches: () => true } },
      { target: { matches: () => false, isContentEditable: true } },
      { defaultPrevented: true },
    ]) s.keyboard(key(extras));
    for (const flag of ["metadataOpen", "deleteOpen", "discardOpen"]) {
      s[flag].value = true;
      s.keyboard(key());
      s[flag].value = false;
    }
    s.runMode.value = "prepare";
    s.keyboard(key());
    s.runMode.value = null;
    s.openPicker("product", "defaultImage", [], 1);
    s.keyboard(key());
    s.picker.value = null;
    s.editing.value = false;
    s.keyboard(key());
    s.editing.value = true;
    assert.deepEqual(s.definition.value.edges, edges);
    s.keyboard(key());
    assert.deepEqual(s.definition.value.nodes, nodes);
    assert.equal(s.selectedId.value, "generate");
    assert.equal(s.definition.value.edges.some((edge: any) => edge.source === "generate" || edge.target === "generate"), false);
    s.undo();
    assert.deepEqual(s.definition.value.edges, edges);
    s.selectedEdgeId.value = edges[0].id;
    s.keyboard(key());
    assert.deepEqual(s.definition.value.edges, edges.slice(1));
    assert.deepEqual(s.definition.value.nodes, nodes);
    s.removeNode("generate");
    assert.equal(s.definition.value.nodes.some((node: any) => node.id === "generate"), false);
  } finally {
    value.app.unmount();
  }
});

test("focused node Delete emits disconnect while its explicit trash action still removes", async () => {
  const definition = PIPELINE_TEMPLATES[1]!.definition();
  const events: string[] = [];
  const value = await render(canvas, {
    definition, selectedId: "generate",
    onDisconnectNode: (id: string) => events.push(`disconnect:${id}`),
    onRemove: (id: string) => events.push(`remove:${id}`),
  });
  let prevented = false;
  value.exposed.moveKey(definition.nodes.find((node) => node.id === "generate"), { key: "Delete", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(events, ["disconnect:generate"]);
  assert.match(value.html, /Delete disconnects/);
  assert.match(value.html, /aria-label="Delete Generate Image"/);
  const disabled = await render(canvas, {
    definition, selectedId: "generate", disabled: true,
    onDisconnectNode: () => events.push("disabled-disconnect"),
  });
  disabled.exposed.moveKey(definition.nodes[0], { key: "Delete", preventDefault() {} });
  assert.deepEqual(events, ["disconnect:generate"]);
});

test("People Input opens a People-only picker and keeps its exact selected pictures", async () => {
  const value = await mount();
  try {
    const s = value.exposed;
    s.useTemplate(PIPELINE_TEMPLATES[0]);
    s.addNode("people-input", { x: 50, y: 400 });
    const person = s.definition.value.nodes.at(-1);
    s.openPicker(person.id, "images", [], 16);
    await flush();
    assert.equal(s.peopleOnlyPicker.value, true);
    assert.equal(s.pickerTab.value, "people");
    assert.equal(findElement(value.tree, "pipeline-library-tab"), undefined);
    assert.ok(findElement(value.tree, "pipeline-people-tab"));
    (globalThis as any).document.getElementById = () => ({ focus() {} });
    for (const key of ["Home", "End", "ArrowLeft", "ArrowRight"]) {
      s.pickerTabKey({ key, preventDefault() {} });
      assert.equal(s.pickerTab.value, "people");
    }
    s.confirmPicker([source, source, "https://example.com/not-private.png"]);
    assert.deepEqual(s.definition.value.nodes.find((node: any) => node.id === person.id).config.images, [source]);
    s.openPicker("product", "defaultImage", [], 1);
    await flush();
    assert.equal(s.peopleOnlyPicker.value, false);
    assert.equal(s.pickerTab.value, "library");
    assert.ok(findElement(value.tree, "pipeline-library-tab"));
    s.picker.value = null;
  } finally {
    value.app.unmount();
  }
});

test("property input events preserve both dimensions and Ctrl S saves them before any blur", async () => {
  const value = await mount();
  try {
    const s = value.exposed;
    s.useTemplate(PIPELINE_TEMPLATES[0]);
    s.addNode("crop", { x: 350, y: 100 });
    await flush();
    const width = findElement(value.tree, "pipeline-width")!,
      height = findElement(value.tree, "pipeline-height")!;
    assert.equal(typeof width.props.onInput, "function");
    assert.equal(typeof height.props.onInput, "function");
    width.props.onInput({ target: { value: "600" } });
    height.props.onInput({ target: { value: "800" } });
    const crop = s.definition.value.nodes.find(
      (node: any) => node.type === "crop",
    );
    assert.deepEqual(
      { width: crop.config.width, height: crop.config.height },
      { width: 600, height: 800 },
    );
    s.keyboard({
      key: "s",
      ctrlKey: true,
      metaKey: false,
      target: { matches: () => false },
      preventDefault: () => {},
    });
    await flush();
    const call = value.env.calls.find(
      (call) => call.url === "/api/pipelines" && call.options.method === "POST",
    )!;
    const persisted = call.options.body.definition.nodes.find(
      (node: any) => node.type === "crop",
    );
    assert.equal(persisted.config.width, 600);
    assert.equal(persisted.config.height, 800);
  } finally {
    value.app.unmount();
  }
});
test("prompt and step-name input events are included in a run snapshot without waiting for change", async () => {
  const value = await mount();
  try {
    const s = value.exposed;
    s.useTemplate(PIPELINE_TEMPLATES[1]);
    s.selectedId.value = "generate";
    await flush();
    findElement(value.tree, "pipeline-generation-prompt")!.props.onInput({
      target: {
        value: "Keep the product exactly as shown. A cool blue studio scene.",
      },
    });
    findElement(value.tree, "pipeline-node-name")!.props.onInput({
      target: { value: "Blue studio" },
    });
    await s.prepareRun();
    s.batchImages.value = [source];
    await s.startRun();
    const call = value.env.calls.find(
      (call) => call.url === "/api/pipelines" && call.options.method === "POST",
    )!;
    const persisted = call.options.body.definition.nodes.find(
      (node: any) => node.id === "generate",
    );
    assert.equal(
      persisted.config.prompt,
      "Keep the product exactly as shown. A cool blue studio scene.",
    );
    assert.equal(persisted.label, "Blue studio");
  } finally {
    value.app.unmount();
  }
});
test("node-run setup includes only connected ancestry and preserves independent batch input paths", async () => {
  const value = await mount();
  try {
    const s = value.exposed;
    s.useTemplate(PIPELINE_TEMPLATES[1]);
    s.addNode("text-input", { x: 20, y: 500 });
    await s.prepareRun("generate");
    assert.deepEqual(
      s.inputNodes.value.map((node: any) => node.id),
      ["product"],
    );
    s.batchImages.value = [source, source.replace("product.png", "second.png")];
    assert.equal(s.canStart.value, true);
    await s.startRun();
    const call = value.env.calls.find(
      (item) => item.url.endsWith("/runs") && item.options.method === "POST",
    )!;
    assert.deepEqual(call.options.body.inputImages, [
      source,
      source.replace("product.png", "second.png"),
    ]);
    assert.equal(call.options.body.targetNodeId, "generate");
    assert.equal(s.runMode.value, "results");
    assert.equal(
      value.env.calls.some((item) => item.url.endsWith("/advance")),
      false,
    );
  } finally {
    value.app.unmount();
  }
});
test('paid pipeline start and run-to-step refuse zero credit with a popup; local-only targets still start', async () => {
  for (const target of [undefined, 'generate']) {
    const env = environment(); env.balance.balance.value = {unlimited: false, actualBalanceUsd: '0', outstandingCount: 0}
    const value = await mount(env)
    try {
      value.exposed.useTemplate(PIPELINE_TEMPLATES.find(template => template.id === 'product-photo'))
      await value.exposed.prepareRun(target); value.exposed.batchImages.value = [source]
      assert.equal(value.exposed.canStart.value, true)
      await value.exposed.startRun()
      assert.equal(env.calls.some((call: any) => call.url.endsWith('/runs') && call.options.method === 'POST'), false)
      assert.equal(env.credit.open.value, true); assert.equal(value.exposed.runError.value, '')
    } finally {value.app.unmount()}
  }
  const env = environment(); env.balance.balance.value = {unlimited: false, actualBalanceUsd: '-0.01', outstandingCount: 0}
  const value = await mount(env)
  try {
    value.exposed.useTemplate(PIPELINE_TEMPLATES.find(template => template.id === 'clean-catalog'))
    await value.exposed.prepareRun(); value.exposed.batchImages.value = [source]
    await value.exposed.startRun()
    assert.equal(env.calls.some((call: any) => call.url.endsWith('/runs') && call.options.method === 'POST'), true)
    assert.equal(env.credit.open.value, false)
  } finally {value.app.unmount()}
})

test('pipeline retry uses the saved run and paid descendants even when the current editor is a local pipeline', async () => {
  const env = environment(); env.balance.balance.value = {unlimited: false, actualBalanceUsd: '0', outstandingCount: 0}
  const value = await mount(env)
  try {
    value.exposed.useTemplate(PIPELINE_TEMPLATES.find(template => template.id === 'clean-catalog'))
    const original = run(); original.status = 'failed'; original.items[0]!.steps.forEach(step => {step.status = 'failed'})
    value.exposed.activeRun.value = original
    const inputStep = original.items[0]!.steps.find(step => step.type === 'image-input')!
    await value.exposed.retryRun([inputStep.id])
    assert.equal(env.calls.some((call: any) => call.url.endsWith('/retry')), false)
    assert.equal(env.credit.open.value, true); assert.equal(value.exposed.runError.value, '')
  } finally {value.app.unmount()}
})

test('completed job rerun uses live credit and saved model nodes instead of the edited canvas', async () => {
  for (const credit of ['0', '-0.01']) {
    const env = environment(); env.balance.balance.value = {unlimited: false, actualBalanceUsd: credit, outstandingCount: 0};
    const value = await mount(env);
    try {
      value.exposed.useTemplate(PIPELINE_TEMPLATES.find(template => template.id === 'clean-catalog'));
      const original = completedRun(); value.exposed.activeRun.value = original;
      await value.exposed.rerunJob(original.items[0]!.id);
      assert.equal(env.calls.some((call: any) => call.url.endsWith('/rerun')), false);
      assert.equal(env.credit.open.value, true); assert.equal(value.exposed.runError.value, '');
    } finally {value.app.unmount();}
  }
});

test('local-only reruns have no balance check; positive and Unlimited paid reruns submit immutable attempt IDs', async () => {
  for (const mode of ['free', 'positive', 'unlimited']) {
    const env = environment();
    env.balance.balance.value = mode === 'unlimited' ? {unlimited: true, actualBalanceUsd: null, outstandingCount: 4}
      : {unlimited: false, actualBalanceUsd: mode === 'free' ? '0' : '0.000000000001', outstandingCount: 0};
    let forced = 0; env.balance.refresh = async (options: {force?: boolean} = {}) => {if (options.force) forced++; return env.balance.balance.value;};
    const value = await mount(env);
    try {
      const original = completedRun();
      if (mode === 'free') {
        const template = PIPELINE_TEMPLATES.find(template => template.id === 'clean-catalog')!.definition();
        original.definition = template;
        original.items[0]!.steps = template.nodes.map((node, index) => ({...original.items[0]!.steps[0]!, id: `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`, nodeId: node.id, type: node.type}));
      }
      value.exposed.useTemplate(PIPELINE_TEMPLATES.find(template => template.id === 'clean-catalog'));
      value.exposed.activeRun.value = original; value.exposed.runMode.value = 'results';
      await value.exposed.rerunJob(original.items[0]!.id);
      const call = env.calls.find((call: any) => call.url.endsWith('/rerun'))!;
      assert.ok(call);
      assert.deepEqual(call.options.body, {itemIds: [original.items[0]!.id], expectedStepIds: original.items[0]!.steps.map(step => step.id), confirmPossibleCharge: mode !== 'free'});
      assert.equal(forced, mode === 'free' ? 0 : 1); assert.equal(env.credit.open.value, false);
      assert.equal(value.exposed.activeRun.value.id, original.id); assert.equal(value.exposed.activeRun.value.status, 'queued');
      assert.equal(value.exposed.runMode.value, 'results');
      assert.equal('definition' in call.options.body, false); assert.equal('inputImages' in call.options.body, false);
    } finally {value.app.unmount();}
  }
});

test('a real per-input rerun button requeues one job in the same pane and suppresses rapid double clicks', async () => {
  const env = environment(); const originalFetch = env.fetch; let release!: (response: unknown) => void;
  env.fetch = async (url: string, options: any) => {
    const response = await originalFetch(url, options);
    return url.endsWith('/rerun') ? new Promise(resolve => {release = resolve;}) : response;
  };
  const value = await mount(env);
  try {
    const original = completedRun();
    const sibling = {...original.items[0]!, id: '66666666-6666-4666-8666-666666666666', index: 1, steps: original.items[0]!.steps.map((step, index) => ({...step, id: `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`}))};
    original.items.push(sibling); original.summary.total = 2; original.summary.succeeded = 2;
    value.exposed.activeRun.value = original; value.exposed.runMode.value = 'results'; await flush();
    const button = findByLabel(value.tree, 'Rerun job for Input 1')!; assert.ok(button); assert.equal(Boolean(button.props.disabled), false);
    button.props.onClick(); button.props.onClick(); await flush();
    assert.equal(env.calls.filter((call: any) => call.url.endsWith('/rerun')).length, 1);
    assert.deepEqual(env.calls.find((call: any) => call.url.endsWith('/rerun'))!.options.body.itemIds, [original.items[0]!.id]);
    const queued = structuredClone(original); queued.status = 'queued'; queued.items[0]!.status = 'queued';
    queued.items[0]!.steps.forEach((step, index) => {step.id = `88888888-8888-4888-8888-${String(index).padStart(12, '0')}`; step.status = 'queued'; step.attempt = 2;});
    release({run: queued}); await flush();
    assert.equal(value.exposed.runMode.value, 'results'); assert.equal(value.exposed.activeRun.value.items[0].status, 'queued');
    assert.deepEqual(value.exposed.activeRun.value.items[1], sibling);
    assert.equal(findByLabel(value.tree, 'Rerun job for Input 1'), undefined);
    assert.equal(findByLabel(value.tree, 'Batch progress by input and step')!.props.tabindex, '0');
  } finally {value.app.unmount();}
});

test('authoritative rerun 402 shows shared balance popup and account switches discard pending rerun responses', async () => {
  const env = environment(); const originalFetch = env.fetch;
  env.fetch = async (url: string, options: any) => {const response = await originalFetch(url, options); if (url.endsWith('/rerun')) throw {statusCode: 402, data: {data: {code: 'CREDIT_EXHAUSTED'}}}; return response;};
  const value = await mount(env);
  try {
    const original = completedRun(); value.exposed.activeRun.value = original;
    await value.exposed.rerunJob(original.items[0]!.id);
    assert.equal(env.credit.open.value, true); assert.equal(value.exposed.runError.value, '');
  } finally {value.app.unmount();}
  const switchedEnv = environment(); const baseFetch = switchedEnv.fetch; let release!: (response: unknown) => void;
  switchedEnv.fetch = async (url: string, options: any) => {const response = await baseFetch(url, options); return url.endsWith('/rerun') ? new Promise(resolve => {release = resolve;}) : response;};
  const switched = await mount(switchedEnv);
  try {
    const original = completedRun(); switched.exposed.activeRun.value = original;
    const request = switched.exposed.rerunJob(original.items[0]!.id); await flush();
    switchedEnv.account.identity.value = 'org.bob'; switchedEnv.account.epoch.value++; await flush();
    release({run: original}); await request; await flush();
    assert.equal(switched.exposed.activeRun.value, null); assert.equal(switchedEnv.credit.open.value, false);
  } finally {switched.app.unmount();}
});

test('progress refresh cannot race a rerun while its live balance check or POST is in flight', async () => {
  const env = environment(); const baseFetch = env.fetch;
  env.balance.balance.value = {unlimited: false, actualBalanceUsd: '1', outstandingCount: 0};
  let releaseBalance!: (balance: unknown) => void, releaseRerun!: (response: unknown) => void;
  env.balance.refresh = async (options: {force?: boolean} = {}) => options.force ? new Promise(resolve => {releaseBalance = resolve;}) : env.balance.balance.value;
  env.fetch = async (url: string, options: any) => {const response = await baseFetch(url, options); return url.endsWith('/rerun') ? new Promise(resolve => {releaseRerun = resolve;}) : response;};
  const value = await mount(env);
  try {
    const original = completedRun(); original.status = 'running';
    original.items.push({...original.items[0]!, id: '99999999-9999-4999-8999-999999999999', index: 1, status: 'queued', steps: original.items[0]!.steps.map(step => ({...step, status: 'queued'}))});
    value.exposed.activeRun.value = original; value.exposed.runMode.value = 'results';
    const job = value.exposed.rerunJob(original.items[0]!.id); await flush();
    await value.exposed.refreshRun();
    assert.equal(env.calls.some((call: any) => call.url === `/api/pipeline-runs/${original.id}`), false);
    releaseBalance(env.balance.balance.value); await flush();
    await value.exposed.refreshRun();
    assert.equal(env.calls.some((call: any) => call.url === `/api/pipeline-runs/${original.id}`), false);
    const queued = structuredClone(original); queued.items[0]!.status = 'queued'; queued.items[0]!.steps.forEach(step => {step.attempt = 2; step.status = 'queued';});
    releaseRerun({run: queued}); await job; await flush();
    assert.equal(value.exposed.activeRun.value.items[0].status, 'queued');
    assert.deepEqual(value.exposed.activeRun.value.items[1], original.items[1]);
  } finally {value.app.unmount();}
});

test('an authoritative pipeline 402 and a background exhausted step show a deduplicated balance notice', async () => {
  const env = environment((url, options) => {
    if (url.endsWith('/runs')) throw {statusCode: 402, data: {data: {code: 'CREDIT_EXHAUSTED'}}}
    if (url === '/api/image-models') return {items: SUPPORTED_IMAGE_MODEL_IDS.map(id => ({id, catalogStatus: 'available'}))}
    if (url === '/api/pipelines') return options.method === 'POST' ? {pipeline: {...saved(), ...options.body}} : {pipelines: [saved()], nextCursor: null}
    return {pipeline: saved()}
  })
  const value = await mount(env)
  try {
    value.exposed.useTemplate(PIPELINE_TEMPLATES.find(template => template.id === 'product-photo'))
    await value.exposed.prepareRun(); value.exposed.batchImages.value = [source]
    await value.exposed.startRun()
    assert.equal(env.credit.open.value, true); assert.equal(value.exposed.runError.value, '')
    env.credit.close()
    env.balance.balance.value = {unlimited: false, actualBalanceUsd: '0', outstandingCount: 0}
    const failed = run(); failed.status = 'failed'
    failed.items[0]!.steps.find(step => step.type === 'generate-image')!.error = {code: 'CREDIT_EXHAUSTED', message: 'Credit exhausted', retryable: true}
    value.exposed.activeRun.value = failed
    await flush(); assert.equal(env.credit.open.value, true)
    env.credit.close(); value.exposed.activeRun.value = structuredClone(failed)
    await flush(); assert.equal(env.credit.open.value, false, 'closing a notice survives identical polling responses')
  } finally {value.app.unmount()}
})

test('historical background credit failures use fresh balance and do not ask topped-up or unlimited users for credit', async () => {
  for (const fresh of [{unlimited: false, actualBalanceUsd: '0.000000000001', outstandingCount: 0}, {unlimited: true, actualBalanceUsd: null, outstandingCount: 4}]) {
    const env = environment(); env.balance.balance.value = {unlimited: false, actualBalanceUsd: '0', outstandingCount: 0}
    let checks = 0
    env.balance.refresh = async (options: {force?: boolean} = {}) => {
      if (options.force) checks++
      env.balance.balance.value = fresh
      return fresh
    }
    const value = await mount(env)
    try {
      const failed = run(); failed.status = 'failed'
      failed.items[0]!.steps.find(step => step.type === 'generate-image')!.error = {code: 'CREDIT_EXHAUSTED', message: 'Credit exhausted', retryable: true}
      value.exposed.activeRun.value = failed
      await flush()
      assert.equal(checks, 1); assert.equal(env.credit.open.value, false)
      assert.equal(value.exposed.runError.value, '')
      value.exposed.activeRun.value = structuredClone(failed)
      await flush(); assert.equal(checks, 1, 'identical saved failures must not keep checking credit')
    } finally {value.app.unmount()}
  }
})

test("uncertain run submission reuses one idempotency key and does not duplicate accepted work", async () => {
  let attempts = 0;
  const env = environment((url, options) => {
    if (url === "/api/image-models")
      return {
        items: SUPPORTED_IMAGE_MODEL_IDS.map((id) => ({
          id,
          catalogStatus: "available",
        })),
      };
    if (url === "/api/pipelines")
      return options.method === "POST"
        ? { pipeline: { ...saved(), ...options.body } }
        : { pipelines: [saved()], nextCursor: null };
    if (url.endsWith("/runs")) {
      attempts++;
      if (attempts === 1) throw new Error("network lost");
      return { run: run() };
    }
    return { pipeline: saved() };
  });
  const value = await mount(env);
  try {
    const s = value.exposed;
    s.useTemplate(PIPELINE_TEMPLATES[1]);
    await s.prepareRun();
    s.batchImages.value = [source];
    await s.startRun();
    assert.match(s.runError.value, /same request key/);
    await s.startRun();
    const calls = env.calls.filter((item) => item.url.endsWith("/runs"));
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0]!.options.body.idempotencyKey,
      calls[1]!.options.body.idempotencyKey,
    );
  } finally {
    value.app.unmount();
  }
});
test("optimistic save conflict preserves edits and blocks submission until a deliberate reload", async () => {
  const env = environment((url, options) => {
    if (url === "/api/image-models") return { items: [] };
    if (url === "/api/pipelines")
      return { pipelines: [saved()], nextCursor: null };
    if (options.method === "PATCH") throw { statusCode: 409 };
    return { pipeline: saved() };
  });
  const value = await mount(env);
  try {
    const s = value.exposed;
    await s.openPipeline(saved().id);
    s.name.value = "My revised collection";
    assert.equal(await s.save(), null);
    assert.equal(s.conflict.value, true);
    assert.equal(s.name.value, "My revised collection");
    await s.prepareRun();
    s.batchImages.value = [source];
    assert.equal(s.canStart.value, false);
  } finally {
    value.app.unmount();
  }
});
test("JSONB object-key ordering does not leave an identical pipeline dirty after saving", async () => {
  const env = environment((url, options) => {
    if (url === "/api/image-models") return { items: [] };
    if (url === "/api/pipelines") return { pipelines: [], nextCursor: null };
    if (options.method === "PATCH")
      return {
        pipeline: {
          ...saved(),
          revision: 2,
          definition: reordered(options.body.definition),
        },
      };
    return {
      pipeline: { ...saved(), definition: reordered(saved().definition) },
    };
  });
  const value = await mount(env);
  try {
    const s = value.exposed;
    await s.openPipeline(saved().id);
    s.moveNode("product", { x: 120, y: 160 });
    await s.save();
    assert.equal(s.dirty.value, false);
    await s.save();
    assert.equal(
      env.calls.filter((call) => call.options.method === "PATCH").length,
      1,
    );
  } finally {
    value.app.unmount();
  }
});
test("run submission waits for the latest graph when edits arrive during a slow save", async () => {
  const patches: Array<{ body: any; resolve: (value: any) => void }> = [];
  const env = environment((url, options) => {
    if (url === "/api/image-models")
      return {
        items: SUPPORTED_IMAGE_MODEL_IDS.map((id) => ({
          id,
          catalogStatus: "available",
        })),
      };
    if (url === "/api/pipelines") return { pipelines: [], nextCursor: null };
    if (options.method === "PATCH")
      return new Promise((resolve) =>
        patches.push({ body: options.body, resolve }),
      );
    if (url.endsWith("/runs"))
      return { run: { ...run(), revision: options.body.revision } };
    return { pipeline: saved() };
  });
  const value = await mount(env);
  let running: Promise<void> | null = null;
  function settle(index: number) {
    const patch = patches[index];
    patch?.resolve({
      pipeline: {
        ...saved(),
        revision: index + 2,
        definition: patch.body.definition,
      },
    });
  }
  try {
    const s = value.exposed;
    await s.openPipeline(saved().id);
    s.moveNode("product", { x: 120, y: 160 });
    await s.prepareRun();
    s.batchImages.value = [source];
    running = s.startRun();
    await flush();
    assert.equal(patches.length, 1);
    s.moveNode("product", { x: 240, y: 220 });
    settle(0);
    await flush();
    assert.equal(patches.length, 2);
    assert.equal(
      env.calls.some((call) => call.url.endsWith("/runs")),
      false,
    );
    assert.equal(patches[1]!.body.revision, 2);
    assert.deepEqual(
      patches[1]!.body.definition.nodes.find(
        (node: any) => node.id === "product",
      ).position,
      { x: 240, y: 220 },
    );
    settle(1);
    await running;
    assert.equal(
      env.calls.find((call) => call.url.endsWith("/runs"))!.options.body
        .revision,
      3,
    );
    assert.equal(s.dirty.value, false);
  } finally {
    value.app.unmount();
    for (let index = 0; index < patches.length; index++) settle(index);
    await running;
  }
});
test("a late save cannot overwrite a newly imported or template draft", async () => {
  let resolveSave: (value: unknown) => void = () => {};
  const deferred = new Promise((resolve) => {
    resolveSave = resolve;
  });
  const env = environment((url, options) =>
    url === "/api/image-models"
      ? { items: [] }
      : options.method === "POST"
        ? deferred
        : url === "/api/pipelines"
          ? { pipelines: [], nextCursor: null }
          : { pipeline: saved() },
  );
  const value = await mount(env);
  try {
    const s = value.exposed;
    s.useTemplate(PIPELINE_TEMPLATES[1]);
    const pending = s.save();
    s.useTemplate(PIPELINE_TEMPLATES[2]);
    resolveSave({ pipeline: saved() });
    await pending;
    await flush();
    assert.equal(s.pipeline.value, null);
    assert.equal(s.name.value, "On-model collection");
    assert.equal(
      s.definition.value.nodes.some((node: any) => node.id === "person"),
      true,
    );
  } finally {
    value.app.unmount();
  }
});
test("manual Save joins an in-flight autosave and both callers return the latest revision once", async () => {
  const patches: Array<{ body: any; resolve: (value: any) => void }> = [];
  const env = environment((url, options) => {
    if (url === "/api/image-models") return { items: [] };
    if (url === "/api/pipelines") return { pipelines: [], nextCursor: null };
    if (options.method === "PATCH")
      return new Promise((resolve) =>
        patches.push({ body: options.body, resolve }),
      );
    return { pipeline: saved() };
  });
  const value = await mount(env);
  let first: Promise<PipelineDTO | null> | null = null,
    second: Promise<PipelineDTO | null> | null = null;
  function settle(index: number) {
    const patch = patches[index];
    patch?.resolve({
      pipeline: {
        ...saved(),
        revision: index + 2,
        definition: patch.body.definition,
      },
    });
  }
  try {
    const s = value.exposed;
    await s.openPipeline(saved().id);
    s.moveNode("product", { x: 120, y: 160 });
    first = s.save();
    await flush();
    s.moveNode("product", { x: 240, y: 220 });
    second = s.save();
    settle(0);
    await flush();
    assert.equal(patches.length, 2);
    settle(1);
    const results = await Promise.all([first, second]);
    assert.deepEqual(
      results.map((value) => value?.revision),
      [3, 3],
    );
    assert.equal(s.dirty.value, false);
    await s.save();
    assert.equal(patches.length, 2);
  } finally {
    value.app.unmount();
    for (let index = 0; index < patches.length; index++) settle(index);
    await Promise.all([first, second]);
  }
});
test("late list and run responses cannot repopulate another account or its private reference selections", async () => {
  let resolveList: (value: unknown) => void = () => {};
  const deferred = new Promise((resolve) => {
    resolveList = resolve;
  });
  const env = environment((url) =>
    url === "/api/image-models"
      ? { items: [] }
      : url === "/api/pipelines"
        ? deferred
        : { run: run() },
  );
  const value = await mount(env);
  try {
    const s = value.exposed;
    s.useTemplate(PIPELINE_TEMPLATES[1]);
    s.openPicker("generate", "referenceImages", [source], 4);
    env.account.epoch.value++;
    env.account.identity.value = "org.bob";
    resolveList({ pipelines: [saved()], nextCursor: null });
    await flush();
    assert.deepEqual(s.pipelines.value, []);
    assert.deepEqual(s.definition.value.nodes, []);
    assert.equal(s.picker.value, null);
    assert.deepEqual(s.pickerUrls.value, []);
    assert.equal(s.activeRun.value, null);
  } finally {
    value.app.unmount();
  }
});
test("private pickers reject external URLs and deduplicate canonical pictures before updating a node", async () => {
  const value = await mount();
  try {
    const s = value.exposed;
    s.useTemplate(PIPELINE_TEMPLATES[1]);
    s.openPicker("generate", "referenceImages", [], 2);
    s.confirmPicker([
      "https://example.org/a.png",
      source,
      source,
      source.replace("product.png", "second.png"),
    ]);
    assert.deepEqual(
      s.definition.value.nodes.find((node: any) => node.id === "generate")
        .config.referenceImages,
      [source, source.replace("product.png", "second.png")],
    );
  } finally {
    value.app.unmount();
  }
});
test("switching a node image model synchronously resets exact settings while favourites preserve selection", async () => {
  const node = createPipelineNode("generate-image", "generate");
  const value = await render(properties, {
    node,
    definition: { version: 1, nodes: [node], edges: [] },
    models: SUPPORTED_IMAGE_MODEL_IDS.map((id) => ({
      id,
      catalogStatus: "available",
    })),
  });
  value.exposed.changeModel({ target: { value: "openai/gpt-image-2" } });
  const update = value.events.find((event) => event.name === "update")!.value;
  assert.equal(update.config.model, "openai/gpt-image-2");
  assert.deepEqual(
    update.config.settings,
    createDefaultSettings("openai/gpt-image-2"),
  );
  value.env.favourites.toggleFavourite("openai/gpt-image-2");
  assert.equal(value.exposed.ai.value.model, node.config.model);
});
test("non-mask utility tools disable every image profile requiring a mask", async () => {
  const node = createPipelineNode("expand", "expand");
  const value = await render(properties, {
    node,
    definition: { version: 1, nodes: [node], edges: [] },
    models: SUPPORTED_IMAGE_MODEL_IDS.map((id) => ({
      id,
      catalogStatus: "available",
    })),
  });
  for (const item of value.exposed.orderedModels.value)
    if (IMAGE_MODEL_PROFILES[item.id as ImageModelId].requiresMask)
      assert.equal(item.available, false, item.id);
});
test("priced run results hide whole unpriced image boxes, show valid zero, and retain original download paths", async () => {
  const fixture = run(),
    step = fixture.items[0]!.steps[1]!;
  step.status = "succeeded";
  step.value = {
    text: null,
    images: [
      {
        id: "held",
        url: source.replace("product.png", "held.png"),
        name: "Held.png",
        priceUsd: ".01",
        priceSource: "estimate",
        generationId: 42,
      },
      {
        id: "zero",
        url: source.replace("product.png", "zero.png"),
        name: "Zero.png",
        priceUsd: "0",
        priceSource: "gateway",
        generationId: 43,
        width: 1024,
        height: 1536,
        mimeType: "image/png",
      },
    ],
  };
  const value = await render(results, { run: fixture });
  assert.doesNotMatch(value.html, /held\.png|Held\.png|Check price/);
  assert.match(value.html, /zero\.png\?preview=480/);
  assert.match(value.html, /\$0\.00 · confirmed/);
  assert.match(value.html, /href="\/api\/data[^\"]+zero\.png"/);
  assert.match(value.html, /Runs continue after you close\s+the browser/);
  assert.match(value.html, /1024 × 1536 px/);
});
test("retry requires selection and explicit possible-charge acknowledgment before sending step IDs", async () => {
  const fixture = run(),
    step = fixture.items[0]!.steps[1]!;
  step.status = "interrupted";
  step.error = {
    code: "interrupted",
    message: "Response was not saved.",
    retryable: true,
  };
  fixture.status = "interrupted";
  const value = await render(results, { run: fixture });
  value.exposed.openRetry();
  value.exposed.retry();
  assert.equal(
    value.events.some((event) => event.name === "retry"),
    false,
  );
  value.exposed.chargeConfirmed.value = true;
  value.exposed.retry();
  assert.deepEqual(
    value.events.find((event) => event.name === "retry")!.value,
    [step.id],
  );
});
test('rerun action is per completed input, has a new-charge notice, and guards pending prices, failures and attempt limits', async () => {
  const fixture = completedRun();
  const value = await render(results, {run: fixture});
  assert.match(value.html, /aria-label="Rerun job for Input 1"/);
  assert.match(value.html, /AI steps create new charges/);
  assert.match(value.html, /Previous pictures stay in Assets/);
  value.exposed.rerun(fixture.items[0]); value.exposed.rerun(fixture.items[0]);
  assert.deepEqual(value.events.filter(event => event.name === 'rerun').map(event => event.value), [fixture.items[0]!.id]);
  for (const state of ['queued', 'running', 'awaiting-price', 'failed', 'interrupted', 'cancelled']) {
    const blocked = completedRun(); blocked.items[0]!.status = state as PipelineRunDTO['status']; blocked.items[0]!.steps[1]!.status = state as PipelineRunDTO['items'][number]['steps'][number]['status'];
    const rendered = await render(results, {run: blocked});
    assert.doesNotMatch(rendered.html, /aria-label="Rerun job for Input 1"/);
    rendered.exposed.rerun(blocked.items[0]); assert.equal(rendered.events.some(event => event.name === 'rerun'), false);
  }
  const held = completedRun(); held.items[0]!.steps[1]!.value = {text: null, images: [{id: 'held', url: source, name: 'Held', generationId: 1, priceUsd: '0.01', priceSource: 'estimate'}]};
  assert.match(pipelineJobRerunBlockedReason(held, held.items[0]!.id), /exact prices/);
  const capped = completedRun(); capped.items[0]!.steps[1]!.attempt = 5;
  const cappedUi = await render(results, {run: capped}); assert.match(cappedUi.html, /five-attempt limit/);
  cappedUi.exposed.rerun(capped.items[0]); assert.equal(cappedUi.events.some(event => event.name === 'rerun'), false);
  const busyUi = await render(results, {run: fixture, busy: true}); busyUi.exposed.rerun(fixture.items[0]); assert.equal(busyUi.events.some(event => event.name === 'rerun'), false);
});

test('a completed job can rerun while a sibling works unless cancellation is still draining', () => {
  const fixture = completedRun(); fixture.status = 'running';
  fixture.items.push({...fixture.items[0]!, id: 'other-input', index: 1, status: 'running', steps: fixture.items[0]!.steps.map(step => ({...step, status: 'running'}))});
  assert.equal(pipelineJobRerunBlockedReason(fixture, fixture.items[0]!.id), '');
  assert.equal(pipelineRerunUsesCredit(fixture, fixture.items[0]!.id), true);
  fixture.cancelRequested = true;
  assert.match(pipelineJobRerunBlockedReason(fixture, fixture.items[0]!.id), /remaining cancelled work/);
});

test('run setup, result columns, expanded details and retry options follow saved left-to-right canvas positions', async () => {
  const fixture = completedRun();
  fixture.definition.nodes.find(node => node.id === 'output')!.position = {x: 10, y: 100};
  fixture.definition.nodes.find(node => node.id === 'product')!.position = {x: 200, y: 200};
  fixture.definition.nodes.find(node => node.id === 'generate')!.position = {x: 200, y: 100};
  fixture.items[0]!.steps.forEach(step => {step.value = {images: [], text: `Details for ${step.nodeId}`};});
  const rendered = await render(results, {run: fixture});
  assert.deepEqual(rendered.exposed.steps.value.map((node: any) => node.id), ['output', 'generate', 'product']);
  assert.deepEqual(rendered.exposed.orderedItemSteps(fixture.items[0]).map((step: any) => step.nodeId), ['output', 'generate', 'product']);
  const detail = rendered.html.slice(rendered.html.indexOf('pipeline-run-item-details'));
  assert.ok(detail.indexOf('Details for output') < detail.indexOf('Details for generate')); assert.ok(detail.indexOf('Details for generate') < detail.indexOf('Details for product'));
  const retryFixture = structuredClone(fixture); retryFixture.status = 'failed'; retryFixture.items[0]!.status = 'failed';
  retryFixture.items[0]!.steps.forEach(step => {step.status = 'failed'; step.error = {code: 'test', message: 'Test error', retryable: true};});
  const retryUi = await render(results, {run: retryFixture}); retryUi.exposed.openRetry();
  assert.deepEqual(retryUi.exposed.retryIds.value, ['output', 'generate', 'product'].map(id => retryFixture.items[0]!.steps.find(step => step.nodeId === id)!.id));
  const workspaceUi = await mount();
  try {
    workspaceUi.exposed.useTemplate(PIPELINE_TEMPLATES.find(template => template.id === 'product-photo'));
    workspaceUi.exposed.definition.value = structuredClone(fixture.definition); await workspaceUi.exposed.prepareRun();
    assert.deepEqual(workspaceUi.exposed.executionNodes.value.map((node: any) => node.id), ['output', 'generate', 'product']);
    assert.equal(workspaceUi.exposed.batchInput.value, 'product');
  } finally {workspaceUi.app.unmount();}
});
test("download all uses the authenticated run endpoint for confirmed final outputs only", async () => {
  const fixture = run();
  fixture.status = "succeeded";
  const image = {
    id: "result",
    url: source.replace("product.png", "final.png"),
    name: "Final.png",
    priceUsd: "0",
    priceSource: "gateway",
    generationId: 43,
    bytes: 100,
  };
  fixture.items[0]!.steps[2]!.status = "succeeded";
  fixture.items[0]!.steps[2]!.value = {
    images: [
      image,
      image,
      {
        ...image,
        id: "held",
        url: source.replace("product.png", "held.png"),
        priceSource: "estimate",
      },
    ],
    text: null,
  };
  const value = await render(results, { run: fixture });
  assert.match(
    value.html,
    /href="\/api\/pipeline-runs\/22222222-2222-4222-8222-222222222222\/download"/,
  );
  assert.match(value.html, /Download all · 1 picture/);
  assert.doesNotMatch(value.html, /held\.png/);
  assert.doesNotMatch(value.html, /token=|apiKey=|password=/);
});
test("oversized archives keep individual downloads and show the concrete archive limit", async () => {
  const fixture = run();
  fixture.items[0]!.steps[2]!.status = "succeeded";
  fixture.items[0]!.steps[2]!.value = {
    images: Array.from({ length: 201 }, (_, index) => ({
      id: String(index),
      url: source.replace("product.png", `result-${index}.png`),
      name: `Result ${index}`,
      priceUsd: "0",
      priceSource: "local-processing",
      bytes: 100,
    })),
    text: null,
  };
  const value = await render(results, { run: fixture });
  assert.doesNotMatch(value.html, /Download all/);
  assert.match(value.html, /200-picture or 256 MB archive limit/);
  assert.match(value.html, /Download original/);
});
