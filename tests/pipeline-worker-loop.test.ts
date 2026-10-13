import test from "node:test";
import assert from "node:assert/strict";
import { createPipelineWorkerLoop } from "../server/utils/pipelineWorkerLoop.ts";

test("pipeline worker coalesces notifications, bounds concurrency and deduplicates loaded runs", async () => {
  let loads = 0,
    active = 0,
    peak = 0,
    errors = 0;
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const worker = createPipelineWorkerLoop({
    load: async () =>
      ++loads === 1
        ? [{ runId: "a" }, { runId: "a" }, { runId: "b" }, { runId: "c" }]
        : [],
    advance: async (value) => {
      active++;
      peak = Math.max(peak, active);
      started.push(value.runId);
      await gate;
      active--;
      return true;
    },
    error: () => errors++,
    concurrency: 2,
  });
  const first = worker.kick(),
    second = worker.kick();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  release();
  await first;
  assert.deepEqual(started, ["a", "b", "c"]);
  assert.equal(errors, 0);
  assert.equal(worker.recentlyActive, true);
  await worker.close();
});

test("worker shutdown aborts active work, awaits it and starts no later node", async () => {
  let calls = 0,
    aborted = false;
  const worker = createPipelineWorkerLoop({
    load: async () => [{ runId: "one" }, { runId: "two" }],
    concurrency: 1,
    advance: async (_, signal) => {
      calls++;
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return false;
    },
    error: () => {
      throw Error("Unexpected worker failure");
    },
  });
  const work = worker.kick();
  await new Promise((resolve) => setImmediate(resolve));
  await worker.close();
  await work;
  assert.equal(aborted, true);
  assert.equal(calls, 1);
  assert.equal(worker.closed, true);
  await worker.kick();
  assert.equal(calls, 1);
});

test("worker drains no-progress claims once and normalizes errors without a busy loop", async () => {
  let loads = 0,
    errors = 0;
  const worker = createPipelineWorkerLoop({
    load: async () => {
      loads++;
      return [{ runId: "one" }];
    },
    advance: async () => false,
    error: () => errors++,
  });
  await worker.kick();
  assert.equal(loads, 1);
  assert.equal(errors, 0);
  assert.equal(worker.recentlyActive, false);
  await worker.close();
  const failed = createPipelineWorkerLoop({
    load: async () => {
      throw Error("private SQL or credential detail");
    },
    advance: async () => true,
    error: () => errors++,
  });
  await failed.kick();
  assert.equal(errors, 1);
  await failed.close();
});
