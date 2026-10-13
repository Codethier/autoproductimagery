// These replace Nuxt auto-imports when account-bound services are bundled for
// the dedicated worker. Values remain server environment secrets, never code.
export { createError } from "h3";
export { useFS } from "../server/utils/useFS";
export function useRuntimeConfig() {
  const bounded = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= min
      ? Math.min(max, Math.floor(value))
      : fallback;
  };
  return {
    AiGatewayApiKey: process.env.NUXT_AI_GATEWAY_API_KEY ?? "",
    imageGenerationConcurrency: bounded(
      "NUXT_IMAGE_GENERATION_CONCURRENCY",
      3,
      1,
      10,
    ),
    imageGenerationMaxQueue: bounded(
      "NUXT_IMAGE_GENERATION_MAX_QUEUE",
      25,
      0,
      100,
    ),
    imageGenerationTimeoutMs: bounded(
      "NUXT_IMAGE_GENERATION_TIMEOUT_MS",
      180_000,
      1000,
      600_000,
    ),
    imageGenerationStaleTtlMs: bounded(
      "NUXT_IMAGE_GENERATION_STALE_TTL_MS",
      15 * 60_000,
      60_000,
      24 * 60 * 60_000,
    ),
    imageGenerationRequestTimeoutMs: bounded(
      "NUXT_IMAGE_GENERATION_REQUEST_TIMEOUT_MS",
      270_000,
      1000,
      900_000,
    ),
  };
}
