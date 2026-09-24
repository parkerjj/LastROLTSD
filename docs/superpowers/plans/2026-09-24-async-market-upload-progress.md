# Execution Ledger

Plan: 2026-09-24-async-market-upload-plan.md
Base: d9103fe. Inline execution using executing-plans and TDD.

Pre-flight: Tasks 3-6 share repository, receipt, cursor and dispatch interfaces.
Ruling: Preserve applied migration checksums; add forward-only migrations instead of editing 001_initial.sql.
Ruling: Use the current checkout on a codex branch so the shared workspace remains reviewable; no deployment or push.
Ruling: A durable snapshot row owns stage/cursor/lease atomically; separate per-stage job rows add no recovery capability and are consolidated into that row.
Ruling: Queue sends are wakeups containing snapshot identity and generation, not payload. Cron claims one eligible chunk per invocation and recovers failed sends. Verify Free cron limits before configuring schedules.
Ruling: The earlier Queue estimates (35/39/83 messages) lacked a derivation. Recalculate from actual chunk/stage counts after implementation; do not claim a free-tier guarantee.

Task 1: complete. Boundary tests failed at 16 and passed at 64; 26 focused tests pass. Forward migration 004 preserves checksums.
Task 2: D1 source guard failed before removal. Removed only obsolete D1 runtime/tests; MySQL behavior coverage is retained and extended below.

Task 2: complete. D1 source guard and MySQL lifecycle checks passed (6 tests).
User constraint: implement code and perform static review only. Do not install/start MySQL or perform runtime integration tests. A downloaded, unextracted MySQL ZIP was removed; no installation or database initialization occurred. Further verification is static only.
Ruling: Public shop IDs are deterministic hashes and can be returned before resolving numeric database IDs. Receipt persists identities in snapshot staging; it does not change live market rows. Pending mappings explicitly use applied=false and resolution=pending; client compatibility must be documented.
Ruling: Use one minute-based recovery Cron plus the existing retention Cron: Workers Free permits five triggers per account, so five stage triggers plus retention would exceed that limit. Each recovery invocation still executes exactly one chunk.
Ruling: Missing inference and the corresponding listing mutation share one bounded transaction. A separate inference stage could lose or misinterpret an intervening delta; atomicity is more valuable than that stage name.
User correction: materialize exactly one client part per Queue invocation. Remove the proposed 20-shop/200-item/byte subdivision: the client controls materialization CPU through its shard configuration. Database reconciliation batch size remains independently configurable through SNAPSHOT_RECONCILE_BATCH_SIZE (default 200). This supersedes the original materialization chunk acceptance criteria and prevents any unconditional <10ms claim.

Tasks 3-6: implementation written. Snapshot row owns stage/cursor/generation/lease, receipt preserves public mappings, Queue consumes one client part or one reconciliation page per invocation, Cron recovers durable work, and admin status/requeue plus bounded staging cleanup are wired. Static TypeScript and focused ESLint passed before final review.
Final review: fresh read-only reviewer identified three issues: newer heartbeat/partial delta could suppress initial full inventory, reappearance could double-count sales, and permanently incomplete payloads lacked cleanup. No runtime verification was performed.
Final fixes: split inventory freshness from liveness; allow older full items to initialize absent listings while newer per-listing observations win. Explicit close/reopen epochs and newer completed shop baselines still block obsolete full content. Missing inference is suppressed behind newer inventory, and older content hashes cannot replace newer delta state.
Final fixes: missing/expired reappearance writes history but starts a new sale baseline; incomplete failed payloads enter bounded seven-day cleanup while receipt tombstones remain.
Ruling: reconcile shop closure before expiring absent-shop listings, so a newer heartbeat between chunks cannot prevent closure after the listings were already expired without a shop lifecycle boundary.
Ruling: source active_full_snapshot_id retains full-job ownership between chunks. A late older full or repaired failed job waits for the current full to finish instead of interleaving materialization with a newer reconciliation cursor. Delta/heartbeat still interleave between chunks under the source row lock.
Verification override: user requested static implementation/review only; regression tests may be added but not executed. Runtime SQL, Cloudflare delivery/CPU and external OpenKore pending-response behavior remain unverified. These are limitations, not passing results.

Tasks 3-7: implemented within the revised static-only scope. Final checks: `rtk proxy pnpm typecheck` exit 0; focused ESLint over Worker runtime, changed test files and docs-check script exit 0; `rtk proxy pnpm test:docs` passed 58 assertions; `rtk proxy git diff --check` exit 0. Receipt/reappearance regression cases are written but not executed after the user's restriction. No benchmark or runtime SQL result is claimed.
Final reviewer declined runtime CPU/MySQL execution/Cloudflare delivery/client compatibility judgments because the user excluded runtime verification; retain these as deployment validation gaps. Existing ignored local-config compatibility flags were outside the change and remain unchanged.
Branch kept locally without merge, push, deployment, or any production database change. The implementation remains reviewable in the shared checkout.
