import fs from "fs";
import path from "node:path";
import { createError } from "h3";

export default defineEventHandler(async (event) => {
  useAuth(event);

  const base = "data";
  const allowed = path.join("data", "images");
  const params = event.context.params as { name?: string | string[] } | undefined;
  if (!params || params.name == null) {
    throw createError({ statusCode: 400, statusMessage: "Missing path parameter 'name'" });
  }

  const rawSegments = Array.isArray(params.name) ? params.name : [params.name];

  const decodedSegments = rawSegments.map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });

  const joined = decodedSegments.join("/");

  const resolvedAllowed = path.resolve(allowed);
  const resolvedTarget = path.resolve(base, joined.replace(/^[/\\]+/, ""));
  if (!resolvedTarget.startsWith(resolvedAllowed + path.sep)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid path" });
  }

  try {
    const stat = await fs.promises.stat(resolvedTarget);
    if (!stat.isFile()) {
      throw createError({ statusCode: 404, statusMessage: "File not found" });
    }
  } catch {
    throw createError({ statusCode: 404, statusMessage: "File not found" });
  }

  return sendStream(event, fs.createReadStream(resolvedTarget));
});
