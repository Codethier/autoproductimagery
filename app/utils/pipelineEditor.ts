/** Canvas geometry and history stay independent of the provider adapters. */
export type CanvasPoint = { x: number; y: number };
export type CanvasView = { x: number; y: number; zoom: number };
export const PIPELINE_NODE_WIDTH = 246;
export const PIPELINE_NODE_HEIGHT = 176;
export const PIPELINE_PORT_SPACING = 28;
export const PIPELINE_PORT_TOP = 112;
export const PIPELINE_HISTORY_LIMIT = 60;

export function copyPipeline<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
/** JSONB and schema parsing may reorder object keys. Array order is meaningful. */
export function pipelineFingerprint(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, entry[key]]),
          )
        : entry,
    ) ?? ""
  );
}
export function clampCanvasPoint(point: CanvasPoint): CanvasPoint {
  return {
    x: Math.max(-9000, Math.min(9000, Math.round(point.x))),
    y: Math.max(-9000, Math.min(9000, Math.round(point.y))),
  };
}
export function canvasPoint(
  client: CanvasPoint,
  bounds: { left: number; top: number },
  view: CanvasView,
): CanvasPoint {
  return {
    x: (client.x - bounds.left - view.x) / view.zoom,
    y: (client.y - bounds.top - view.y) / view.zoom,
  };
}
export function zoomCanvas(
  view: CanvasView,
  zoom: number,
  center: CanvasPoint,
): CanvasView {
  const next = Math.max(0.25, Math.min(1.75, zoom));
  return {
    zoom: next,
    x: center.x - ((center.x - view.x) * next) / view.zoom,
    y: center.y - ((center.y - view.y) * next) / view.zoom,
  };
}
export function fitCanvas(
  positions: CanvasPoint[],
  width: number,
  height: number,
): CanvasView {
  if (!positions.length || width <= 0 || height <= 0)
    return { x: 80, y: 80, zoom: 1 };
  const left = Math.min(...positions.map((point) => point.x));
  const top = Math.min(...positions.map((point) => point.y));
  const right =
    Math.max(...positions.map((point) => point.x)) + PIPELINE_NODE_WIDTH;
  const bottom =
    Math.max(...positions.map((point) => point.y)) + PIPELINE_NODE_HEIGHT + 60;
  const zoom = Math.max(
    0.25,
    Math.min(1, (width - 96) / (right - left), (height - 96) / (bottom - top)),
  );
  return {
    zoom,
    x: (width - (right - left) * zoom) / 2 - left * zoom,
    y: (height - (bottom - top) * zoom) / 2 - top * zoom,
  };
}
export function connectionPath(
  source: CanvasPoint,
  target: CanvasPoint,
): string {
  const bend = Math.max(70, Math.min(360, Math.abs(target.x - source.x) * 0.5));
  return `M ${source.x} ${source.y} C ${source.x + bend} ${source.y}, ${target.x - bend} ${target.y}, ${target.x} ${target.y}`;
}
export function minimapBounds(positions: CanvasPoint[]) {
  if (!positions.length) return { left: 0, top: 0, width: 500, height: 300 };
  const left = Math.min(...positions.map((point) => point.x)) - 40;
  const top = Math.min(...positions.map((point) => point.y)) - 40;
  return {
    left,
    top,
    width: Math.max(
      500,
      Math.max(...positions.map((point) => point.x)) +
        PIPELINE_NODE_WIDTH +
        40 -
        left,
    ),
    height: Math.max(
      300,
      Math.max(...positions.map((point) => point.y)) +
        PIPELINE_NODE_HEIGHT +
        100 -
        top,
    ),
  };
}
export function createsPipelineCycle(
  edges: Array<{ source: string; target: string }>,
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  const seen = new Set<string>();
  const queue = [target];
  while (queue.length) {
    const current = queue.shift()!;
    if (current === source) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges)
      if (edge.source === current) queue.push(edge.target);
  }
  return false;
}
/** History contains private in-memory snapshots only; it is never browser-persisted. */
export function createPipelineHistory<T>(initial: T) {
  let values = [copyPipeline(initial)];
  let index = 0;
  return {
    reset(value: T) {
      values = [copyPipeline(value)];
      index = 0;
    },
    push(value: T) {
      const next = copyPipeline(value);
      if (pipelineFingerprint(next) === pipelineFingerprint(values[index]))
        return false;
      values = values.slice(0, index + 1);
      values.push(next);
      if (values.length > PIPELINE_HISTORY_LIMIT) values.shift();
      index = values.length - 1;
      return true;
    },
    undo(): T | undefined {
      if (index <= 0) return undefined;
      index -= 1;
      return copyPipeline(values[index]!);
    },
    redo(): T | undefined {
      if (index >= values.length - 1) return undefined;
      index += 1;
      return copyPipeline(values[index]!);
    },
    get canUndo() {
      return index > 0;
    },
    get canRedo() {
      return index < values.length - 1;
    },
    get size() {
      return values.length;
    },
  };
}
