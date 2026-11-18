import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createPipelineNode,
  getPipelineNodePorts,
  PIPELINE_NODE_LABELS,
  type PipelineNodeType,
  type PipelineRunDTO,
} from "../schemas/pipelines.ts";
import { PIPELINE_TEXT_MODEL_PROFILES } from "../schemas/pipeline-text-models.ts";
import { PIPELINE_PALETTE } from "../app/utils/pipelineTemplates.ts";
import { pipelineJobRerunBlockedReason } from "../app/utils/pipelineCredit.ts";
import {
  PIPELINE_NODE_GROUPS,
  pipelineMessageText,
  pipelineNodeSummary,
  pipelineNodeTypeKey,
  pipelinePortLabel,
  pipelineRerunReasonText,
  pipelineStatusLabel,
} from "../app/utils/pipelineEditor.ts";
import { hasMessage, translate } from "./i18n-test-helpers.ts";

const en = (key: string, params?: Record<string, unknown>) => translate(key, params, "en");
const hu = (key: string, params?: Record<string, unknown>) => translate(key, params, "hu");
const types = Object.keys(PIPELINE_NODE_LABELS) as PipelineNodeType[];
const components = ["PipelineCanvas", "PipelineNodeProperties", "PipelineRunResults"].map((name) => ({
  name,
  source: readFileSync(new URL(`../app/components/${name}.vue`, import.meta.url), "utf8"),
}));

test("every static pipelineEditor key used by the editor components exists in English and Hungarian", () => {
  for (const { name, source } of components) {
    const keys = [...source.matchAll(/\bt\(\s*["'`]((?:pipelineEditor|common)\.[A-Za-z0-9_.]+)["'`]/g)].map((match) => match[1]!);
    assert.ok(keys.length > 10, `${name} must translate its copy`);
    for (const key of keys) {
      assert.ok(hasMessage(key, "en"), `${name}: missing en ${key}`);
      assert.ok(hasMessage(key, "hu"), `${name}: missing hu ${key}`);
    }
  }
});

test("dynamic option, status, type, group and port keys resolve for every schema value", () => {
  for (const type of types) {
    assert.ok(hasMessage(`${pipelineNodeTypeKey(type)}.name`, "hu"), type);
    assert.ok(hasMessage(`${pipelineNodeTypeKey(type)}.description`, "hu"), type);
    assert.ok(hasMessage(`pipelineEditor.paletteGroups.${PIPELINE_NODE_GROUPS[type]}`, "hu"), type);
    // English display names stay identical to the persisted default labels.
    assert.equal(en(`${pipelineNodeTypeKey(type)}.name`), PIPELINE_NODE_LABELS[type]);
  }
  for (const item of PIPELINE_PALETTE) {
    assert.equal(en(`${pipelineNodeTypeKey(item.type)}.description`), item.description, item.type);
    assert.equal(en(`pipelineEditor.paletteGroups.${PIPELINE_NODE_GROUPS[item.type]}`), item.group, item.type);
  }
  const groups = ["positions", "fits", "sides", "colors", "reasoning", "separators"] as const;
  const values: Record<(typeof groups)[number], string[]> = {
    positions: ["centre", "north", "south", "east", "west"],
    fits: ["contain", "cover", "inside", "outside", "fill"],
    sides: ["top", "bottom", "left", "right"],
    colors: ["amber", "rose", "sage", "blue"],
    reasoning: [...new Set(Object.values(PIPELINE_TEXT_MODEL_PROFILES).flatMap((profile) => [...profile.reasoningLevels]))],
    separators: ["newLine", "blankLine", "space", "comma", "none"],
  };
  for (const group of groups)
    for (const value of values[group])
      assert.ok(hasMessage(`pipelineEditor.properties.${group}.${value}`, "hu"), `${group}.${value}`);
  const t = (key: string, params?: Record<string, unknown>) => hu(key, params);
  for (const status of ["queued", "running", "awaiting-price", "succeeded", "partial", "failed", "cancelled", "interrupted", "skipped"])
    assert.notEqual(pipelineStatusLabel(t, status), status);
  assert.equal(pipelineStatusLabel(t, undefined), "Nem része ennek a futtatásnak");
  for (const type of types)
    for (const port of [...getPipelineNodePorts(createPipelineNode(type, "node")).inputs, ...getPipelineNodePorts(createPipelineNode(type, "node")).outputs]) {
      assert.equal(pipelinePortLabel(en, port), port.label, `${type}.${port.id}`);
      assert.notEqual(pipelinePortLabel(t, port), "", `${type}.${port.id}`);
    }
  assert.equal(pipelinePortLabel(t, { label: "References" }), "Referenciák");
});

test("canvas summaries keep user text verbatim and localize fallbacks", () => {
  const prompted = createPipelineNode("generate-image", "generate");
  prompted.config.prompt = "A product on marble";
  assert.equal(pipelineMessageText(hu, pipelineNodeSummary(prompted)), "A product on marble");
  const empty = createPipelineNode("generate-image", "generate");
  assert.equal(pipelineMessageText(en, pipelineNodeSummary(empty)), "Connect a prompt or write one in settings.");
  assert.equal(pipelineMessageText(hu, pipelineNodeSummary(empty)), "Köss be egy promptot, vagy írj egyet a beállításokban.");
  const people = createPipelineNode("people-input", "person");
  people.config.images = ["/images/a.png", "/images/b.png"];
  assert.equal(pipelineMessageText(en, pipelineNodeSummary(people)), "2 person references · reused across the batch");
  people.config.images = ["/images/a.png"];
  assert.equal(pipelineMessageText(en, pipelineNodeSummary(people)), "1 person reference · reused across the batch");
  const translateNode = createPipelineNode("translate", "translate");
  // The target language is stored data sent to the model; it is never translated.
  assert.equal(pipelineMessageText(hu, pipelineNodeSummary(translateNode)), `Fordítás erre: ${translateNode.config.language}`);
  const output = createPipelineNode("output", "output");
  output.config.format = "webp";
  assert.equal(pipelineMessageText(en, pipelineNodeSummary(output)), "WEBP export");
  for (const type of types) assert.doesNotMatch(pipelineMessageText(hu, pipelineNodeSummary(createPipelineNode(type, "node"))), /^pipelineEditor\./, type);
});

test("rerun refusal reasons from the shared credit helper all have translations", () => {
  const step = (status: string, extra: Record<string, unknown> = {}) => ({ id: "s", nodeId: "n", type: "crop", status, attempt: 1, value: null, ...extra });
  const run = (item: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ cancelRequested: false, items: [{ id: "i", status: "succeeded", steps: [step("succeeded")], ...item }], ...extra }) as unknown as PipelineRunDTO;
  const cases = [
    run({ status: "failed" }),
    run({}, { cancelRequested: true, items: [{ id: "i", status: "succeeded", steps: [step("succeeded")] }, { id: "j", status: "running", steps: [] }] }),
    run({ steps: [step("succeeded", { value: { images: [{ generationId: "g", url: "/images/a.png" }] } })] }),
    run({ steps: [step("succeeded", { attempt: 5 })] }),
  ];
  for (const value of cases) {
    const reason = pipelineJobRerunBlockedReason(value, "i");
    assert.ok(reason);
    assert.equal(pipelineRerunReasonText(en, reason), reason);
    assert.notEqual(pipelineRerunReasonText(hu, reason), reason);
  }
  assert.equal(pipelineRerunReasonText(hu, ""), "");
});

test("the Pipelines model selector keeps visible New and Transparent tags in both languages", () => {
  const source = components.find((value) => value.name === "PipelineNodeProperties")!.source;
  assert.match(source, /isNewImageModel\(item\.id\) \? ` · \$\{t\("pipelineEditor\.tags\.new"\)\}`/);
  assert.match(source, /supportsTransparentBackground \? ` · \$\{t\("pipelineEditor\.tags\.transparent"\)\}`/);
  assert.equal(en("pipelineEditor.tags.new"), "New");
  assert.equal(en("pipelineEditor.tags.transparent"), "Transparent");
  assert.equal(hu("pipelineEditor.tags.new"), "Új");
  assert.equal(hu("pipelineEditor.tags.transparent"), "Átlátszó");
});
