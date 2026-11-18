import {
  createPipelineNode,
  PIPELINE_NODE_LABELS,
  type PipelineDefinition,
  type PipelineNode,
  type PipelineNodeType,
} from "../../schemas/pipelines";

/**
 * A vue-i18n style translator. Utilities stay pure: callers pass `t` from
 * `useI18n()`. Without one, the English copy below is used; it mirrors
 * `i18n/locales/en/pipelines.json` and a regression test keeps them in sync.
 */
export type PipelineTranslate = (
  key: string,
  params?: Record<string, unknown>,
) => string;

export const PIPELINE_TEMPLATE_ENGLISH: Record<string, string> = {
  "pipelines.palette.groups.inputs": "Inputs",
  "pipelines.palette.groups.aiTools": "AI tools",
  "pipelines.palette.groups.imageTools": "Image tools",
  "pipelines.palette.groups.textTools": "Text tools",
  "pipelines.palette.groups.finish": "Finish & notes",
  "pipelines.palette.descriptions.imageInput":
    "A picture supplied each time the pipeline runs.",
  "pipelines.palette.descriptions.peopleInput":
    "Reusable person pictures from your People or shared profiles.",
  "pipelines.palette.descriptions.textInput":
    "A prompt or value supplied for each run.",
  "pipelines.palette.descriptions.staticImage":
    "Reusable pictures from your Library or People.",
  "pipelines.palette.descriptions.staticText":
    "Keep a prompt or instruction in the pipeline.",
  "pipelines.palette.descriptions.generateImage":
    "Generate or edit pictures with the current image models.",
  "pipelines.palette.descriptions.describeImage":
    "Describe a picture and pass its text to another step.",
  "pipelines.palette.descriptions.promptEnhancer":
    "Turn a short idea into a detailed prompt.",
  "pipelines.palette.descriptions.llm":
    "Transform text with a custom instruction.",
  "pipelines.palette.descriptions.removeBackground":
    "Make a transparent cutout with BiRefNet on the CPU.",
  "pipelines.palette.descriptions.upscale":
    "Enlarge pictures by 2× or 4×, with optional AI detail.",
  "pipelines.palette.descriptions.expand":
    "Generate a larger scene around your picture.",
  "pipelines.palette.descriptions.crop":
    "Crop to exact dimensions and choose the focus position.",
  "pipelines.palette.descriptions.resize":
    "Fit pictures into exact dimensions.",
  "pipelines.palette.descriptions.translate":
    "Translate the text in a picture while preserving its design.",
  "pipelines.palette.descriptions.promptConcatenator":
    "Join several text branches in connection order.",
  "pipelines.palette.descriptions.output":
    "Collect the pipeline results and choose their image format.",
  "pipelines.palette.descriptions.stickyNote":
    "Leave a note on the canvas for your future self.",
  "pipelines.nodeLabels.imageInput": "Image Input",
  "pipelines.nodeLabels.peopleInput": "People Input",
  "pipelines.nodeLabels.textInput": "Text Input",
  "pipelines.nodeLabels.staticImage": "Static Image",
  "pipelines.nodeLabels.staticText": "Static Text",
  "pipelines.nodeLabels.generateImage": "Generate Image",
  "pipelines.nodeLabels.removeBackground": "Remove Background",
  "pipelines.nodeLabels.crop": "Crop",
  "pipelines.nodeLabels.resize": "Resize",
  "pipelines.nodeLabels.upscale": "Upscale",
  "pipelines.nodeLabels.expand": "Expand",
  "pipelines.nodeLabels.translate": "Translate",
  "pipelines.nodeLabels.describeImage": "Describe Image",
  "pipelines.nodeLabels.promptEnhancer": "Prompt Enhancer",
  "pipelines.nodeLabels.llm": "LLM",
  "pipelines.nodeLabels.promptConcatenator": "Prompt Concatenator",
  "pipelines.nodeLabels.output": "Pipeline Output",
  "pipelines.nodeLabels.stickyNote": "Sticky Note",
  "pipelines.nodeSummary.generateEmpty":
    "Connect a prompt or write one in settings.",
  "pipelines.nodeSummary.staticTextEmpty": "Write reusable text.",
  "pipelines.nodeSummary.textInputEmpty": "Text supplied when you run.",
  "pipelines.nodeSummary.staticImageOne": "{count} reference picture",
  "pipelines.nodeSummary.staticImageOther": "{count} reference pictures",
  "pipelines.nodeSummary.peopleOne":
    "{count} person reference · reused across the batch",
  "pipelines.nodeSummary.peopleOther":
    "{count} person references · reused across the batch",
  "pipelines.nodeSummary.peopleEmpty": "Choose person pictures from People.",
  "pipelines.nodeSummary.imageInput":
    "One independent job for each batch picture.",
  "pipelines.nodeSummary.removeBackgroundLite": "BiRefNet Lite · local CPU",
  "pipelines.nodeSummary.removeBackgroundFull": "BiRefNet Full · local CPU",
  "pipelines.nodeSummary.dimensions": "{width} × {height} px",
  "pipelines.nodeSummary.upscaleAi": "{scale}× · AI detail",
  "pipelines.nodeSummary.upscaleStandard": "{scale}× · standard resize",
  "pipelines.nodeSummary.translateTo": "Translate to {language}",
  "pipelines.nodeSummary.outputOriginal": "Collect original results",
  "pipelines.nodeSummary.outputFormat": "{format} export",
  "pipelines.nodeSummary.stickyNoteEmpty": "Write a note.",
  "pipelines.templates.blank.name": "Start from scratch",
  "pipelines.templates.blank.description":
    "Connect inputs, tools and outputs into your own workflow.",
  "pipelines.templates.productPhoto.name": "Product photography",
  "pipelines.templates.productPhoto.description":
    "Place each product in the same polished scene, one picture at a time.",
  "pipelines.templates.onModel.name": "On-model collection",
  "pipelines.templates.onModel.description":
    "Combine your product pictures with a reusable person reference.",
  "pipelines.templates.cleanCatalog.name": "Clean catalog",
  "pipelines.templates.cleanCatalog.description":
    "Remove backgrounds and prepare consistently sized transparent product pictures.",
  "pipelines.templates.describeToPrompt.name": "Picture to campaign",
  "pipelines.templates.describeToPrompt.description":
    "Describe each product, enhance the prompt, then generate a campaign picture.",
  "pipelines.templates.labels.productPicture": "Product picture",
  "pipelines.templates.labels.personReference": "Person reference",
};

function english(key: string, params: Record<string, unknown> = {}) {
  const message = PIPELINE_TEMPLATE_ENGLISH[key];
  if (message === undefined) return key;
  return message.replace(/\{\s*([A-Za-z_]\w*)\s*\}/g, (_match, name: string) =>
    String(params[name] ?? ""),
  );
}
function text(
  t: PipelineTranslate | undefined,
  key: string,
  params?: Record<string, unknown>,
) {
  return t ? t(key, params) : english(key, params);
}
function camel(type: PipelineNodeType) {
  return type.replace(/-([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

export type PipelinePaletteEntry = {
  type: PipelineNodeType;
  /** English group name; also the stable identity used for grouping. */
  group: string;
  groupKey: string;
  icon: string;
  /** English description; display `t(descriptionKey)`. */
  description: string;
  descriptionKey: string;
};
type PaletteGroup = "inputs" | "aiTools" | "imageTools" | "textTools" | "finish";
function entry(
  type: PipelineNodeType,
  group: PaletteGroup,
  icon: string,
): PipelinePaletteEntry {
  const groupKey = `pipelines.palette.groups.${group}`,
    descriptionKey = `pipelines.palette.descriptions.${camel(type)}`;
  return {
    type,
    group: english(groupKey),
    groupKey,
    icon,
    description: english(descriptionKey),
    descriptionKey,
  };
}
export const PIPELINE_PALETTE: PipelinePaletteEntry[] = [
  entry("image-input", "inputs", "i-lucide-image-plus"),
  entry("people-input", "inputs", "i-lucide-contact-round"),
  entry("text-input", "inputs", "i-lucide-text-cursor-input"),
  entry("static-image", "inputs", "i-lucide-images"),
  entry("static-text", "inputs", "i-lucide-text"),
  entry("generate-image", "aiTools", "i-lucide-sparkles"),
  entry("describe-image", "aiTools", "i-lucide-scan-eye"),
  entry("prompt-enhancer", "aiTools", "i-lucide-wand-sparkles"),
  entry("llm", "aiTools", "i-lucide-brain"),
  entry("remove-background", "imageTools", "i-lucide-scissors"),
  entry("upscale", "imageTools", "i-lucide-maximize-2"),
  entry("expand", "imageTools", "i-lucide-scan"),
  entry("crop", "imageTools", "i-lucide-crop"),
  entry("resize", "imageTools", "i-lucide-scaling"),
  entry("translate", "imageTools", "i-lucide-languages"),
  entry("prompt-concatenator", "textTools", "i-lucide-list-plus"),
  entry("output", "finish", "i-lucide-folder-output"),
  entry("sticky-note", "finish", "i-lucide-sticky-note"),
];
export function pipelineNodeIcon(type: PipelineNodeType) {
  return (
    PIPELINE_PALETTE.find((value) => value.type === type)?.icon ??
    "i-lucide-workflow"
  );
}
/**
 * The default label for a new node. Labels are user-editable graph data, so
 * they are localized once, when the node is created, and then kept as typed.
 */
export function pipelineNodeLabel(
  type: PipelineNodeType,
  t?: PipelineTranslate,
): string {
  const key = `pipelines.nodeLabels.${camel(type)}`;
  const value = text(t, key).trim().slice(0, 100);
  return value && value !== key ? value : PIPELINE_NODE_LABELS[type];
}
export function pipelineNodeDescription(
  node: PipelineNode,
  t?: PipelineTranslate,
): string {
  const say = (key: string, params?: Record<string, unknown>) =>
    text(t, `pipelines.nodeSummary.${key}`, params);
  if (node.type === "generate-image")
    return node.config.prompt || say("generateEmpty");
  if (node.type === "static-text")
    return node.config.text || say("staticTextEmpty");
  if (node.type === "text-input")
    return node.config.defaultValue || say("textInputEmpty");
  if (node.type === "static-image") {
    const count = node.config.images.length;
    return say(count === 1 ? "staticImageOne" : "staticImageOther", { count });
  }
  if (node.type === "people-input") {
    const count = node.config.images.length;
    return count
      ? say(count === 1 ? "peopleOne" : "peopleOther", { count })
      : say("peopleEmpty");
  }
  if (node.type === "image-input") return say("imageInput");
  if (node.type === "remove-background")
    return node.config.model === "birefnet-lite"
      ? say("removeBackgroundLite")
      : say("removeBackgroundFull");
  if (node.type === "crop" || node.type === "resize")
    return say("dimensions", {
      width: node.config.width,
      height: node.config.height,
    });
  if (node.type === "upscale")
    return say(node.config.mode === "ai" ? "upscaleAi" : "upscaleStandard", {
      scale: node.config.scale,
    });
  if (node.type === "translate")
    return say("translateTo", { language: node.config.language });
  if (node.type === "output")
    return node.config.format === "original"
      ? say("outputOriginal")
      : say("outputFormat", { format: node.config.format.toUpperCase() });
  if (node.type === "sticky-note")
    return node.config.text || say("stickyNoteEmpty");
  const palette = PIPELINE_PALETTE.find((value) => value.type === node.type);
  return palette
    ? text(t, palette.descriptionKey)
    : pipelineNodeLabel(node.type, t);
}
export type PipelineTemplate = {
  id: string;
  /** Message keys; display with `t(nameKey)` and `t(descriptionKey)`. */
  nameKey: string;
  descriptionKey: string;
  icon: string;
  /**
   * Builds a fresh graph. With `t`, node labels (editable data) are localized
   * at instantiation. Prompts sent to models deliberately stay in English.
   */
  definition: (t?: PipelineTranslate) => PipelineDefinition;
};
/** A template's display name and description in the active language. */
export function pipelineTemplateText(
  template: PipelineTemplate,
  t?: PipelineTranslate,
) {
  return {
    name: text(t, template.nameKey),
    description: text(t, template.descriptionKey),
  };
}
function edge(
  source: string,
  target: string,
  targetPort: string,
  sourcePort: "image" | "text" = "image",
) {
  return {
    id: `${source}_${target}_${targetPort}`,
    source,
    sourcePort,
    target,
    targetPort,
  };
}
function node<T extends PipelineNodeType>(
  type: T,
  id: string,
  position: { x: number; y: number },
  t?: PipelineTranslate,
) {
  const value = createPipelineNode(type, id, position);
  value.label = pipelineNodeLabel(type, t);
  return value;
}
function base(t?: PipelineTranslate) {
  const input = node("image-input", "product", { x: 80, y: 140 }, t);
  input.label = text(t, "pipelines.templates.labels.productPicture");
  const generation = node("generate-image", "generate", { x: 450, y: 140 }, t);
  const output = node("output", "output", { x: 820, y: 140 }, t);
  return { input, generation, output };
}
function template(
  id: string,
  key: string,
  icon: string,
  definition: PipelineTemplate["definition"],
): PipelineTemplate {
  return {
    id,
    nameKey: `pipelines.templates.${key}.name`,
    descriptionKey: `pipelines.templates.${key}.description`,
    icon,
    definition,
  };
}
export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  template("blank", "blank", "i-lucide-plus", (t) => ({
    version: 1,
    nodes: [
      node("image-input", "product", { x: 80, y: 140 }, t),
      node("output", "output", { x: 450, y: 140 }, t),
    ],
    edges: [edge("product", "output", "media")],
  })),
  template("product-photo", "productPhoto", "i-lucide-camera", (t) => {
    const { input, generation, output } = base(t);
    generation.config.prompt =
      "Create a polished product photograph of the exact product shown in the input picture. Preserve its shape, details and colors. Use a warm neutral studio backdrop with natural light and a subtle contact shadow.";
    return {
      version: 1,
      nodes: [input, generation, output],
      edges: [
        edge("product", "generate", "image"),
        edge("generate", "output", "media"),
      ],
    };
  }),
  template("on-model", "onModel", "i-lucide-contact-round", (t) => {
    const { input, generation, output } = base(t);
    const person = node("people-input", "person", { x: 80, y: 420 }, t);
    person.label = text(t, "pipelines.templates.labels.personReference");
    generation.config.prompt =
      "Photograph the adult person in the reference wearing the exact clothing item in the product picture. Preserve the person’s facial identity and the clothing’s color, pattern, cut and details. A natural fashion studio photograph, full body, neutral background.";
    return {
      version: 1,
      nodes: [input, person, generation, output],
      edges: [
        edge("product", "generate", "image"),
        edge("person", "generate", "references"),
        edge("generate", "output", "media"),
      ],
    };
  }),
  template("clean-catalog", "cleanCatalog", "i-lucide-scissors", (t) => {
    const input = node("image-input", "product", { x: 60, y: 140 }, t);
    const clean = node("remove-background", "cutout", { x: 370, y: 140 }, t);
    const resize = node("resize", "resize", { x: 680, y: 140 }, t);
    const output = node("output", "output", { x: 990, y: 140 }, t);
    resize.config.width = 1600;
    resize.config.height = 1600;
    output.config.format = "png";
    return {
      version: 1,
      nodes: [input, clean, resize, output],
      edges: [
        edge("product", "cutout", "image"),
        edge("cutout", "resize", "image"),
        edge("resize", "output", "media"),
      ],
    };
  }),
  template(
    "describe-to-prompt",
    "describeToPrompt",
    "i-lucide-wand-sparkles",
    (t) => {
      const { input, generation, output } = base(t);
      generation.position = { x: 1040, y: 140 };
      output.position = { x: 1370, y: 140 };
      const describe = node("describe-image", "describe", { x: 400, y: 140 }, t);
      describe.config.prompt =
        "Describe this product precisely: its materials, color, shape and distinguishing details.";
      const enhance = node("prompt-enhancer", "enhance", { x: 720, y: 140 }, t);
      enhance.config.systemPrompt =
        "Create a detailed product photography prompt from the supplied product description. Preserve the exact product. Use natural studio lighting, a warm neutral background and a refined composition.";
      generation.config.prompt = "";
      return {
        version: 1,
        nodes: [input, describe, enhance, generation, output],
        edges: [
          edge("product", "describe", "image"),
          edge("describe", "enhance", "text", "text"),
          edge("enhance", "generate", "prompt", "text"),
          edge("product", "generate", "image"),
          edge("generate", "output", "media"),
        ],
      };
    },
  ),
];
