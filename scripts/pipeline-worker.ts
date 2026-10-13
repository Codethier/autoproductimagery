import "dotenv/config";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  getDatabasePool,
  getDatabasePoolConfig,
  closeDatabasePool,
} from "../server/utils/lib/db";
import { closeImageStorage } from "../server/utils/useFS";
import { verifyBackgroundRemovalRuntime } from "../server/utils/backgroundRemovalRuntime";
import {
  kickBackgroundRemovalQueue,
  closeBackgroundRemovalQueue,
} from "../server/utils/backgroundRemovalRunner";
import {
  listRunnablePipelineRunAccounts,
  advancePipelineRun,
} from "../server/utils/pipelineRunner";
import { createPipelineWorkerLoop } from "../server/utils/pipelineWorkerLoop";
import { createPipelineNotifications } from "../server/utils/pipelineNotifications";
import { useRuntimeConfig } from "./pipeline-worker-runtime";

const runtimeConfig = useRuntimeConfig();
const requestedConcurrency = Number(
  process.env.PIPELINE_WORKER_CONCURRENCY ?? 2,
);
const concurrency = Number.isFinite(requestedConcurrency)
  ? Math.max(1, Math.min(3, Math.floor(requestedConcurrency)))
  : 2;
const port = Number(
  process.env.PORT ?? process.env.PIPELINE_WORKER_PORT ?? 3221,
);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw Error("Invalid pipeline worker port");
const host = process.env.PIPELINE_WORKER_HOST ?? "0.0.0.0";
const pool = getDatabasePool();
// LISTEN holds a connection. A one-connection deployment uses durable polling
// instead, leaving its only connection available for claims and progress.
const notificationsEnabled = (getDatabasePoolConfig().max ?? 3) > 1;
let closing = false,
  ready = false,
  ticker: ReturnType<typeof setTimeout> | undefined;
const worker = createPipelineWorkerLoop({
  concurrency,
  load: listRunnablePipelineRunAccounts,
  advance: async (job, signal) => {
    const result = await advancePipelineRun(job.actor, job.runId, {
      runtimeConfig,
      signal,
    });
    return result.advanced;
  },
  error: () =>
    console.error(
      "Pipeline work is temporarily unavailable; saved progress will be checked again.",
    ),
});
const notifications = createPipelineNotifications({
  pool,
  notify: () => {
    if (!closing) void worker.kick();
  },
  unavailable: () =>
    console.error(
      "Pipeline notifications are temporarily unavailable; durable polling will continue.",
    ),
});

const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.method !== "GET" || request.url !== "/health") {
    response.writeHead(404);
    response.end('{"error":"Not found"}');
    return;
  }
  response.writeHead(ready && !closing ? 200 : 503);
  response.end(JSON.stringify({ ok: ready && !closing, worker: "pipelines" }));
});
server.headersTimeout = 5000;
server.requestTimeout = 5000;
server.maxHeadersCount = 20;
server.on("error", () => {
  console.error("Pipeline worker health listener could not start.");
  void close(1);
});

async function tick() {
  if (closing) return;
  try {
    if (notificationsEnabled) await notifications.connect();
    if (closing) return;
    // A lost notification, expired lease or delayed exact price must not leave
    // a durable run stuck. Only this dedicated worker has a fallback poll.
    void kickBackgroundRemovalQueue();
    await worker.kick();
  } catch {
    console.error(
      "Pipeline worker connection is temporarily unavailable; it will reconnect.",
    );
  } finally {
    if (!closing)
      ticker = setTimeout(
        () => {
          void tick();
        },
        worker.recentlyActive ? 5000 : 60_000,
      );
  }
}

async function close(code = 0) {
  if (closing) return;
  closing = true;
  ready = false;
  if (ticker) clearTimeout(ticker);
  // Active Gateway work is aborted and awaited. Its persisted paid-start
  // fence survives a forced shutdown, so a replacement cannot blindly retry.
  const deadline = setTimeout(() => process.exit(code || 1), 45_000);
  try {
    await Promise.all([
      notifications.close(),
      worker.close(),
      closeBackgroundRemovalQueue(),
    ]);
    closeImageStorage();
    await closeDatabasePool();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } catch {
    console.error("Pipeline worker shutdown could not finish cleanly.");
    code = 1;
  } finally {
    clearTimeout(deadline);
    process.exitCode = code;
  }
}
process.once("SIGTERM", () => {
  void close();
});
process.once("SIGINT", () => {
  void close();
});

async function startWorker() {
  try {
    if (!runtimeConfig.AiGatewayApiKey)
      throw Error("Pipeline worker Gateway credentials are missing");
    await verifyBackgroundRemovalRuntime();
    if (closing) return;
    console.info("Pipeline worker CPU runtime verified");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    if (closing) return;
    const started = Date.now();
    let available = false,
      connectionWarning = false;
    // Only the app pre-deploy command applies migrations. Git builds of two
    // services can finish in either order, so wait without applying SQL here.
    while (!closing && Date.now() - started < 5 * 60_000) {
      try {
        const result = await pool.query<{
          available: boolean;
        }>(`SELECT to_regclass('pipeline_run') IS NOT NULL AND
      to_regclass('pipeline_run_step') IS NOT NULL AND to_regclass('pipeline_step_output') IS NOT NULL AS available`);
        if (result.rows[0]?.available) {
          available = true;
          break;
        }
      } catch {
        if (!connectionWarning && !closing)
          console.error(
            "Pipeline worker is waiting for PostgreSQL and the app migration.",
          );
        connectionWarning = true;
      }
      await delay(5000);
    }
    if (!closing && !available) throw Error("Pipeline migration is not ready");
    if (!closing) {
      if (notificationsEnabled) await notifications.connect();
      if (!closing) {
        ready = true;
        console.info(
          JSON.stringify({
            component: "pipeline-worker",
            status: "ready",
            concurrency,
            notificationsEnabled,
            availableMemoryGiB: Number(
              (process.availableMemory() / 1024 ** 3).toFixed(2),
            ),
            memoryLimitGiB: Number(
              (process.constrainedMemory() / 1024 ** 3).toFixed(2),
            ),
          }),
        );
        void tick();
      }
    }
  } catch {
    console.error(
      "Pipeline worker could not start. Check PostgreSQL, private storage, Gateway configuration and the app migration.",
    );
    await close(1);
  }
}
await startWorker();
