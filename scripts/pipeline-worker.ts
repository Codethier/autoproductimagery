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
  hasPendingPipelineWorkerWork,
} from "../server/utils/pipelineRunner";
import { createPipelineWorkerLoop } from "../server/utils/pipelineWorkerLoop";
import { createPipelineNotifications } from "../server/utils/pipelineNotifications";
import {createPipelineWorkerScheduler} from '../server/utils/pipelineWorkerScheduler';
import {getPipelineWorkerWakeConfig, pipelineWorkerWakeToken} from '../server/utils/pipelineWorkerWake';
import {createPipelineWorkerHttpHandler} from '../server/utils/pipelineWorkerHttp';
import { useRuntimeConfig } from "./pipeline-worker-runtime";

const runtimeConfig = useRuntimeConfig();
const requestedConcurrency = Number(
  process.env.PIPELINE_WORKER_CONCURRENCY ?? 2,
);
const concurrency = Number.isFinite(requestedConcurrency)
  ? Math.max(1, Math.min(3, Math.floor(requestedConcurrency)))
  : 2;
const port = Number(
  process.env.PORT ?? process.env.PIPELINE_WORKER_PORT ?? ((process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_PROJECT_ID) ? 8080 : 3221),
);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw Error("Invalid pipeline worker port");
// Railway's private DNS is IPv6. Node's unspecified IPv6 listener also accepts
// IPv4 connections, including Railway's public health proxy.
const host = process.env.PIPELINE_WORKER_HOST ?? "::";
const serverless = Boolean(getPipelineWorkerWakeConfig());
const wakeToken = pipelineWorkerWakeToken();
const pool = getDatabasePool();
// LISTEN holds a connection. A one-connection deployment uses durable polling
// instead, leaving its only connection available for claims and progress.
const notificationsEnabled = (getDatabasePoolConfig().max ?? 3) > 1;
let closing = false,
  ready = false;
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
    if (!closing && ready) void scheduler.wake();
  },
  unavailable: () =>
    console.error(
      "Pipeline notifications are temporarily unavailable; saved work will be checked again while active.",
    ),
});

const scheduler = createPipelineWorkerScheduler({
  serverless,
  connect: () => notificationsEnabled ? notifications.connect() : Promise.resolve(false),
  // Both bounded runners are awaited; idle inference children are shut down
  // before releasing LISTEN and allowing the database/service to sleep.
  drain: async () => {await Promise.all([worker.kick(), kickBackgroundRemovalQueue()]);},
  pending: hasPendingPipelineWorkerWork,
  disconnect: async () => {
    await Promise.all([notifications.disconnect(), closeBackgroundRemovalQueue()]);
    closeImageStorage();
  },
  error: () => console.error('Pipeline worker connection is temporarily unavailable; saved work will be checked again.'),
});
const server = createServer(createPipelineWorkerHttpHandler({
  ready: () => ready && !closing,
  token: wakeToken,
  wake: () => {void scheduler.wake();},
}));
server.headersTimeout = 5000;
server.requestTimeout = 5000;
server.maxHeadersCount = 20;
server.on("error", () => {
  console.error("Pipeline worker health listener could not start.");
  void close(1);
});

async function close(code = 0) {
  if (closing) return;
  closing = true;
  ready = false;
  // Active Gateway work is aborted and awaited. Its persisted paid-start
  // fence survives a forced shutdown, so a replacement cannot blindly retry.
  const deadline = setTimeout(() => process.exit(code || 1), 45_000);
  try {
    await Promise.all([
      notifications.close(),
      scheduler.close(),
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
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await verifyBackgroundRemovalRuntime();
    if (closing) return;
    console.info("Pipeline worker CPU runtime verified");
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
      if (!closing) {
        ready = true;
        console.info(
          JSON.stringify({
            component: "pipeline-worker",
            status: "ready",
            concurrency,
            notificationsEnabled,
            serverless,
            availableMemoryGiB: Number(
              (process.availableMemory() / 1024 ** 3).toFixed(2),
            ),
            memoryLimitGiB: Number(
              (process.constrainedMemory() / 1024 ** 3).toFixed(2),
            ),
          }),
        );
        void scheduler.wake();
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
