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
