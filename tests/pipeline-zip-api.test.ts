import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { createApp, createError, createRouter, toNodeListener } from "h3";
import { unzipSync } from "fflate";

const root = new URL("../", import.meta.url);
const key = "__pipelineZipApiTest";
const actor = { userId: "local-user", organizationId: "local-org" };
const mocks = new Map([
  [
    new URL("server/utils/useAuth.ts", root).href,
    `export const useAuth = async () => globalThis.${key}.auth();`,
  ],
  [
    new URL("server/utils/pipelineRepository.ts", root).href,
    `
        export const createPipelineRepository = actor => globalThis.${key}.repository(actor);
        export const pipelineRequestError = error => {throw error};`,
  ],
]);
registerHooks({
  load(url, context, nextLoad) {
    const source = mocks.get(url);
    return source
      ? { format: "module", shortCircuit: true, source }
      : nextLoad(url, context);
  },
});
const download = (
  await import("../server/api/pipeline-runs/[id]/download.get.ts")
).default;
const runId = "7417b007-204e-4e4e-9170-e9b32f808db3";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(
  work: (env: ReturnType<typeof environment>, base: string) => Promise<void>,
) {
  const env = environment();
  (globalThis as Record<string, unknown>)[key] = env;
  const app = createApp(),
    router = createRouter();
  router.get("/api/pipeline-runs/:id/download", download);
  app.use(router);
  const server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await work(env, `http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    Reflect.deleteProperty(globalThis, key);
  }
}
function environment() {
  const env = {
    authenticated: true,
    held: false,
    scopes: [] as unknown[],
    loaded: [] as string[],
    checks: [] as string[],
    metadata: [] as string[],
    images: Array.from({ length: 12 }, (_, index) => ({
      url: `/images/output/private-${index}.png`,
      name: `Picture ${index}.png`,
    })),
    async auth() {
      if (!env.authenticated)
        throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
      return actor;
    },
    repository(account: unknown) {
      env.scopes.push(account);
      return {
        async detail(id: string) {
          if (id !== runId)
            throw createError({
              statusCode: 404,
              statusMessage: "Pipeline run not found",
            });
          return {
            id,
            targetNodeId: null,
            definition: { nodes: [{ id: "final", type: "output" }] },
            items: [
              {
                steps: [
                  {
                    nodeId: "unpriced-intermediate",
                    value: {
                      images: [
                        {
                          url: "/images/output/unpriced.png",
                          name: "Held result",
                        },
                      ],
                    },
                  },
                  {
                    nodeId: "final",
                    value: env.held ? null : { images: env.images },
                  },
                ],
              },
            ],
          };
        },
        async storage() {
          return {
            async assetByUrl(url: string) {
              env.metadata.push(url);
              assert.ok(env.images.some((image) => image.url === url));
              // AssetFile's public metadata property is bytes. The
              // registry's private byteSize column is not exposed.
              return { url, bytes: png.byteLength };
            },
            async getImageFile(url: string) {
              env.loaded.push(url);
              return { buffer: Buffer.from(png), mimeType: "image/png" };
            },
            async assertReadableImages(urls: string[]) {
              env.checks.push(...urls);
            },
          };
        },
      };
    },
  };
  return env;
}

test("private ZIP route uses public byte metadata and streams more than ten small confirmed final outputs", async () =>
  fixture(async (env, base) => {
    const response = await fetch(`${base}/api/pipeline-runs/${runId}/download`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "Cookie");
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      response.headers.get("content-disposition"),
      `attachment; filename="pipeline-${runId}.zip"`,
    );
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    assert.equal(Object.keys(files).length, 12);
    for (const bytes of Object.values(files))
      assert.deepEqual(Buffer.from(bytes), png);
    assert.deepEqual(env.scopes, [actor]);
    assert.deepEqual(
      env.loaded,
      env.images.map((image) => image.url),
    );
    assert.deepEqual(env.checks, env.loaded);
    assert.ok(!env.metadata.includes("/images/output/unpriced.png"));
  }));

test("unauthenticated, foreign and unpriced ZIP requests never load a private image and keep private headers", async () =>
  fixture(async (env, base) => {
    env.authenticated = false;
    const unauthenticated = await fetch(
      `${base}/api/pipeline-runs/${runId}/download`,
    );
    assert.equal(unauthenticated.status, 401);
    assert.equal(
      unauthenticated.headers.get("cache-control"),
      "private, no-store",
    );
    assert.equal(unauthenticated.headers.get("vary"), "Cookie");
    env.authenticated = true;
    const foreign = await fetch(`${base}/api/pipeline-runs/foreigner/download`);
    assert.equal(foreign.status, 404);
    env.held = true;
    const unpriced = await fetch(`${base}/api/pipeline-runs/${runId}/download`);
    assert.equal(unpriced.status, 404);
    assert.equal(unpriced.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(env.loaded, []);
    assert.deepEqual(env.metadata, []);
  }));
