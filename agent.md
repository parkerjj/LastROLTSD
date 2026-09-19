# LastROWeb Agent Notes

## Final review status (2026-09-19)

- Scope remains Cloudflare Worker/Hono, D1/SQLite, Vite web UI, protocol fixtures, and documentation. No OpenKore source was modified, copied, compiled, bundled, or added as a runtime dependency.
- The implementation plan completion ledger marks Tasks 1-15 complete.
- Fresh verification from the deployment worktree passed: pnpm lint; pnpm typecheck; pnpm test (25 files, 102 tests); pnpm test:docs (14 assertions); pnpm --filter web build; Windows pnpm playwright test (2 browser tests); Wrangler production deploy --dry-run; and git diff --check.
- The fallback listing-option path is bounded: insertListingOptions sorts tuples, writes chunks of at most 12 rows, and counts six bound values per row. The 21-option regression test covers the former over-100-bound failure.
- The project and CI require the latest Node 24 release, declared by `.nvmrc` and the root `engines` field, with pnpm 11.19.0 declared only by `packageManager`. GitHub Actions uses checkout/setup-node v7 and pnpm/action-setup v6 so the actions themselves no longer depend on the deprecated Node 20 runtime.
- WSL is Debian 2. Use `nvm install 24 && nvm alias default 24 && nvm use 24`; then verify non-interactive login shells with `wsl.exe -d Debian -- bash -lc 'node -v; npm -v; pnpm -v'`.

## Deployment automation handoff

- Branch `codex/deployment-automation` adds generated local/deployment credentials, a safe D1 source seed, temporary Wrangler config rendering, and GitHub Actions production deployment from `main`.
- `.dev.vars`, `.deployment-secrets.local`, `wrangler.*.local.toml`, and `source-seed.*.local.sql` are ignored. Never commit or print their contents.
- Production GitHub environment secrets are `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_D1_DATABASE_ID`. Worker secrets `CURSOR_SECRET` and `ADMIN_SECRET` are configured once with Wrangler and persist across deployments.
- GitHub Actions is the sole automatic deployment route. Do not also enable Cloudflare Git integration.
- Windows-managed Codex linked worktrees contain a Windows absolute `.git` pointer; WSL Git cannot operate inside them. Run Node/pnpm commands through WSL and Git commands with Windows Git, or use the main `/mnt/d/Development/LastROWeb` checkout directly in WSL.
- Playwright browser binaries are downloaded in WSL, but its system libraries still require the user to run `pnpm exec playwright install --with-deps chromium webkit` interactively with sudo. GitHub Actions installs both browser projects and their dependencies automatically.

## Known non-blocking limitations

1. Concurrent first insertion of the same (session, fingerprint) can be won by another request after the initial lookup. INSERT OR IGNORE is idempotent, but the losing request does not perform a second reload or transition. A future integration test can harden this.
2. History cursors are signed and listing queries remain path-scoped, but the cursor payload currently does not encode the listing ID. Reusing a valid cursor on another listing can skip older rows; bind cursors to listing IDs if strict cross-listing cursor isolation is required.
3. Bulk JSON1 paths use one JSON payload parameter and bounded statement counts. Monitor payload and SQL text size as limits evolve.
4. History and sold-event retention defaults to 90 days; evaluate D1 free quotas before production scale-up. Current listings are not deleted.
5. Wrangler/D1 migration smoke checks were reliable; programmatic Miniflare probing was not. Re-run a staging D1 smoke upload before production deployment.
6. Preserve the hardening changes on branch codex/lastroweb-implementation; do not use destructive reset or checkout commands.

## Safety reminders for future agents

- Never write under D:\openkore\ or any OpenKore project directory.
- Do not commit API keys, D1 IDs, production secrets, or real player data.
- Keep all source state scoped to authenticated source_id; do not trust client JSON source IDs.
- Maintain full/delta/heartbeat semantics, first-full baseline behavior, signed keyset cursors, transition-key idempotency, 512 KiB body / 16-part / 50-result limits, and chunked D1 writes.
- Use apply_patch for edits and write a failing test before production changes.
