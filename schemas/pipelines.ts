import { z } from "zod";
import {
  ImageModelIdSchema,
  ImageGenerationSettingsSchema,
  ImagePathSchema,
  DEFAULT_IMAGE_MODEL_ID,
  createDefaultSettings,
  getImageModelProfile,
  generationOutputCount,
} from "./image-generation";

export const PIPELINE_LIMITS = {
  nodes: 24,
  edges: 80,
  batchImages: 50,
  imagesPerStep: 50,
  paidCallsPerRun: 500,
  textLength: 20_000,
} as const;
export const PIPELINE_NODE_TYPES = [
  "image-input",
  "people-input",
  "text-input",
  "static-image",
  "static-text",
  "generate-image",
  "remove-background",
  "crop",
  "resize",
  "upscale",
  "expand",
  "translate",
  "describe-image",
  "prompt-enhancer",
  "llm",
  "prompt-concatenator",
  "output",
  "sticky-note",
] as const;
export type PipelineNodeType = (typeof PIPELINE_NODE_TYPES)[number];
const reservedIds = new Set(
  [...Object.getOwnPropertyNames(Object.prototype), "prototype"].map((value) =>
    value.toLowerCase(),
  ),
);
const NodeId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,80}$/)
  .refine(
    (value) => !reservedIds.has(value.toLowerCase()),
    "Choose a distinct pipeline identifier.",
  );
const PipelineImagePathSchema = ImagePathSchema.refine((value) => {
  if (/[?#\\\x00-\x1f\x7f]/.test(value)) return false;
  try {
    return value
      .slice("/images/".length)
      .split("/")
      .every((encoded) => {
        const part = decodeURIComponent(encoded);
        return (
          Boolean(part) &&
          part !== "." &&
          part !== ".." &&
          !/[\\/%\x00-\x1f\x7f]/.test(part)
        );
      });
  } catch {
    return false;
  }
}, "Use an unambiguous private image path.");
const text = z.string().max(PIPELINE_LIMITS.textLength);
const dimension = z.number().int().min(1).max(8192);
const color = z.string().regex(/^(transparent|#[0-9a-fA-F]{6})$/);
const aiSettings = {
  model: ImageModelIdSchema,
  settings: ImageGenerationSettingsSchema,
};
const generationConfig = z
  .object({
    ...aiSettings,
    prompt: text.default(""),
    referenceImages: z.array(PipelineImagePathSchema).max(16).default([]),
    maskImage: PipelineImagePathSchema.optional(),
  })
  .strict();
const localPosition = z.enum(["centre", "north", "south", "east", "west"]);
const utilityConfig = z
  .object({
    model: z
      .literal("google/gemini-2.5-flash")
      .default("google/gemini-2.5-flash"),
    systemPrompt: text.default(""),
    prompt: text.default(""),
    temperature: z.number().min(0).max(2).default(0.5),
    maxOutputTokens: z.number().int().min(64).max(4096).default(1024),
  })
  .strict();
const base = {
  id: NodeId,
  label: z.string().trim().min(1).max(100),
  position: z
    .object({
      x: z.number().finite().min(-10000).max(10000),
      y: z.number().finite().min(-10000).max(10000),
    })
    .strict(),
};
const node = <T extends PipelineNodeType, S extends z.ZodType>(
  type: T,
  config: S,
) => z.object({ ...base, type: z.literal(type), config }).strict();
export const PipelineNodeSchema = z.discriminatedUnion("type", [
  node(
    "image-input",
    z
      .object({
        defaultImage: PipelineImagePathSchema.optional(),
        required: z.boolean().default(true),
      })
      .strict(),
  ),
  node(
    "people-input",
    z
      .object({ images: z.array(PipelineImagePathSchema).max(16).default([]) })
      .strict(),
  ),
  node(
    "text-input",
    z
      .object({
        defaultValue: text.default(""),
        required: z.boolean().default(true),
      })
      .strict(),
  ),
  node(
    "static-image",
    z
      .object({ images: z.array(PipelineImagePathSchema).max(16).default([]) })
      .strict(),
  ),
  node("static-text", z.object({ text: text.default("") }).strict()),
  node("generate-image", generationConfig),
  node(
    "remove-background",
    z
      .object({
        model: z.enum(["birefnet-lite", "birefnet"]).default("birefnet-lite"),
      })
      .strict(),
  ),
  node(
    "crop",
    z
      .object({
        width: dimension.default(1024),
        height: dimension.default(1024),
        position: localPosition.default("centre"),
      })
      .strict(),
  ),
  node(
    "resize",
    z
      .object({
        width: dimension.default(1024),
        height: dimension.default(1024),
        fit: z
          .enum(["contain", "cover", "inside", "outside", "fill"])
          .default("contain"),
        background: color.default("transparent"),
      })
      .strict(),
  ),
  node(
    "upscale",
    z
      .object({
        mode: z.enum(["standard", "ai"]).default("standard"),
        scale: z.union([z.literal(2), z.literal(4)]).default(2),
        ...aiSettings,
      })
      .strict(),
  ),
  node(
    "expand",
    z
      .object({
        ...aiSettings,
        mode: z.enum(["pixels", "aspect-ratio"]).default("pixels"),
        top: z.number().int().min(0).max(4096).default(128),
        bottom: z.number().int().min(0).max(4096).default(128),
        left: z.number().int().min(0).max(4096).default(128),
        right: z.number().int().min(0).max(4096).default(128),
        aspectRatio: z
          .enum([
            "1:1",
            "2:3",
            "3:2",
            "3:4",
            "4:3",
            "4:5",
            "5:4",
            "9:16",
            "16:9",
            "21:9",
          ])
          .default("1:1"),
        creativity: z.number().min(0).max(1).default(0.5),
        prompt: text.default(
          "Extend the scene naturally while preserving the original subject.",
        ),
      })
      .strict(),
  ),
  node(
    "translate",
    z
      .object({
        ...aiSettings,
        language: z.string().trim().min(1).max(80).default("English"),
        prompt: text.default("Preserve the image design and layout."),
      })
      .strict(),
  ),
  node("describe-image", utilityConfig),
  node("prompt-enhancer", utilityConfig),
  node("llm", utilityConfig),
  node(
    "prompt-concatenator",
    z.object({ separator: z.string().max(20).default("\n") }).strict(),
  ),
  node(
    "output",
    z
      .object({
        format: z.enum(["original", "png", "jpeg", "webp"]).default("original"),
        quality: z.number().int().min(1).max(100).default(90),
      })
      .strict(),
  ),
  node(
    "sticky-note",
    z
      .object({
        text: z.string().max(4000).default(""),
        color: z.enum(["amber", "rose", "sage", "blue"]).default("amber"),
      })
      .strict(),
  ),
]);
export type PipelineNode = z.infer<typeof PipelineNodeSchema>;
export type PipelinePort = {
  id: string;
  label: string;
  type: "image" | "text" | "media";
  required: boolean;
  multiple?: boolean;
};
export const PIPELINE_NODE_LABELS: Record<PipelineNodeType, string> = {
  "image-input": "Image Input",
  "people-input": "People Input",
  "text-input": "Text Input",
  "static-image": "Static Image",
  "static-text": "Static Text",
  "generate-image": "Generate Image",
  "remove-background": "Remove Background",
  crop: "Crop",
  resize: "Resize",
  upscale: "Upscale",
  expand: "Expand",
  translate: "Translate",
  "describe-image": "Describe Image",
  "prompt-enhancer": "Prompt Enhancer",
  llm: "LLM",
  "prompt-concatenator": "Prompt Concatenator",
  output: "Pipeline Output",
  "sticky-note": "Sticky Note",
};
export function getPipelineNodePorts(value: PipelineNode): {
  inputs: PipelinePort[];
  outputs: PipelinePort[];
} {
  const image = (required = true): PipelinePort => ({
    id: "image",
    label: "Image",
    type: "image",
    required,
  });
  const prompt = (required = false): PipelinePort => ({
    id: "prompt",
    label: "Prompt",
    type: "text",
    required,
  });
  const imageOut: PipelinePort = {
    id: "image",
    label: "Image",
    type: "image",
    required: false,
  };
  const textOut: PipelinePort = {
    id: "text",
    label: "Text",
    type: "text",
    required: false,
  };
  if (value.type === "sticky-note") return { inputs: [], outputs: [] };
  if (value.type === "image-input" || value.type === "people-input" || value.type === "static-image")
    return { inputs: [], outputs: [imageOut] };
  if (value.type === "text-input" || value.type === "static-text")
    return { inputs: [], outputs: [textOut] };
  if (value.type === "generate-image") {
    const profile = getImageModelProfile(value.config.model)!;
    return {
      inputs: [
        prompt(),
        image(false),
        {
          id: "references",
          label: "References",
          type: "image",
          required: false,
          multiple: true,
        },
        ...(profile.supportsMask
          ? [
              {
                id: "mask",
                label: "Mask",
                type: "image" as const,
                required:
                  Boolean(profile.requiresMask) && !value.config.maskImage,
              },
            ]
          : []),
      ],
      outputs: [imageOut],
    };
  }
  if (value.type === "describe-image")
    return { inputs: [image(), prompt()], outputs: [textOut] };
  if (value.type === "llm" || value.type === "prompt-enhancer")
    return {
      inputs: [
        {
          id: "text",
          label: value.type === "llm" ? "Text" : "Prompt",
          type: "text",
          required: !value.config.prompt.trim(),
        },
        image(false),
      ],
      outputs: [textOut],
    };
  if (value.type === "prompt-concatenator")
    return {
      inputs: [
        {
          id: "text",
          label: "Text",
          type: "text",
          required: true,
          multiple: true,
        },
      ],
      outputs: [textOut],
    };
  if (value.type === "output")
    return {
      inputs: [
        {
          id: "media",
          label: "Output",
          type: "media",
          required: true,
          multiple: true,
        },
      ],
      outputs: [],
    };
  return {
    inputs: [
      image(),
      ...(value.type === "expand" || value.type === "translate"
        ? [prompt()]
        : []),
    ],
    outputs: [imageOut],
  };
}
export function createPipelineNode<T extends PipelineNodeType>(
  type: T,
  id: string,
  position = { x: 80, y: 80 },
): Extract<PipelineNode, { type: T }> {
  const ai = {
    model: DEFAULT_IMAGE_MODEL_ID,
    settings: createDefaultSettings(DEFAULT_IMAGE_MODEL_ID),
  };
  const configs: Record<PipelineNodeType, unknown> = {
    "image-input": {},
    "people-input": {},
    "text-input": {},
    "static-image": {},
    "static-text": {},
    "generate-image": { ...ai },
    "remove-background": {},
    crop: {},
    resize: {},
    upscale: { ...ai },
    expand: { ...ai },
    translate: { ...ai },
    "describe-image": {},
    "prompt-enhancer": {},
    llm: {},
    "prompt-concatenator": {},
    output: {},
    "sticky-note": {},
  };
  return PipelineNodeSchema.parse({
    id,
    type,
    label: PIPELINE_NODE_LABELS[type],
    position,
    config: configs[type],
  }) as Extract<PipelineNode, { type: T }>;
}
export const PipelineEdgeSchema = z
  .object({
    id: NodeId,
    source: NodeId,
    sourcePort: z.enum(["image", "text"]),
    target: NodeId,
    targetPort: z.string().min(1).max(40),
  })
  .strict();
export type PipelineEdge = z.infer<typeof PipelineEdgeSchema>;
export const PipelineDefinitionSchema = z
  .object({
    version: z.literal(1),
    nodes: z.array(PipelineNodeSchema).max(PIPELINE_LIMITS.nodes),
    edges: z.array(PipelineEdgeSchema).max(PIPELINE_LIMITS.edges),
  })
  .strict()
  .superRefine((graph, context) => {
    const ids = new Set<string>(),
      edgeIds = new Set<string>(),
      targets = new Set<string>();
    for (const [index, n] of graph.nodes.entries()) {
      if (ids.has(n.id))
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: "Node IDs must be unique.",
        });
      ids.add(n.id);
      if ("model" in n.config && "settings" in n.config) {
        const profile = getImageModelProfile(n.config.model);
        if (!profile || profile.settingsKind !== n.config.settings.kind)
          context.addIssue({
            code: "custom",
            path: ["nodes", index, "config", "settings"],
            message: "Settings must belong to the exact selected model.",
          });
      }
      if (
        (n.type === "crop" || n.type === "resize") &&
        n.config.width * n.config.height > 40_000_000
      )
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "config"],
          message: "Images may contain at most 40 megapixels.",
        });
    }
    for (const [index, e] of graph.edges.entries()) {
      if (edgeIds.has(e.id))
        context.addIssue({
          code: "custom",
          path: ["edges", index, "id"],
          message: "Connection IDs must be unique.",
        });
      edgeIds.add(e.id);
      const source = graph.nodes.find((n) => n.id === e.source),
        target = graph.nodes.find((n) => n.id === e.target);
      const from =
          source &&
          getPipelineNodePorts(source).outputs.find(
            (p) => p.id === e.sourcePort,
          ),
        to =
          target &&
          getPipelineNodePorts(target).inputs.find(
            (p) => p.id === e.targetPort,
          );
      if (
        !from ||
        !to ||
        e.source === e.target ||
        (to.type !== "media" && from.type !== to.type)
      )
        context.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "Connect compatible ports on different nodes.",
        });
      const key = `${e.target}:${e.targetPort}`;
      if (to && !to.multiple && targets.has(key))
        context.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "This input accepts one connection.",
        });
      targets.add(key);
    }
    const active = new Set<string>(),
      done = new Set<string>();
    function visit(id: string): boolean {
      if (active.has(id)) return false;
      if (done.has(id)) return true;
      active.add(id);
      for (const e of graph.edges.filter((e) => e.source === id))
        if (!visit(e.target)) return false;
      active.delete(id);
      done.add(id);
      return true;
    }
    if (graph.nodes.some((n) => !visit(n.id)))
      context.addIssue({
        code: "custom",
        path: ["edges"],
        message: "Pipelines cannot contain cycles.",
      });
  });
export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;
export function getPipelineExecutionNodes(
  graph: PipelineDefinition,
  targetNodeId?: string,
): PipelineNode[] {
  const needed = new Set<string>();
  function add(id: string) {
    if (needed.has(id)) return;
    needed.add(id);
    for (const e of graph.edges.filter((e) => e.target === id)) add(e.source);
  }
  if (targetNodeId) add(targetNodeId);
  else
    for (const n of graph.nodes.filter((n) => n.type === "output")) add(n.id);
  const result: PipelineNode[] = [];
  const visited = new Set<string>();
  function append(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    for (const e of graph.edges.filter((e) => e.target === id))
      append(e.source);
    const n = graph.nodes.find((n) => n.id === id);
    if (n && needed.has(id)) result.push(n);
  }
  for (const id of needed) append(id);
  return result;
}
export function pipelineRunIssues(
  graph: PipelineDefinition,
  targetNodeId?: string,
): string[] {
  const issues: string[] = [];
  if (
    targetNodeId &&
    !graph.nodes.some((n) => n.id === targetNodeId && n.type !== "sticky-note")
  )
    return ["Choose a runnable node."];
  if (!targetNodeId && !graph.nodes.some((n) => n.type === "output"))
    issues.push("Add a Pipeline Output node.");
  for (const n of getPipelineExecutionNodes(graph, targetNodeId)) {
    for (const p of getPipelineNodePorts(n).inputs.filter((p) => p.required))
      if (!graph.edges.some((e) => e.target === n.id && e.targetPort === p.id))
        issues.push(`${n.label}: connect ${p.label}.`);
    if (n.type === "static-image" && !n.config.images.length)
      issues.push(`${n.label}: choose an image.`);
    if (n.type === "people-input" && !n.config.images.length)
      issues.push(`${n.label}: choose at least one People picture.`);
    if (n.type === "static-text" && !n.config.text.trim())
      issues.push(`${n.label}: enter text.`);
    if (
      n.type === "generate-image" &&
      !n.config.prompt.trim() &&
      !graph.edges.some((e) => e.target === n.id && e.targetPort === "prompt")
    )
      issues.push(`${n.label}: provide a prompt.`);
  }
  return issues;
}
export const SavePipelineSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(4000).default(""),
    definition: PipelineDefinitionSchema,
  })
  .strict();
export const UpdatePipelineSchema = SavePipelineSchema.extend({
  revision: z.number().int().positive(),
}).strict();
export const StartPipelineRunSchema = z
  .object({
    revision: z.number().int().positive(),
    idempotencyKey: z.string().uuid(),
    batchInputNodeId: NodeId.optional(),
    inputImages: z
      .array(PipelineImagePathSchema)
      .max(PIPELINE_LIMITS.batchImages)
      .default([]),
    inputs: z.record(NodeId, text).default({}),
    targetNodeId: NodeId.optional(),
  })
  .strict();
export type StartPipelineRun = z.infer<typeof StartPipelineRunSchema>;
export type PipelineDTO = {
  id: string;
  name: string;
  description: string;
  revision: number;
  definition: PipelineDefinition;
  createdAt: string;
  updatedAt: string;
};
export type PipelineListDTO = {
  pipelines: PipelineDTO[];
  nextCursor: string | null;
};
export type PipelineImageValue = {
  id: string;
  url: string;
  name: string;
  priceUsd: string | null;
  priceSource: string | null;
  generationId?: number;
  width?: number;
  height?: number;
  mimeType?: string;
  bytes?: number;
};
export type PipelineValue = {
  images: PipelineImageValue[];
  text: string | null;
};
export type PipelineRunStatus =
  | "queued"
  | "running"
  | "awaiting-price"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";
export type PipelineStepStatus =
  | "queued"
  | "running"
  | "awaiting-price"
  | "succeeded"
  | "failed"
  | "skipped"
  | "interrupted"
  | "cancelled";
export type PipelineError = {
  code: string;
  message: string;
  retryable: boolean;
};
export type PipelineRunStepDTO = {
  id: string;
  nodeId: string;
  type: PipelineNodeType;
  status: PipelineStepStatus;
  value: PipelineValue | null;
  error: PipelineError | null;
  generationIds: number[];
  backgroundRemovalJobId: string | null;
  startedAt: string | null;
  completedAt: string | null;
};
export type PipelineRunItemDTO = {
  id: string;
  index: number;
  inputUrl: string | null;
  status: PipelineRunStatus;
  steps: PipelineRunStepDTO[];
};
export type PipelineRunDTO = {
  id: string;
  pipelineId: string;
  name: string;
  revision: number;
  status: PipelineRunStatus;
  definition: PipelineDefinition;
  targetNodeId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelRequested: boolean;
  items: PipelineRunItemDTO[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    pending: number;
    confirmedCostUsd: string;
    outstandingCount: number;
  };
};
export type PipelineRunListDTO = {
  runs: Omit<PipelineRunDTO, "items" | "definition">[];
  nextCursor: string | null;
};
export const RetryPipelineRunSchema = z
  .object({
    stepIds: z.array(z.string().uuid()).min(1).max(50),
    confirmPossibleCharge: z.boolean().default(false),
  })
  .strict();
export const PipelineListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(512).optional(),
    search: z.string().trim().max(100).default(""),
  })
  .strict();
export function pipelineExpectedNodeOutputs(
  node: PipelineNode,
  inputCount = 1,
): number {
  if (node.type === "people-input" || node.type === "static-image")
    return node.config.images.length;
  if (
    node.type === "generate-image" ||
    node.type === "expand" ||
    node.type === "translate" ||
    (node.type === "upscale" && node.config.mode === "ai")
  )
    return (
      Math.max(1, inputCount) * generationOutputCount(node.config.settings)
    );
  return inputCount;
}
