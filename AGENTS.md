# AI Product Image Generator

## Product scope

- This is an image-only product imagery application. Prompts are text, and all uploaded/reference/mask/generated media must be validated image files.
- PDF, video, audio, arbitrary files, and public media URLs are intentionally out of scope. Do not advertise or partially implement those model capabilities.
- Each selected product image creates an independent generation job. Shared reference images may be attached to each job subject to that model's limits.
- When the user says "add new models", check the entire current Vercel AI Gateway catalog across ALL providers and official provider documentation, then add every missing model that accepts BOTH text prompts AND uploaded images and produces images. Do not restrict discovery to OpenAI/Google or to recently released models. Image understanding with text-only output and text-to-image-only models do not qualify.
- For each "add new models" pass that adds models, show a visible "New" tag in the model selector for every model added in that pass. Replace the previous pass's "New" tags so only the latest additions carry the tag. Track this with explicit per-model metadata, separate from lifecycle labels such as recommended/current/legacy; do not infer it from model names or provider release dates. If the pass adds no models, leave the existing tags unchanged. Keep model-addition pass metadata in `schemas/image-model-discovery.ts`; use a unique pass identifier, including a suffix when multiple passes happen on the same date.
- Order the model selector with user favourites first, then models tagged "New", then the remaining models. Preserve curated order within each group. Provide an accessible heart toggle for favourites and persist those choices across reloads. Model-refresh passes must preserve user favourites; marking or unmarking a favourite must not change the selected model or its settings.
- Complete each model addition through the exact-ID profile, strict settings schema, selector/settings UI, Gateway adapter, reference/mask validation, output accounting, stored settings/replay, and regression coverage. Verify actual image-edit/reference support in official documentation; catalog modality metadata alone can omit image inputs. Keep unavailable models clearly marked, and report eligible models that Gateway cannot yet serve. This shorthand does not authorize production deployment.

## Stack and integration boundaries

- Framework: Nuxt 4 on Node 26.
- Railpack must install `libatomic1` in both the build and final runtime image through `railpack.json`. Node 26 requires `libatomic.so.1` on Linux. Deployment checks must verify the final runtime's shared libraries; a successful build alone is insufficient.
- Coolify currently uses Railpack 0.23.0. Use explicit Apt package names in `railpack.json`; do not use the `"..."` list-extension syntax from newer Railpack documentation, because this version can pass it literally to `apt-get`. Check configuration compatibility against the deployed Railpack version.
- ORM/database: Drizzle with local SQLite/libSQL.
- All AI calls must use Vercel AI SDK through Vercel AI Gateway. Do not add direct provider SDK/API calls.
- Curated image-model profiles and their runtime schemas live in `schemas/image-generation.ts` and `schemas/catalog-image-models.ts`. Record the catalog audit and exclusions in `docs/image-model-catalog.md`. Exact model IDs and discriminated settings—not names, descriptions, or regex heuristics—must choose adapters and capabilities.
- All Gateway providers are in scope. Keep an explicit, verified per-model whitelist and record exclusions when a catalog model cannot use uploaded pictures through Gateway or returns unsupported media such as SVG.

## Model settings and resolution

- Image resolution is not uniform across models. Never expose one generic size/aspect UI to every model.
- Each model profile must declare its own settings component, defaults, allowed aspect ratios/sizes, reference limits, tools, warnings, and adapter.
- The client derives controls from the selected profile, resets incompatible settings synchronously when the model changes, and never sends stale settings from another model family.
- Shared Zod schemas are the request boundary. The server must parse and enforce the selected profile even when the UI has already validated it; never restore `as any` forwarding of provider options.
- Persist the normalized requested/effective model and settings used for every generation. Regenerate/refine must replay the exact stored image sources and settings or clearly report that exact replay is unavailable.
- Record actual returned image MIME type, byte size, width, and height. Do not infer output dimensions from requested settings.

## Generation reliability

- Provider calls require a bounded timeout/abort signal and normalized, redacted, retryable timeout errors.
- Generation concurrency and queue depth are process-wide and bounded. Reject overload with an explicit `429`; never accumulate an unbounded queue of future paid calls.
- Create pending rows before provider work. Terminal state changes must be atomic and conditional on `status = 'pending'`; a failed sibling must never overwrite a successful output.
- Recover abandoned pending rows using a conservative stale timeout or durable lease/heartbeat. Process start time is not job ownership and must not be used to fail another worker's live job.
- Persist every provider output independently, release image buffers promptly, and clean up only the exact output file whose persistence failed.
- Capture bounded/redacted provider diagnostics, request IDs, attempt data, retryability, warnings, and billing for every attempt. Never expose credentials, image bytes/data URLs, cookies, absolute filesystem paths, or directory listings in API errors.

## Authentication and request safety

- Never store configured usernames/passwords or other server credentials in client-readable cookies or browser storage.
- Authenticate through a server endpoint and issue an opaque/signed, expiring `HttpOnly`, `SameSite` session cookie; use `Secure` in production/HTTPS and timing-safe comparisons for secrets/signatures.
- Parse multipart uploads as bounded streams; enforce request, file-count, per-file, aggregate-byte, and concurrent-upload limits during consumption. Do not reintroduce whole-body multipart parsers for large image uploads.
- Keep all image reads, writes, listings, and serving confined to the designated image root after resolving real paths. Reject symlinks/junctions/reparse points within managed image paths.
- Determine trusted image MIME/extension from successfully decoded content, not caller filenames or magic prefixes alone. Reject corrupt, truncated, arbitrary ISO-BMFF/video, and unsupported image payloads before storage.
- Login and other credential-verification endpoints require bounded, process-wide attempt throttling in addition to timing-safe comparison.

## Database and migrations

- NEVER hand-edit generated files under `drizzle/` or `drizzle/meta/`.
- Change `server/db/schema.ts`, then generate with `npm run drizzle:generate -- --name=<name>` and review the generated SQL.
- Test migrations on a disposable/local database before applying them. Use `npm run drizzle:migrate`; do not use `drizzle:push` for schema changes in this project.
- List/history endpoints must paginate in SQL and should not deserialize large per-generation metadata unless the caller requests details.

## Verification

- Add regression coverage for every model profile and settings discriminator, model switching, mask/source validation, timeouts, limiter overload/recovery, multi-output partial failures, pending-job recovery, auth sessions, upload limits, root confinement, and redacted errors.
- Before handing off changes, run `npm test`, `npx nuxi typecheck`, `npm run build`, `npx drizzle-kit check`, and `git diff --check` when applicable.
- Do not make paid generation calls during routine tests.

## Production safety — non-negotiable

- NEVER deploy, redeploy, promote, restart, roll back, or otherwise mutate any production environment unless the user explicitly asks and confirms the exact action.
- NEVER use Railway CLI/API/MCP or another deployment tool to change production without that explicit confirmation. In particular, never run `railway up` against production or upload a local working tree directly to a production service.
- Production migrations, database writes, environment-variable changes, service configuration changes, and destructive production operations are forbidden by default.
- Production access is read-only: inspect status/logs/metrics only when requested.
