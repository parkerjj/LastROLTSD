# LastROWeb Agent Notes

## Final review status (2026-09-18)

- Scope remains Cloudflare Worker/Hono, D1/SQLite, Vite web UI, protocol fixtures, and documentation. No OpenKore source was modified, copied, compiled, bundled, or added as a runtime dependency.
- The implementation plan completion ledger marks Tasks 1-15 complete.
- Fresh verification from the current worktree passed: pnpm lint; pnpm typecheck; pnpm test (24 files, 94 tests); pnpm test:docs (14 assertions); pnpm --filter web build; pnpm playwright test (2 browser tests); and git diff --check.
- The fallback listing-option path is bounded: insertListingOptions sorts tuples, writes chunks of at most 12 rows, and counts six bound values per row. The 21-option regression test covers the former over-100-bound failure.
- WSL is available, but its distribution does not expose Node, npm, or pnpm; final commands ran with the repository Windows Node toolchain.

## Known non-blocking limitations

1. Concurrent first insertion of the same (session, fingerprint) can be won by another request after the initial lookup. INSERT OR IGNORE is idempotent, but the losing request does not perform a second reload or transition. A future integration test can harden this.
2. Bulk JSON1 paths use one JSON payload parameter and bounded statement counts. Monitor payload and SQL text size as limits evolve.
3. History and sold-event retention defaults to 90 days; evaluate D1 free quotas before production scale-up. Current listings are not deleted.
4. Wrangler/D1 migration smoke checks were reliable; programmatic Miniflare probing was not. Re-run a staging D1 smoke upload before production deployment.
5. Preserve the hardening changes on branch codex/lastroweb-implementation; do not use destructive reset or checkout commands.

## Safety reminders for future agents

- Never write under D:\openkore\ or any OpenKore project directory.
- Do not commit API keys, D1 IDs, production secrets, or real player data.
- Keep all source state scoped to authenticated source_id; do not trust client JSON source IDs.
- Maintain full/delta/heartbeat semantics, first-full baseline behavior, signed keyset cursors, transition-key idempotency, 512 KiB body / 16-part / 50-result limits, and chunked D1 writes.
- Use apply_patch for edits and write a failing test before production changes.
