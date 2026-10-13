import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasPoint,
  clampCanvasPoint,
  connectionPath,
  createsPipelineCycle,
  createPipelineHistory,
  fitCanvas,
  minimapBounds,
  pipelineFingerprint,
  PIPELINE_HISTORY_LIMIT,
  zoomCanvas,
} from "../app/utils/pipelineEditor.ts";
test("pipeline fingerprints ignore object-key order while preserving meaningful array order", () => {
  assert.equal(
    pipelineFingerprint({
      nodes: [{ id: "input", config: { width: 600, height: 800 } }],
      edges: [],
    }),
    pipelineFingerprint({
      edges: [],
      nodes: [{ config: { height: 800, width: 600 }, id: "input" }],
    }),
  );
  assert.notEqual(
    pipelineFingerprint({ edges: ["first", "second"] }),
    pipelineFingerprint({ edges: ["second", "first"] }),
  );
  const history = createPipelineHistory({ point: { x: 100, y: 200 } });
  assert.equal(history.push({ point: { y: 200, x: 100 } }), false);
});

test("canvas zoom preserves the point under the pointer and bounds zoom", () => {
  const view = { x: 20, y: 40, zoom: 0.8 };
  const center = { x: 250, y: 180 };
  const before = canvasPoint(center, { left: 0, top: 0 }, view);
  const after = canvasPoint(
    center,
    { left: 0, top: 0 },
    zoomCanvas(view, 1.5, center),
  );
  assert.equal(before.x, after.x);
  assert.equal(before.y, after.y);
  assert.equal(zoomCanvas(view, 100, center).zoom, 1.75);
  assert.equal(zoomCanvas(view, -1, center).zoom, 0.25);
});
test("fit and minimap contain negative coordinates without losing distant nodes", () => {
  const positions = [
    { x: -600, y: -400 },
    { x: 800, y: 500 },
  ];
  const fitted = fitCanvas(positions, 1200, 800);
  assert.ok(fitted.zoom >= 0.25 && fitted.zoom <= 1);
  const bounds = minimapBounds(positions);
  assert.ok(bounds.left < -600 && bounds.top < -400);
  assert.ok(
    bounds.left + bounds.width > 800 && bounds.top + bounds.height > 500,
  );
  assert.deepEqual(clampCanvasPoint({ x: 50000, y: -50000 }), {
    x: 9000,
    y: -9000,
  });
  assert.match(connectionPath(positions[0]!, positions[1]!), /^M -600 -400 C /);
});
test("connection validation rejects a cycle across branches and accepts independent branches", () => {
  const edges = [
    { source: "input", target: "clean" },
    { source: "clean", target: "generate" },
    { source: "input", target: "describe" },
    { source: "describe", target: "generate" },
  ];
  assert.equal(createsPipelineCycle(edges, "generate", "input"), true);
  assert.equal(createsPipelineCycle(edges, "generate", "describe"), true);
  assert.equal(createsPipelineCycle(edges, "generate", "generate"), true);
  assert.equal(createsPipelineCycle(edges, "generate", "output"), false);
});
test("undo history clones private snapshots, discards redo after editing and stays bounded", () => {
  const initial = { nodes: [{ name: "Input" }] };
  const history = createPipelineHistory(initial);
  initial.nodes[0]!.name = "Mutated";
  assert.equal(history.push({ nodes: [{ name: "Input" }] }), false);
  history.push({ nodes: [{ name: "Generate" }] });
  const previous = history.undo()!;
  assert.equal(previous.nodes[0]!.name, "Input");
  previous.nodes[0]!.name = "Leaked";
  assert.equal(history.redo()!.nodes[0]!.name, "Generate");
  history.undo();
  history.push({ nodes: [{ name: "Crop" }] });
  assert.equal(history.canRedo, false);
  for (let index = 0; index < 100; index += 1)
    history.push({ nodes: [{ name: `${index}` }] });
  assert.equal(history.size, PIPELINE_HISTORY_LIMIT);
  history.reset({ nodes: [{ name: "New account" }] });
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
});
