import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createPipelineNode,
  PIPELINE_NODE_LABELS,
  PipelineDefinitionSchema,
  type PipelineNodeType,
} from "../schemas/pipelines.ts";
import {
  PIPELINE_PALETTE,
  PIPELINE_TEMPLATE_ENGLISH,
  PIPELINE_TEMPLATES,
  pipelineNodeDescription,
  pipelineNodeLabel,
  pipelineTemplateText,
} from "../app/utils/pipelineTemplates.ts";
import { hasMessage, translate, useI18n } from "./i18n-test-helpers.ts";

const en = useI18n("en").t,
  hu = useI18n("hu").t;

test("the template utility's English fallback copy matches en/pipelines.json and exists in Hungarian", () => {
  for (const [key, english] of Object.entries(PIPELINE_TEMPLATE_ENGLISH)) {
    assert.ok(hasMessage(key, "en"), `${key} missing from en`);
    assert.ok(hasMessage(key, "hu"), `${key} missing from hu`);
    // Interpolate each placeholder with itself to compare the raw messages.
    const params = Object.fromEntries([...english.matchAll(/\{(\w+)\}/g)].map((match) => [match[1]!, `{${match[1]}}`]));
    assert.equal(translate(key, params, "en"), english, key);
  }
  for (const entry of PIPELINE_PALETTE) {
    assert.ok(PIPELINE_TEMPLATE_ENGLISH[entry.groupKey], entry.groupKey);
    assert.ok(PIPELINE_TEMPLATE_ENGLISH[entry.descriptionKey], entry.descriptionKey);
    assert.equal(entry.description, PIPELINE_TEMPLATE_ENGLISH[entry.descriptionKey]);
  }
  for (const template of PIPELINE_TEMPLATES) {
    assert.ok(PIPELINE_TEMPLATE_ENGLISH[template.nameKey], template.nameKey);
    assert.ok(PIPELINE_TEMPLATE_ENGLISH[template.descriptionKey], template.descriptionKey);
  }
  // English default node labels stay identical to the schema's labels.
  for (const type of Object.keys(PIPELINE_NODE_LABELS) as PipelineNodeType[])
    assert.equal(pipelineNodeLabel(type), PIPELINE_NODE_LABELS[type], type);
});

test("templates localize their picker text and editable node labels but keep model prompts in English", () => {
  for (const template of PIPELINE_TEMPLATES) {
    const english = template.definition(),
      englishT = template.definition(en),
      hungarian = template.definition(hu);
    assert.deepEqual(englishT, english, `${template.id} English instantiation`);
    assert.equal(PipelineDefinitionSchema.safeParse(hungarian).success, true, template.id);
    assert.deepEqual(
      hungarian.nodes.map((node) => [node.id, node.type, node.config]),
      english.nodes.map((node) => [node.id, node.type, node.config]),
      `${template.id} prompts and settings are language independent`,
    );
    assert.deepEqual(hungarian.edges, english.edges);
    assert.notEqual(pipelineTemplateText(template, hu).name, pipelineTemplateText(template).name);
  }
  const onModel = PIPELINE_TEMPLATES.find((value) => value.id === "on-model")!;
  assert.deepEqual(pipelineTemplateText(onModel), {
    name: "On-model collection",
    description: "Combine your product pictures with a reusable person reference.",
  });
  assert.equal(pipelineTemplateText(onModel, hu).name, "Modellen viselt kollekció");
  const labels = Object.fromEntries(onModel.definition(hu).nodes.map((node) => [node.id, node.label]));
  assert.deepEqual(labels, {
    product: "Termékkép",
    person: "Személyreferencia",
    generate: "Képgenerálás",
    output: "Munkafolyamat kimenete",
  });
  const generate = onModel.definition(hu).nodes.find((node) => node.type === "generate-image")!;
  assert.match(generate.config.prompt, /^Photograph the adult person/);
});

test("node summaries translate with t and keep English without one", () => {
  const people = createPipelineNode("people-input", "person", { x: 0, y: 0 });
  people.config.images = ["/images/a.png", "/images/b.png"];
  assert.equal(pipelineNodeDescription(people), "2 person references · reused across the batch");
  assert.equal(pipelineNodeDescription(people, en), "2 person references · reused across the batch");
  assert.equal(pipelineNodeDescription(people, hu), "2 személyreferencia · az egész kötegben újrahasználva");
  const upscale = createPipelineNode("upscale", "upscale", { x: 0, y: 0 });
  assert.match(pipelineNodeDescription(upscale, hu), /^\d× · /);
  const concat = createPipelineNode("prompt-concatenator", "join", { x: 0, y: 0 });
  assert.equal(pipelineNodeDescription(concat), "Join several text branches in connection order.");
  assert.equal(pipelineNodeDescription(concat, hu), "Több szöveges ág összefűzése a kapcsolatok sorrendjében.");
  assert.equal(pipelineNodeLabel("generate-image", hu), "Képgenerálás");
  assert.equal(pipelineNodeLabel("generate-image", (key) => key), "Generate Image");
});

test("the Pipelines workspace renders template, library and run copy through the pipelines namespace", () => {
  const source = readFileSync(new URL("../app/components/PipelinesWorkspace.vue", import.meta.url), "utf8");
  const keys = [...source.matchAll(/\bt\(\s*["']((?:pipelines|common)\.[\w.]+)["']/g)].map((match) => match[1]!);
  const sayKeys = [...source.matchAll(/key:\s*["'](pipelines\.[\w.]+)["']/g), ...source.matchAll(/message\(error,\s*["'](pipelines\.[\w.]+)["']\)/g)].map((match) => match[1]!);
  assert.ok(keys.length > 80, "workspace copy is translated");
  for (const key of [...keys, ...sayKeys]) {
    assert.ok(hasMessage(key, "en"), `${key} missing from en`);
    assert.ok(hasMessage(key, "hu"), `${key} missing from hu`);
  }
  assert.match(source, /t\(template\.nameKey\)/);
  assert.match(source, /template\.definition\(translate\)/);
  assert.match(source, /watch\(locale,/);
  // Previously hard-coded English copy now lives only in the message files.
  for (const english of ["Build once. Create again.", "Untitled pipeline", "Finish the workflow first", "Connect image to image", "Leave unsaved changes?"])
    assert.equal(source.includes(english), false, english);
  assert.equal(translate("pipelines.untitled"), "Untitled pipeline");
  assert.equal(translate("pipelines.untitled", {}, "hu"), "Névtelen munkafolyamat");
  const page = readFileSync(new URL("../app/pages/pipelines.vue", import.meta.url), "utf8");
  assert.match(page, /t\("pipelines\.pageTitle"\)/);
});
