import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import {
  createPipelineZip,
  validatePipelineZipEntries,
  PIPELINE_ZIP_LIMITS,
} from "../server/utils/pipelineZip.ts";

const url = "/images/output/source.png";
async function collect(stream: ReturnType<typeof createPipelineZip>) {
  const values: Buffer[] = [];
  for await (const chunk of stream) values.push(Buffer.from(chunk));
  return Buffer.concat(values);
}
test("pipeline ZIP preserves originals, streams one source at a time and sanitizes entry names", async () => {
  const source = Buffer.alloc(512 * 1024, 7),
    seen: string[] = [];
  const entries = [
    { url, name: "../../private/CON.png", bytes: source.length },
    {
      url: "/images/output/second.png",
      name: "Second.png",
      bytes: source.length,
    },
  ];
  const zipped = await collect(
    createPipelineZip(entries, async (value) => {
      seen.push(value);
      return { buffer: Buffer.from(source), mimeType: "image/png" };
    }),
  );
  const decoded = unzipSync(zipped),
    names = Object.keys(decoded);
  assert.equal(names.length, 2);
  assert.ok(
    names.every(
      (name) =>
        !name.includes("/") && !name.includes("\\") && !name.startsWith("."),
    ),
  );
  assert.deepEqual(Buffer.from(decoded[names[0]!]!), source);
  assert.deepEqual(Buffer.from(decoded[names[1]!]!), source);
  assert.deepEqual(
    seen,
    entries.map((entry) => entry.url),
  );
  assert.equal(
    zipped.length,
    source.length * 2 +
      22 +
      names.reduce(
        (total, name) => total + 92 + 2 * Buffer.byteLength(name),
        0,
      ),
  );
});
test("ZIP admission bounds original byte totals, count, private paths and concurrent streams", async () => {
  assert.throws(() => validatePipelineZipEntries([]), { statusCode: 404 });
  assert.throws(
    () =>
      validatePipelineZipEntries(Array(201).fill({ url, name: "x", bytes: 1 })),
    { statusCode: 413 },
  );
  assert.throws(
    () =>
      validatePipelineZipEntries(
        Array(11).fill({ url, name: "x", bytes: 25 * 1024 * 1024 }),
      ),
    { statusCode: 413 },
  );
  assert.throws(
    () =>
      validatePipelineZipEntries([
        { url: "https://example.com/p.png", name: "x", bytes: 1 },
      ]),
    { statusCode: 400 },
  );
  const load = async () => ({
    buffer: Buffer.from([1]),
    mimeType: "image/png",
  });
  const streams = Array.from({ length: PIPELINE_ZIP_LIMITS.concurrency }, () =>
    createPipelineZip([{ url, name: "x", bytes: 1 }], load),
  );
  assert.throws(() => createPipelineZip([{ url, name: "x", bytes: 1 }], load), {
    statusCode: 429,
  });
  for (const stream of streams) stream.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  await collect(createPipelineZip([{ url, name: "x", bytes: 1 }], load));
});
test("ZIP admission includes headers and UTF-8 names in the 256 MiB boundary", async () => {
  const entries = Array.from({ length: 11 }, () => ({
    url,
    name: "x.png",
    bytes: 25 * 1024 * 1024,
  }));
  const overhead =
    22 + entries.length * (92 + 2 * Buffer.byteLength("image-001-x.webp"));
  entries[10]!.bytes =
    PIPELINE_ZIP_LIMITS.bytes - 10 * 25 * 1024 * 1024 - overhead;
  assert.doesNotThrow(() => validatePipelineZipEntries(entries));
  entries[10]!.bytes++;
  assert.throws(() => validatePipelineZipEntries(entries), { statusCode: 413 });

  // The boundary truncates this last emoji's UTF-16 pair. The archive must
  // still encode a valid filename and preserve its exact stored image bytes.
  const name = `${"📷".repeat(39)}a📷.png`,
    source = Buffer.from([1]);
  const zipped = await collect(
    createPipelineZip([{ url, name, bytes: source.length }], async () => ({
      buffer: source,
      mimeType: "image/webp",
    })),
  );
  const decoded = unzipSync(zipped),
    [actualName] = Object.keys(decoded);
  assert.ok(actualName);
  assert.deepEqual(Buffer.from(decoded[actualName!]!), source);
  assert.equal(
    zipped.length,
    source.length + 22 + 92 + 2 * Buffer.byteLength(actualName!),
  );
});
test("revoked source, changed bytes or cancellation abort the archive without exposing diagnostics", async () => {
  let reads = 0;
  await assert.rejects(
    collect(
      createPipelineZip(
        [
          { url, name: "first", bytes: 1 },
          { url: "/images/output/revoked.png", name: "second", bytes: 1 },
        ],
        async () => {
          if (++reads === 2)
            throw Error("s3 secret, cookie, C:\\private\\file");
          return { buffer: Buffer.from([1]), mimeType: "image/png" };
        },
      ),
    ),
    (error) => {
      assert.equal((error as { statusCode: number }).statusCode, 503);
      assert.doesNotMatch(String(error), /s3 secret|cookie|C:\\private/);
      return true;
    },
  );
  await assert.rejects(
    collect(
      createPipelineZip([{ url, name: "changed", bytes: 1 }], async () => ({
        buffer: Buffer.from([1, 2]),
        mimeType: "image/png",
      })),
    ),
    { statusCode: 503 },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collect(
      createPipelineZip(
        [{ url, name: "cancelled", bytes: 1 }],
        async () => ({ buffer: Buffer.from([1]), mimeType: "image/png" }),
        controller.signal,
      ),
    ),
    { statusCode: 499 },
  );
});
