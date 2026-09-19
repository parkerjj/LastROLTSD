# LastROWeb Agent Notes

## Final review status (2026-09-19)

- Scope remains Cloudflare Worker/Hono, D1/SQLite, Vite web UI, protocol fixtures, and documentation. No OpenKore source was modified, copied, compiled, bundled, or added as a runtime dependency.
- The implementation plan completion ledger marks Tasks 1-15 complete.
- Fresh verification from the deployment worktree passed: pnpm lint; pnpm typecheck; pnpm test (25 files, 102 tests); pnpm test:docs (14 assertions); pnpm --filter web build; Windows pnpm playwright test (2 browser tests); Wrangler production deploy --dry-run; and git diff --check.
- The fallback listing-option path is bounded: insertListingOptions sorts tuples, writes chunks of at most 12 rows, and counts six bound values per row. The 21-option regression test covers the former over-100-bound failure.
- The project and CI require the latest Node 24 release, declared by `.nvmrc` and the root `engines` field, with the repository's current pnpm version declared by `packageManager`. GitHub Actions uses checkout/setup-node v7 and pnpm/action-setup v6 so the actions themselves no longer depend on the deprecated Node 20 runtime.
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
6. The historical deployment/implementation branches mentioned above are context only. For the catalog/search work, work directly on `main`; do not create, switch to, or retain another branch or worktree, and do not use destructive reset or checkout commands.

## Safety reminders for future agents

- Never write under D:\openkore\ or any OpenKore project directory.
- Do not commit API keys, D1 IDs, production secrets, or real player data.
- Keep all source state scoped to authenticated source_id; do not trust client JSON source IDs.
- Maintain full/delta/heartbeat semantics, first-full baseline behavior, signed keyset cursors, transition-key idempotency, 512 KiB body / 16-part / 50-result limits, and chunked D1 writes.
- Use apply_patch for edits and write a failing test before production changes.

## Catalog/search architecture decisions (2026-09-19)

- The approved design is `docs/superpowers/specs/2026-09-19-lastroweb-catalog-search-design.md`; its implementation plan is `docs/superpowers/plans/2026-09-19-lastroweb-catalog-search-plan.md`.
- Protocol v2 uploads only live observations. Items contain `item_id`, optional `item_key`, price, quantity, upgrade, slots, card IDs, and raw `(option_type, option_value, option_param)` tuples. Items do not contain an authoritative Chinese name or description.
- Every v2 shop contains a required per-transfer `uuid` and `shop_status` (`opening` or `dismissed`), plus stable `vendor_account_id`, vendor/shop text, type, map, and coordinates. `shop_id` is optional client cache input and is never trusted as identity.
- The Worker computes a source-scoped canonical identity from identity version, authenticated `source_id`, vendor account ID, shop type, normalized map/title, and integer coordinates. It returns `shop_v1_<sha256>` and echoes every input UUID in the ordered upload response.
- A restarted client without `shop_id` must resolve the existing `(source_id, identity_hash)` row. A mismatched client ID is corrected, not used to create a second shop. Different sources never merge.
- `dismissed` is an explicit close event: atomically close the shop/session, expire active/missing listings, and write no sold event. Missing full/delta/heartbeat data is not dismissal. A stale opening cannot reopen a newer dismissal; a newer opening starts a new session.
- `item_catalog` and `item_aliases` own item names, descriptions, and aliases. Existing listings resolve names by item ID at read time and fall back to `未知物品 #<id>`; card IDs use the same catalog. Unknown item IDs remain valid rows.
- `option_definitions` is keyed by `option_type`, with label/template, value type, unit, scale, allowed operators, param policy, and repeat policy. Raw option tuples remain authoritative listing data; unknown option types remain visible as raw tuples.
- Chinese q search uses D1 FTS5 trigram for queries of three or more Unicode code points and `search_short_tokens` for one/two code points. Search uses indexed JOIN/EXISTS inside SQLite and never builds an application-side item-ID `IN` list.
- Search cursors bind normalized q mode, catalog/option/index versions, all filters, option semantics, sort, and keyset boundary. Catalog or option version changes invalidate old cursors.
- v1 compatibility is temporary through 2026-10-31. v1 `items[].name`, `shop_key`, and client option display text are never identity, fingerprint, display, search, or catalog authority. From 2026-11-01 the old upload/exact-option contract is rejected, subject to the migration plan's backup and deployment gate.
- The importer accepts only explicit external input files/directories, supports dry-run and deterministic checksums, reports encoding/duplicate/invalid-row errors, and writes generated production SQL/JSON only under ignored paths. It must not hard-code or write `D:\openkore`.

## Strict execution order for catalog/search work

1. Protocol v2 and shop identity primitives.
2. D1 catalog, option-definition, search-index, and shop-lifecycle migrations.
3. Source-scoped shop resolver and atomic lifecycle repository.
4. Ingestion response mapping and explicit opening/dismissed handling.
5. Listing fingerprint and catalog-aware response boundary.
6. Deterministic catalog/option importer and redacted fixtures.
7. Catalog apply service and derived FTS/token rebuilds.
8. Metadata-driven option API and condition compiler.
9. Catalog/alias/shop-text search and versioned cursors.
10. Item autocomplete and cache contract.
11. Vite query UI with server-defined option controls.
12. API documentation, v1 deprecation guard, and post-window legacy-column migration.
13. Full-flow, D1-budget, browser, CI, and final verification.

Do not skip ahead while an earlier task's focused tests or migration assertions fail. Do not run the legacy-column removal migration before 2026-11-01, a verified production backup, and an approved maintenance window. Work directly on `main`; do not create or retain another branch, worktree, or OpenKore dependency.
