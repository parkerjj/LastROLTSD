# LastROWeb Market Resource Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留两字符任意子串搜索、物品联想、价格/库存历史、sold inference、multipart full、幂等和 option filters 的前提下，把常规 upload/search 的 D1 rows read、rows written 与 Worker CPU 限制在小集合内。

**Architecture:** catalog 与 option definitions 改为版本化构建产物，物品联想和 item name substring 解析在浏览器完成；D1 只保存动态 market 状态。upload 以 shop 级 `profile_hash`/`full_state_hash` 判断变化，hash 相同的 shop 不读取 listings；full finalize 只扫描 active/stale shops 和最多 16 个 batch part。搜索扫描 active-shop partial covering index，再按候选 `item_id/shop_id` 走 listing partial indexes。

**Tech Stack:** TypeScript 5.7、Hono、Cloudflare Workers、D1/SQLite、Vite 6、Vitest 3、Node.js 24、pnpm 12。

**Spec:** `docs/designs/2026-09-21-market-ingestion-write-amplification.md`

## Global Constraints

- 不访问或修改 production D1；实现与验证全部使用本地 D1/SQLite fixture，远端重建由发布人员单独执行。
- 允许清空并重建数据库；不保留旧 schema、旧 cursor、旧 `qMode` 或旧 API response 的兼容层。
- 文本搜索最少 2 个 Unicode 字符，必须支持 item name/alias、shop title、vendor name 的任意位置 substring。
- autocomplete 只搜索 item name、alias 和 item ID；输入阶段不得请求 D1。
- 正常出现且内容未变化的 shop/listing 不得写 D1；accepted retry 不得产生业务写入。
- full snapshot 只有全部 parts accepted 后才允许执行 shop missing/close；partial、乱序和重复 part 不得关闭 shop。
- listing state 继续使用乐观版本控制；history/sold transition 必须幂等。
- 不引入外部搜索服务、Durable Object、KV 或 R2；只有实测超过当前架构边界后才重新评估。
- 所有 SQL 查询必须有 rows-read 预算、所有 mutation 必须有 rows-written 预算；不能把 SQLite `changes` 当成 D1 `rows_written`。

## Product Decisions Required Before Task 2

计划采用以下四项资源边界。若不同意，先停止执行 Task 2 之后的工作并重新设计对应功能：

1. 删除逐 listing 的精确 `last_seen_at` 和 `updated_desc`，改为 `last_changed_at`/`changed_desc`，页面另行展示 source 级 `last_full_snapshot_at`。保留精确 listing last-seen 会强制每次 full 写全部 listings，和本计划目标冲突。
2. 客户端 item substring 最多向搜索 API 提交 200 个候选 item IDs；shop/vendor 候选最多 100 个。超过上限时显示“匹配范围过大，请继续输入”，不执行 listing 查询。取消上限会允许常见两字符 query 扫描大范围 listings。
3. 删除 shop session 概念；同一物理 shop 关闭后重开时，fingerprint 相同的 listing 延续同一条 history。若必须把每次开店视为独立 session，就需要恢复 session row、session lookup 和 reopen/expire 写入。
4. `listing_events` 默认保留 180 天，`upload_batches` 保留 30 天。若要求永久历史，需接受数据库持续增长并另行设计归档，而不能让公共查询直接扫描无限历史。

## Target Resource Budgets

| 场景 | D1 logical rows read | D1 logical rows written | Worker CPU |
|---|---:|---:|---|
| autocomplete 每次按键 | 0 | 0 | 浏览器 `includes`，2 字符门槛，150ms debounce |
| accepted retry | 1 batch row | 0 | payload hash + response decode |
| no-change full，400 shops/4000 listings/16 parts | 每 part 对应 shop rows；finalize 最多 16 batch + 400 shop rows；0 listing rows | `2 * parts + 1 source`，0 shop/listing/event/options | 规范化、fingerprint、每 shop 一个 SHA-256；不做 listing diff |
| 10 listings 变化且分布在 3 shops | 上述 + 3 shops 的 listing rows | 10 listings + 10 events + 最多 3 shop hash rows + batch/source | 只对 3 shops 做内存 diff |
| 3 shops 首次缺失 | 最多 16 batch + 400 shop rows | 3 shop rows + 1 source | 400 个整数集合比较 |
| 正式文本搜索 | 最多 400 active-shop index rows + 候选 listing/index rows + 当前页 options | 0 | q 规范化、cursor HMAC、最多 20/50 条渲染 |
| catalog 发布 | 0 | 0 | 离线生成 versioned JSON；D1 无 catalog 写入 |

---

### Task 1: Add Resource-Metering Test Infrastructure

**Files:**
- Create: `apps/worker/src/db/d1-meter.ts`
- Modify: `apps/worker/src/db/d1-repository.ts:9-14`
- Modify: `apps/worker/src/index.ts:18-41`
- Modify: `apps/worker/src/observability.ts:1-28`
- Test: `apps/worker/test/d1-meter.test.ts`
- Test: `apps/worker/test/resource-budgets.test.ts`

**Interfaces:**
- Produces: `D1Meter.record(stage, meta)`, `D1Meter.snapshot()`, `D1Usage`.
- Consumes: D1 `meta.rows_read`, `meta.rows_written`, `meta.changes`, `meta.duration` from `.all()`/`.run()` results.

- [x] **Step 1: Write failing meter tests**

```typescript
it('tracks rows independently from changes', () => {
  const meter = createD1Meter();
  meter.record('listing_diff', { rows_read: 12, rows_written: 4, changes: 1, duration: 0.8 });
  expect(meter.snapshot()).toEqual({ rowsRead: 12, rowsWritten: 4, changes: 1, durationMs: 0.8, stages: { listing_diff: { rowsRead: 12, rowsWritten: 4, changes: 1, durationMs: 0.8 } } });
});
```

- [x] **Step 2: Run the tests and verify failure**

Run: `rtk pnpm exec vitest run apps/worker/test/d1-meter.test.ts`

Expected: FAIL because `d1-meter.ts` does not exist.

- [x] **Step 3: Implement the meter and repository wrappers**

```typescript
export interface D1UsageBucket { rowsRead: number; rowsWritten: number; changes: number; durationMs: number; }
export interface D1Usage extends D1UsageBucket { stages: Record<string, D1UsageBucket>; }
export interface D1MetaLike { rows_read?: number; rows_written?: number; changes?: number; duration?: number; }

export function createD1Meter() {
  const usage: D1Usage = { rowsRead: 0, rowsWritten: 0, changes: 0, durationMs: 0, stages: {} };
  return {
    record(stage: string, meta: D1MetaLike | undefined): void {
      const bucket = usage.stages[stage] ??= { rowsRead: 0, rowsWritten: 0, changes: 0, durationMs: 0 };
      const next = { rowsRead: Number(meta?.rows_read ?? 0), rowsWritten: Number(meta?.rows_written ?? 0), changes: Number(meta?.changes ?? 0), durationMs: Number(meta?.duration ?? 0) };
      usage.rowsRead += next.rowsRead; usage.rowsWritten += next.rowsWritten; usage.changes += next.changes; usage.durationMs += next.durationMs;
      bucket.rowsRead += next.rowsRead; bucket.rowsWritten += next.rowsWritten; bucket.changes += next.changes; bucket.durationMs += next.durationMs;
    },
    snapshot(): D1Usage { return structuredClone(usage); },
    reset(): void { usage.rowsRead = 0; usage.rowsWritten = 0; usage.changes = 0; usage.durationMs = 0; usage.stages = {}; },
  };
}
```

Refactor repository helper `one()` to call `.all<T>()` and take `results[0]` so its meta is available. `createApp()` creates one meter, passes it to `createD1Repository()`, resets it at request start, and reads it in the existing request-finally middleware. The production entrypoint constructs one app per fetch; tests that reuse an app must remain sequential when asserting metrics. Do not emit one log per SQL statement. Aggregate per upload/search and add the totals to the existing `lastroweb.request` log as `rows_read`, `rows_written`, `d1_duration_ms` and stage totals. Sample full stage details at 5%; always log when a request exceeds 5,000 rows read, 500 rows written, or 30ms D1 duration.

- [x] **Step 4: Add fixture-level budget assertions**

Create a fake D1 result factory that supplies configurable meta and assert that `rows_written=8` remains 8 when `changes=1`. Add helpers `expectUsageAtMost(actual, budget)` and `expectStageWrites(actual, stage, expected)`.

- [x] **Step 5: Verify**

Run: `rtk pnpm exec vitest run apps/worker/test/d1-meter.test.ts apps/worker/test/resource-budgets.test.ts`

Expected: PASS.

```bash
rtk git add apps/worker/src/db/d1-meter.ts apps/worker/src/db/d1-repository.ts apps/worker/src/index.ts apps/worker/src/observability.ts apps/worker/test/d1-meter.test.ts apps/worker/test/resource-budgets.test.ts
rtk git commit -m "test: meter D1 resource usage"
```

### Task 2: Replace the Database With the Minimal Dynamic-Market Schema

**Files:**
- Replace: `migrations/0001_initial.sql`
- Delete: `migrations/0002_indexes.sql` through `migrations/0010_official_lastro_70_83_option_definitions.sql`
- Modify: `apps/worker/test/migrations.test.ts`
- Modify: `scripts/render-source-seed.mjs`

**Interfaces:**
- Produces: `market_sources`, `shops`, `listings`, `listing_options`, `listing_events`, `upload_batches`.
- Removes: vendors, sessions, catalog, option dictionary, FTS, token and snapshot-session persistence.

- [x] **Step 1: Write schema-shape tests**

Assert the exact six tables, foreign keys, partial indexes and absence of obsolete objects:

```typescript
expect(objects.filter((row) => row.type === 'table').map((row) => row.name)).toEqual([
  'listing_events', 'listing_options', 'listings', 'market_sources', 'shops', 'upload_batches',
]);
for (const removed of ['vendors','shop_sessions','snapshot_sessions','item_catalog','item_aliases','search_short_tokens','item_search_fts','shop_search_fts','option_definitions']) {
  expect(objects.some((row) => row.name === removed)).toBe(false);
}
```

- [x] **Step 2: Run the migration test and verify failure**

Run: `rtk pnpm exec vitest run apps/worker/test/migrations.test.ts`

Expected: FAIL because the existing migrations create obsolete tables.

- [x] **Step 3: Replace the schema with this ownership model**

The new migration must contain these columns and constraints:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE market_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  last_upload_at INTEGER,
  last_full_snapshot_id TEXT,
  last_full_snapshot_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
  identity_hash TEXT NOT NULL,
  public_shop_id TEXT NOT NULL,
  vendor_account_id TEXT NOT NULL,
  vendor_name TEXT NOT NULL DEFAULT '',
  vendor_name_normalized TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  title_normalized TEXT NOT NULL DEFAULT '',
  shop_type TEXT NOT NULL CHECK(shop_type IN ('buy','sell')),
  map_name TEXT NOT NULL DEFAULT '',
  x INTEGER NOT NULL DEFAULT 0 CHECK(x >= 0),
  y INTEGER NOT NULL DEFAULT 0 CHECK(y >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','stale','closed')),
  profile_hash TEXT NOT NULL,
  full_state_hash TEXT,
  state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
  missing_full_count INTEGER NOT NULL DEFAULT 0 CHECK(missing_full_count >= 0),
  last_missing_snapshot_id TEXT,
  last_status_observed_at INTEGER NOT NULL,
  last_changed_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT CHECK(close_reason IS NULL OR close_reason IN ('explicit_dismissed','missing_full')),
  UNIQUE(source_id, identity_hash),
  UNIQUE(source_id, public_shop_id)
);

CREATE TABLE listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  item_fingerprint TEXT NOT NULL,
  item_key TEXT,
  item_id INTEGER NOT NULL CHECK(item_id >= 0),
  upgrade INTEGER NOT NULL DEFAULT 0 CHECK(upgrade >= 0),
  slots INTEGER NOT NULL DEFAULT 0 CHECK(slots >= 0),
  card0 INTEGER NOT NULL DEFAULT 0,
  card1 INTEGER NOT NULL DEFAULT 0,
  card2 INTEGER NOT NULL DEFAULT 0,
  card3 INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL CHECK(price >= 0),
  quantity INTEGER NOT NULL CHECK(quantity >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','missing','sold_out','expired')),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
  missing_full_count INTEGER NOT NULL DEFAULT 0 CHECK(missing_full_count >= 0),
  last_missing_snapshot_id TEXT,
  first_seen_at INTEGER NOT NULL,
  last_changed_at INTEGER NOT NULL,
  last_changed_snapshot_id TEXT NOT NULL,
  UNIQUE(shop_id, item_fingerprint)
);

CREATE TABLE listing_options (
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL CHECK(option_index >= 0),
  option_type INTEGER NOT NULL,
  option_value INTEGER NOT NULL,
  option_param INTEGER NOT NULL,
  PRIMARY KEY(listing_id, option_index)
) WITHOUT ROWID;

CREATE TABLE listing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('first_seen','state_changed','missing','reappeared','expired')),
  from_price INTEGER,
  to_price INTEGER NOT NULL CHECK(to_price >= 0),
  from_quantity INTEGER,
  to_quantity INTEGER NOT NULL CHECK(to_quantity >= 0),
  sold_quantity INTEGER NOT NULL DEFAULT 0 CHECK(sold_quantity >= 0),
  reason TEXT CHECK(reason IS NULL OR reason IN ('price','quantity_decrease','sold_out','missing_full','reappeared','shop_closed')),
  transition_key TEXT NOT NULL UNIQUE
);

CREATE TABLE upload_batches (
  source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 15),
  part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 16),
  snapshot_mode TEXT NOT NULL CHECK(snapshot_mode IN ('full','delta','heartbeat')),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing','accepted','rejected')),
  shop_ids_json TEXT NOT NULL DEFAULT '[]',
  response_json TEXT,
  received_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(source_id, batch_id),
  UNIQUE(source_id, snapshot_id, part_index)
) WITHOUT ROWID;

CREATE INDEX idx_shops_active_directory
  ON shops(title_normalized, vendor_name_normalized, map_name, shop_type, id)
  WHERE status='active';
CREATE INDEX idx_shops_active_filter
  ON shops(map_name, shop_type, id)
  WHERE status='active';
CREATE INDEX idx_shops_source_lifecycle
  ON shops(source_id, status, missing_full_count, id);
CREATE INDEX idx_listings_active_item_price
  ON listings(item_id, price, id)
  WHERE status='active';
CREATE INDEX idx_listings_active_shop_price
  ON listings(shop_id, price, id)
  WHERE status='active';
CREATE INDEX idx_listings_active_price
  ON listings(price, id)
  WHERE status='active';
CREATE INDEX idx_listings_shop_status
  ON listings(shop_id, status, id);
CREATE INDEX idx_listing_options_lookup
  ON listing_options(option_type, option_value, option_param, listing_id);
CREATE INDEX idx_listing_events_history
  ON listing_events(listing_id, observed_at DESC, id DESC);
CREATE INDEX idx_upload_batches_snapshot
  ON upload_batches(source_id, snapshot_id, status, part_index);
```

- [x] **Step 4: Add query-plan assertions**

Use local SQLite `EXPLAIN QUERY PLAN` to assert `idx_listings_active_item_price`, `idx_listings_active_shop_price`, `idx_shops_active_filter`, `idx_listing_options_lookup`, and `idx_listing_events_history` are selected for representative queries. For substring shop search, assert a scan of `idx_shops_active_directory`, not `shops` or `listings`.

- [x] **Step 5: Verify**

Run: `rtk pnpm exec vitest run apps/worker/test/migrations.test.ts apps/worker/test/query-indexes.test.ts`

Expected: PASS.

```bash
rtk git add migrations scripts/render-source-seed.mjs apps/worker/test/migrations.test.ts apps/worker/test/query-indexes.test.ts
rtk git commit -m "refactor: replace market database schema"
```

### Task 3: Generate Static Catalog and Option Assets

**Files:**
- Modify: `scripts/catalog-import.mjs`
- Modify: `scripts/catalog-import-lib.mjs`
- Modify: `scripts/catalog-import.test.mjs`
- Create: `data/option-definitions-lastro-70.83.json`
- Create: `packages/protocol/src/generated/option-definitions.ts`
- Create: `apps/web/src/generated/item-catalog.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `ItemCatalogAsset { version, checksum, items }` and bundled `OPTION_VERSION`/`OPTION_DEFINITIONS`.
- Removes: generated catalog SQL and all catalog/option D1 writes.

- [ ] **Step 1: Write failing asset-generation tests**

```javascript
const asset = buildCatalogAsset(parsed, { version: 'items-v1' });
assert.deepEqual(asset.items[0], { itemId: 4001, name: '波利卡片', normalized: '波利卡片', aliases: ['波利卡'] });
assert.equal(asset.checksum, sha256Hex(JSON.stringify(asset.items)));
assert.equal(renderCatalogSqlParts(parsed, { version: 'items-v1' }), undefined);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `rtk pnpm exec vitest run scripts/catalog-import.test.mjs`

Expected: FAIL because `buildCatalogAsset` is absent and SQL output still exists.

- [ ] **Step 3: Replace SQL rendering with deterministic JSON output**

`catalog:import` must write one UTF-8 JSON asset with this exact shape, sorted by `itemId`, with aliases sorted by normalized value:

```typescript
export interface ItemCatalogAsset {
  version: string;
  checksum: string;
  items: Array<{ itemId: number; name: string; normalized: string; aliases: string[] }>;
}
```

The command becomes:

```bash
rtk pnpm catalog:import -- --input-file data/items.json --kind items --version items-lastro-70.83 --output-file apps/web/src/generated/item-catalog.json
```

Reject duplicate IDs, normalized canonical-name collisions, alias collisions, empty names and output larger than 2 MiB uncompressed. The generated checksum covers only the canonical `items` array.

- [ ] **Step 4: Make option definitions a shared generated module**

Move the 193 current definitions from migrations into `data/option-definitions-lastro-70.83.json`. Generate:

```typescript
export const OPTION_VERSION = 'options-lastro-70.83';
export const OPTION_DEFINITIONS: readonly OptionDefinition[] = Object.freeze(definitions);
export const OPTION_DEFINITION_BY_TYPE = new Map(OPTION_DEFINITIONS.map((item) => [item.type, item]));
```

The Worker search validator and `/api/v1/options` route import this module; the browser may either import it directly or retain the endpoint. No D1 query is permitted for option metadata.

- [ ] **Step 5: Verify deterministic output and commit**

Run twice and assert `rtk git diff --exit-code` after the second run. Then run:

`rtk pnpm exec vitest run scripts/catalog-import.test.mjs apps/worker/test/options.test.ts`

Expected: PASS.

```bash
rtk git add scripts data packages/protocol/src/generated apps/web/src/generated package.json apps/worker/test/options.test.ts
rtk git commit -m "refactor: publish search metadata as static assets"
```

### Task 4: Replace Search Contracts and Timestamp Semantics

**Files:**
- Modify: `packages/protocol/src/types.ts:15-21`
- Modify: `apps/worker/src/domain/search.ts`
- Modify: `apps/worker/src/db/types.ts`
- Modify: `apps/web/src/types.ts:30-80`
- Modify: `apps/web/src/query-form.ts`
- Modify: `apps/web/src/render.ts`
- Test: `apps/worker/test/search.test.ts`
- Test: `apps/web/test/query-form.test.ts`
- Test: `apps/web/test/query-ui.test.ts`

**Interfaces:**
- Produces: `item_ids?: number[]`, `changed_desc`, `lastChangedAt`, `dataUpdatedAt`.
- Removes: `qMode`, `catalogVersion`, `searchIndexVersion`, `updated_desc`, `lastSeenAt`.

- [ ] **Step 1: Write failing protocol tests**

```typescript
expect(parseSearchParams(new URL('https://x.test?q=%E5%88%A9%E5%8D%A1&item_ids=4001,4002'))).toMatchObject({
  q: '利卡', item_ids: [4001, 4002], sort: 'price_asc', limit: 20,
});
expect(() => parseSearchParams(new URL('https://x.test?q=%E5%88%A9'))).toThrow('q must contain at least 2 characters');
expect(() => parseSearchParams(new URL(`https://x.test?q=aa&item_ids=${Array.from({ length: 201 }, (_, index) => index + 1).join(',')}`))).toThrow('item_ids supports at most 200 values');
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `rtk pnpm exec vitest run apps/worker/test/search.test.ts apps/web/test/query-form.test.ts apps/web/test/query-ui.test.ts`

Expected: FAIL on the old qMode/sort/timestamp contract.

- [ ] **Step 3: Implement the new contract**

```typescript
export interface SearchFilters {
  q?: string;
  item_id?: number;
  item_ids?: number[];
  price_min?: number;
  price_max?: number;
  map?: string;
  shop_type?: 'buy' | 'sell';
  options?: SearchOptionFilter[];
  option_mode?: 'all' | 'any';
  limit: number;
  cursor?: string;
  sort: 'price_asc' | 'price_desc' | 'changed_desc';
}
```

Normalize q with NFKC, trim, collapse spaces and lowercase. Deduplicate/sort `item_ids`, allow only safe non-negative integers, cap at 200, and reject textual q shorter than two Unicode code points. Cursor context must include SHA-256 of canonical item IDs plus normalized q and all filters; do not encode the full item array into the cursor.

- [ ] **Step 4: Rename UI semantics**

Render `lastChangedAt` as “最后变化”，and render response-level `dataUpdatedAt` once as “市场数据更新于”. Do not imply that unchanged individual listings were observed at that timestamp.

- [ ] **Step 5: Verify and commit**

Run: `rtk pnpm exec vitest run apps/worker/test/search.test.ts apps/web/test/query-form.test.ts apps/web/test/query-ui.test.ts`

Expected: PASS.

```bash
rtk git add packages/protocol/src/types.ts apps/worker/src/domain/search.ts apps/worker/src/db/types.ts apps/web/src/types.ts apps/web/src/query-form.ts apps/web/src/render.ts apps/worker/test/search.test.ts apps/web/test/query-form.test.ts apps/web/test/query-ui.test.ts
rtk git commit -m "refactor: bound search and expose change timestamps"
```

### Task 5: Move Item Autocomplete and Name Resolution Into the Browser

**Files:**
- Create: `apps/web/src/catalog-index.ts`
- Modify: `apps/web/src/api.ts:15-51`
- Modify: `apps/web/src/main.ts:70-170`
- Delete: `apps/worker/src/routes/items.ts`
- Modify: `apps/worker/src/index.ts:8-40`
- Test: `apps/web/test/catalog-index.test.ts`
- Modify: `apps/web/test/api.test.ts`
- Delete: `apps/worker/test/items.test.ts`

**Interfaces:**
- Produces: `CatalogIndex.suggest(query, 20)`, `CatalogIndex.resolveIds(query, 200)`, `CatalogIndex.nameFor(itemId)`.
- Consumes: generated `ItemCatalogAsset` from Task 3.

- [ ] **Step 1: Write failing catalog-index tests**

```typescript
const index = createCatalogIndex({ version: 'v1', checksum: 'x', items: [
  { itemId: 4001, name: '波利卡片', normalized: '波利卡片', aliases: ['波利卡'] },
] });
expect(index.suggest('利卡', 20).map((item) => item.itemId)).toEqual([4001]);
expect(index.suggest('4001', 20).map((item) => item.itemId)).toEqual([4001]);
expect(index.resolveIds('利卡', 200)).toEqual({ ids: [4001], tooBroad: false });
expect(index.suggest('利', 20)).toEqual([]);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `rtk pnpm exec vitest run apps/web/test/catalog-index.test.ts`

Expected: FAIL because `catalog-index.ts` does not exist.

- [ ] **Step 3: Implement one-time loading and substring matching**

Load the Vite-hashed JSON URL once, retain a single in-memory array and precomputed searchable text per item, and perform `searchable.includes(normalizedQuery)`. Use a 150ms debounce for suggestions. Do not build n-gram maps in the browser; the catalog size is small enough for a linear in-memory scan and this avoids memory amplification.

- [ ] **Step 4: Submit item candidates with formal searches**

On form submit, resolve item IDs from q and send `item_ids=1,2,3`. Continue sending raw q so the Worker can match shop/vendor. If `tooBroad` is true, stop locally and display “匹配物品超过 200 个，请继续输入更精确的名称”. Pure `item_id` filtering bypasses the candidate array.

- [ ] **Step 5: Remove the D1-backed item endpoint**

Delete `MarketApi.getItems`, the Worker items route and its registration. Result rendering calls `catalog.nameFor(result.itemId)` instead of expecting an item name from D1.

- [ ] **Step 6: Verify browser behavior and commit**

Run: `rtk pnpm exec vitest run apps/web/test/catalog-index.test.ts apps/web/test/api.test.ts apps/web/test/query-ui.test.ts`

Expected: PASS, and the API mock observes no `/api/v1/items` request.

```bash
rtk git add apps/web/src apps/web/test apps/worker/src/index.ts apps/worker/src/routes/items.ts apps/worker/test/items.test.ts
rtk git commit -m "feat: resolve item search in the browser"
```

### Task 6: Implement Bounded D1 Market Search

**Files:**
- Create: `apps/worker/src/db/search-query.ts`
- Modify: `apps/worker/src/db/d1-repository.ts:615-711`
- Modify: `apps/worker/src/db/repository.ts:65-113`
- Modify: `apps/worker/src/routes/search.ts`
- Modify: `apps/worker/src/routes/options.ts`
- Test: `apps/worker/test/d1-search.test.ts`
- Test: `apps/worker/test/search.test.ts`
- Test: `apps/worker/test/cache.test.ts`

**Interfaces:**
- Produces: `findShopCandidates(q, filters, 101)`, `searchListings(filters)`, `SearchPage.dataUpdatedAt`.
- Consumes: item IDs resolved by Task 5 and indexes from Task 2.

- [ ] **Step 1: Write failing search behavior and plan tests**

Seed `波利卡片`, shop title `利卡特价`, vendor `杰利卡`, and assert q=`利卡` plus item ID 4001 returns all three matching origins without duplicates. Seed 101 matching shops and assert HTTP 422 with code `query_too_broad` before any listing query executes.

- [ ] **Step 2: Run tests and verify failure**

Run: `rtk pnpm exec vitest run apps/worker/test/d1-search.test.ts apps/worker/test/search.test.ts`

Expected: FAIL because search still queries FTS/token/catalog tables.

- [ ] **Step 3: Implement the two-phase bounded query**

Phase one scans only active shops:

```sql
SELECT id
FROM shops INDEXED BY idx_shops_active_directory
WHERE status='active'
  AND (?1='' OR instr(title_normalized,?1)>0 OR instr(vendor_name_normalized,?1)>0)
  AND (?2 IS NULL OR map_name=?2)
  AND (?3 IS NULL OR shop_type=?3)
LIMIT 101;
```

If 101 rows return, reject as too broad. Phase two uses JSON arrays as one bind parameter and indexed branches:

```sql
WITH item_candidates(item_id) AS (
  SELECT CAST(value AS INTEGER) FROM json_each(?1)
), shop_candidates(shop_id) AS (
  SELECT CAST(value AS INTEGER) FROM json_each(?2)
), candidate_ids(id) AS (
  SELECT l.id FROM item_candidates c JOIN listings l INDEXED BY idx_listings_active_item_price ON l.item_id=c.item_id WHERE l.status='active'
  UNION
  SELECT l.id FROM shop_candidates c JOIN listings l INDEXED BY idx_listings_active_shop_price ON l.shop_id=c.shop_id WHERE l.status='active'
)
SELECT l.id,l.shop_id,l.item_id,l.price,l.quantity,l.last_changed_at,
       s.public_shop_id,s.title,s.vendor_name,s.map_name,s.shop_type
FROM candidate_ids c
JOIN listings l ON l.id=c.id
JOIN shops s ON s.id=l.shop_id AND s.status='active'
WHERE (?3 IS NULL OR l.price>=?3)
  AND (?4 IS NULL OR l.price<=?4)
ORDER BY l.price ASC,l.id ASC
LIMIT ?5;
```

Build separate fixed SQL templates for `price_asc`, `price_desc`, `changed_desc`, and browse-without-q. Do not concatenate user values or dynamic column names. Append compiled option `EXISTS` predicates using the existing validated definition model.

- [ ] **Step 4: Fetch options only for the returned page**

After selecting at most `limit + 1` listings, load options in one query using `json_each(?1)` over page IDs. Do not join options into the main pagination query.

- [ ] **Step 5: Keep caching simple and explicit**

Retain `Cache-Control: public, max-age=30, s-maxage=30`. Include q, item IDs, all filters and cursor in the URL so Cloudflare/browser cache keys remain correct. `/api/v1/options` returns the bundled definitions with a checksum ETag and one-day cache; it performs zero D1 reads.

- [ ] **Step 6: Verify query plans, budgets and commit**

Run: `rtk pnpm exec vitest run apps/worker/test/d1-search.test.ts apps/worker/test/search.test.ts apps/worker/test/cache.test.ts`

Expected: PASS; item autocomplete consumes zero D1; shop resolution reads at most 101 rows before rejecting; page options query receives at most 50 IDs.

```bash
rtk git add apps/worker/src/db/search-query.ts apps/worker/src/db/d1-repository.ts apps/worker/src/db/repository.ts apps/worker/src/routes/search.ts apps/worker/src/routes/options.ts apps/worker/test/d1-search.test.ts apps/worker/test/search.test.ts apps/worker/test/cache.test.ts
rtk git commit -m "feat: add bounded indexed market search"
```

### Task 7: Replace Vendor/Session Resolution With Conditional Shop State

**Files:**
- Create: `apps/worker/src/domain/shop-state.ts`
- Modify: `apps/worker/src/domain/fingerprint.ts`
- Modify: `apps/worker/src/db/types.ts`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/db/d1-repository.ts:17-312`
- Delete: `apps/worker/src/services/session-manager.ts`
- Test: `apps/worker/test/shop-state.test.ts`
- Modify: `apps/worker/test/d1-repository.test.ts`

**Interfaces:**
- Produces: `ShopObservationPlan`, `computeShopProfileHash()`, `computeFullShopStateHash()`.
- Removes: `VendorRow`, `ShopSessionRow`, `getOrCreateVendor`, `getOrCreateSession`, session TTL and session heartbeat writes.

- [ ] **Step 1: Write failing hash and plan tests**

```typescript
expect(await computeFullShopStateHash(shopWithItemsInOrderA)).toBe(await computeFullShopStateHash(shopWithItemsInOrderB));
expect(await computeFullShopStateHash(shop)).not.toBe(await computeFullShopStateHash(shopWithPriceChange));
expect(planShopObservation(existing, sameProfile, sameState, 'full')).toMatchObject({ writeShop: false, readListings: false });
expect(planShopObservation(existing, sameProfile, changedState, 'full')).toMatchObject({ writeShop: false, readListings: true });
```

- [ ] **Step 2: Run tests and verify failure**

Run: `rtk pnpm exec vitest run apps/worker/test/shop-state.test.ts apps/worker/test/d1-repository.test.ts`

Expected: FAIL because shop state hashing and conditional plans do not exist.

- [ ] **Step 3: Define canonical hashes**

`profile_hash` covers normalized vendor account/name, title, type, map and coordinates. `full_state_hash` covers a sorted array of each item's fingerprint, price and quantity. Item fingerprint excludes session ID and covers source ID, shop identity hash, item key/id, upgrade, slots, cards and canonical sorted options.

Use SHA-256 hex. Canonical arrays sort lexicographically before serialization; object key insertion order must not affect output.

- [ ] **Step 4: Replace bulk shop resolution**

Load existing shops once with `json_each` over source/identity pairs. Build three arrays:

- new shops: one INSERT each through a single JSON bulk statement;
- profile/lifecycle changes: conditional UPDATE with `state_version=state_version+1`;
- unchanged shops: return IDs and hashes without UPDATE.

An explicit dismissed observation closes the shop only when `observed_at >= last_status_observed_at`. Reopening a closed shop sets active and clears close fields. No vendor table, session table, FTS or token statement is executed.

- [ ] **Step 5: Handle mode-specific full-state hashes**

- full + same `full_state_hash`: `readListings=false`, no shop write;
- full + changed hash: `readListings=true`; update hash only after listing diff succeeds;
- delta with listing changes: conditionally set `full_state_hash=NULL` once;
- heartbeat with unchanged profile/status: no business write.

- [ ] **Step 6: Verify no-change SQL and commit**

Assert the no-change bulk fixture prepares no `UPDATE shops`, no listing SELECT and no vendor/session/search-index SQL after the single bulk shop-state SELECT.

```bash
rtk git add apps/worker/src/domain/shop-state.ts apps/worker/src/domain/fingerprint.ts apps/worker/src/db apps/worker/src/services/session-manager.ts apps/worker/test/shop-state.test.ts apps/worker/test/d1-repository.test.ts
rtk git commit -m "refactor: resolve uploads by conditional shop state"
```

### Task 8: Apply Listing Diffs Only for Changed Shops

**Files:**
- Modify: `apps/worker/src/services/ingestion.ts:82-195`
- Replace: `apps/worker/src/services/state-transition.ts`
- Create: `apps/worker/src/services/listing-diff.ts`
- Modify: `apps/worker/src/services/sold-events.ts`
- Modify: `apps/worker/src/db/d1-repository.ts:330-524`
- Test: `apps/worker/test/listing-diff.test.ts`
- Modify: `apps/worker/test/state-transition.test.ts`
- Modify: `apps/worker/test/ingestion.test.ts`
- Modify: `apps/worker/test/d1-lifecycle.test.ts`

**Interfaces:**
- Produces: `diffShopListings(existing, incoming, mode)`, `applyListingDiffs(plans)`.
- Consumes: changed-shop decisions from Task 7.

- [ ] **Step 1: Write a complete state-table test**

Cover unchanged, price change, quantity decrease, quantity zero, new identity, missing in complete full, reappearance, delta absence and retry. Assert exact listing/event/option mutation counts for each row of the state table.

- [ ] **Step 2: Run tests and verify failure**

Run: `rtk pnpm exec vitest run apps/worker/test/listing-diff.test.ts apps/worker/test/state-transition.test.ts apps/worker/test/ingestion.test.ts`

Expected: FAIL because current ingestion loads every observed listing and later marks all observed rows.

- [ ] **Step 3: Implement changed-shop loading**

Group observations by internal shop ID. Drop unchanged full groups before repository listing lookup. For changed groups, load all non-expired listings for those shop IDs with one JSON query; this is required to find missing identities within a complete full shop.

`diffShopListings` returns four arrays:

```typescript
interface ListingDiff {
  inserts: NewListing[];
  updates: ListingStateUpdate[];
  events: ListingEventInsert[];
  optionRows: ListingOptionInsert[];
}
```

For delta, absence never creates a missing transition. For full, absent active fingerprints increment missing only once per snapshot using `last_missing_snapshot_id`; reappearance resets the counter only when it was non-zero.

- [ ] **Step 4: Write each real transition once**

- New identity: one listing INSERT, one `first_seen` event, N immutable option rows.
- Price/quantity/status change: one CAS listing UPDATE and one `state_changed` event containing both price and quantity deltas; do not write a second sold table row.
- Unchanged: zero listing/event/option writes.
- Missing/reappeared: one guarded listing UPDATE and one event only when status changes.
- Shop close: one bulk listing status UPDATE; no per-listing event fan-out.

Use deterministic `transition_key = sha256(sourceId + snapshotId + listingId + eventType + fromState + toState)`. `INSERT OR IGNORE` is allowed only for this unique event key, never as a substitute for state CAS.

- [ ] **Step 5: Remove observed writes and old tables**

Delete `markListingsObserved`, `markListingsObservedBulk`, `recordSnapshotSessions`, price-history inserts, sold-event inserts and option replacement paths from repository interfaces and implementations.

- [ ] **Step 6: Verify resource fixtures and commit**

Run: `rtk pnpm exec vitest run apps/worker/test/listing-diff.test.ts apps/worker/test/state-transition.test.ts apps/worker/test/ingestion.test.ts apps/worker/test/d1-lifecycle.test.ts apps/worker/test/resource-budgets.test.ts`

Expected: no-change 400/4000 fixture reports zero listing reads/writes and zero option/event writes; 10 changes report exactly 10 listing updates and 10 events.

```bash
rtk git add apps/worker/src/services apps/worker/src/db apps/worker/test
rtk git commit -m "refactor: write only changed listing state"
```

### Task 9: Finalize Multipart Full Snapshots Without Historical Scans

**Files:**
- Replace: `apps/worker/src/services/snapshot-reconciler.ts`
- Modify: `apps/worker/src/services/ingestion.ts:154-171`
- Modify: `apps/worker/src/db/repository.ts`
- Modify: `apps/worker/src/db/d1-repository.ts:550-605`
- Modify: `apps/worker/test/snapshot-reconciler.test.ts`
- Modify: `apps/worker/test/protocol-v2-migration.test.ts`

**Interfaces:**
- Produces: `finalizeFullSnapshot(sourceId, snapshotId, observedAt)`.
- Consumes: accepted batch rows containing `shop_ids_json`.

- [ ] **Step 1: Write completion, retry and race tests**

Test 16 parts in arbitrary order, a missing part, duplicate accepted part, different `part_count`, two concurrent finalizers, stale older snapshot and three consecutive complete snapshots missing the same shop.

- [ ] **Step 2: Run tests and verify failure**

Run: `rtk pnpm exec vitest run apps/worker/test/snapshot-reconciler.test.ts apps/worker/test/protocol-v2-migration.test.ts`

Expected: FAIL because current reconciliation depends on `snapshot_sessions` and listing observed fields.

- [ ] **Step 3: Persist only the part shop set**

When completing a full batch, update that batch once with sorted unique internal shop IDs and response JSON:

```sql
UPDATE upload_batches
SET status='accepted',shop_ids_json=?3,response_json=?4,completed_at=?5
WHERE source_id=?1 AND batch_id=?2 AND status='processing';
```

Heartbeat/delta rows store `[]`. Reject duplicate shop IDs across full parts because the protocol treats one shop as an indivisible unit.

- [ ] **Step 4: Finalize from the current snapshot only**

Read rows using `idx_upload_batches_snapshot`; require exactly `part_count` accepted parts and complete indexes `0..part_count-1`. Union current shop IDs in Worker memory. Read only source shops with `status IN ('active','stale')`.

For each shop:

- present + `missing_full_count=0`: no write;
- present + previous miss: reset count/status once;
- absent + `last_missing_snapshot_id=snapshotId`: no write;
- absent first/second time: increment, status stale;
- absent third time: set closed, close reason `missing_full`, then bulk-expire its active/missing listings.

Finally CAS-update `market_sources.last_full_snapshot_id/at` only when the incoming observed time is not older. The per-shop `last_missing_snapshot_id` guard makes concurrent finalizers idempotent.

- [ ] **Step 5: Verify bounded reads and commit**

Assert finalize SQL references only the current `(source_id,snapshot_id)` and active/stale shops. Assert it contains no unbounded upload-batch query and no listing scan for present shops.

```bash
rtk git add apps/worker/src/services/snapshot-reconciler.ts apps/worker/src/services/ingestion.ts apps/worker/src/db apps/worker/test/snapshot-reconciler.test.ts apps/worker/test/protocol-v2-migration.test.ts apps/worker/test/resource-budgets.test.ts
rtk git commit -m "refactor: reconcile full snapshots from bounded shop sets"
```

### Task 10: Bound History, Retention and Operational Cleanup

**Files:**
- Modify: `apps/worker/src/routes/history.ts`
- Modify: `apps/worker/src/services/retention.ts`
- Modify: `apps/worker/src/db/d1-repository.ts:650-689`
- Modify: `apps/worker/test/history.test.ts`
- Modify: `apps/worker/test/retention.test.ts`
- Modify: `agent.md`
- Modify: `docs/operations.md`

**Interfaces:**
- Produces: keyset-paginated unified event history and bounded scheduled cleanup.
- Consumes: `listing_events` and `upload_batches` from Task 2.

- [ ] **Step 1: Write failing history/retention tests**

Assert history uses `(observed_at DESC,id DESC)` keyset pagination with maximum limit 50. Assert retention deletes at most 500 rows per scheduled invocation and never runs inside upload/search requests.

- [ ] **Step 2: Run tests and verify failure**

Run: `rtk pnpm exec vitest run apps/worker/test/history.test.ts apps/worker/test/retention.test.ts`

Expected: FAIL on old history tables and old retention SQL.

- [ ] **Step 3: Implement bounded retention**

Retain accepted/rejected upload batches for 30 days and listing events for 180 days. Each scheduled invocation executes at most one batch per table:

```sql
DELETE FROM upload_batches WHERE (source_id,batch_id) IN (
  SELECT source_id,batch_id FROM upload_batches WHERE received_at<?1 ORDER BY received_at LIMIT 500
);
DELETE FROM listing_events WHERE id IN (
  SELECT id FROM listing_events WHERE observed_at<?1 ORDER BY observed_at LIMIT 500
);
```

Log deleted rows from D1 meta. Do not loop in one invocation; the next cron run continues.

- [ ] **Step 4: Update operational documentation**

Document the database reset requirement, catalog asset generation, source seed, local migration command, scheduled retention, product limits, expected resource budgets and rollback procedure. Rollback means redeploying the previous Worker with a separate old-schema database binding; there is no in-place downgrade.

- [ ] **Step 5: Verify and commit**

Run: `rtk pnpm exec vitest run apps/worker/test/history.test.ts apps/worker/test/retention.test.ts`

Expected: PASS.

```bash
rtk git add apps/worker/src/routes/history.ts apps/worker/src/services/retention.ts apps/worker/src/db/d1-repository.ts apps/worker/test/history.test.ts apps/worker/test/retention.test.ts agent.md docs/operations.md
rtk git commit -m "chore: bound history retention and document operations"
```

### Task 11: Remove Compatibility Code and Run Full Acceptance

**Files:**
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/env.ts`
- Modify: `apps/worker/test/upload-route.test.ts`
- Modify: `apps/worker/test/admin.test.ts`
- Modify: `apps/web/test/search-controller.test.ts`
- Modify: `README.md`
- Test: entire repository

**Interfaces:**
- Produces: one supported schema and one supported API behavior.
- Removes: fallback repository methods, dual paths, old qMode, catalog endpoint, legacy migration tests and dead environment variables.

- [ ] **Step 1: Delete fallback branches**

Make the optimized bulk repository methods required rather than optional. Remove single-shop/session fallbacks, legacy history/sold APIs, old search version constants and schema feature flags. Search the repository and require zero matches for:

```text
search_short_tokens
item_search_fts
shop_search_fts
snapshot_sessions
shop_sessions
markListingsObserved
qMode
SEARCH_INDEX_VERSION
updated_desc
lastSeenAt
```

- [ ] **Step 2: Run static checks**

Run:

```bash
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm test:docs
```

Expected: all commands exit 0.

- [ ] **Step 3: Run all tests**

Run: `rtk pnpm test`

Expected: all suites pass with no skipped resource-budget tests.

- [ ] **Step 4: Run acceptance fixtures**

Run fixtures for first full 400/4000, no-change full, 10 listing changes, 3 missing shops, close/reopen, quantity to zero, option identity change, accepted retry, 16 out-of-order parts, partial full, two concurrent finalizers, two-character search and over-broad search rejection.

Record for every fixture: Worker elapsed ms, D1 duration, rows read, rows written, changed rows, statement count and response size. Fail acceptance when:

- no-change full reads any listing row or writes any shop/listing/event/option row;
- accepted retry writes any row;
- autocomplete invokes `/api/v1/items` or any D1-backed endpoint;
- normal two-character search scans `listings` without an item/shop candidate index;
- incomplete full changes missing counters or closes a shop;
- a retry duplicates an event.

- [ ] **Step 5: Build the web app**

Run: `rtk pnpm build`

Expected: exit 0; generated catalog is emitted as a hashed static asset and is not inlined into the main JavaScript bundle.

- [ ] **Step 6: Commit the integrated result**

```bash
rtk git add apps packages scripts migrations data docs README.md agent.md
rtk git commit -m "feat: minimize LastROWeb market resource usage"
```

## Deployment Sequence

1. Build and test locally with a fresh SQLite/D1 database; do not apply the new schema over the existing database.
2. Generate and verify catalog/option assets, then deploy web/Worker code against a new empty D1 binding.
3. Seed `market_sources`, configure the new database ID, and run the single migration.
4. Send one complete full snapshot to establish shop/listing state.
5. Run acceptance searches for item substring, shop title and vendor name before switching traffic.
6. Observe `rows_read`, `rows_written`, D1 duration and Worker duration for at least one complete upload cycle.
7. Keep the old Worker/database binding available only as a short rollback target; delete it after the new path passes the resource budgets and functional regression suite.

## Final Acceptance Definition

- `利卡` can suggest `波利卡片` in the browser and formal search can return listings matched through item `波利卡片`, shop title `利卡特价`, or vendor `杰利卡`.
- autocomplete performs zero Worker/D1 requests after the catalog asset has loaded.
- no-change full produces zero listing reads and zero shop/listing/event/option writes.
- normal shop/vendor substring search scans no more than the active-shop directory index; no leading-wildcard query runs over listings/history.
- first full remains O(new shops + new listings + options), because initial persistence cannot be eliminated.
- only real state changes create listing events; retry and concurrency guards prevent duplicates.
- incomplete multipart snapshots never cause missing/closed transitions.
- database contains no FTS, n-gram, vendor, session, snapshot-session, catalog or option-definition tables.
