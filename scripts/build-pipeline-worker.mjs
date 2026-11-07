import { build } from "esbuild";
import { resolve } from "node:path";

await build({
  entryPoints: ["scripts/pipeline-worker.ts"],
  outfile: ".output/pipeline-worker.mjs",
  bundle: true,
  platform: "node",
  target: "node26",
  format: "esm",
  packages: "external",
  sourcemap: false,
  alias: { "~~": resolve(".") },
  inject: ["scripts/pipeline-worker-runtime.ts"],
});
