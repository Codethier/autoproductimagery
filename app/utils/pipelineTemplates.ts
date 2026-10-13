import {
  createPipelineNode,
  PIPELINE_NODE_LABELS,
  type PipelineDefinition,
  type PipelineNode,
  type PipelineNodeType,
} from "../../schemas/pipelines";

export const PIPELINE_PALETTE: Array<{
  type: PipelineNodeType;
  group: string;
  icon: string;
  description: string;
}> = [
  {
    type: "image-input",
    group: "Inputs",
    icon: "i-lucide-image-plus",
    description: "A picture supplied each time the pipeline runs.",
  },
  {
    type: "text-input",
    group: "Inputs",
    icon: "i-lucide-text-cursor-input",
    description: "A prompt or value supplied for each run.",
  },
  {
    type: "static-image",
    group: "Inputs",
    icon: "i-lucide-images",
    description: "Reusable pictures from your Library or People.",
  },
  {
    type: "static-text",
    group: "Inputs",
    icon: "i-lucide-text",
    description: "Keep a prompt or instruction in the pipeline.",
  },
  {
    type: "generate-image",
    group: "AI tools",
    icon: "i-lucide-sparkles",
    description: "Generate or edit pictures with the current image models.",
  },
  {
    type: "describe-image",
    group: "AI tools",
    icon: "i-lucide-scan-eye",
    description: "Describe a picture and pass its text to another step.",
  },
  {
    type: "prompt-enhancer",
    group: "AI tools",
    icon: "i-lucide-wand-sparkles",
    description: "Turn a short idea into a detailed prompt.",
  },
  {
    type: "llm",
    group: "AI tools",
    icon: "i-lucide-brain",
    description: "Transform text with a custom instruction.",
  },
  {
    type: "remove-background",
    group: "Image tools",
    icon: "i-lucide-scissors",
    description: "Make a transparent cutout with BiRefNet on the CPU.",
  },
  {
    type: "upscale",
    group: "Image tools",
    icon: "i-lucide-maximize-2",
    description: "Enlarge pictures by 2× or 4×, with optional AI detail.",
  },
  {
    type: "expand",
    group: "Image tools",
    icon: "i-lucide-scan",
    description: "Generate a larger scene around your picture.",
  },
  {
    type: "crop",
    group: "Image tools",
    icon: "i-lucide-crop",
    description: "Crop to exact dimensions and choose the focus position.",
  },
  {
    type: "resize",
    group: "Image tools",
    icon: "i-lucide-scaling",
    description: "Fit pictures into exact dimensions.",
  },
  {
    type: "translate",
    group: "Image tools",
    icon: "i-lucide-languages",
    description: "Translate the text in a picture while preserving its design.",
  },
  {
    type: "prompt-concatenator",
    group: "Text tools",
    icon: "i-lucide-list-plus",
    description: "Join several text branches in connection order.",
  },
  {
    type: "output",
    group: "Finish & notes",
    icon: "i-lucide-folder-output",
    description: "Collect the pipeline results and choose their image format.",
  },
  {
    type: "sticky-note",
    group: "Finish & notes",
    icon: "i-lucide-sticky-note",
    description: "Leave a note on the canvas for your future self.",
  },
];
export function pipelineNodeIcon(type: PipelineNodeType) {
  return (
    PIPELINE_PALETTE.find((value) => value.type === type)?.icon ??
    "i-lucide-workflow"
  );
}
export function pipelineNodeDescription(node: PipelineNode): string {
  if (node.type === "generate-image")
    return node.config.prompt || "Connect a prompt or write one in settings.";
  if (node.type === "static-text")
    return node.config.text || "Write reusable text.";
  if (node.type === "text-input")
    return node.config.defaultValue || "Text supplied when you run.";
  if (node.type === "static-image")
    return `${node.config.images.length} reference picture${node.config.images.length === 1 ? "" : "s"}`;
  if (node.type === "image-input")
    return "One independent job for each batch picture.";
  if (node.type === "remove-background")
    return node.config.model === "birefnet-lite"
      ? "BiRefNet Lite · local CPU"
      : "BiRefNet Full · local CPU";
  if (node.type === "crop" || node.type === "resize")
    return `${node.config.width} × ${node.config.height} px`;
  if (node.type === "upscale")
    return `${node.config.scale}× · ${node.config.mode === "ai" ? "AI detail" : "standard resize"}`;
  if (node.type === "translate") return `Translate to ${node.config.language}`;
  if (node.type === "output")
    return node.config.format === "original"
      ? "Collect original results"
      : `${node.config.format.toUpperCase()} export`;
  if (node.type === "sticky-note") return node.config.text || "Write a note.";
  return (
    PIPELINE_PALETTE.find((value) => value.type === node.type)?.description ??
    PIPELINE_NODE_LABELS[node.type]
  );
}
export type PipelineTemplate = {
  id: string;
  name: string;
  description: string;
  icon: string;
  definition: () => PipelineDefinition;
};
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
function base() {
  const input = createPipelineNode("image-input", "product", { x: 80, y: 140 });
  input.label = "Product picture";
  const generation = createPipelineNode("generate-image", "generate", {
    x: 450,
    y: 140,
  });
  const output = createPipelineNode("output", "output", { x: 820, y: 140 });
  return { input, generation, output };
}
export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: "blank",
    name: "Start from scratch",
    description: "Connect inputs, tools and outputs into your own workflow.",
    icon: "i-lucide-plus",
    definition: () => ({
      version: 1,
      nodes: [
        createPipelineNode("image-input", "product", { x: 80, y: 140 }),
        createPipelineNode("output", "output", { x: 450, y: 140 }),
      ],
      edges: [edge("product", "output", "media")],
    }),
  },
  {
    id: "product-photo",
    name: "Product photography",
    description:
      "Place each product in the same polished scene, one picture at a time.",
    icon: "i-lucide-camera",
    definition: () => {
      const { input, generation, output } = base();
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
    },
  },
  {
    id: "on-model",
    name: "On-model collection",
    description:
      "Combine your product pictures with a reusable person reference.",
    icon: "i-lucide-contact-round",
    definition: () => {
      const { input, generation, output } = base();
      const person = createPipelineNode("static-image", "person", {
        x: 80,
        y: 420,
      });
      person.label = "Person reference";
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
    },
  },
  {
    id: "clean-catalog",
    name: "Clean catalog",
    description:
      "Remove backgrounds and prepare consistently sized transparent product pictures.",
    icon: "i-lucide-scissors",
    definition: () => {
      const input = createPipelineNode("image-input", "product", {
        x: 60,
        y: 140,
      });
      const clean = createPipelineNode("remove-background", "cutout", {
        x: 370,
        y: 140,
      });
      const resize = createPipelineNode("resize", "resize", { x: 680, y: 140 });
      const output = createPipelineNode("output", "output", { x: 990, y: 140 });
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
    },
  },
  {
    id: "describe-to-prompt",
    name: "Picture to campaign",
    description:
      "Describe each product, enhance the prompt, then generate a campaign picture.",
    icon: "i-lucide-wand-sparkles",
    definition: () => {
      const { input, generation, output } = base();
      generation.position = { x: 1040, y: 140 };
      output.position = { x: 1370, y: 140 };
      const describe = createPipelineNode("describe-image", "describe", {
        x: 400,
        y: 140,
      });
      describe.config.prompt =
        "Describe this product precisely: its materials, color, shape and distinguishing details.";
      const enhance = createPipelineNode("prompt-enhancer", "enhance", {
        x: 720,
        y: 140,
      });
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
  },
];
