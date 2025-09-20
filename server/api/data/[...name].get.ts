import fs from "fs";
import path from "node:path";
import { createError } from "h3";

export default defineEventHandler(async (event) => {
  const base = "data";
  const params = event.context.params as { name?: string | string[] } | undefined;
  if (!params || params.name == null) {
    throw createError({ statusCode: 400, statusMessage: "Missing path parameter 'name'" });
  }

  const rawSegments = Array.isArray(params.name) ? params.name : [params.name];

  // Decode each URL segment to handle spaces and special characters
  const decodedSegments = rawSegments.map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      // If decoding fails, fall back to the original segment
      return seg;
    }
  });

  // Join segments using POSIX-style separator, then normalize with path utilities
  const joined = decodedSegments.join("/");

  // Prevent path traversal and ensure the resolved path stays within the base directory
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(base, joined.replace(/^[/\\]+/, ""));
  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw createError({ statusCode: 400, statusMessage: "Invalid path" });
  }

  // Stream the file if it exists; otherwise return 404
  try {
    await fs.promises.access(resolvedTarget, fs.constants.R_OK);
  } catch {
    throw createError({ statusCode: 404, statusMessage: "File not found" });
  }

  return sendStream(event, fs.createReadStream(resolvedTarget));
});