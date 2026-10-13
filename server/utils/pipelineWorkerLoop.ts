export type PipelineWorkerLoopDependencies<T extends { runId: string }> = {
  load(limit: number): Promise<T[]>;
  advance(run: T, signal: AbortSignal): Promise<boolean>;
  error(): void;
  concurrency?: number;
  maxRounds?: number;
};

/** A notification wakes one bounded drain; duplicate wakes do not duplicate work. */
export function createPipelineWorkerLoop<T extends { runId: string }>(
  deps: PipelineWorkerLoopDependencies<T>,
) {
  const concurrency = Math.max(
    1,
    Math.min(3, Math.floor(deps.concurrency ?? 2)),
  );
  const maxRounds = Math.max(
    1,
    Math.min(200, Math.floor(deps.maxRounds ?? 100)),
  );
  const controller = new AbortController();
  let closed = false,
    revision = 0,
    work: Promise<void> | undefined,
    lastProgressAt = 0;
  async function drain() {
    for (let round = 0; round < maxRounds && !closed; round++) {
      const seen = revision;
      const pending = await deps.load(10);
      const seenIds = new Set<string>();
      const unique = pending
        .filter((value) => {
          if (seenIds.has(value.runId)) return false;
          seenIds.add(value.runId);
          return true;
        })
        .slice(0, 10);
      if (!unique.length) {
        if (seen === revision) return;
        continue;
      }
      let progressed = false;
      for (
        let index = 0;
        index < unique.length && !closed;
        index += concurrency
      ) {
        const results = await Promise.allSettled(
          unique
            .slice(index, index + concurrency)
            .map((value) => deps.advance(value, controller.signal)),
        );
        for (const result of results) {
          if (result.status === "fulfilled")
            progressed = result.value || progressed;
          else deps.error();
        }
      }
      if (progressed) lastProgressAt = Date.now();
      if (!progressed && seen === revision) return;
    }
  }
  function kick(): Promise<void> {
    revision++;
    if (closed) return Promise.resolve();
    if (work) return work;
    work = drain()
      .catch(() => deps.error())
      .finally(() => {
        work = undefined;
      });
    return work;
  }
  async function close() {
    closed = true;
    controller.abort(new Error("Pipeline worker is stopping"));
    await work;
  }
  return {
    kick,
    close,
    get busy() {
      return Boolean(work);
    },
    get recentlyActive() {
      return Date.now() - lastProgressAt < 15 * 60_000;
    },
    get closed() {
      return closed;
    },
  };
}
