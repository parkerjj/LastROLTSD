# Market upload CPU optimization implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement the tasks in order.

**Goal:** Reduce market upload CPU without changing protocol v2, identity hashes, upload acknowledgements, or transaction semantics.

**Architecture:** Optimize the existing upload flow in place. Use a specialized valid-input parser with the existing Zod schema as the error-path fallback, a direct HTTP upload entry, and compact full receipt metadata. Measure the real async receipt path with synthetic storage before considering database/interface changes.

**Tech Stack:** TypeScript, Hono, Zod 3, mysql2, Vitest, Node 24, Cloudflare Workers.

**Spec:** User-approved optimization proposal from 2026-09-30; `docs/api.md` is authoritative for protocol and `docs/upload-performance.md` for async boundaries.

## Global constraints

- Work on `codex/market-upload-cpu` and open a PR to main; do not merge or deploy.
- Preserve strict field checking, defaults, trim behavior, validation error status/codes, and canonical serialized payload order.
- Preserve full/delta/heartbeat, dismissal, source scoping, snapshot identity uniqueness, and transaction atomicity.
- Keep database connections invocation-scoped and 32 KiB transport write splitting intact.
- Do not access production databases or modify external OpenKore code.
- No runtime eval, no new production dependencies, and no schema migration without measured justification and integration coverage.
- Local process CPU measurements are comparative evidence, not Cloudflare billing or a guarantee of 10 ms.

## Review focus

- Reordered keys, explicit undefined optional fields, Unicode trimming, default arrays, and maximum numeric values must produce identical canonical payloads.
- Unknown or inherited fields, malformed dates, sparse arrays, and NaN/Infinity must not bypass validation.
- Parallel upload calls with different source/environment/database settings must not share request state or sockets.
- Direct upload errors and success responses must retain cache-control, request ID headers, and safe logging.
- Full retries must preserve hashes and pending acknowledgements; receipt changes must not apply listings synchronously.

### Task 1: Baseline and compatibility coverage

**Files:** `scripts/benchmark-upload-cpu.mjs`, `packages/protocol/test/schema.test.ts`, `docs/upload-performance.md`.

**Interfaces:** Consumes existing `createApp(env, database)`, `parseUploadRequest(input)` and the async full receipt. Produces reproducible synthetic request cases and canonical compatibility cases.

- [x] Build the web application and run the baseline suite with local subprocess permissions. Expected: all available tests pass; MySQL integration tests skip when no test database is configured.
- [x] Replace the legacy-only benchmark with validation and current full HTTP receipt scenarios, including duplicate and last-part dispatch paths. Measure multiple body sizes and options counts with process CPU; keep external storage synthetic and label its limits.
- [x] Run the benchmark before implementation and retain the result in ignored scratch.
- [x] Add canonical parser compatibility tests derived from literal boundary inputs and differential checks against the retained schema.

### Task 2: Specialized valid-input parser

**Files:** create `packages/protocol/src/fast-upload.ts`, modify `packages/protocol/src/schema.ts`; test `packages/protocol/test/fast-upload.test.ts`.

**Interfaces:** Produces `tryParseUploadRequest(input: unknown): UploadRequest | undefined`. `parseUploadRequest` uses it first and retains the Zod fallback for unsupported/invalid inputs and exact issue reporting.

- [x] Write tests for defaults, output field order, strict nested fields, dates, numeric ranges, non-mutation, and duplicate UUID/dismissed behavior. Run RED before implementing the parser.
- [x] Implement static linear validation and direct output construction. Reuse the schema's single root timestamp validator instead of independently redefining date acceptance.
- [x] Run differential valid/invalid cases, the protocol suite, and the benchmark. Expected: equivalent payload bytes/errors and lower validation CPU.
- [x] Commit the parser and its tests with the complete optimization branch.

### Task 3: Direct upload entry and compact receipt metadata

**Files:** `apps/worker/src/routes/upload.ts`, `apps/worker/src/index.ts`, `apps/worker/src/services/full-upload.ts`; tests in `apps/worker/test/upload-route.test.ts`, `mysql-worker-lifecycle.test.ts`, `full-upload-receipt.test.ts`.

**Interfaces:** Extract `uploadResponse(request, env, repo, state, handler?)` from the route and use it for both registered routes and the direct Worker upload entry. Keep every database invocation-scoped. Full receipts pass only `{ identityHash, shopId }` per shop to storage.

- [x] Write RED tests covering independent parallel upload contexts, request IDs, safe errors, body limits, and compact receipt identities with preserved payload hashes.
- [x] Extract the route handler with unchanged response behavior. Bypass application/router/service setup for POST upload; create the synchronous listing service only when needed.
- [x] Remove redundant post-schema structural traversals while keeping effective body limits, and omit unused identity canonical strings from stored metadata.
- [x] Run all tests and benchmark validation/current HTTP paths. Inspect the remaining costs before choosing database changes; record any deferred architecture work with its missing evidence.
- [x] Update CPU verification documentation, run lint/typecheck/build/docs and Worker dry-run checks, request an independent whole-branch review, and fix important findings.
- [ ] Commit and push the new branch, create the PR, and inspect its CI result.

## Execution notes

- Added a bounded source-scoped pure identity cache after measuring repeated identity costs. Cache hits, mutations, source changes, FIFO eviction, and missed-cache CPU are covered.
- Database stored procedures and client sharding are deferred: the harness excludes real mysql2/TLS cost, no test MySQL is configured, and OpenKore is outside this repository. No database/schema or upload contract changes are justified by the available evidence.
- See `docs/upload-performance.md` and its raw comparison data for measured scope and production verification requirements.

- Independent whole-branch review found no critical or important issue. Three minor findings were reproduced with failing tests and fixed: unusual accessor/iterator fallback, fixed body-limit error precedence, and declared-size request metrics. Final benchmark rerun includes these compatibility guards.
- Full checks before review: 361 tests passed, 8 MySQL integration tests skipped; lint, typecheck, web build, 58 documentation assertions, and production Worker dry-run passed. Final checks after review are recorded in the PR.
