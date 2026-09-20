# LastROWeb Catalog, Shop Identity, and Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate LastROWeb from client-supplied item metadata and exact option tuples to a server-owned item catalog, source-scoped stable shop IDs, explicit shop lifecycle events, Chinese catalog/search indexes, and metadata-driven option queries without breaking full/delta/heartbeat, idempotency, or D1 Free limits.

**Architecture:** Protocol v2 uploads only live observations and raw option tuples. The Worker resolves each shop through a canonical source-scoped identity, returns the client UUID with a stable server `shop_id`, and applies `opening` or `dismissed` atomically. D1 owns versioned item/alias/option definitions; FTS5 trigram indexes handle queries with three or more Unicode code points and a short-token table handles one- and two-code-point queries. Search stays inside SQLite using indexed `JOIN`/`EXISTS` predicates.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1/SQLite, FTS5, Vite, Zod, Vitest, Wrangler, Playwright, Node 24, pnpm 12.4.2.

**Spec:** `docs/superpowers/specs/2026-09-19-lastroweb-catalog-search-design.md`

## Global Constraints

- Do not modify, import, copy, compile, package, vendor, or add OpenKore source code; do not read from or write to `D:\openkore`.
- Work directly on `main`; do not create, switch to, or retain another branch or worktree.
- OpenKore uploads live observations only: item ID/key, price, quantity, upgrade, slots, card IDs, raw `(option_type, option_value, option_param)`, shop/vendor/location/time/snapshot fields, `shop_id?`, `shop_status`, and required per-transfer `uuid`.
- `item_catalog`, aliases, descriptions, option labels, display templates, and allowed operators are Worker/D1 authority; uploaded item names and option display text are never identity, display, or search authority.
- Preserve source isolation, first-complete-full baseline behavior, delta omission semantics, heartbeat liveness, 16-part snapshots, 512 KiB upload bodies, signed keyset cursors, idempotent batches, and bounded/chunked D1 writes.
- Unknown item IDs and unknown option types must be accepted and displayed through deterministic fallbacks.
- A `dismissed` shop expires active/missing listings and ends the current session without creating a sold event; omitted shops are not implicitly dismissed.
- Generated production SQL/JSON and importer outputs must be written only under ignored paths; commit only small redacted fixtures and schemas.
- Every implementation task follows TDD: write the named failing test, run the focused command and record the failure, implement the smallest change, run the focused command and relevant suite, then commit on `main`.
- No SQL query may receive more than 100 bound values or exceed 100 KiB; no listing search may use per-row N+1 queries or application-generated giant `IN` lists.

## Review Focus

- A restarted client omits `shop_id`, sends a changed or stale client `shop_id`, or retries the same UUID: the server returns one canonical `shop_id` without duplicate shops and preserves the original UUID mapping. Test in Tasks 1, 3, and 4.
- An explicit `dismissed` arrives beside a delayed `opening`, a missing full part, or a delta omission: only the correctly ordered explicit event closes the shop, and no false sold event is written. Test in Task 4.
- A listing has an unknown item ID, an unknown option type, or a catalog rename after upload: the row remains searchable and changes display through catalog/fallback data without a new fingerprint. Test in Task 5 and Task 7.
- A Chinese query is one, two, or three-plus Unicode code points and combines item text with shop/vendor text: the correct token/FTS path runs inside D1, with no application-side ID expansion. Test in Task 9.
- An option definition disallows an operator, scales a value, or repeats the same type: the API rejects invalid filters and applies the declared all/any/repeat policy using raw tuples. Test in Task 8 and Task 9.

---

### Task 1: Protocol v2, Normalization, and Shop Identity Primitives

**Files:**
- Modify: `packages/protocol/src/schema.ts`
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/normalize.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `apps/worker/src/domain/shop-identity.ts`
- Modify: `packages/protocol/test/schema.test.ts`
- Modify: `packages/protocol/test/normalize.test.ts`
- Create: `apps/worker/test/shop-identity.test.ts`
- Modify: `tests/fixtures/full-upload.json`
- Modify: `tests/fixtures/delta-upload.json`
- Modify: `tests/fixtures/heartbeat-upload.json`

**Interfaces:**
- `parseUploadRequest(input: unknown): UploadRequestV2 | UploadRequestV1Compat` validates the declared protocol version and returns a discriminated request type.
- `normalizeShopIdentity(input: ShopIdentityInput): NormalizedShopIdentity` returns the fixed canonical JSON string and normalized fields.
- `computeShopIdentity(input: ShopIdentityInput): Promise<{ identityHash: string; shopId: string; canonical: string }>` returns lowercase SHA-256 and `shop_v1_<hex>`.
- `normalizeItem` returns item data without a required or authoritative name and preserves only raw option tuples.

- [ ] **Step 1: Write failing v2 schema tests.** Add assertions for a v2 shop with `uuid`, `shop_status=opening`, `vendor_account_id`, optional `shop_id`, and an item without `name`; reject a missing UUID, invalid status, a dismissed shop with non-empty items, missing vendor account ID, and a client-supplied unknown item field.

```ts
it('accepts observation-only v2 items and shop resolution fields', () => {
  const parsed = parseUploadRequest(v2Fixture);
  expect(parsed.protocol_version).toBe(2);
  expect(parsed.shops[0]?.uuid).toMatch(/^[0-9a-f-]{36}$/);
  expect(parsed.shops[0]?.items[0]).not.toHaveProperty('name');
});

it('rejects a dismissed shop carrying listings', () => {
  expect(() => parseUploadRequest({ ...v2Fixture, shops: [{ ...v2Fixture.shops[0], shop_status: 'dismissed', items: [v2Fixture.shops[0].items[0]] }] })).toThrow();
});
```

- [ ] **Step 2: Run the focused protocol tests to verify failure.** Run `pnpm vitest run packages/protocol/test/schema.test.ts packages/protocol/test/normalize.test.ts`; expect failures because the current schema requires protocol 1 and `items[].name`.
- [ ] **Step 3: Write failing identity tests.** Assert NFKC, whitespace folding, stable case handling, integer coordinate serialization, vendor name exclusion, source isolation, changed title producing a different identity, and deterministic `shop_v1_` output.
- [ ] **Step 4: Implement v2 schema and v1 compatibility parsing.** Keep v1 parsing available until 2026-10-31; map v1 `shop_key`/`vendor_key` into a compatibility domain object, discard v1 `name` and `display_value` for all authority decisions, and reject v2 dismissed shops with items.
- [ ] **Step 5: Implement canonical identity and normalization.** Serialize keys in the order `identity_version`, `source_id`, `vendor_account_id`, `shop_type`, `map_name_normalized`, `x`, `y`, `title_normalized`; hash the UTF-8 canonical JSON with Web Crypto SHA-256.
- [ ] **Step 6: Update redacted fixtures and run the focused suite.** Run `pnpm vitest run packages/protocol/test apps/worker/test/shop-identity.test.ts`; expect all protocol and identity tests to pass and verify fixtures contain no credentials, real player data, or OpenKore source.
- [ ] **Step 7: Commit the protocol primitives.** Run `git add packages/protocol apps/worker/src/domain/shop-identity.ts apps/worker/test/shop-identity.test.ts tests/fixtures && git commit -m "feat: add catalog search protocol v2"`.

### Task 2: D1 Catalog, Option Definition, Search Index, and Shop Lifecycle Migrations

**Files:**
- Create: `migrations/0005_catalog_core.sql`
- Create: `migrations/0006_search_indexes.sql`
- Create: `migrations/0007_shop_identity_lifecycle.sql`
- Modify: `apps/worker/test/migrations.test.ts`
- Modify: `docs/deployment.md`

**Interfaces:**
- Migrations create `item_catalog`, `item_aliases`, `catalog_versions`, `catalog_state`, `option_definitions`, `search_short_tokens`, `item_search_fts`, and `shop_search_fts`.
- Migrations add nullable compatibility columns for `shops.identity_version`, `shops.identity_hash`, `shops.shop_id`, `shops.vendor_account_id`, `shops.close_reason`, `shops.last_status_observed_at`, and `shops.last_status_batch_id`.
- The migration leaves current `listings.item_name` data readable only for rollback inspection; no new task may use it as an authority field.

- [ ] **Step 1: Write failing migration assertions.** Assert all catalog/version/option tables, the `(source_id, identity_hash)` and `(source_id, shop_id)` uniqueness constraints, lifecycle columns, FTS5 virtual tables with `tokenize='trigram'`, and short-token primary keys.
- [ ] **Step 2: Run the migration test before implementation.** Run `pnpm vitest run apps/worker/test/migrations.test.ts`; record the missing table/index names.
- [ ] **Step 3: Create catalog and option-definition tables.** Use integer item IDs without a foreign key from listings, text versions/checksums, normalized names, alias kind, operator JSON, param policy JSON, repeat policy, scale, and deterministic timestamps.
- [ ] **Step 4: Create search indexes.** Define FTS5 tables with `item_id UNINDEXED`/`shop_id UNINDEXED` and indexed text, plus `search_short_tokens(scope_type, scope_id, token)`; add indexes for token lookup, catalog normalized names, aliases, option type, and shop status/identity.
- [ ] **Step 5: Add shop lifecycle columns and constraints.** Preserve existing session/listing/history tables, add explicit close reason/status timestamps, and reject duplicate identity rows before the unique index is applied in the migration smoke procedure.
- [ ] **Step 6: Run local migrations and commit.** Run `pnpm wrangler d1 migrations apply lastroweb-local --local` and `pnpm vitest run apps/worker/test/migrations.test.ts`; commit with `feat: add catalog and shop identity schema`.

### Task 3: Source-Scoped Shop Resolver and Atomic Lifecycle Repository

**Files:**
- Modify: `apps/worker/src/db/types.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/db/d1-repository.ts`
- Modify: `apps/worker/src/services/session-manager.ts`
- Create: `apps/worker/src/services/shop-lifecycle.ts`
- Create: `apps/worker/test/shop-lifecycle.test.ts`
- Modify: `apps/worker/test/d1-repository.test.ts`

**Interfaces:**
- `resolveShop(input: ShopResolutionInput): Promise<ShopResolution>` returns `{ shopId, internalShopId, identityHash, resolution, status, lastStatusObservedAt }`.
- `applyShopObservation(input: ShopObservation): Promise<ShopResolution>` resolves by `(source_id, identity_hash)`, ignores a mismatched client `shop_id`, and records the server response mapping.
- `dismissShop(input: DismissShopInput): Promise<DismissResult>` atomically closes the shop, ends the current session, expires active/missing listings, and returns zero sold events.
- `getOrStartShopSession` uses the resolved internal integer shop key and never the client UUID or external `shop_id` as a session foreign key.

- [ ] **Step 1: Write failing repository tests.** Cover first creation, restart without client shop ID, mismatched client shop ID correction, two sources with identical canonical fields, duplicate identity collision, and stale opening after a newer dismissed event.
- [ ] **Step 2: Write failing lifecycle tests.** Assert dismissed updates shop/session/listing states in one logical operation, writes no `sold_events`, preserves history rows, and a later newer opening starts a fresh session.
- [ ] **Step 3: Run the focused tests to verify failure.** Run `pnpm vitest run apps/worker/test/shop-lifecycle.test.ts apps/worker/test/d1-repository.test.ts`.
- [ ] **Step 4: Implement typed repository methods.** Add prepared statements for identity lookup/upsert and use `D1Database.batch()` for status transitions; never interpolate source IDs, hashes, titles, or UUIDs into SQL.
- [ ] **Step 5: Implement timestamp ordering.** Compare `observed_at` with `last_status_observed_at`; newer observations win, equal timestamps prefer dismissed, and stale opening returns `stale_event_ignored` without reopening the shop.
- [ ] **Step 6: Implement source-safe session transitions.** On dismissed, set `ended_at`, expire only the resolved shop session's active/missing listings, and do not call sold-event code; on a newer opening after closed, create a new session.
- [ ] **Step 7: Run repository and lifecycle tests and commit.** Run `pnpm vitest run apps/worker/test/shop-lifecycle.test.ts apps/worker/test/d1-repository.test.ts`; commit with `feat: resolve source-scoped shop identities`.

### Task 4: Ingestion v2, UUID-to-Shop Response, and Full/Delta/Heartbeat Semantics

**Files:**
- Modify: `apps/worker/src/services/ingestion.ts`
- Modify: `apps/worker/src/routes/upload.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/db/d1-repository.ts`
- Modify: `apps/worker/test/ingestion.test.ts`
- Modify: `apps/worker/test/upload-route.test.ts`
- Create: `tests/fixtures/dismissed-upload.json`

**Interfaces:**
- `UploadResult` adds `shops: ShopUploadResult[]`, preserving request order and the original `uuid`.
- `ingestUpload` accepts v1 compatibility and v2 requests, but routes all accepted data through the v2 domain representation.
- `ShopUploadResult` contains `uuid`, final `shop_id`, `shop_status`, `resolution`, and `applied`.

- [ ] **Step 1: Write failing ingestion tests.** Cover opening full, opening delta, v2 heartbeat, explicit dismissed, duplicate batch response, retry response, same shop in a restarted client without `shop_id`, stale opening, and source isolation.
- [ ] **Step 2: Add exact response assertions.** Assert `response.shops[i].uuid === request.shops[i].uuid`, the returned `shop_id` is stable across restart, duplicate responses preserve the original mapping, and `dismissed` returns `resolution: "dismissed"` with zero sold events.
- [ ] **Step 3: Run focused ingestion tests to verify failure.** Run `pnpm vitest run apps/worker/test/ingestion.test.ts apps/worker/test/upload-route.test.ts`; current code should fail because it indexes sessions by `shop_key` and returns no shop mappings.
- [ ] **Step 4: Implement v2 shop resolution before listing processing.** Resolve every shop through the lifecycle repository, reject duplicate UUIDs or duplicate canonical identities in one request/snapshot scope, and retain the ordered result array.
- [ ] **Step 5: Implement status-specific processing.** Opening processes items according to full/delta mode; heartbeat updates liveness only; dismissed requires empty items, applies the atomic close operation, and skips listing state/sold-event processing.
- [ ] **Step 6: Preserve batch idempotency.** Hash normalized v2 payload including UUIDs, return stored `response_json` for an identical retry, reject a reused canonical batch ID with a different UUID/payload, and keep `Idempotency-Key = snapshot_id/part_index`.
- [ ] **Step 7: Run focused and integration upload tests and commit.** Run `pnpm vitest run apps/worker/test/ingestion.test.ts apps/worker/test/upload-route.test.ts tests/integration/upload-flow.test.ts`; commit with `feat: return stable shop IDs from uploads`.

### Task 5: Remove Client Item Metadata from Listing Identity and Responses

**Files:**
- Modify: `apps/worker/src/domain/fingerprint.ts`
- Modify: `apps/worker/src/services/state-transition.ts`
- Modify: `apps/worker/src/services/ingestion.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/db/d1-repository.ts`
- Modify: `apps/worker/src/db/types.ts`
- Create: `apps/worker/src/domain/item-display.ts`
- Create: `apps/worker/test/item-display.test.ts`
- Modify: `apps/worker/test/fingerprint.test.ts`
- Modify: `apps/worker/test/state-transition.test.ts`

**Interfaces:**
- `computeItemFingerprint` accepts only source/session/item key/item ID/equipment fields/raw options.
- `resolveItemDisplay(itemId, catalogRow): ItemDisplay` returns catalog name or `未知物品 #<itemId>`.
- Listing creation and update inputs no longer require `itemName` or `itemNameNormalized`.

- [ ] **Step 1: Write failing fingerprint tests.** Pass two otherwise identical items with different client names and assert equal fingerprints; assert changing any raw tuple/equipment field changes the fingerprint; assert option labels and descriptions cannot reach the hash input.
- [ ] **Step 2: Write failing fallback tests.** Assert a known catalog row returns its canonical name and an absent row returns exactly `未知物品 #1234`; assert unknown card IDs use the same catalog fallback.
- [ ] **Step 3: Run focused tests to verify failure.** Run `pnpm vitest run apps/worker/test/fingerprint.test.ts apps/worker/test/item-display.test.ts apps/worker/test/state-transition.test.ts`.
- [ ] **Step 4: Remove item name from domain writes.** Stop normalizing or inserting v1/v2 upload names, keep any existing legacy database columns unused and nullable at the API boundary, and ensure listing history/fingerprint code never reads them.
- [ ] **Step 5: Add catalog-aware response mapping.** Make repository listing queries return item ID first and join catalog data at read time; use the fallback renderer for unknown IDs and preserve raw option tuples for unknown types.
- [ ] **Step 6: Run state, fingerprint, and integration tests and commit.** Run `pnpm vitest run apps/worker/test/fingerprint.test.ts apps/worker/test/state-transition.test.ts apps/worker/test/item-display.test.ts tests/integration`; commit with `refactor: remove client item metadata authority`.

### Task 6: Deterministic Static Catalog and Option Importer

**Files:**
- Create: `scripts/catalog-import.mjs`
- Create: `scripts/catalog-import-lib.mjs`
- Create: `scripts/catalog-import.test.mjs`
- Create: `tests/fixtures/catalog-items.json`
- Create: `tests/fixtures/catalog-options.json`
- Modify: `.gitignore`
- Modify: `package.json`
- Create: `docs/catalog-import.md`

**Interfaces:**
- CLI: `node scripts/catalog-import.mjs --input-file <path> --kind items|options --version <version> --output-dir <ignored-dir> [--encoding auto|utf8|utf8-bom|utf16le|utf16be] [--dry-run]`.
- `parseCatalogInput(buffer, metadata): ParsedCatalogInput` detects only declared/BOM/strict UTF-8 encodings and reports filename/line/field errors.
- `buildCatalogManifest(input): CatalogManifest` returns deterministic record counts, input checksums, importer version, data version, and output checksum.
- `renderCatalogSql(parsed): string` sorts records deterministically and never emits secrets, player data, shop observations, or absolute source paths.

- [ ] **Step 1: Write failing importer tests.** Cover UTF-8 BOM, UTF-16 BOM, explicit encoding, strict invalid UTF-8, duplicate item IDs, duplicate aliases, normalized alias collisions, invalid option definitions, dry-run with no output, deterministic output across runs, and output directory rejection when it is not an ignored/generated path.
- [ ] **Step 2: Run the importer tests to verify failure.** Run `node --test scripts/catalog-import.test.mjs`; expect missing CLI/library failures.
- [ ] **Step 3: Define redacted fixture schemas.** Use only synthetic IDs/names such as item `1234`/`测试剑` and option type `12`/`ATK +`; include aliases and an unknown-safe fixture row without any real player or shop values.
- [ ] **Step 4: Implement encoding and strict parsing.** Require explicit `--input-file` or `--input-dir`, support JSON/JSONL/CSV/TSV according to the documented field map, fail on undecidable encoding, and include filename/line/field in every validation error.
- [ ] **Step 5: Implement deterministic normalization and manifest generation.** Apply NFKC/whitespace normalization, sort by item ID/normalized alias/option type, compute SHA-256 checksums, and use a declared data version rather than current time.
- [ ] **Step 6: Implement dry-run and ignored output enforcement.** Dry-run prints counts/checksum summaries without writing SQL/JSON; normal output goes under `.generated/catalog/` or another explicitly ignored directory. Do not add any default path pointing to `D:\openkore`.
- [ ] **Step 7: Add scripts and fixtures to package checks and commit.** Run `node --test scripts/catalog-import.test.mjs` and `pnpm test:docs`; commit with `feat: add deterministic catalog importer`.

### Task 7: Catalog/Option Apply Service and Derived Index Rebuilds

**Files:**
- Create: `apps/worker/src/services/catalog-service.ts`
- Create: `apps/worker/src/services/search-index-service.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/db/d1-repository.ts`
- Modify: `migrations/0005_catalog_core.sql`
- Modify: `migrations/0006_search_indexes.sql`
- Create: `apps/worker/test/catalog-service.test.ts`
- Create: `apps/worker/test/search-index-service.test.ts`

**Interfaces:**
- `applyCatalogRelease(input: CatalogRelease): Promise<CatalogApplyResult>` validates checksum/version and updates catalog, aliases, version state, FTS rows, and short tokens atomically in bounded chunks.
- `rebuildItemSearchIndex(itemIds?: number[]): Promise<number>` rebuilds canonical names, aliases, and searchable descriptions.
- `rebuildShopSearchIndex(shopIds?: number[]): Promise<number>` rebuilds title/vendor text after shop observation changes.
- `getCurrentCatalogVersion(): Promise<string>` and `getCurrentOptionVersion(): Promise<string>` feed API responses and cursors.

- [ ] **Step 1: Write failing catalog update tests.** Insert a listing with item ID 1234, apply catalog version A, assert the response name is version A, apply version B without uploading the listing again, and assert the same listing returns version B with the same fingerprint/listing ID.
- [ ] **Step 2: Write failing index rebuild tests.** Assert an item name/alias produces FTS and one/two-character tokens, a shop title/vendor update replaces its derived row, and rebuilding twice produces identical row counts/content.
- [ ] **Step 3: Run focused tests to verify failure.** Run `pnpm vitest run apps/worker/test/catalog-service.test.ts apps/worker/test/search-index-service.test.ts`.
- [ ] **Step 4: Implement bounded catalog release application.** Load one generated release, verify manifest checksum and version, upsert catalog/alias/definition rows with JSON1 or bounded batches, and update the active version only after all rows and indexes succeed.
- [ ] **Step 5: Implement FTS5 and short-token rebuilds.** Delete/reinsert only affected derived rows, generate tokens by Unicode code point rather than UTF-8 bytes, and keep statement/bind counts within repository assertions.
- [ ] **Step 6: Add a local apply command and run the regression suite.** Provide `pnpm catalog:apply -- --input-dir <ignored-dir> --version <version>` for local/staging use, run `pnpm test`, and commit with `feat: apply versioned catalog releases`.

### Task 8: Metadata-Driven Option API and Query Condition Compiler

**Files:**
- Modify: `apps/worker/src/domain/search.ts`
- Create: `apps/worker/src/domain/option-conditions.ts`
- Modify: `apps/worker/src/routes/options.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/db/d1-repository.ts`
- Modify: `packages/protocol/src/types.ts`
- Create: `apps/worker/test/option-conditions.test.ts`
- Modify: `apps/worker/test/options.test.ts`

**Interfaces:**
- `parseOptionCondition(raw: string, definitions: OptionDefinitionMap): OptionCondition` parses `<type>:<operator>:<value>[:<param>]` and applies scale/param validation.
- `compileOptionPredicates(conditions, mode, definitions): CompiledOptionPredicate` returns SQL fragments selected from a fixed operator map plus bound values; it never accepts raw SQL operators.
- `getOptionDefinitions(version?: string): Promise<OptionDefinition[]>` returns the new metadata model with ETag material.
- `OptionDefinition` includes `type`, `handle`, `labelZh`, `valueType`, `unit`, `scale`, `allowedOperators`, `paramPolicy`, `repeatPolicy`, and `displayTemplate`.

- [ ] **Step 1: Write failing condition tests.** Cover `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, invalid operators, integer/scaled values, exponent rejection, missing/forbidden params, all/any, and same/distinct repeat policies.
- [ ] **Step 2: Write failing route tests.** Assert `/api/v1/options` returns type-level definitions, no exact tuple dictionary rows, a version, ETag, and 24-hour cache headers.
- [ ] **Step 3: Run focused tests to verify failure.** Run `pnpm vitest run apps/worker/test/option-conditions.test.ts apps/worker/test/options.test.ts`.
- [ ] **Step 4: Implement metadata parsing and fixed operator compilation.** Use an allowlist mapping operator names to SQL fragments; convert scaled decimal input to integers before binding; apply `param_policy` and `repeat_policy` from the server definition.
- [ ] **Step 5: Implement `/api/v1/options` response and ETag.** Return only current definitions sorted by option type/handle; derive ETag from the version and stable response JSON; honor `If-None-Match` with 304.
- [ ] **Step 6: Keep old exact tuple filters in a bounded compatibility path.** Parse old `option_type/option_value/option_param` as one `eq` condition until 2026-10-31, reject mixing old and new encodings, and mark the old path deprecated in the response/docs.
- [ ] **Step 7: Run option tests and commit.** Run `pnpm vitest run apps/worker/test/option-conditions.test.ts apps/worker/test/options.test.ts`; commit with `feat: add metadata-driven option filters`.

### Task 9: D1 Search with Catalog/Alias/Shop Text and Versioned Cursors

**Files:**
- Modify: `apps/worker/src/domain/search.ts`
- Modify: `apps/worker/src/routes/search.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/db/d1-repository.ts`
- Modify: `apps/worker/src/db/types.ts`
- Modify: `apps/worker/test/search.test.ts`
- Modify: `apps/worker/test/d1-repository.test.ts`
- Modify: `tests/integration/search-flow.test.ts`

**Interfaces:**
- `SearchFilters` contains normalized `q`, `qMode`, catalog/option/index versions, up to eight compiled option conditions, all/any mode, item/price/map/shop/status filters, limit, sort, and cursor.
- `searchCursorContext(filters): string` includes all normalized filters plus active catalog/option/index versions.
- `searchListings(filters): Promise<SearchPage<ListingSearchResult>>` returns catalog fallback fields, shop ID/status, raw/defined options, and no client item name.

- [ ] **Step 1: Write failing parser tests.** Cover q normalization, empty q, one/two/three-code-point mode selection, q length, old/new option conflict, eight-condition cap, limit 1..50, and cursor rejection when any filter or version changes.
- [ ] **Step 2: Write failing repository search tests.** Assert generated SQL contains catalog/alias/shop FTS or short-token `EXISTS`, joins item ID rather than listing name, uses bound values, contains no application-built item ID list, and hydrates options in one bounded query.
- [ ] **Step 3: Run focused search tests to verify failure.** Run `pnpm vitest run apps/worker/test/search.test.ts apps/worker/test/d1-repository.test.ts tests/integration/search-flow.test.ts`.
- [ ] **Step 4: Implement q mode selection.** Count Unicode code points after NFKC/space normalization; use short-token EXISTS for lengths 1–2 and FTS5 MATCH EXISTS for lengths 3+; combine item and shop/vendor matches with OR while preserving status/session predicates.
- [ ] **Step 5: Implement catalog-aware listing SQL.** `LEFT JOIN item_catalog`, use `COALESCE(canonical_name_zh, '未知物品 #' || l.item_id)` in the response mapping, join shop/vendor text only from current shop rows, and exclude closed/dismissed shops even when `include_stale=true`.
- [ ] **Step 6: Implement option predicate SQL.** Use `EXISTS` for raw tuple comparisons and the declared same/distinct repeat policy; bind every value and keep all generated statements within repository bound/SQL assertions.
- [ ] **Step 7: Implement signed versioned keyset cursors.** Include normalized q mode, catalog/option/index versions, all filters, sort, last sort value, and last listing ID; reject a cursor with any mismatch before querying D1.
- [ ] **Step 8: Run search and integration tests and commit.** Run `pnpm vitest run apps/worker/test/search.test.ts apps/worker/test/d1-repository.test.ts tests/integration/search-flow.test.ts`; commit with `feat: search catalog and raw option observations`.

### Task 10: Item Autocomplete Endpoint and Cache Contract

**Files:**
- Create: `apps/worker/src/routes/items.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/middleware/cache.ts`
- Create: `apps/worker/test/items.test.ts`
- Modify: `apps/worker/test/cache.test.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/db/d1-repository.ts`

**Interfaces:**
- `GET /api/v1/items?q=<text>&limit=1..20` returns `{ version, items: [{ itemId, name, aliases }] }`.
- `searchItemsAutocomplete(q, limit): Promise<ItemAutocompletePage>` searches catalog/aliases only, never listings or uploaded names.

- [ ] **Step 1: Write failing endpoint tests.** Cover item name match, alias match, one/two-character token search, unknown query, limit clamp/rejection, unknown item absence, ETag, and 24-hour cache headers.
- [ ] **Step 2: Run focused tests to verify failure.** Run `pnpm vitest run apps/worker/test/items.test.ts apps/worker/test/cache.test.ts`.
- [ ] **Step 3: Implement bounded catalog autocomplete.** Use catalog and alias short tokens/FTS, sort by exact normalized name then item ID, bind the 20-row limit, and return the active catalog version.
- [ ] **Step 4: Wire route and ETag caching.** Add the route before SPA fallback, return 304 for a matching ETag, and keep upload responses `no-store` and market search at 30 seconds.
- [ ] **Step 5: Run endpoint tests and commit.** Run `pnpm vitest run apps/worker/test/items.test.ts apps/worker/test/cache.test.ts`; commit with `feat: add item catalog autocomplete`.

### Task 11: Vite Query UI with Server-Defined Option Controls

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/state.ts`
- Modify: `apps/web/src/query-form.ts`
- Modify: `apps/web/src/render.ts`
- Modify: `apps/web/src/main.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/test/query-ui.test.ts`
- Modify: `tests/browser/query.spec.ts`

**Interfaces:**
- `MarketApi.getOptions(): Promise<OptionDefinitionsResponse>` and `MarketApi.getItems(q): Promise<ItemAutocompletePage>` use ETag-aware same-origin requests.
- `serializeSearchForm(form, definitions): SearchFilters` emits repeated `option=<type>:<operator>:<value>[:<param>]` values and `option_mode`.
- `renderOptionRow(definitions, condition): HTMLElement` exposes only allowed Chinese labels/operators and a numeric value input.

- [ ] **Step 1: Write failing UI tests.** Assert initial metadata load, a row shaped as `[中文词条下拉框] [比较符下拉框] [数值输入]`, operator filtering per definition, all/any serialization, catalog autocomplete selection, unknown item fallback rendering, loading/empty/error states, and cursor pagination preserving filters.
- [ ] **Step 2: Run UI tests to verify failure.** Run `pnpm vitest run apps/web/test/query-ui.test.ts`.
- [ ] **Step 3: Implement metadata loading and form state.** Load `/api/v1/options` before enabling option rows, rebuild operator choices when the selected type changes, show param input only when `param_policy.filterable` is true, and never hard-code labels.
- [ ] **Step 4: Implement query serialization and result rendering.** Send new option query encoding, render catalog names/fallbacks, raw unknown options, shop ID/status and observed time, and keep active/dismissed status visible without showing closed results by default.
- [ ] **Step 5: Run UI tests and production build.** Run `pnpm vitest run apps/web/test/query-ui.test.ts` and `pnpm --filter web build`.
- [ ] **Step 6: Commit the UI migration.** Run `git add apps/web tests/browser/query.spec.ts && git commit -m "feat: add metadata-driven option query UI"`.

### Task 12: API Documentation, v1 Deprecation, and Legacy Column Cutover

**Files:**
- Modify: `docs/api.md`
- Modify: `docs/deployment.md`
- Modify: `scripts/check-docs.mjs`
- Modify: `tests/fixtures/full-upload.json`
- Modify: `tests/fixtures/delta-upload.json`
- Modify: `tests/fixtures/heartbeat-upload.json`
- Create: `tests/fixtures/dismissed-upload.json`
- Create: `migrations/0008_remove_legacy_item_names.sql`
- Modify: `apps/worker/src/routes/upload.ts`
- Modify: `apps/worker/src/domain/search.ts`
- Modify: `apps/worker/test/migrations.test.ts`
- Modify: `apps/worker/test/upload-route.test.ts`
- Modify: `apps/worker/test/search.test.ts`

**Interfaces:**
- `docs/api.md` becomes the v2 contract for the external adapter and documents v1 compatibility through 2026-10-31 and rejection from 2026-11-01.
- `scripts/check-docs.mjs` verifies v2 fields, UUID response mapping, dismissed semantics, catalog authority, option query syntax, autocomplete route, deprecation dates, and OpenKore prohibition.
- `migrations/0008_remove_legacy_item_names.sql` is executed only after the v1 window and a production backup; it rebuilds `listings` without `item_name`/`item_name_normalized` rather than using a destructive reset.

- [ ] **Step 1: Write failing documentation assertions.** Require `protocol_version: 2`, no v2 `items[].name`, `shop_id`, `uuid`, `shop_status`, response `shops[]`, `GET /api/v1/items`, `option=<type>:<operator>:<value>`, fallback names, explicit close behavior, limits, and exact dates `2026-10-31`/`2026-11-01`.
- [ ] **Step 2: Run the documentation check to verify failure.** Run `pnpm test:docs`; the old API examples and assertions must fail until rewritten.
- [ ] **Step 3: Rewrite API and fixture documentation.** Include redacted v2 full/delta/heartbeat/dismissed examples, retry mapping, restart dedupe, catalog/option authority, one/two/three-character q behavior, cache/ETag, and no OpenKore source/runtime dependency.
- [ ] **Step 4: Add v1 cutoff guards.** Before the cutoff, emit a deterministic deprecation error/header for v1 and old exact option parameters when configured for enforcement; from 2026-11-01, reject them with a documented protocol error.
- [ ] **Step 5: Write the post-cutover migration test and migration.** Assert the legacy columns are absent after the table rebuild while item ID, fingerprint, history, option, and foreign-key data remain intact. Do not run this migration in production before the date gate and backup check.
- [ ] **Step 6: Run docs, migration, route, and search tests and commit.** Run `pnpm test:docs` and `pnpm vitest run apps/worker/test/migrations.test.ts apps/worker/test/upload-route.test.ts apps/worker/test/search.test.ts`; commit with `docs: publish catalog search v2 contract`.

### Task 13: Full-Flow, D1 Budget, Browser, and Prohibition Verification

**Files:**
- Modify: `tests/integration/upload-flow.test.ts`
- Modify: `tests/integration/search-flow.test.ts`
- Modify: `tests/browser/query.spec.ts`
- Modify: `apps/worker/test/limits.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `agent.md`

**Interfaces:**
- Integration tests use real local D1 migrations and the Hono app, not a fake repository, for shop identity, catalog JOIN, FTS/token search, options, lifecycle, and cursor behavior.
- CI verifies TypeScript, lint, unit/integration tests, docs, web build, browser tests, and repository policy scans without accessing any OpenKore path.

- [ ] **Step 1: Add full-flow upload assertions.** Cover first full baseline, multi-part full completion, delta quantity decrease, explicit dismissed with zero sold events, delayed opening ignored, restart without shop ID, mismatched shop ID correction, duplicate batch response, and two-source isolation.
- [ ] **Step 2: Add full-flow search assertions.** Seed `波利卡片`, `波利帽`, an alias, a shop title, a vendor name, an unknown item ID, and an unknown option type; assert q searches return the correct listings using catalog/alias/shop text and fallback output.
- [ ] **Step 3: Add option/cursor assertions.** Cover `ATK + >= 50`, disallowed operators, all/any, same/distinct repeated types, catalog version changes invalidating cursors, and no offset/giant-IN path.
- [ ] **Step 4: Add D1 budget assertions.** Keep body 512 KiB, parts 16, page 50, options 8, statement count <=45, bound values <=100, and SQL length <=100 KiB; assert option hydration uses a bounded batch query.
- [ ] **Step 5: Run all verification commands.** Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:docs`, `pnpm --filter web build`, and `pnpm playwright test`; all must exit 0. Run `git diff --check` and verify no path under `D:\openkore` was read or changed.
- [ ] **Step 6: Update CI and commit the verification package.** Add migration/test/build/browser commands to `.github/workflows/ci.yml`, run the full suite again, and commit with `test: verify catalog and shop lifecycle migration`.

## Strict Execution Order

1. Task 1: protocol v2 and identity primitives.
2. Task 2: D1 schema migrations.
3. Task 3: repository shop resolver and lifecycle transitions.
4. Task 4: ingestion response mapping and explicit status handling.
5. Task 5: listing fingerprint and catalog-aware response boundary.
6. Task 6: importer and redacted fixtures.
7. Task 7: catalog apply and derived index maintenance.
8. Task 8: option definitions and condition compiler.
9. Task 9: D1 search and signed cursor context.
10. Task 10: item autocomplete and cache contract.
11. Task 11: query UI.
12. Task 12: API docs, v1 cutoff guard, and post-window legacy cleanup migration.
13. Task 13: integration, budget, browser, CI, and final verification.

Do not start a later task while an earlier task's focused tests or migration assertions fail. Do not execute Task 12's legacy-column removal migration before 2026-11-01, a verified backup, and an explicit production maintenance window. Keep every implementation commit on `main`; do not push unless the user separately requests it.

## Final Acceptance Criteria

- A v2 full/delta/heartbeat upload returns every input UUID with one stable server `shop_id`; a restarted client without `shop_id` does not duplicate the shop.
- A dismissed shop is excluded from current search, its active/missing listings become expired, and no sold event is recorded; missing delta/full data still follows the existing semantics.
- Listing fingerprints never depend on uploaded names, descriptions, aliases, option labels, or display text.
- Catalog/alias changes update existing listing display names without another upload; unknown IDs remain queryable as `未知物品 #<id>`.
- Unknown raw option tuples remain stored and visible; valid option filters use server-defined operators, scale, param policy, and repeat policy.
- One/two-character and three-plus-character Chinese q searches use their respective indexed D1 paths; no application-side giant `IN` list exists.
- Search cursors bind normalized filters and catalog/option/index versions; changed context rejects the cursor.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:docs`, `pnpm --filter web build`, `pnpm playwright test`, and `git diff --check` pass.
- No OpenKore file, source tree, generated real data, secret, or `D:\openkore` runtime dependency enters the repository.

## Completion Ledger (Final Integration Review)

- [x] Tasks 1-13: protocol v2, migrations, source-scoped shop lifecycle, importer, catalog/option search, metadata-driven UI, documentation, and CI verification completed on `main`.
- [x] Real local-D1 end-to-end path added: migration from empty SQLite, catalog import, name-free full upload, Chinese catalog search, option filter, keyset pagination, history, idempotent replay, heartbeat, and catalog rename without re-upload.
- [x] Final review fixed D1 bulk transition confirmation so successful updates are not reported as state conflicts when batch `run()` omits `RETURNING` rows.
- [x] Final release command matrix and deployment safety review recorded in `agent.md`; no production upload, push, or deployment performed.
