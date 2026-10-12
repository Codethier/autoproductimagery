# AI Product Image Generator

Generate product imagery through Vercel AI Gateway, using independent jobs for each selected product image and optional shared reference images or masks.

![Example generated image](public/examples/image2.png)

## Storage and runtime

- Uploaded and generated images are validated raster images in a **private S3-compatible bucket**. Railway Storage Buckets are supported.
- PostgreSQL stores generation history, exact replay settings, output dimensions/MIME/bytes, billing, attempt diagnostics, and coordination leases.
- The Nuxt app needs no persistent disk or app volume. Warm instances share PostgreSQL and S3; a fresh instance can serve images and replay stored generations.
- Authenticated image routes proxy private objects through `/api/data/images/...`. Bucket credentials and object URLs are never sent to the browser.
- Folder markers preserve empty folders. File listings use bounded cursor pagination; the file browser loads more pages on demand. Concurrent uploads use conditional object creation rather than overwriting a same-name image.
- Generation admission, running limits, job ownership, and login throttling are coordinated across instances. Provider work is awaited within the request, with abortable timeouts and durable recovery of abandoned pending rows.

This is an image-only application. PDF, video, audio, arbitrary file uploads, and external media URLs are unsupported. All AI requests use the Vercel AI SDK through Vercel AI Gateway.

## Requirements and configuration

Use Node.js 26.x, PostgreSQL, a private S3-compatible bucket, and a Vercel AI Gateway key. Copy `.env.example` to an ignored `.env` and fill in the server credentials:

```env
NUXT_AI_GATEWAY_API_KEY=
NUXT_AUTH_USER=
NUXT_AUTH_PASSWORD=
NUXT_AUTH_SESSION_SECRET=
DATABASE_URL=postgresql://localhost:5432/autoproductimagery
DATABASE_POOL_MAX=3
S3_ENDPOINT=https://t3.storageapi.dev
S3_REGION=auto
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_PREFIX=images
S3_FORCE_PATH_STYLE=false
```

Set a strong login password and a separate random session secret of at least 32 characters. Every app instance must use the same credentials and signing secret. Changing either invalidates existing sessions. Cookies are expiring, signed, `HttpOnly`, `SameSite`, and secure under HTTPS/production.

Railway buckets use virtual-host addressing, so `S3_FORCE_PATH_STYLE=false` is appropriate for Railway. Use the bucket's **base endpoint** and its S3 bucket name from the Credentials tab. The bucket's display name and S3 bucket name can differ. Other S3 services may require path addressing. Objects remain under `S3_PREFIX`; do not point unrelated applications at the same prefix.

Inside Railway, reference the bucket and database variables on the app service instead of copying credentials. For resources named `images-dev` and `Postgres`:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
S3_ENDPOINT=${{images-dev.ENDPOINT}}
S3_BUCKET=${{images-dev.BUCKET}}
S3_REGION=${{images-dev.REGION}}
S3_ACCESS_KEY_ID=${{images-dev.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{images-dev.SECRET_ACCESS_KEY}}
```

The app uses a small PostgreSQL connection pool (`DATABASE_POOL_MAX`, default 3, maximum 10) with bounded connection/query/idle timeouts. For many function instances, use a compatible database connection pooler and account for total instance connections. Outside Railway's private network, use a TLS connection URL with certificate verification or set `DATABASE_SSL=true` and, if needed, `DATABASE_CA_CERT` to a trusted PEM certificate (`\n` escapes are accepted). The runtime rejects `sslmode=no-verify` and never disables certificate verification. Railway's private network URL does not need a public TCP proxy.

## Development and verification

```sh
npm ci
npm run drizzle:migrate
npm run dev
```

Migrations require an explicitly configured PostgreSQL `DATABASE_URL`; SQLite URLs are rejected. Run migrations once against the intended development database before starting the app. They never run on app cold starts.

```sh
npm test
npx nuxi typecheck
npm run build
npx drizzle-kit check
git diff --check
```

Set `TEST_DATABASE_URL` and `PG_TEST_DATABASE_URL` to a **disposable PostgreSQL database** to run the database and cross-instance integration tests as well. Those tests create isolated schemas and fake provider transports; they do not make paid image-generation calls.

## Serverless deployment

Railway's sleeping/serverless app mode is supported: the app uses shared S3/PostgreSQL state and does not mount an image or SQLite volume. Build from the repository root with `npm run build`, then start with `node .output/server/index.mjs`. Apply migrations as a separate, explicit deployment step, rather than from the start command or every incoming request.

Keep `railpack.json`: Node 26 requires `libatomic1` in both the build and final runtime image. It uses explicit Apt package names compatible with Railpack 0.23.0. Verify the final runtime as well as the build.

The default provider timeout is 180 seconds. `NUXT_IMAGE_GENERATION_REQUEST_TIMEOUT_MS` defaults to 270 seconds and limits queue waits and provider work. Already-returned provider outputs are still persisted through bounded S3/database operations before the handler returns. Set the host's maximum request duration above the provider-work budget **plus the output-persistence margin**, or lower the configured budget and batch size. This requires a Node serverless runtime with enough execution time for image generation; edge-only runtimes and short-duration functions are unsupported.

Expired worker leases permit conservative pending-job recovery on subsequent requests. A paid call that fails or exceeds its deadline is recorded as retryable when appropriate; completed siblings remain successful. A hard process kill between an S3 write and database persistence can leave an orphan object for later operational cleanup.

## Migrations and existing local data

Drizzle ORM and Kit stay pinned to `1.0.0-rc.4`. The PostgreSQL schema lives in `server/db/schema.ts`; its generated SQL and snapshots live in `drizzle/postgres/`. The earlier SQLite migration folders under `drizzle/` are retained intact as historical archives, and are not applied to PostgreSQL.

Change the schema, then generate and review migrations:

```sh
npm run drizzle:generate -- --name=describe_the_change
npx drizzle-kit check
npm run drizzle:migrate
```

Never hand-edit generated SQL/snapshots or use `drizzle-kit push`. Test a migration on a disposable database before applying it to the intended environment. `drizzle:up` is an explicit migration-format upgrade tool, not a startup command.

Existing local images and SQLite databases are preserved by this refactor. The explicit import tools support moving them to a development target while keeping historical `/images/...` paths and stored replay settings. Review their dry-run reports first; they do not run automatically. Production migration/import/deployment requires separate authorization and confirmation of the exact action.

Read-only inventory and validation:

```sh
node --import ./tests/register-typescript.mjs scripts/import-local-images.ts --source ./data/images --dry-run
node --import ./tests/register-typescript.mjs scripts/import-sqlite-to-postgres.ts --sqlite=./sqlite/drizzle.db --dry-run
```

To apply to an empty development target, first configure the development bucket credentials, set `APP_ENV=development`, and run the image importer with `--confirm-development` instead of `--dry-run`. Then set `IMPORT_DATABASE_URL` explicitly and run the database importer with `--apply --environment=development`. The image importer preserves paths, validates content, resumes identical existing objects, and refuses conflicting overwrites. The database importer preserves IDs, JSON, timestamps, billing, and log relationships transactionally, and refuses a populated generation/history target.

The local `private-agents.md` stores the selected Railway project/development IDs and is ignored. Real `.env` files, databases, and `.codex/artifacts/` reports are also ignored; `.env.example` contains no credentials.
