# AI Product Image Generator

## Product scope

- This is an image-only product imagery application. Prompts are text, and all uploaded/reference/mask/generated media must be validated image files.
- PDF, video, audio, arbitrary files, and public media URLs are intentionally out of scope. Do not advertise or partially implement those model capabilities.
- Each selected product image creates an independent generation job. Shared reference images may be attached to each job subject to that model's limits.

## Stack and integration boundaries

- Framework: Nuxt 4 on Node 26.
- ORM/database: Drizzle with local SQLite/libSQL.
- All AI calls must use Vercel AI SDK through Vercel AI Gateway. Do not add direct provider SDK/API calls.
- Curated image-model profiles and their runtime schemas live in `schemas/image-generation.ts`. Exact model IDs and discriminated settings—not names, descriptions, or regex heuristics—must choose adapters and capabilities.
- Keep the curated provider scope to OpenAI and Google Gemini image models unless the user explicitly expands it.

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
