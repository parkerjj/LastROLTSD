# Async Market Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move full market snapshots to a MySQL-backed, chunked background pipeline with 64-part uploads while keeping the existing shop-id response contract and the delta/heartbeat behavior.

**Architecture:** Full upload HTTP requests claim and persist validated payloads plus lightweight shop identity manifests, then return `202` with the `uuid -> shop_id` mapping. A snapshot job state machine processes materialization, shop reconciliation, listing reconciliation, inferred sales, and finalization through one bounded continuation chunk per Worker invocation. Queue is an optional dispatcher; MySQL jobs plus independent Cron stages remain the correctness fallback.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers/Queues/Cron, MySQL 8 through `mysql2/promise`, Zod, Vitest, Wrangler, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-24-async-market-upload-design.md`

## Global Constraints

- Full upload HTTP requests must not run listing fingerprinting, listing transitions, missing/sold reconciliation, or finalization.
- Full upload responses must preserve ordered `shops[]` entries containing `uuid` and stable public `shop_id`.
- Full part payloads stay in MySQL; Queue messages contain only job identifiers, stage, and cursors and remain below 64KB.
- Every Queue consumer invocation processes exactly one chunk (`max_batch_size = 1`); Cron fallback also claims one chunk per invocation.
- `materialize_parts` processes at most 20 shops and 200 listings per chunk; listing reconciliation and inferred-sale stages process at most 200 listings/candidates per chunk.
- Each chunk must meet benchmark gates of p95 <= 6ms and p99 <= 8ms CPU target, leaving headroom under the 10ms Free CPU limit; production `cpuTimeMs` is the deployment evidence.
- Part indexes are `0..63`; part counts are `1..64`; accepted-part tracking must not use a JavaScript 32-bit bitmask.
- Delta and heartbeat retain their current synchronous semantics during this change.
- Every stage has a durable cursor, lease, retry count, CAS claim, and idempotent transition keys.
- No production Worker module may import D1 types or construct a D1 repository.
- SQL values remain parameterized; payloads, API keys, passwords, and complete shop/item data never enter logs.

## Review Focus

- A full part is accepted out of order or retried with the same payload: it must return the same `uuid -> shop_id` mapping and never duplicate a domain write. (Task 4)
- A full part is retried with a different payload or a conflicting part count: it must fail before changing snapshot state. (Task 3)
- A Queue consumer receives more than one message in a test batch: configuration and handler must enforce one chunk per invocation. (Task 6)
- A chunk fails after its MySQL transaction but before the next message is sent: replay must be a no-op and the cursor must not skip work. (Task 6)
- A full snapshot has 64 parts and a stale snapshot arrives after a newer completed full: the older snapshot must not close shops or overwrite the source timestamp. (Task 3 and Task 7)

### Task 1: Raise the protocol and schema part limit to 64

**Files:**
- Modify: `packages/protocol/src/schema.ts`
- Modify: `apps/worker/src/middleware/limits.ts`
- Modify: `migrations/mysql/001_initial.sql`
- Modify: `docs/api.md`
- Modify: `packages/protocol/test/schema.test.ts`
- Modify: `apps/worker/test/errors.test.ts`
- Modify: `apps/worker/test/mysql-schema.test.ts`
- Modify: `apps/worker/test/snapshot-reconciler.test.ts`

**Interfaces:**
- Produces `MAX_PARTS = 64` in the protocol validator and Worker limit module.
- Keeps `part_index < part_count` and accepts `part_index = 63`, `part_count = 64`.

- [ ] **Step 1: Write failing boundary tests.** Add assertions that `(part_index: 63, part_count: 64)` parses and passes limits, while `part_index: 64`, `part_count: 65`, and a MySQL insert with `part_count = 65` fail. Add a 64-part completeness fixture with one missing index and assert it remains incomplete.
- [ ] **Step 2: Run the focused tests.** Run `rtk pnpm exec vitest run packages/protocol/test/schema.test.ts apps/worker/test/errors.test.ts apps/worker/test/mysql-schema.test.ts apps/worker/test/snapshot-reconciler.test.ts`; expect failures from the current 16-part constants/checks.
- [ ] **Step 3: Implement the limit change.** Change `.max(15)`/`.max(16)` and `MAX_PARTS` to 63/64, update MySQL checks to `BETWEEN 0 AND 63` and `BETWEEN 1 AND 64`, and ensure completeness loops use the declared count without a 32-bit mask.
- [ ] **Step 4: Update the public API documentation.** Replace the 16-part statement and examples with the 64-part contract, including the 512KiB per-request limit.
- [ ] **Step 5: Run the focused tests and commit.** Run the same focused command plus `rtk git diff --check`; commit `feat: allow 64 upload parts`.

### Task 2: Remove D1 runtime TypeScript and D1-only test contracts

**Files:**
- Delete: `apps/worker/src/db/d1-repository.ts`
- Delete: `apps/worker/src/db/d1-meter.ts`
- Delete: `apps/worker/test/d1-repository.test.ts`
- Delete: `apps/worker/test/d1-lifecycle.test.ts`
- Delete: `apps/worker/test/d1-search.test.ts`
- Delete: `apps/worker/test/d1-meter.test.ts`
- Delete: `apps/worker/test/resource-budgets.test.ts`
- Delete: `apps/worker/test/options-bundle.test.ts`
- Delete: `apps/worker/test/migrations.test.ts`
- Delete: `apps/worker/test/query-indexes.test.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Test: `apps/worker/test/mysql-worker-lifecycle.test.ts`

**Interfaces:**
- Production repository construction remains `createMysqlRepository` from `apps/worker/src/index.ts`.
- `MarketRepository` no longer exports the D1-only `assertBatchBounds` helper.

- [ ] **Step 1: Add a production import guard.** Create `apps/worker/test/no-d1-runtime.test.ts` that scans `apps/worker/src` and asserts no source file contains `d1-repository`, `d1-meter`, `D1Database`, `createD1Repository`, or `env.DB`.
- [ ] **Step 2: Run the guard before deletion.** Run `rtk pnpm exec vitest run apps/worker/test/no-d1-runtime.test.ts`; expect it to fail on the two D1 modules and the D1-only helper references.
- [ ] **Step 3: Delete the runtime modules and D1-only tests.** Remove the listed files and delete `assertBatchBounds` from `repository.ts`; retain historical `migrations/0001_initial.sql` and design documents because they are not Worker runtime modules.
- [ ] **Step 4: Verify MySQL-only construction.** Run `rtk pnpm exec vitest run apps/worker/test/no-d1-runtime.test.ts apps/worker/test/mysql-worker-lifecycle.test.ts`; assert the guard passes and Worker health/scheduled retention still closes MySQL pools.
- [ ] **Step 5: Commit the clean break.** Run `rtk rg -n "d1-repository|d1-meter|D1Database|createD1Repository|env\.DB" apps/worker/src`; expect no matches, then commit `refactor: remove D1 worker runtime`.

### Task 3: Add MySQL snapshot and durable job state

**Files:**
- Create: `migrations/mysql/004_async_snapshot_jobs.sql`
- Modify: `migrations/mysql/001_initial.sql`
- Modify: `apps/worker/src/db/types.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/db/mysql-repository.ts`
- Modify: `apps/worker/test/mysql-schema.test.ts`
- Modify: `apps/worker/test/mysql-repository-core.test.ts`
- Create: `apps/worker/test/snapshot-jobs-repository.test.ts`

**Interfaces:**
- `SnapshotStage = 'materialize_parts' | 'reconcile_shops' | 'reconcile_listings' | 'infer_sales' | 'finalize'`.
- `SnapshotJobRow` contains `id`, `sourceId`, `snapshotId`, `stage`, `status`, `cursorJson`, `attempts`, `availableAt`, `leaseUntil`, `leaseToken`, and `lastError`.
- `SnapshotRow` contains `sourceId`, `snapshotId`, `partCount`, `observedAt`, `acceptedParts`, `status`, `currentStage`, `leaseUntil`, and `lastError`.
- Repository methods:

```ts
interface ReceiveFullPartInput {
  sourceId: string;
  batchId: string;
  snapshotId: string;
  partIndex: number;
  partCount: number;
  observedAt: number;
  payloadHash: string;
  payloadJson: string;
  shopIds: number[];
  shopHashes: string[];
}
interface ReceiveFullPartResult {
  batch: BatchRow;
  duplicate: boolean;
  allPartsAccepted: boolean;
  materializeJobId: number | null;
}
interface AdvanceSnapshotJobInput {
  jobId: number;
  leaseToken: string;
  cursorJson: string | null;
  stageComplete: boolean;
  now: number;
}
interface AdvanceSnapshotJobResult {
  accepted: boolean;
  nextJobId: number | null;
}
interface FailSnapshotJobInput {
  jobId: number;
  leaseToken: string;
  error: string;
  now: number;
}
receiveFullPart(input: ReceiveFullPartInput): Promise<ReceiveFullPartResult>;
getSnapshot(sourceId: string, snapshotId: string): Promise<SnapshotRow | null>;
claimSnapshotJob(stage: SnapshotStage, now: number, leaseMs: number): Promise<SnapshotJobRow | null>;
advanceSnapshotJob(input: AdvanceSnapshotJobInput): Promise<AdvanceSnapshotJobResult>;
failSnapshotJob(input: FailSnapshotJobInput): Promise<void>;
```

- [ ] **Step 1: Write schema and repository contract tests.** Assert the new tables, foreign keys, stage/status checks, unique `(source_id,snapshot_id,stage)`, nullable legacy payload migration behavior, and 64-part accepted-count handling. Test that two concurrent claims cannot both receive the same lease.
- [ ] **Step 2: Run the focused tests.** Run `rtk pnpm exec vitest run apps/worker/test/mysql-schema.test.ts apps/worker/test/snapshot-jobs-repository.test.ts`; expect missing table/column/method failures.
- [ ] **Step 3: Add the MySQL migration.** Add `payload_json` to `upload_batches`; update status checks for receive/materialize states; create `market_snapshots`, `market_snapshot_jobs`, and per-stage indexes for available jobs and expired leases. Use counts/rows for accepted parts instead of a JavaScript bitmask.
- [ ] **Step 4: Implement typed row mapping and transactional claim methods.** `receiveFullPart` must atomically insert/upsert the snapshot row, claim the unique part, increment accepted state exactly once, and create the first job only when all part indexes are present. `claimSnapshotJob` must use a conditional update inside a transaction and return only the winning lease.
- [ ] **Step 5: Implement cursor advancement and retry release.** `advanceSnapshotJob` must transactionally persist the cursor and either mark the stage done/create the next stage or requeue the same stage; `failSnapshotJob` must increment attempts and set exponential `available_at` without losing the cursor.
- [ ] **Step 6: Run repository tests and commit.** Run `rtk pnpm exec vitest run apps/worker/test/mysql-schema.test.ts apps/worker/test/snapshot-jobs-repository.test.ts apps/worker/test/mysql-repository-core.test.ts`; commit `feat: add durable snapshot jobs`.

### Task 4: Split full HTTP receipt from background materialization while preserving shop IDs

**Files:**
- Modify: `apps/worker/src/services/ingestion.ts`
- Modify: `apps/worker/src/routes/upload.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/db/mysql-repository.ts`
- Modify: `apps/worker/src/env.ts`
- Modify: `packages/protocol/src/types.ts`
- Modify: `apps/worker/test/ingestion.test.ts`
- Modify: `apps/worker/test/upload-route.test.ts`
- Create: `apps/worker/test/full-upload-receipt.test.ts`

**Interfaces:**
- `receiveFullUpload(source, request, idempotencyKey, repo, dispatch?): Promise<UploadResult>` performs validation/claim/storage and returns pending reconciliation metadata.
- `processStoredFullPart(sourceId, snapshotId, partIndex, repo, state): Promise<MaterializeChunkResult>` replays one bounded cursor chunk outside the HTTP route.
- `UploadResult` gains optional `reconciliation?: { status: 'pending' | 'complete' | 'failed'; snapshot_id: string; stage?: SnapshotStage }`.
- `MaterializeChunkResult` is `{ processedShops: number; processedListings: number; nextCursor: string | null; complete: boolean }`.
- The lightweight resolver returns `shops[]` in request order and writes only shop identity rows plus `shop_ids_json`/`shop_hashes_json`; it does not create sessions or touch listings.

- [ ] **Step 1: Write failing full-receipt tests.** Assert a full part returns `202` with `processed_listings: 0`, a pending stage, and the ordered `uuid -> shop_id` mappings; assert `reconcileSnapshot`, `applyBatchObservations`, `markListingsObserved`, and `updateShopFullStateHashes` are not called.
- [ ] **Step 2: Add idempotency and completeness tests.** Cover parts arriving in order `2,0,1`, duplicate identical payloads, changed payload reuse, incompatible part counts, and the final-part transition that creates exactly one `materialize_parts` job.
- [ ] **Step 3: Run the focused tests to verify failure.** Run `rtk pnpm exec vitest run apps/worker/test/full-upload-receipt.test.ts apps/worker/test/ingestion.test.ts apps/worker/test/upload-route.test.ts`; expect the current synchronous ingestion path to fail the no-listing-write assertions.
- [ ] **Step 4: Implement lightweight shop resolution and receipt.** Compute canonical identity hashes, resolve/upsert shop rows in one bounded bulk repository call, construct the ordered response mappings, serialize the validated payload into `payload_json`, and atomically call `receiveFullPart`.
- [ ] **Step 5: Route only full requests to the new path.** Keep delta/heartbeat on `ingestUpload`; route full requests through `receiveFullUpload` and return `202` with `cache-control: no-store`.
- [ ] **Step 6: Extract replayable materialization.** Refactor the existing shop/session/listing work so `processStoredFullPart` reads a stored payload and processes at most 20 shops and 200 listings, persisting its cursor before a continuation is dispatched. Do not call finalization from this function.
- [ ] **Step 7: Run focused and protocol tests and commit.** Run the focused command plus `rtk pnpm exec vitest run apps/worker/test/protocol-v2-migration.test.ts`; commit `feat: make full upload receipt asynchronous`.

### Task 5: Implement bounded stage workers and idempotent reconciliation

**Files:**
- Create: `apps/worker/src/services/snapshot-jobs.ts`
- Modify: `apps/worker/src/services/snapshot-reconciler.ts`
- Modify: `apps/worker/src/services/state-transition.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/db/mysql-repository.ts`
- Create: `apps/worker/test/snapshot-jobs.test.ts`
- Modify: `apps/worker/test/snapshot-reconciler.test.ts`
- Modify: `apps/worker/test/state-transition.test.ts`

**Interfaces:**
- `runSnapshotJobChunk(job: SnapshotJobRow, deps: SnapshotJobDependencies): Promise<SnapshotJobChunkResult>` executes exactly one bounded chunk.
- `SnapshotJobDependencies` contains the MySQL repository, listing state service, clock, and a dispatcher callback; it has no Hono or HTTP dependency.
- `SnapshotJobChunkResult` contains `processed`, `nextCursor`, `stageComplete`, and aggregate counters.

- [ ] **Step 1: Write failing chunk-budget tests.** Generate 500 shops/5,000 listings and assert one materialize chunk processes no more than 20 shops/200 listings, one listing/inferred-sale chunk processes no more than 200 rows, and every incomplete result contains a cursor.
- [ ] **Step 2: Write failing idempotency tests.** Replay the same materialize, missing-listing, inferred-sale, and finalize messages; assert no duplicate history/sold event and no cursor advancement beyond the committed transaction.
- [ ] **Step 3: Run the focused tests.** Run `rtk pnpm exec vitest run apps/worker/test/snapshot-jobs.test.ts apps/worker/test/snapshot-reconciler.test.ts apps/worker/test/state-transition.test.ts`; expect missing stage runner and cursor behavior.
- [ ] **Step 4: Implement stage dispatch.** Add a stage switch that calls materialize, shop reconcile, listing reconcile, infer sales, or finalize; each path reads only its cursor range, commits bounded MySQL work, and returns before the next range.
- [ ] **Step 5: Add CAS and stale-snapshot guards.** Require the claimed job lease and snapshot status in every advancement; compare `observed_at` to the latest completed source snapshot before applying missing/close mutations; make stale full snapshots complete-noop.
- [ ] **Step 6: Fix full-state hash semantics.** Keep `shops.full_state_hash` as the content hash; store completion identity separately in snapshot/job metadata so an unchanged shop skips listing reads on the next full.
- [ ] **Step 7: Run stage tests and commit.** Run the focused command plus `rtk pnpm exec vitest run apps/worker/test/mysql-repository-core.test.ts`; commit `feat: process snapshots in bounded stages`.

### Task 6: Add Queue consumer, Cron stage fallback, and one-message execution

**Files:**
- Modify: `apps/worker/src/env.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `wrangler.toml`
- Modify: `wrangler.production.local.toml`
- Create: `apps/worker/src/services/snapshot-dispatcher.ts`
- Create: `apps/worker/test/snapshot-dispatcher.test.ts`
- Modify: `apps/worker/test/mysql-worker-lifecycle.test.ts`

**Interfaces:**
- `SnapshotJobMessage = { jobId: number; sourceId: string; snapshotId: string; stage: SnapshotStage }`.
- `SnapshotDispatcher.dispatch(message): Promise<'queued' | 'cron_fallback'>` sends a small Queue message when available, otherwise leaves the job queued for Cron.
- Worker export adds `queue(batch, bindings)` and routes `scheduled(event, bindings)` to one stage-specific job runner or retention.

Wrangler queue configuration is explicit:

```toml
[[queues.producers]]
binding = "SNAPSHOT_QUEUE"
queue = "lastroweb-snapshot-jobs"

[[queues.consumers]]
queue = "lastroweb-snapshot-jobs"
max_batch_size = 1
max_retries = 3
```

- [ ] **Step 1: Write failing dispatcher tests.** Assert Queue messages contain only the typed identifiers, dispatch reports fallback when `SNAPSHOT_QUEUE` is absent, and a queue batch with two messages is rejected by the test harness rather than processed together.
- [ ] **Step 2: Write failing lifecycle tests.** Assert a queue message claims one job lease, runs one chunk, persists the cursor, and sends at most one continuation; assert a failed chunk calls `retry()` and does not mark the stage done.
- [ ] **Step 3: Run the focused tests.** Run `rtk pnpm exec vitest run apps/worker/test/snapshot-dispatcher.test.ts apps/worker/test/mysql-worker-lifecycle.test.ts`; expect missing queue handler/configuration failures.
- [ ] **Step 4: Implement the dispatcher and queue handler.** Add the optional Queue binding to `AppEnv`, serialize only `SnapshotJobMessage`, claim one job, call `runSnapshotJobChunk`, acknowledge on success, and retry on failure. Configure the consumer with `max_batch_size = 1` and explicit retry limits.
- [ ] **Step 5: Implement independent Cron branches.** Map distinct cron expressions to `materialize_parts`, `reconcile_shops`, `reconcile_listings`, `infer_sales`, and `finalize`; each invocation claims one eligible job and processes one chunk. Keep the existing retention schedule separate.
- [ ] **Step 6: Add queue-operation accounting and fallback.** Record estimated 64KB-chunk operations for each send/read/delete, stop enqueueing continuations when the configured daily budget is near 10,000, and leave the job available for Cron. The accounting is an estimate and must never delete a job solely because Queue is unavailable.
- [ ] **Step 7: Run Worker lifecycle tests and commit.** Run the focused command plus `rtk pnpm typecheck`; commit `feat: dispatch snapshot jobs through queue or cron`.

### Task 7: Verify CPU budgets, update API/operations documentation, and complete integration coverage

**Files:**
- Modify: `docs/api.md`
- Modify: `docs/upload-performance.md`
- Modify: `docs/deployment.md`
- Modify: `apps/worker/test/upload-route.test.ts`
- Modify: `apps/worker/test/ingestion.test.ts`
- Create: `apps/worker/test/async-full-upload.integration.test.ts`
- Modify: `scripts/benchmark-upload-cpu.mjs`
- Create: `scripts/benchmark-snapshot-jobs.mjs`

**Interfaces:**
- Documentation describes `202` pending responses, shop mappings, eventual full completion, retry behavior, 64-part limits, Queue/Cron operation accounting, and the distinction between CPU time and elapsed MySQL/network time.
- Benchmarks report per-stage p50/p95/p99 CPU for 500 shops/5,000 listings and assert configured chunks meet the p95/p99 target.

- [ ] **Step 1: Write failing contract tests.** Assert full upload responses include pending reconciliation and shop mappings, delta/heartbeat responses retain current counters, stale/partial full snapshots never close shops, and a completed job eventually updates source snapshot metadata once.
- [ ] **Step 2: Run the integration tests before implementation.** Run `rtk pnpm exec vitest run apps/worker/test/async-full-upload.integration.test.ts apps/worker/test/upload-route.test.ts apps/worker/test/ingestion.test.ts`; record failures from the new response and eventual-consistency contract.
- [ ] **Step 3: Implement integration fixtures and benchmark harness.** Generate 500 shops with 10 listings each, nine 115KB-class payloads, five-waypoint full cadence, and delta payloads at one tenth of full size; measure each stage separately and fail the benchmark when p95 > 6ms or p99 > 8ms.
- [ ] **Step 4: Update API and operational docs.** Document that `202` means payload accepted/persisted, not reconciliation completed; explain how clients retain `shop_id`, how to retry identical parts, how operators requeue failed stages, and how to estimate Queue operations.
- [ ] **Step 5: Run the full verification set.** Run `rtk pnpm test`, `rtk pnpm typecheck`, `rtk pnpm test:docs`, `rtk pnpm exec vitest run apps/worker/test/async-full-upload.integration.test.ts`, and the two CPU benchmarks. Record the existing generated-file lint limitation separately if it remains.
- [ ] **Step 6: Commit the verified implementation.** Run `rtk git diff --check` and commit `test: verify async full upload budgets`.

## Plan Self-Review

- 64-part protocol, Worker, MySQL checks, completeness, docs, and tests are covered by Task 1.
- D1 runtime deletion and source import guards are covered by Task 2.
- Raw payload persistence, accepted-part state, job leases, cursors, and CAS are covered by Task 3.
- Shop-id response compatibility and full/delta/heartbeat split are covered by Task 4.
- Bounded CPU chunks, stale snapshots, hash correctness, transitions, inferred sales, and finalization are covered by Task 5.
- Queue batch size, Cron fallback, optional bindings, retry behavior, and operation estimates are covered by Task 6.
- End-to-end semantics, benchmark evidence, docs, and verification are covered by Task 7.
- No task relies on a 32-bit accepted-part mask or sends the 115KB payload through Queue.

