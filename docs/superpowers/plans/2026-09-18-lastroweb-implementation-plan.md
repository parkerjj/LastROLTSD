# LastROWeb Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the LastROWeb Worker, D1 database, upload API, search API, and Vite web UI described by the design specification, with no OpenKore source-code changes.

**Architecture:** A Hono TypeScript Worker authenticates upload sources, validates a shared JSON contract, writes current market state and bounded history to D1, and serves the Vite-built static UI. Upload processing is source-scoped, idempotent by batch/part, uses canonical item fingerprints including structured options, and applies optimistic state versions for concurrent requests. The OpenKore adapter is an external consumer; this repository only documents and tests the HTTP contract with redacted JSON fixtures.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1/SQLite, Vite, Zod, Vitest, Wrangler, Playwright for browser smoke tests.

**Spec:** `docs/superpowers/specs/2026-09-18-lastroweb-design.md`

## Global Constraints

- Do not modify, import, compile, or vendor OpenKore source code; only maintain the HTTP contract and redacted JSON fixtures.
- Use Workers + Hono + D1 + Vite; do not introduce Java, Flutter, MySQL, PostgreSQL, Next.js, or a long-running Node server.
- All source state is isolated by authenticated `source_id`; never execute a global shop close operation.
- The first complete snapshot establishes a baseline and must not create sold events.
- A listing identity includes item ID, upgrade, slots, cards, sorted `(option_type, option_value, option_param)` tuples, and `item_key` when supplied.
- Upload requests use `Authorization: Bearer`, `Idempotency-Key`, a 512 KiB body limit, and at most 16 parts per snapshot.
- Search pages use keyset cursors and a maximum page size of 50; query values are bound parameters and sort fields are allowlisted.
- D1 writes use batch/bulk SQL; no unbounded N+1 query loops and no per-search D1 logging.
- Keep price history and sold events for 90 days by default; cleanup must be chunked and observable.
- Every task follows test-first order: write the focused failing test, run it, implement the smallest change, run the focused test and relevant suite, then commit.

---

## File Map

Create the following focused modules rather than a single Worker file:

```text
package.json                         # workspace scripts and package manager metadata
pnpm-workspace.yaml                  # apps/* and packages/* workspaces
tsconfig.base.json                   # strict shared TypeScript settings
wrangler.toml                         # Worker, D1, assets, migrations, environments
migrations/0001_initial.sql          # tables, foreign keys, CHECK constraints
migrations/0002_indexes.sql          # query and uniqueness indexes
migrations/0003_option_dictionary.sql # versioned LastRO option dictionary seed
packages/protocol/src/schema.ts      # Zod request/response contract
packages/protocol/src/types.ts       # inferred public types
packages/protocol/src/normalize.ts   # scalar and option normalization
packages/protocol/src/index.ts       # package exports
apps/worker/src/index.ts              # Hono app and static asset fallback
apps/worker/src/env.ts                # bindings and runtime configuration
apps/worker/src/middleware/*.ts       # auth, errors, cache, limits
apps/worker/src/domain/*.ts           # fingerprints and state transition rules
apps/worker/src/db/*.ts               # repository interfaces and D1 implementation
apps/worker/src/services/*.ts         # ingestion, reconciliation, cleanup
apps/worker/src/routes/*.ts           # health, upload, search, options, history
apps/web/index.html                   # Vite entry document
apps/web/src/*.ts                     # API client, state, rendering, controls
tests/fixtures/*.json                 # redacted protocol fixtures, never OpenKore code
tests/integration/*.test.ts            # D1-backed upload/search flows
tests/browser/*.spec.ts               # production UI smoke tests
scripts/check-docs.mjs                # API/design documentation contract check
docs/api.md                            # public API contract and examples
docs/deployment.md                     # Wrangler/D1/secrets/rollback runbook
README.md                              # project setup and scope
```

## Task 1: Workspace and Worker/Web Scaffolding

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- Create: `apps/worker/package.json`, `apps/worker/src/index.ts`, `apps/worker/src/env.ts`
- Create: `apps/web/package.json`, `apps/web/index.html`, `apps/web/src/main.ts`
- Create: `vitest.config.ts`, `playwright.config.ts`, `.gitignore`, `.dev.vars.example`
- Test: `apps/worker/test/health.test.ts`, `apps/web/test/build.test.ts`

**Interfaces:**
- Produces `createApp(env: AppEnv): Hono` and a `/api/health` route returning `{ok:true, version, db}`.
- Produces the Vite `dist` output consumed by Wrangler Workers Static Assets.

- [ ] **Step 1: Write the failing health and build tests.** Assert that the Hono app returns HTTP 200 with JSON keys `ok`, `version`, and `db`, and that a Vite production build emits `dist/index.html`.
- [ ] **Step 2: Run the focused tests to verify failure.** Run `pnpm vitest run apps/worker/test/health.test.ts apps/web/test/build.test.ts`; expect failure because the workspace and app entry points do not exist.
- [ ] **Step 3: Add the workspace configuration and minimal app entries.** Use strict TypeScript, ESM, Node-compatible test scripts, and `pnpm --filter` scripts. Keep the Worker entry free of database logic; return `db: "unconfigured"` until the D1 repository is added.
- [ ] **Step 4: Configure Wrangler assets and local dev.** Set `main = "apps/worker/src/index.ts"`, assets directory to `apps/web/dist`, compatibility date to the current project date, and separate `dev`/`staging`/`production` D1 database bindings without committing IDs or secrets.
- [ ] **Step 5: Run focused tests and a production build.** Run `pnpm vitest run apps/worker/test/health.test.ts apps/web/test/build.test.ts` and `pnpm --filter web build`; both must exit 0.
- [ ] **Step 6: Commit the scaffolding.** `git add package.json pnpm-workspace.yaml tsconfig.base.json wrangler.toml apps vitest.config.ts playwright.config.ts .gitignore .dev.vars.example && git commit -m "chore: scaffold LastROWeb workspace"`.

## Task 2: Shared Upload and Query Contract

**Files:**
- Create: `packages/protocol/src/schema.ts`, `packages/protocol/src/types.ts`, `packages/protocol/src/normalize.ts`, `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/schema.test.ts`, `packages/protocol/test/normalize.test.ts`
- Create: `tests/fixtures/full-upload.json`, `tests/fixtures/delta-upload.json`, `tests/fixtures/heartbeat-upload.json`
- Modify: `packages/protocol/package.json`

**Interfaces:**
- `parseUploadRequest(input: unknown): UploadRequest` throws a typed validation error.
- `normalizeOption(input: RawOption): NormalizedOption` returns integer `type`, `value`, and `param` fields.
- `normalizeItem(input: RawItem): NormalizedItem` fills `cards` to four integers and sorts options without mutating the caller object.
- `UploadRequest`, `UploadShop`, `UploadItem`, `ItemOption`, `SearchFilters`, `SearchPage<T>` are the shared public types.

- [ ] **Step 1: Write failing contract tests.** Cover a valid full payload, missing `snapshot_id`, invalid `part_index`, body item count limits, negative price/quantity, an option with non-integer fields, and unknown `snapshot_mode`. Assert the fixture contains no `source_id` trust field requirement.
- [ ] **Step 2: Run the protocol tests to verify failure.** Run `pnpm vitest run packages/protocol/test`; expect missing schema/normalizer failures.
- [ ] **Step 3: Implement Zod schemas.** Enforce protocol version 1, ISO timestamp parsing, `part_count` 1..16, `part_index` in range, `shops_seen` string limits, item text limits, at most four cards, and a bounded options array. Strip unknown fields only after validation and never accept client `source_id` as an authority field.
- [ ] **Step 4: Implement deterministic normalization.** Normalize Unicode and whitespace for display-search fields, coerce only safe integer strings, use zero for missing cards, sort options by `(type,value,param)`, and preserve `item_key` when provided.
- [ ] **Step 5: Add redacted fixtures.** Fixtures represent the documented contract only: no OpenKore source, credentials, player identifiers, or production coordinates. Include at least two options in different input orders to exercise canonical sorting.
- [ ] **Step 6: Run tests and commit.** Run `pnpm vitest run packages/protocol/test`; expect all tests to pass. Commit with `feat: add shared market protocol`.

## Task 3: D1 Schema and Migrations

**Files:**
- Create: `migrations/0001_initial.sql`, `migrations/0002_indexes.sql`, `migrations/0003_option_dictionary.sql`
- Create: `apps/worker/test/migrations.test.ts`
- Modify: `wrangler.toml`, `docs/deployment.md`

**Interfaces:**
- Produces a local D1 schema containing `market_sources`, `vendors`, `shops`, `shop_sessions`, `listings`, `listing_options`, `option_dictionary`, `listing_price_history`, `sold_events`, and `upload_batches`.
- Produces unique keys `(source_id, batch_id)`, `(source_id, snapshot_id, part_index)`, `(source_id, shop_key)`, `(shop_session_id, item_fingerprint)`, `(listing_id, option_index)`, and `sold_events.transition_key`.

- [ ] **Step 1: Write migration assertions.** Start a local D1 database, apply migrations, and assert every required table, foreign key, unique index, and search index exists. Assert that deleting a source cannot silently leave current listings.
- [ ] **Step 2: Run the migration test to verify failure.** Run `pnpm vitest run apps/worker/test/migrations.test.ts`; expect missing tables/indexes.
- [ ] **Step 3: Write `0001_initial.sql`.** Use integer epoch milliseconds, text IDs, explicit `CHECK` constraints for non-negative price/quantity and valid statuses, foreign keys, `missing_streak INTEGER NOT NULL DEFAULT 0`, `state_version INTEGER NOT NULL DEFAULT 0`, `initial_sync_complete INTEGER NOT NULL DEFAULT 0`, and `upload_batches.payload_hash TEXT NOT NULL`.
- [ ] **Step 4: Write `0002_indexes.sql`.** Add source/status/last-seen, item/status, session/status, price, option type/value/param, history time, and unique transition indexes exactly as specified in the design.
- [ ] **Step 5: Seed `option_dictionary`.** Insert a versioned, reviewable seed dataset with stable `(option_type, option_value, option_param)` keys and display/search tokens. Keep the seed data separate from request handling and document how to replace it with the verified LastRO dictionary.
- [ ] **Step 6: Run migrations against local D1 and commit.** Run `pnpm wrangler d1 migrations apply lastroweb-local --local`, then the migration test. Commit with `feat: add D1 market schema`.

## Task 4: Repository and Runtime Configuration

**Files:**
- Create: `apps/worker/src/db/types.ts`, `apps/worker/src/db/repository.ts`, `apps/worker/src/db/d1-repository.ts`
- Create: `apps/worker/src/env.ts`, `apps/worker/test/d1-repository.test.ts`
- Modify: `apps/worker/src/index.ts`

**Interfaces:**
- `interface MarketRepository` exposes `findSourceByApiKeyHash`, `getOrCreateVendor`, `getOrCreateShop`, `getOrCreateSession`, `getBatch`, `insertBatch`, `loadListingsByFingerprint`, `applyListingChanges`, `markShopHeartbeats`, `finalizeSnapshot`, `searchListings`, `getListingHistory`, and `getOptionDictionary`.
- `createD1Repository(db: D1Database): MarketRepository` is the only module allowed to construct raw D1 statements.
- `AppEnv` contains `DB`, `ASSETS`, `ENVIRONMENT`, `BUILD_VERSION`, `MAX_BODY_BYTES`, and optional `UPLOAD_LIMITER` binding.

- [ ] **Step 1: Write repository contract tests with a fake D1 adapter.** Assert source lookup, batch lookup, and a listing state transition return typed domain objects; assert repository methods never interpolate user values into SQL.
- [ ] **Step 2: Run the tests to verify failure.** Run `pnpm vitest run apps/worker/test/d1-repository.test.ts`; expect missing repository methods.
- [ ] **Step 3: Define domain row types.** Keep database row types separate from API response types. Convert integer booleans and epoch timestamps at the repository boundary.
- [ ] **Step 4: Implement prepared statements and bounded batch helpers.** Use `D1Database.prepare().bind(...)` and `db.batch(...)`; expose a helper that rejects more than 45 statements or more than 100 bound values in one generated statement.
- [ ] **Step 5: Wire the repository into `createApp`.** Pass the repository through Hono context instead of importing a global database connection from route modules.
- [ ] **Step 6: Run the repository tests and commit.** Commit with `feat: add typed D1 repository`.

## Task 5: Authentication, Errors, Limits, and Health

**Files:**
- Create: `apps/worker/src/middleware/auth.ts`, `apps/worker/src/middleware/errors.ts`, `apps/worker/src/middleware/limits.ts`, `apps/worker/src/observability.ts`
- Create: `apps/worker/src/routes/health.ts`
- Create: `apps/worker/test/auth.test.ts`, `apps/worker/test/errors.test.ts`, `apps/worker/test/health.test.ts`
- Modify: `apps/worker/src/index.ts`, `.dev.vars.example`

**Interfaces:**
- `requireSource(c): Promise<AuthenticatedSource>` reads `Authorization: Bearer`, hashes the token, and loads the source; it never uses JSON `source_id`.
- `jsonError(code, message, status, requestId)` returns the standard error envelope.
- `enforceUploadLimits(request, parsedRequest)` enforces body, part, and per-request listing limits.

- [ ] **Step 1: Write failing middleware tests.** Cover missing/invalid bearer tokens (401), disabled sources (403), oversized body (413), malformed JSON (400), invalid schema (400), and an error response containing `request_id` but no secret.
- [ ] **Step 2: Run focused tests to verify failure.** Run `pnpm vitest run apps/worker/test/auth.test.ts apps/worker/test/errors.test.ts`; expect missing middleware.
- [ ] **Step 3: Implement authentication and error mapping.** Use Web Crypto SHA-256 for the random API key hash, map known domain errors to 400/401/403/409/413/429/503, and generate a request ID per invocation.
- [ ] **Step 4: Implement limit checks.** Check `Content-Length` when present and actual bytes while reading the body; enforce 512 KiB, `part_count <= 16`, bounded shop/item/options counts, and a configured daily/source rate-limit binding when available.
- [ ] **Step 5: Implement `/api/health`.** Return build version, environment, and a cheap D1 connectivity result without exposing database IDs or source counts.
- [ ] **Step 6: Run tests and commit.** Commit with `feat: add API security middleware`.

## Task 6: Canonical Fingerprints and Upload Normalization

**Files:**
- Create: `apps/worker/src/domain/fingerprint.ts`, `apps/worker/src/domain/transitions.ts`
- Create: `apps/worker/test/fingerprint.test.ts`, `apps/worker/test/transitions.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- `canonicalItemString(input: FingerprintInput): string` serializes source/session/item identity deterministically.
- `computeItemFingerprint(input: FingerprintInput): Promise<string>` returns lowercase SHA-256 hex.
- `calculateQuantityTransition(oldQuantity, newQuantity): QuantityTransition` returns `unchanged`, `increased`, `decreased`, or `sold_out` plus `soldQuantity`.
- `makeTransitionKey(listingId, stateVersion, oldQuantity, newQuantity, reason): Promise<string>` returns the event dedupe key.

- [ ] **Step 1: Write failing fingerprint tests.** Assert option order does not change a fingerprint, changing any option tuple/upgrade/card/slot changes it, missing cards normalize to zero, and two `item_key` values keep otherwise identical variants distinct.
- [ ] **Step 2: Write failing transition tests.** Assert quantity decrease produces the exact delta, increase produces no sold quantity, and invalid negative values are rejected.
- [ ] **Step 3: Run focused tests to verify failure.** Run `pnpm vitest run apps/worker/test/fingerprint.test.ts apps/worker/test/transitions.test.ts`.
- [ ] **Step 4: Implement canonical serialization and Web Crypto hashing.** Include `source_id`, `shop_session_id`, optional `item_key`, item fields, and sorted option tuples; use a fixed JSON representation and no locale-sensitive formatting.
- [ ] **Step 5: Implement transition helpers and commit.** Run the focused tests and commit with `feat: add canonical listing identity`.

## Task 7: Upload Ingestion, Batch Idempotency, and Session Management

**Files:**
- Create: `apps/worker/src/services/ingestion.ts`, `apps/worker/src/services/session-manager.ts`, `apps/worker/src/routes/upload.ts`
- Create: `apps/worker/test/ingestion.test.ts`, `apps/worker/test/upload-route.test.ts`
- Modify: `apps/worker/src/index.ts`, `apps/worker/src/db/repository.ts`, `apps/worker/src/db/d1-repository.ts`

**Interfaces:**
- `ingestUpload(source: AuthenticatedSource, request: UploadRequest, repo: MarketRepository): Promise<UploadResult>`.
- `getOrStartShopSession(sourceId, shopKey, clientRunId, observedAt, repo): Promise<ShopSession>`; a run change or 30-minute gap starts a new session.
- `ListingStateService.applyBatchObservations(source, session, normalizedItems): Promise<StateBatchResult>`; ingestion calls this interface and does not implement listing state mutation itself.
- `UploadResult` contains `accepted`, `batchId`, `duplicate`, processed/changed/sold counts, and nullable `next`.

- [ ] **Step 1: Write failing ingestion tests.** Cover a full baseline, delta update, heartbeat-only request, duplicate `Idempotency-Key`, duplicate `(snapshot_id,part_index)`, disabled source, and two sources using the same `shop_key` without cross-source changes.
- [ ] **Step 2: Run focused tests to verify failure.** Run `pnpm vitest run apps/worker/test/ingestion.test.ts apps/worker/test/upload-route.test.ts`.
- [ ] **Step 3: Implement request-to-domain normalization.** Authenticate before parsing source-sensitive fields, parse the shared schema, compute canonical fingerprints, resolve vendors/shops/sessions, and attach the authenticated source ID.
- [ ] **Step 4: Implement batch idempotency.** Compute a canonical payload hash after schema normalization, insert `upload_batches` with a unique conflict path, and on an existing accepted batch return the stored response only when the hash matches. Reject a reused batch ID whose payload hash differs.
- [ ] **Step 5: Implement the ingestion/state boundary.** Persist accepted batch metadata, resolve source-scoped shops and sessions, and delegate normalized item observations to `ListingStateService.applyBatchObservations`; do not duplicate listing mutation SQL in the route or orchestration layer.
- [ ] **Step 6: Implement heartbeat writes.** Update `shops.last_seen_at` only for authenticated source IDs in `shops_seen`; do not close any shop outside that source or outside a completed full snapshot.
- [ ] **Step 7: Run focused tests plus the route contract test.** Run `pnpm vitest run apps/worker/test/ingestion.test.ts apps/worker/test/upload-route.test.ts`; use a fake `ListingStateService` in this task. Commit with `feat: ingest idempotent market uploads`.

## Task 8: State Versions, Price History, and Sold Events

**Files:**
- Create: `apps/worker/src/services/state-transition.ts`, `apps/worker/src/services/sold-events.ts`
- Create: `apps/worker/test/state-transition.test.ts`, `apps/worker/test/sold-events.test.ts`
- Modify: `apps/worker/src/services/ingestion.ts`, `apps/worker/src/db/d1-repository.ts`, `migrations/0001_initial.sql`

**Interfaces:**
- `ListingStateService.applyBatchObservations(source, session, observations): Promise<StateBatchResult>` uses one bounded JSON/SQL batch per chunk and delegates each optimistic version conflict to a single retry path.
- `applyListingObservation(input: ListingObservation): Promise<ObservationResult>` uses an expected `state_version` and returns `updated`, `conflict`, `historyWritten`, and optional sold event data.
- `buildSoldEvent(listing, transition, reason, observedAt): SoldEventCandidate | null` never emits during an incomplete baseline.

- [ ] **Step 1: Write failing state tests.** Cover first observation, unchanged observation, price-only change, quantity decrease, quantity increase, sold-out transition, optimistic version conflict, and a repeated transition key.
- [ ] **Step 2: Write failing baseline tests.** Assert the first complete full snapshot leaves `initial_sync_complete=0` until all parts are accepted and produces zero sold events even when previous client data is absent.
- [ ] **Step 3: Run focused tests to verify failure.** Run `pnpm vitest run apps/worker/test/state-transition.test.ts apps/worker/test/sold-events.test.ts`.
- [ ] **Step 4: Implement compare-and-update and the state service.** Pass one canonical JSON array per chunk to JSON1 or generate `VALUES` statements under the parameter limit. Update a listing only when the expected version matches; increment `state_version`, reset `missing_streak` on observation, update `last_seen_at`, and write `listing_price_history` only for first/changed/status observations.
- [ ] **Step 5: Implement direct quantity-decrease events.** In one D1 batch, update the listing, insert history, and insert `sold_events` with a unique `transition_key`. If the version update affects zero rows, reload and retry once; return 409 after the second conflict.
- [ ] **Step 6: Run focused tests and commit.** Commit with `feat: record listing history and sold events`.

## Task 9: Full Snapshot Reconciliation

**Files:**
- Create: `apps/worker/src/services/snapshot-reconciler.ts`
- Create: `apps/worker/test/snapshot-reconciler.test.ts`
- Modify: `apps/worker/src/services/ingestion.ts`, `apps/worker/src/db/repository.ts`, `apps/worker/src/db/d1-repository.ts`

**Interfaces:**
- `finalizeSnapshot(sourceId, snapshotId): Promise<SnapshotFinalizeResult>` verifies all accepted parts before reconciliation.
- `reconcileMissingListings(sourceId, snapshotId, observedAt): Promise<ReconciliationResult>` operates only on sessions and shops belonging to that source.

- [ ] **Step 1: Write failing reconciliation tests.** Cover missing part (no reconciliation), first full baseline (no sold), one missing full snapshot (mark candidate only), two consecutive complete missing snapshots (mark missing and optionally infer low-confidence sold), delta omission (no missing), and shop closure (expired, not sold).
- [ ] **Step 2: Run the focused test to verify failure.** Run `pnpm vitest run apps/worker/test/snapshot-reconciler.test.ts`.
- [ ] **Step 3: Implement part completeness.** Query `upload_batches` by `(source_id,snapshot_id)`, require exactly `part_count` accepted parts with consistent metadata, and record `last_complete_snapshot_id` only after the baseline has been committed.
- [ ] **Step 4: Implement source-scoped missing logic.** Compare observed fingerprints for each complete shop snapshot, increment a missing counter or equivalent state, and only apply the two-snapshot rule. Never treat an unobserved delta item as sold.
- [ ] **Step 5: Implement session expiration.** On a 30-minute gap or client run change, close the old session and create a new one; set leftover listings to `expired` without generating sold events.
- [ ] **Step 6: Run focused and integration tests and commit.** Commit with `feat: reconcile complete market snapshots`.

## Task 10: Search, Option Dictionary, and History APIs

**Files:**
- Create: `apps/worker/src/domain/search.ts`, `apps/worker/src/routes/search.ts`, `apps/worker/src/routes/options.ts`, `apps/worker/src/routes/history.ts`
- Create: `apps/worker/test/search.test.ts`, `apps/worker/test/options.test.ts`, `apps/worker/test/history.test.ts`
- Modify: `apps/worker/src/index.ts`, `apps/worker/src/db/repository.ts`, `apps/worker/src/db/d1-repository.ts`

**Interfaces:**
- `parseSearchParams(url: URL): SearchFilters` validates `limit <= 50`, numeric ranges, option filters, `include_stale`, and a signed/base64url keyset cursor.
- `searchListings(filters: SearchFilters): Promise<SearchPage<ListingSearchResult>>` returns listing, options, shop, vendor, price, quantity, and observed time.
- `getOptionDictionary(version?: string): Promise<OptionDictionaryEntry[]>`.
- `getListingHistory(listingId, limit, cursor): Promise<HistoryPage>`.

- [ ] **Step 1: Write failing API tests.** Cover exact item ID, normalized text search, price range, map/shop type, option all/any, invalid sort, limit clamping, stable cursor pagination, unknown listing ID (404), and dictionary caching headers.
- [ ] **Step 2: Run focused tests to verify failure.** Run `pnpm vitest run apps/worker/test/search.test.ts apps/worker/test/options.test.ts apps/worker/test/history.test.ts`.
- [ ] **Step 3: Implement safe parameter parsing.** Use an allowlist for `sort=price_asc|price_desc|updated_desc`; encode cursor values as signed/base64url JSON containing the last sort value and listing ID; reject malformed or oversized cursors.
- [ ] **Step 4: Implement indexed SQL.** Use item/status/price/option indexes, `EXISTS` for option filters, source/session status predicates, bound parameters, and a hard result limit of 50. Do not use offset pagination or raw SQL fragments from query parameters.
- [ ] **Step 5: Implement routes and cache headers.** Add `GET /api/v1/market/search`, `GET /api/v1/options`, and `GET /api/v1/market/listings/:id/history`; use 30-second public cache for search, 24-hour cache plus ETag for options, and no cache for upload responses.
- [ ] **Step 6: Run focused tests and commit.** Commit with `feat: add market search and history APIs`.

## Task 11: Vite Query UI

**Files:**
- Create: `apps/web/src/api.ts`, `apps/web/src/types.ts`, `apps/web/src/state.ts`, `apps/web/src/render.ts`, `apps/web/src/styles.css`
- Create: `apps/web/test/query-ui.test.ts`
- Modify: `apps/web/index.html`, `apps/web/src/main.ts`

**Interfaces:**
- `MarketApi.search(filters: SearchFilters): Promise<SearchPage<ListingSearchResult>>`.
- `MarketApi.getHistory(listingId): Promise<HistoryPage>`.
- `renderSearchResults(container, page, state): void` and `renderHistory(drawer, history): void`.

- [ ] **Step 1: Write failing UI tests.** Assert form submission serializes item ID, text, price, map, shop type, and one/all option filters; loading, empty, error, and result states render without overlapping controls; cursor “next” requests the returned cursor.
- [ ] **Step 2: Run UI tests to verify failure.** Run `pnpm vitest run apps/web/test/query-ui.test.ts`.
- [ ] **Step 3: Implement the API client.** Use same-origin `/api` paths, abort stale requests with `AbortController`, parse the standard error envelope, and preserve filters while paginating.
- [ ] **Step 4: Implement the query form and option controls.** Render repeatable option rows with type/value/param fields and an all/any segmented control; do not expose internal source IDs or raw JSON.
- [ ] **Step 5: Implement result table and history drawer.** Show item identity fields, structured option names/values, price, quantity, map, vendor/shop, update time, and explicit “inferred sale” reason when present. Provide accessible labels, keyboard focus, responsive table behavior, and an empty state.
- [ ] **Step 6: Run UI tests and Vite production build.** Run `pnpm vitest run apps/web/test/query-ui.test.ts` and `pnpm --filter web build`; commit with `feat: add Vite market query UI`.

## Task 12: Static Assets, Runtime Caching, and Observability

**Files:**
- Create: `apps/worker/src/middleware/cache.ts`, `apps/worker/src/observability.ts`, `apps/worker/test/cache.test.ts`
- Modify: `apps/worker/src/index.ts`, `wrangler.toml`, `apps/web/src/main.ts`

**Interfaces:**
- `withQueryCacheHeaders(response, kind): Response` applies search/options/uncached policy.
- `recordMetric(event: MetricEvent): void` emits structured Workers Logs without writing to D1.

- [ ] **Step 1: Write failing cache and logging tests.** Assert search `Cache-Control` is `public, max-age=30, s-maxage=30`, options max age is 86400 with ETag, upload responses are `no-store`, and logs redact bearer tokens and complete payloads.
- [ ] **Step 2: Run focused tests to verify failure.** Run `pnpm vitest run apps/worker/test/cache.test.ts`.
- [ ] **Step 3: Implement cache middleware and ETag.** Hash the option dictionary version/content, honor `If-None-Match`, and leave authenticated upload routes uncached.
- [ ] **Step 4: Implement structured metrics.** Record request ID, route, status, elapsed time, body bytes, counts, and D1 error class; cap or omit user text and coordinates in logs.
- [ ] **Step 5: Verify static fallback.** Build the web app and run Wrangler dev; assert `/` returns `index.html`, `/assets/*` returns built assets, and unknown non-API paths fall back to the SPA document.
- [ ] **Step 6: Run tests and commit.** Commit with `feat: add Worker caching and observability`.

## Task 13: Cleanup, Retention, and Export Hooks

**Files:**
- Create: `apps/worker/src/services/retention.ts`, `apps/worker/src/routes/admin.ts`
- Create: `apps/worker/test/retention.test.ts`
- Modify: `wrangler.toml`, `docs/deployment.md`

**Interfaces:**
- `runRetention(now, policy, repo): Promise<RetentionResult>` deletes expired history/sold rows in bounded chunks and returns counts.
- `GET /api/admin/retention-preview` is disabled unless an admin secret is configured; it reports counts only and never returns raw records.

- [ ] **Step 1: Write failing retention tests.** Assert rows older than 90 days are selected, current listings are never deleted, deletes are chunked, and a failed chunk can be retried without corrupting active state.
- [ ] **Step 2: Run the focused test to verify failure.** Run `pnpm vitest run apps/worker/test/retention.test.ts`.
- [ ] **Step 3: Implement chunked retention.** Delete price history and sold events in deterministic ID/time chunks, emit counts, and stop before the request/query budget. Keep retention days configurable with a default of 90.
- [ ] **Step 4: Add a Cron trigger and dry-run preview.** Configure a daily Wrangler cron; require a separate admin secret for preview and keep it off by default in local development.
- [ ] **Step 5: Run tests and commit.** Commit with `feat: add bounded history retention`.

## Task 14: Contract, Integration, and Browser Verification

**Files:**
- Create: `tests/integration/upload-flow.test.ts`, `tests/integration/search-flow.test.ts`, `tests/browser/query.spec.ts`, `tests/fixtures/expected-responses/*.json`
- Modify: `playwright.config.ts`, `package.json`, `.github/workflows/ci.yml`

**Interfaces:**
- The integration suite starts local D1, applies all migrations, seeds one source and option dictionary, and exercises HTTP routes through the real Hono app.
- The browser suite starts Wrangler/Vite production output and tests the public query workflow.

- [ ] **Step 1: Write the full-flow assertions.** Cover first full baseline, repeated full batch, delta quantity decrease with exactly one sold event, option-order identity, missing-part no-op, two-source isolation, history response, and cursor pagination.
- [ ] **Step 2: Run the integration suite against the current implementation.** Run `pnpm vitest run tests/integration`; record any failing behavior before fixing it.
- [ ] **Step 3: Add browser smoke tests.** Use Playwright to search a seeded item, filter by an option, paginate, open history, and verify empty/error states at desktop and mobile viewport sizes.
- [ ] **Step 4: Run all verification commands.** Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter web build`, and `pnpm playwright test`; all commands must exit 0.
- [ ] **Step 5: Add CI.** Run migrations, unit/integration tests, typecheck, lint, build, and browser smoke tests on pull requests without deploying secrets.
- [ ] **Step 6: Commit the verification suite.** Commit with `test: cover upload and query workflows`.

## Task 15: Documentation, Staging Deployment, and Final Review Package

**Files:**
- Create: `README.md`, `docs/api.md`, `docs/deployment.md`, `docs/operations.md`, `scripts/check-docs.mjs`
- Modify: `wrangler.toml`, `.dev.vars.example`, `docs/superpowers/specs/2026-09-18-lastroweb-design.md`

**Interfaces:**
- `docs/api.md` is the authoritative external contract for the OpenKore adapter team; it contains request/response JSON, authentication, errors, limits, and full/delta/heartbeat semantics.
- `docs/deployment.md` is an operator runbook for local, staging, production, migrations, secrets, rollback, backup, and retention.

- [ ] **Step 1: Write documentation checks.** Add a script that verifies the API document contains the required paths, headers, `options` triple, `snapshot_mode`, and first-full baseline rule.
- [ ] **Step 2: Run the documentation check to verify failure.** Run `pnpm test:docs`; expect failure before the documents are complete.
- [ ] **Step 3: Document the contract without OpenKore implementation.** State that another project owns the client adapter; include redacted cURL/JSON examples and explicit constraints for `source_id`, `item_key`, options, retries, and part completion. Add the root `test:docs` script that runs `node scripts/check-docs.mjs`.
- [ ] **Step 4: Document staging deployment.** Include D1 creation, migrations, secrets, static asset build, health check, smoke upload, query smoke test, rollback to a previous Worker version, and backup verification.
- [ ] **Step 5: Run all docs and release checks.** Run `pnpm test:docs`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter web build`, and `pnpm playwright test`.
- [ ] **Step 6: Commit the release package.** Commit with `docs: add deployment and API runbooks`.

## Execution and Review Gates

1. The main agent reads the design and this plan before changing files, creates a `codex/` branch or isolated worktree, and keeps the task checklist current.
2. Each task is implemented with a fresh implementation agent using the exact files and interfaces listed in that task. The implementation agent runs the focused tests before handing off.
3. A separate review agent reviews the diff and test output for each completed task. A task is not marked complete until the review agent either approves it or the implementation agent addresses every finding.
4. After Task 15, the main agent runs the full verification commands again, checks `git diff --check`, confirms no OpenKore source or credentials were added, and performs the final review against every design section.
5. The final review must explicitly verify: D1 query/parameter limits, source isolation, first-full behavior, duplicate batch behavior, option-order fingerprints, sold-event idempotency, 90-day cleanup, cache headers, and responsive UI states.

## Acceptance Criteria

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter web build`, and `pnpm playwright test` all exit 0.
- A first full upload creates current listings and zero sold events; replaying it returns `duplicate: true` without additional writes.
- A delta quantity decrease creates one correctly quantified sold event; retrying the same batch does not create a second event.
- A changed option tuple creates a new fingerprint; reordered equivalent options do not.
- A complete full snapshot can reconcile missing listings only after all parts arrive and only within the source/session rules.
- Search supports item ID, text, price, map, shop type, and structured option filters with keyset pagination.
- The Worker serves the Vite UI and API from one origin with the documented cache and error behavior.
- The repository contains no OpenKore source changes and no production credentials.

## Completion Ledger

- [x] Task 1: workspace/Worker/Vite scaffolding, health and build tests (`b6dcd74`)
- [x] Task 2: protocol schemas, normalization and redacted fixtures (`71022bd`)
- [x] Task 3: D1 migrations, constraints and indexes (`9e967d4`)
- [x] Task 4: typed repository and runtime environment (`ece8f91`)
- [x] Task 5: authentication, errors, limits and health (`e2be597`)
- [x] Task 6: canonical fingerprints and quantity transitions (`e5147a0`)
- [x] Task 7: upload ingestion, session management and idempotency (`2cea7e2`, `b76a43e`)
- [x] Task 8: state versions, history and sold events (`237e434`, `c1bb899`, `b76a43e`)
- [x] Task 9: complete full-snapshot reconciliation (`c14ba51`)
- [x] Task 10: search, option dictionary, history and signed cursors (`97992c7`, `6ea65b9`, `be37c13`)
- [x] Task 11: Vite query UI, option controls and history states (`5651ea0`, `5223f11`)
- [x] Task 12: cache headers, static fallback and request metrics (`726f4f3`, `5223f11`)
- [x] Task 13: bounded retention and admin preview (`251944f`)
- [x] Task 14: integration and browser verification (`f35f759`)
- [x] Task 15: API/deployment/operations documentation and contract check (`9959704`)

Implementation commits and the independent review findings that required follow-up are captured above; the final verification commands are the release gate for the complete package.
