import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import { createRenderer, createSSRApp, h, nextTick, ref } from "vue";
import {
  createPipelineNode,
  PIPELINE_NODE_LABELS,
  PipelineDefinitionSchema,
  type PipelineDefinition,
  type PipelineNode,
} from "../schemas/pipelines.ts";
import {
  PIPELINE_PALETTE,
  PIPELINE_TEMPLATES,
  pipelineNodeDescription,
  pipelineNodeIcon,
} from "../app/utils/pipelineTemplates.ts";

const root = new URL("../", import.meta.url);
const properties = new URL("app/components/PipelineNodeProperties.vue", root).href;
const favourites = new URL("app/composables/useImageModelFavourites.ts", root).href;
registerHooks({
  load(url, context, next) {
    if (url === favourites) return {
      format: "module", shortCircuit: true,
      source: `import {computed,ref} from 'vue';export const useImageModelFavourites=()=>({favouriteModelIds:ref([]),favouriteSet:computed(()=>new Set()),ready:ref(true),toggleFavourite(){}});`,
    };
    if (url.startsWith(new URL("app/components/generation-settings/", root).href) && url.endsWith(".vue"))
      return {format: "module", shortCircuit: true, source: "export default {setup:()=>()=>null};"};
    if (url === properties) {
      const filename = fileURLToPath(url);
      const {descriptor} = parse(readFileSync(filename, "utf8"), {filename});
      const compiled = compileScript(descriptor, {id: filename, inlineTemplate: true});
      return {format: "module", shortCircuit: true, source: stripTypeScriptTypes(`import {computed,ref,watch} from 'vue';${compiled.content}`)};
    }
    return next(url, context);
  },
});

const photo = "/images/organizations/org/users/member/objects/person/alex.png";
const secondPhoto = "/images/organizations/org/users/member/objects/person/alex-side.png";
function person(images: string[] = []) {
  const value = createPipelineNode("people-input", "person", {x: 0, y: 0});
  value.config.images = images;
  return value;
}
function definition(node: PipelineNode): PipelineDefinition {
  return {version: 1, nodes: [node], edges: []};
}
function registerComponents(app: any) {
  app.component("UIcon", {props: ["name"], setup: (props: any) => () => h("span", {"data-icon": props.name})});
  app.component("NuxtErrorBoundary", {setup: (_props: unknown, {slots}: any) => () => slots.default?.()});
  app.component("ModelGuidance", {props: ["modelId", "settings", "context"], setup: (props: any) => () => h("aside", {"data-model-guidance": props.modelId})});
}
type MemoryNode = {tag: string; text: string; children: MemoryNode[]; parent: MemoryNode | null; props: Record<string, any>};
function memoryNode(tag: string, text = ""): MemoryNode { return {tag, text, children: [], parent: null, props: {}}; }
const renderer = createRenderer<MemoryNode, MemoryNode>({
  createElement: tag => memoryNode(tag), createText: text => memoryNode("#text", text), createComment: text => memoryNode("#comment", text),
  insert(value, parent, anchor) {
    if (value.parent) value.parent.children.splice(value.parent.children.indexOf(value), 1);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(value); else parent.children.splice(index, 0, value);
    value.parent = parent;
  },
  remove(value) {if (value.parent) value.parent.children.splice(value.parent.children.indexOf(value), 1); value.parent = null;},
  setText(value, text) {value.text = text;}, setElementText(value, text) {value.text = text; value.children = [];},
  parentNode: value => value.parent, nextSibling: value => value.parent?.children[value.parent.children.indexOf(value) + 1] ?? null,
  patchProp(value, name, _before, after) {value.props[name] = after;},
});
function renderedText(value: MemoryNode): string {return value.text + value.children.map(renderedText).join("");}
function elements(value: MemoryNode): MemoryNode[] {return [value, ...value.children.flatMap(elements)];}
function button(value: MemoryNode, label: string): MemoryNode {
  const result = elements(value).find(child => child.tag === "button" && (renderedText(child).trim() === label || child.props["aria-label"] === label));
  assert.ok(result, `Expected a rendered button: ${label}`); return result;
}
async function mount(node: PipelineNode, disabled = false, graph = definition(node)) {
  const {default: component} = await import(properties);
  const selected = ref(node), events: Array<{name: string; values: unknown[]}> = [];
  const app = renderer.createApp({render: () => h(component, {
    node: selected.value, definition: graph, models: [], disabled,
    onPicker: (...values: unknown[]) => events.push({name: "picker", values}),
    onConnect: (...values: unknown[]) => events.push({name: "connect", values}),
    onUpdate: (value: PipelineNode) => {events.push({name: "update", values: [value]}); selected.value = value;},
  })});
  registerComponents(app);
  const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message);
  const tree = memoryNode("root"); app.mount(tree); await nextTick();
  assert.deepEqual(warnings, []);
  return {app, tree, events, selected};
}

test("People Input has its own input palette entry, count summary and on-model template", () => {
  const entries = PIPELINE_PALETTE.filter(value => value.type === "people-input");
  assert.equal(entries.length, 1); assert.equal(entries[0]!.group, "Inputs");
  assert.equal(PIPELINE_NODE_LABELS["people-input"], "People Input");
  assert.equal(pipelineNodeIcon("people-input"), "i-lucide-contact-round");
  assert.match(entries[0]!.description, /People.*shared profiles/);
  assert.match(pipelineNodeDescription(person()), /Choose person pictures/);
  assert.match(pipelineNodeDescription(person([photo])), /1 person reference · reused across the batch/);
  assert.match(pipelineNodeDescription(person([photo, secondPhoto])), /2 person references · reused across the batch/);
  const template = PIPELINE_TEMPLATES.find(value => value.id === "on-model")!.definition();
  assert.equal(PipelineDefinitionSchema.safeParse(template).success, true);
  assert.equal(template.nodes.find(value => value.id === "person")?.type, "people-input");
  assert.ok(template.edges.some(value => value.source === "person" && value.target === "generate" && value.targetPort === "references"));
});

test("the actual People Input inspector explains fixed references and renders private bounded photo previews", async () => {
  const {default: component} = await import(properties);
  const node = person([photo, secondPhoto]);
  const app = createSSRApp({render: () => h(component, {node, definition: definition(node), models: []})});
  registerComponents(app);
  const warnings: string[] = []; app.config.warnHandler = message => warnings.push(message);
  const html = await renderToString(app);
  assert.deepEqual(warnings, []);
  assert.match(html, /Choose person pictures/); assert.match(html, /profiles shared with you/);
  assert.match(html, /same for every product in a batch/); assert.match(html, /Generate Image → References/);
  assert.match(html, /2 \/ 16 person pictures selected/); assert.match(html, /Clear selection/);
  for (const url of [photo, secondPhoto]) assert.ok(html.includes(`/api/data${url}?preview=160`));
  assert.equal((html.match(/alt="Person reference"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Choose default picture|>Choose pictures\s*<\/button>|Upload|Add a connection/);
});

test("People Input picker retains its selection and emits the 16-photo limit; removing and clearing update the actual node", async t => {
  const value = await mount(person([photo, secondPhoto])); t.after(() => value.app.unmount());
  button(value.tree, "Choose person pictures").props.onClick();
  assert.deepEqual(value.events, [{name: "picker", values: ["images", [photo, secondPhoto], 16]}]);
  const remove = elements(value.tree).find(child => child.props["aria-label"] === "Remove person reference")!;
  remove.props.onClick(); await nextTick();
  assert.equal(value.selected.value.type, "people-input");
  assert.deepEqual(value.selected.value.config, {images: [secondPhoto]});
  assert.match(renderedText(value.tree), /1 \/ 16 person pictures selected/);
  button(value.tree, "Clear selection").props.onClick(); await nextTick();
  assert.deepEqual(value.selected.value.config, {images: []});
  assert.match(renderedText(value.tree), /0 \/ 16 person pictures selected/);
  assert.equal(elements(value.tree).some(child => child.tag === "img"), false);
  assert.equal(elements(value.tree).some(child => child.tag === "button" && renderedText(child).trim() === "Clear selection"), false);
});

test("disabled People Input controls cannot emit picker or configuration changes", async t => {
  const value = await mount(person([photo]), true); t.after(() => value.app.unmount());
  for (const label of ["Choose person pictures", "Remove person reference", "Clear selection"]) {
    const control = button(value.tree, label); assert.equal(control.props.disabled, true);
    control.props.onClick();
  }
  assert.deepEqual(value.events, []); assert.deepEqual(value.selected.value.config, {images: [photo]});
});

test("an already connected People source remains selectable and emits the exact connection to toggle", async t => {
  const source = person([photo]), target = createPipelineNode("generate-image", "generate", {x: 400, y: 0});
  const graph: PipelineDefinition = {version: 1, nodes: [source, target], edges: [{id: "person_reference", source: source.id, sourcePort: "image", target: target.id, targetPort: "references"}]};
  const value = await mount(target, false, graph); t.after(() => value.app.unmount());
  const select = elements(value.tree).find(child => child.props.id === "pipeline-connect-references")!;
  assert.ok(elements(select).some(child => child.tag === "option" && child.props.value === "person:image"));
  const event = {target: {value: "person:image"}};
  select.props.onChange(event);
  assert.deepEqual(value.events, [{name: "connect", values: ["person", "image", "references"]}]);
  assert.equal(event.target.value, "");
});
