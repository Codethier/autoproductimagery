import test from "node:test";
import assert from "node:assert/strict";
import {
  createPipelineNode,
  PIPELINE_NODE_TYPES,
  PipelineDefinitionSchema,
  PipelineNodeSchema,
  StartPipelineRunSchema,
  getPipelineExecutionNodes,
  getPipelineNodePorts,
  pipelineRunIssues,
  pipelineExpectedNodeOutputs,
  PIPELINE_LIMITS,
} from "../schemas/pipelines.ts";
import {
  SUPPORTED_IMAGE_MODEL_IDS,
  createDefaultSettings,
  getImageModelProfile,
} from "../schemas/image-generation.ts";

const image = "/images/input/source.png";
const edge = (
  source: string,
  target: string,
  targetPort = "image",
  sourcePort: "image" | "text" = "image",
  id = `${source}_${target}_${targetPort}`,
) => ({ id, source, sourcePort, target, targetPort });
const basic = () => ({
  version: 1 as const,
  nodes: [
    createPipelineNode("image-input", "input"),
    createPipelineNode("crop", "crop"),
    createPipelineNode("output", "output"),
  ],
  edges: [edge("input", "crop"), edge("crop", "output", "media")],
});

test("every image pipeline node has strict persisted defaults and explicit typed ports", () => {
  for (const type of PIPELINE_NODE_TYPES) {
    const value = createPipelineNode(type, type);
    assert.equal(value.type, type);
    assert.deepEqual(PipelineNodeSchema.parse(value), value);
    assert.equal(
      PipelineNodeSchema.safeParse({ ...value, arbitraryCode: "eval()" })
        .success,
      false,
    );
    assert.equal(
      PipelineNodeSchema.safeParse({
        ...value,
        config: { ...value.config, unknownOption: true },
      }).success,
      false,
    );
    const ports = getPipelineNodePorts(value);
    assert.equal(
      new Set(ports.inputs.map((p) => p.id)).size,
      ports.inputs.length,
    );
    assert.equal(
      new Set(ports.outputs.map((p) => p.id)).size,
      ports.outputs.length,
    );
  }
  for (const unsupported of [
    "video-input",
    "generate-video",
    "static-video",
    "describe-video",
    "audio-input",
    "http-request",
    "javascript",
  ])
    assert.equal(
      PipelineNodeSchema.safeParse({
        ...createPipelineNode("image-input", "input"),
        type: unsupported,
      }).success,
      false,
    );
});

test("pipeline generation uses exact current model settings and mask capabilities", () => {
  for (const model of SUPPORTED_IMAGE_MODEL_IDS) {
    const value = {
      ...createPipelineNode("generate-image", "generate"),
      config: {
        model,
        settings: createDefaultSettings(model),
        prompt: "Create a product photograph",
        referenceImages: [],
      },
    };
    assert.equal(
      PipelineDefinitionSchema.safeParse({
        version: 1,
        nodes: [value],
        edges: [],
      }).success,
      true,
      model,
    );
    const ports = getPipelineNodePorts(value);
    assert.equal(
      ports.inputs.some((p) => p.id === "mask"),
      getImageModelProfile(model)?.supportsMask,
      model,
    );
    if (getImageModelProfile(model)?.requiresMask) {
      assert.equal(ports.inputs.find((p) => p.id === "mask")?.required, true);
      const configuredMask = {
        ...value,
        config: { ...value.config, maskImage: image },
      };
      assert.equal(
        getPipelineNodePorts(configuredMask).inputs.find((p) => p.id === "mask")
          ?.required,
        false,
      );
      assert.equal(
        pipelineRunIssues(
          { version: 1, nodes: [configuredMask], edges: [] },
          "generate",
        ).some((issue) => issue.includes("connect Mask")),
        false,
      );
    }
    const different = SUPPORTED_IMAGE_MODEL_IDS.find(
      (other) =>
        getImageModelProfile(other)?.settingsKind !==
        getImageModelProfile(model)?.settingsKind,
    )!;
    assert.equal(
      PipelineDefinitionSchema.safeParse({
        version: 1,
        nodes: [
          {
            ...value,
            config: {
              ...value.config,
              settings: createDefaultSettings(different),
            },
          },
        ],
        edges: [],
      }).success,
      false,
      model,
    );
  }
});

test("connections reject cycles, incompatible ports, duplicates and missing node identities", () => {
  const valid = basic();
  assert.equal(PipelineDefinitionSchema.safeParse(valid).success, true);
  assert.equal(
    PipelineDefinitionSchema.safeParse({
      ...valid,
      edges: [...valid.edges, edge("crop", "crop")],
    }).success,
    false,
  );
  assert.equal(
    PipelineDefinitionSchema.safeParse({
      ...valid,
      edges: [...valid.edges, edge("absent", "crop")],
    }).success,
    false,
  );
  assert.equal(
    PipelineDefinitionSchema.safeParse({
      ...valid,
      edges: [
        ...valid.edges,
        edge("input", "crop", "image", "image", "duplicate_input"),
      ],
    }).success,
    false,
  );
  assert.equal(
    PipelineDefinitionSchema.safeParse({
      ...valid,
      nodes: [...valid.nodes, valid.nodes[0]],
    }).success,
    false,
  );
  assert.equal(
    PipelineDefinitionSchema.safeParse({
      ...valid,
      edges: [...valid.edges, valid.edges[0]],
    }).success,
    false,
  );
  const other = createPipelineNode("crop", "other");
  assert.equal(
    PipelineDefinitionSchema.safeParse({
      ...valid,
      nodes: [...valid.nodes, other],
      edges: [edge("crop", "other"), edge("other", "crop")],
    }).success,
    false,
  );
  const text = createPipelineNode("static-text", "text");
  assert.equal(
    PipelineDefinitionSchema.safeParse({
      ...valid,
      nodes: [...valid.nodes, text],
      edges: [edge("text", "crop", "image", "text")],
    }).success,
    false,
  );
  assert.equal(
    PipelineDefinitionSchema.safeParse({
      ...valid,
      edges: [edge("input", "crop", "unknown")],
    }).success,
    false,
  );
});

test("reference and concatenation ports accept ordered multiple compatible connections", () => {
  const generate = createPipelineNode("generate-image", "generate");
  generate.config.prompt = "Keep references";
  const concat = createPipelineNode("prompt-concatenator", "concat");
  const nodes = [
    createPipelineNode("image-input", "a"),
    createPipelineNode("image-input", "b"),
    createPipelineNode("static-text", "x"),
    createPipelineNode("static-text", "y"),
    generate,
    concat,
  ];
  assert.equal(
    PipelineDefinitionSchema.safeParse({
      version: 1,
      nodes,
      edges: [
        edge("a", "generate", "references"),
        edge("b", "generate", "references"),
        edge("x", "concat", "text", "text"),
        edge("y", "concat", "text", "text"),
      ],
    }).success,
    true,
  );
});

test("only output ancestry runs and a single-node test ignores unrelated unfinished nodes", () => {
  const graph = PipelineDefinitionSchema.parse({
    ...basic(),
    nodes: [
      ...basic().nodes,
      createPipelineNode("generate-image", "unfinished"),
      createPipelineNode("sticky-note", "note"),
    ],
  });
  assert.deepEqual(
    getPipelineExecutionNodes(graph).map((n) => n.id),
    ["input", "crop", "output"],
  );
  assert.deepEqual(
    getPipelineExecutionNodes(graph, "crop").map((n) => n.id),
    ["input", "crop"],
  );
  assert.deepEqual(pipelineRunIssues(graph), []);
  assert.deepEqual(pipelineRunIssues(graph, "crop"), []);
  assert.match(pipelineRunIssues(graph, "note").join(" "), /runnable/);
  assert.match(pipelineRunIssues(graph, "unknown").join(" "), /runnable/);
});

test("drafts may be incomplete but run validation lists required nodes, ports and prompts", () => {
  assert.equal(
    PipelineDefinitionSchema.safeParse({ version: 1, nodes: [], edges: [] })
      .success,
    true,
  );
  assert.match(
    pipelineRunIssues({ version: 1, nodes: [], edges: [] }).join(" "),
    /Output/,
  );
  const graph = {
    version: 1 as const,
    nodes: [
      createPipelineNode("generate-image", "generate"),
      createPipelineNode("output", "output"),
    ],
    edges: [edge("generate", "output", "media")],
  };
  assert.match(pipelineRunIssues(graph).join(" "), /prompt/);
  const cropped = { ...basic(), edges: [edge("crop", "output", "media")] };
  assert.match(pipelineRunIssues(cropped).join(" "), /connect Image/);
});

test("all fixed image sources require private canonical image paths", () => {
  for (const path of [
    "https://example.com/person.jpg",
    "data:image/png;base64,abc",
    "/images/../secret.png",
    "/images/input/%2e%2e/secret.png",
  ]) {
    assert.equal(
      PipelineNodeSchema.safeParse({
        ...createPipelineNode("static-image", "static"),
        config: { images: [path] },
      }).success,
      false,
      path,
    );
    assert.equal(
      PipelineNodeSchema.safeParse({
        ...createPipelineNode("image-input", "input"),
        config: { defaultImage: path },
      }).success,
      false,
      path,
    );
    assert.equal(
      StartPipelineRunSchema.safeParse({
        revision: 1,
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        inputImages: [path],
      }).success,
      false,
      path,
    );
  }
  assert.equal(
    PipelineNodeSchema.safeParse({
      ...createPipelineNode("static-image", "static"),
      config: { images: [image] },
    }).success,
    true,
  );
});

test("saved graphs and runs are bounded and cannot accept arbitrary executable request fields", () => {
  for (const id of [
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "valueOf",
    "__defineGetter__",
    "hasOwnProperty",
  ])
    assert.equal(
      PipelineNodeSchema.safeParse({
        ...createPipelineNode("text-input", "valid"),
        id,
      }).success,
      false,
      id,
    );
  assert.equal(
    PipelineDefinitionSchema.safeParse({
      version: 1,
      nodes: Array.from({ length: PIPELINE_LIMITS.nodes + 1 }, (_, i) =>
        createPipelineNode("sticky-note", `note_${i}`),
      ),
      edges: [],
    }).success,
    false,
  );
  const request = {
    revision: 1,
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    batchInputNodeId: "input",
    inputImages: [image],
    inputs: { prompt: "Studio portrait" },
    targetNodeId: "crop",
  };
  assert.equal(StartPipelineRunSchema.safeParse(request).success, true);
  assert.equal(
    StartPipelineRunSchema.safeParse({
      ...request,
      inputImages: Array(PIPELINE_LIMITS.batchImages + 1).fill(image),
    }).success,
    false,
  );
  assert.equal(
    StartPipelineRunSchema.safeParse({ ...request, script: "eval()" }).success,
    false,
  );
  assert.equal(
    StartPipelineRunSchema.safeParse({ ...request, revision: 0 }).success,
    false,
  );
  assert.equal(
    PipelineNodeSchema.safeParse({
      ...createPipelineNode("crop", "crop"),
      config: { width: 8193, height: 1 },
    }).success,
    false,
  );
  assert.equal(
    PipelineDefinitionSchema.safeParse({
      version: 1,
      nodes: [
        {
          ...createPipelineNode("crop", "crop"),
          config: { width: 8192, height: 8192, position: "centre" },
        },
      ],
      edges: [],
    }).success,
    false,
  );
});

test("output projection accounts for exact model output counts without unbounded fanout", () => {
  const node = createPipelineNode("generate-image", "generate");
  node.config.model = "openai/gpt-image-1";
  node.config.settings = {
    ...createDefaultSettings("openai/gpt-image-1"),
    numberOfImages: 3,
  };
  assert.equal(pipelineExpectedNodeOutputs(node, 2), 6);
  assert.equal(
    pipelineExpectedNodeOutputs(createPipelineNode("crop", "crop"), 2),
    2,
  );
});
