import { defineEventHandler, getRouterParam, setHeader, sendStream } from "h3";
import { useAuth } from "../../../utils/useAuth";
import {
  createPipelineRepository,
  pipelineRequestError,
} from "../../../utils/pipelineRepository";
import { privatePipelineResponse } from "../../../utils/pipelineRequests";
import {
  createPipelineZip,
  validatePipelineZipEntries,
  type PipelineZipEntry,
} from "../../../utils/pipelineZip";

export default defineEventHandler(async (event) => {
  privatePipelineResponse(event);
  try {
    const actor = await useAuth(event),
      repository = createPipelineRepository(actor);
    const run = await repository.detail(getRouterParam(event, "id") ?? "");
    const selected = run.targetNodeId
      ? [run.targetNodeId]
      : run.definition.nodes
          .filter((node) => node.type === "output")
          .map((node) => node.id);
    const urls = new Map<string, string>();
    for (const item of run.items)
      for (const step of item.steps.filter((value) =>
        selected.includes(value.nodeId),
      ))
        for (const image of step.value?.images ?? [])
          urls.set(image.url, image.name);
    const storage = await repository.storage(),
      entries: PipelineZipEntry[] = [];
    for (const [url, name] of urls) {
      const asset = await storage.assetByUrl(url);
      entries.push({ url, name, bytes: asset.bytes ?? undefined });
    }
    validatePipelineZipEntries(entries);
    const controller = new AbortController();
    const disconnected = () => {
      if (!event.node.res.writableFinished) controller.abort();
    };
    event.node.res.once("close", disconnected);
    const stream = createPipelineZip(
      entries,
      async (url) => {
        const image = await storage.getImageFile(url);
        await storage.assertReadableImages([url]);
        return image;
      },
      controller.signal,
    );
    setHeader(event, "content-type", "application/zip");
    setHeader(
      event,
      "content-disposition",
      `attachment; filename="pipeline-${run.id}.zip"`,
    );
    setHeader(event, "x-content-type-options", "nosniff");
    try {
      return await sendStream(event, stream);
    } finally {
      event.node.res.removeListener("close", disconnected);
    }
  } catch (error) {
    return pipelineRequestError(error);
  }
});
