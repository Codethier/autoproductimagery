import { Readable } from "node:stream";
import { Zip, ZipPassThrough } from "fflate";
import { createError } from "h3";
import { ImagePathSchema } from "../../schemas/image-generation";
import { MAX_STORED_IMAGE_BYTES } from "./imageValidation";

export const PIPELINE_ZIP_LIMITS = {
  files: 200,
  bytes: 256 * 1024 * 1024,
  concurrency: 2,
  timeoutMs: 180_000,
} as const;
export type PipelineZipEntry = { url: string; name: string; bytes?: number };
type Loader = (url: string) => Promise<{ buffer: Buffer; mimeType: string }>;
let activeArchives = 0;
const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
};

export function validatePipelineZipEntries(entries: PipelineZipEntry[]) {
  if (!entries.length)
    throw createError({
      statusCode: 404,
      statusMessage: "No confirmed pipeline output pictures are available",
    });
  if (entries.length > PIPELINE_ZIP_LIMITS.files)
    throw createError({
      statusCode: 413,
      statusMessage: "Download at most 200 pictures in one archive",
    });
  // Stored entries have a local header, data descriptor, and central-directory
  // record. Reserve the longest supported extension before loading any bytes.
  let total = 22;
  for (const [index, entry] of entries.entries()) {
    if (!ImagePathSchema.safeParse(entry.url).success)
      throw createError({
        statusCode: 400,
        statusMessage: "Invalid private image path",
      });
    const bytes = entry.bytes ?? MAX_STORED_IMAGE_BYTES;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > MAX_STORED_IMAGE_BYTES
    )
      throw createError({
        statusCode: 413,
        statusMessage: "A pipeline output exceeds the image download limit",
      });
    total +=
      bytes +
      92 +
      2 * Buffer.byteLength(archiveName(entry, index, "image/webp"));
  }
  if (total > PIPELINE_ZIP_LIMITS.bytes)
    throw createError({
      statusCode: 413,
      statusMessage:
        "This archive exceeds 256 MiB; download its pictures individually",
    });
}
function archiveName(entry: PipelineZipEntry, index: number, mimeType: string) {
  const extension = extensions[mimeType];
  if (!extension)
    throw createError({
      statusCode: 415,
      statusMessage: "Only validated image files can be archived",
    });
  const sanitizedStem =
    entry.name
      .replace(/\.[^.]*$/, "")
      .normalize("NFC")
      .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "-")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 80) || "picture";
  // A length limit may cut a UTF-16 surrogate pair. Normalize it to valid UTF-8
  // so admission and fflate agree on the actual filename byte length.
  const stem = Buffer.from(sanitizedStem).toString("utf8");
  return `image-${String(index + 1).padStart(3, "0")}-${stem.replace(/[. ]+$/, "")}.${extension}`;
}

/** Original bytes, one image at a time, with bounded stream backpressure. */
export function createPipelineZip(
  entries: PipelineZipEntry[],
  load: Loader,
  externalSignal?: AbortSignal,
) {
  validatePipelineZipEntries(entries);
  if (activeArchives >= PIPELINE_ZIP_LIMITS.concurrency)
    throw createError({
      statusCode: 429,
      statusMessage: "Image archive downloads are busy; try again shortly",
    });
  activeArchives++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      activeArchives--;
    }
  };
  const signal = externalSignal
    ? AbortSignal.any([
        externalSignal,
        AbortSignal.timeout(PIPELINE_ZIP_LIMITS.timeoutMs),
      ])
    : AbortSignal.timeout(PIPELINE_ZIP_LIMITS.timeoutMs);
  async function* chunks() {
    let queue: Uint8Array[] = [];
    let zipError = false,
      bytes = 0,
      wireBytes = 0;
    const zip = new Zip((error, data) => {
      if (error) zipError = true;
      else if (data.length) {
        wireBytes += data.length;
        if (wireBytes > PIPELINE_ZIP_LIMITS.bytes) zipError = true;
        else queue.push(data);
      }
    });
    try {
      for (const [index, entry] of entries.entries()) {
        signal.throwIfAborted();
        const file = await load(entry.url);
        signal.throwIfAborted();
        if (
          file.buffer.byteLength > MAX_STORED_IMAGE_BYTES ||
          file.buffer.byteLength === 0 ||
          (entry.bytes !== undefined && file.buffer.byteLength !== entry.bytes)
        )
          throw Error("Image download changed");
        bytes += file.buffer.byteLength;
        if (bytes > PIPELINE_ZIP_LIMITS.bytes)
          throw Error("Image archive limit exceeded");
        const output = new ZipPassThrough(
          archiveName(entry, index, file.mimeType),
        );
        output.mtime = new Date("1980-01-01T00:00:00Z");
        zip.add(output);
        while (queue.length) yield queue.shift()!;
        for (
          let offset = 0;
          offset < file.buffer.byteLength;
          offset += 64 * 1024
        ) {
          signal.throwIfAborted();
          const end = Math.min(offset + 64 * 1024, file.buffer.byteLength);
          output.push(
            file.buffer.subarray(offset, end),
            end === file.buffer.byteLength,
          );
          if (zipError) throw Error("Image archive failed");
          while (queue.length) yield queue.shift()!;
        }
        file.buffer = Buffer.alloc(0);
      }
      zip.end();
      if (zipError) throw Error("Image archive failed");
      while (queue.length) yield queue.shift()!;
    } catch {
      throw createError({
        statusCode: 503,
        statusMessage:
          "The private image archive could not finish. Refresh the run and try again.",
      });
    } finally {
      zip.terminate();
      queue = [];
      release();
    }
  }
  const stream = Readable.from(chunks(), {
    objectMode: false,
    highWaterMark: 64 * 1024,
  });
  const abort = () =>
    stream.destroy(
      createError({
        statusCode: 499,
        statusMessage: "Image archive download was cancelled",
      }),
    );
  signal.addEventListener("abort", abort, { once: true });
  stream.once("close", () => {
    signal.removeEventListener("abort", abort);
    release();
  });
  stream.on("error", () => {});
  if (signal.aborted) abort();
  return stream;
}
