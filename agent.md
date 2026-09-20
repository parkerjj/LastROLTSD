# LastROWeb Agent Notes

## Final review status (2026-09-19)

- Scope remains Cloudflare Worker/Hono, D1/SQLite, Vite web UI, protocol fixtures, and documentation. No OpenKore source was modified, copied, compiled, bundled, or added as a runtime dependency.
- The implementation plan completion ledger marks Tasks 1-15 complete.
- Fresh verification from this workspace passed: pnpm lint; pnpm typecheck; pnpm test (30 files, 124 tests); pnpm test:docs (44 assertions); pnpm --filter web build; Windows pnpm playwright test (2 browser tests); and git diff --check.
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

## Final integration and release review (2026-09-20)

- Final architecture is a single Hono Worker serving the Vite static UI and `/api/*`, with D1 migrations 0001-0009 applied in order. Protocol v2 carries only numeric item identity/observation fields and raw option tuples; catalog names, aliases, descriptions, and option display metadata are server-owned. Shop identity is source-scoped and session-scoped, and explicit dismissal closes only the authenticated source's shop/session.
- The deterministic importer entry point is `pnpm catalog:import -- --input-file <items-file> --description-file <descriptions-file> --kind items --version <release> --encoding auto --description-encoding auto --skip-empty-names --output-dir .generated\catalog\<release>`. Run `--dry-run` first, review the manifest and every `batchFiles` part, then apply the parts in manifest order with Wrangler. Reapplying the same release is idempotent and never rewrites listings.
- OpenKore agents must send `protocol_version: 2` to `POST /api/v1/market/upload`, use `Idempotency-Key: <snapshot_id>/<part_index>`, include a UUID and `shop_status` for every shop, and omit item names, aliases, descriptions, option labels, and display text. Items contain `item_id`, optional `item_key`, upgrade/slot/card IDs, price/quantity, and raw `(type,value,param)` options only. Full, delta, heartbeat, and dismissed semantics are defined authoritatively in `docs/api.md`.
- The release review includes a real local-D1 integration path in `tests/integration/catalog-upload-search-flow.test.ts`: it executes all migrations, invokes the importer on redacted fixtures, uploads a name-free baseline, searches `波利`, applies `ATK >= 50`, paginates, reads history, replays a delta without another sold event, and applies a catalog rename without re-uploading the listing.

### Known low-severity issues

1. A concurrent first insert of the same `(session, fingerprint)` can be won by another request after the initial lookup; the loser relies on idempotent `INSERT OR IGNORE` and does not reload/transition in that same request. Add a race-focused integration test before scaling concurrency.
2. History cursors are signed and listing queries are bounded, but the history cursor payload does not encode the listing ID. A valid cursor can therefore be reused across listing IDs and skip older rows; bind history cursors to the listing ID if strict cross-listing cursor isolation is required.
3. JSON1 bulk writes intentionally use one bounded JSON payload parameter. Reassess payload and SQL-size telemetry if the configured upload limits change.

### Deployment preflight

- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:docs`, `pnpm --filter web build`, `pnpm playwright test`, `pnpm exec wrangler deploy --dry-run`, `git diff --check`, and `git status --short` from Node 24.x/pnpm 12.4.2.
- Apply migrations to a disposable/local D1 first, run `PRAGMA foreign_key_check`, and inspect bounded `EXPLAIN QUERY PLAN` output before any remote verification. Do not run production catalog imports twice merely to verify them.
- Configure production `CURSOR_SECRET` and `ADMIN_SECRET` with Wrangler. GitHub Actions additionally requires `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_D1_DATABASE_ID`; source upload keys are seeded as hashes and are never committed.
- D1 Free capacity is a planning constraint: retain history and sold events for 90 days by default, never delete current listings, and obtain an explicit quota review before increasing upload volume, catalog size, or retention.
- This managed review host reported pnpm 11.19.0 even though the repository requires pnpm 12.4.2; its `pnpm exec` wrapper could not resolve the installed Playwright/Wrangler bins. The direct local Playwright and Wrangler entry points passed, so repeat the documented matrix with pnpm 12.4.2 before release.

## Remote D1 quota safety

- Never run an unbounded `COUNT(*)`, aggregate, table scan, index scan, or bulk diagnostic query against remote D1 merely to verify row totals. Full integrity and cardinality checks belong on local D1 or a disposable staging database.
- Before adding or manually running a remote `SELECT`, `UPDATE`, `DELETE`, or import, inspect its predicates and indexes locally with `EXPLAIN QUERY PLAN`. Production point checks must use a primary key, a selective indexed predicate, or a strict `LIMIT` whose plan is bounded.
- If a remote operation could read or write more than 100,000 rows, estimate the row cost first and obtain the user's explicit approval. This includes index rebuilds, catalog imports, migrations, maintenance, and verification queries.
- Verify catalog releases remotely through `catalog_state`, the recorded `catalog_versions.item_count` and checksums, plus a small primary-key or indexed sample. Do not recount `item_catalog`, `item_search_fts`, `search_short_tokens`, listings, history, or sold-event tables in production.
- Never rerun a production import only to verify it. Import once after review, then use bounded metadata and sample queries. A retry is allowed only to recover a known interrupted or failed idempotent apply.
- Keep remote writes chunked and bounded by the repository's existing statement, parameter, and invocation budgets. Do not use production as a load-test target.

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
- OpenKore agents must upload `protocol_version: 2`. There is no production v1 compatibility window: the earlier design was never deployed. v2 items omit client names and option display text; the server uses only item IDs, structured numeric fields, and raw option tuples for ingestion and identity.
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
12. API documentation, protocol-v2 contract, and legacy audit-column policy.
13. Full-flow, D1-budget, browser, CI, and final verification.

Do not skip ahead while an earlier task focused test or migration assertion fails. Legacy item/display columns may remain for audit, but runtime writes and reads must use catalog item IDs and raw option tuples. Work directly on `main`; do not create or retain another branch, worktree, or OpenKore dependency.
