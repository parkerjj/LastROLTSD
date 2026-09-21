# LastROWeb Market Upload -> Worker -> D1 写入放大优化设计

> 状态：设计稿，仅分析，不修改生产代码，不部署，不访问 production D1。
> 范围：OpenKore protocol v2 的 `full` / `delta` / `heartbeat` upload、Cloudflare Worker ingestion、D1 repository 与搜索索引。

## 1. 执行摘要

当前主因不是 listing diff 本身：`state-transition.ts` 已经只为价格/数量变化建立 transition，但 ingestion 在每个非 heartbeat part 之后仍调用 `markListingsObservedBulk`，把约 4,000 个未变化 listing 的 `last_seen_at`、`last_batch_id`、`missing_streak`、`status` 全部 UPDATE。并行地，shop 解析会把 vendor/shop 写入式 upsert，复用 session 也会 UPDATE `last_seen_at`；full part 会向 `snapshot_sessions` 写一行/ shop-session；shop 搜索索引还会 DELETE+INSERT FTS，并删除/重建短 token。D1 的计费还会把相关索引行计入 `rows_written`，所以 SQL 的“只是一条 UPDATE”并不等于一行计费。

推荐采用“变化驱动状态 + snapshot-level compact manifest + 延迟/低频搜索索引”：
* 保留 `state_version`、历史、sold event 和批次幂等；取消热路径对 unchanged listing 的 observed UPDATE，改为 `shop_snapshot_manifests` 中保存每个完整 snapshot 的压缩 listing fingerprint 集合。
* full 只有所有 part accepted 后才 finalize；part 重试/乱序只更新同一 batch 的审计状态，绝不触发缺失判定。finalize 读取 snapshot manifest 与上一次完整 manifest 做 diff，仅对真正缺失 listing、shop miss 或关闭/重开对象写入。
* shop 生命周期增加明确的 `missing_full_count`/`presence_misses_remaining` 语义；正常被看到的 shop 不写，连续 3 个完整 full 缺失才关闭。
* 删除 shop FTS 与 shop short-token 热路径；item catalog search 可保留 item-only FTS 作为低频/异步建立的 catalog 索引。默认 market search 优先 `item_id`、map、shop_type、价格和已有 B-tree；任意 shop 标题子串搜索改为管理端低频查询或缓存/外部搜索。

在 400 shops / 4,000 listings 的模型中，当前 no-change full 的逻辑写入下界约 4,000 listing observed + 400 shop/session + 4,000 snapshot-session + 索引/FTS/token；实际容易超过 10,000--30,000 rows。推荐模型的 no-change full 为 `O(parts + changed metadata)`：16 parts 仅约 16 个 batch 状态写、1 个 snapshot manifest、0 个 listing 主表/history/options/FTS 写入（索引只按实际变更产生）。首次 full 仍需写入 4,000 listing、必要 history/options，因此不能宣称低于 `O(N)`；优化目标是后续写入与变化量成正比。

## 2. 当前代码调用链

### Upload/幂等/part 完整性

* HTTP 入口：`apps/worker/src/routes/upload.ts:31-67`；要求 `Idempotency-Key` 等于 `snapshot_id/part_index`，解析旧 error contract。
* 主流程：`apps/worker/src/services/ingestion.ts:88-172`。`getBatch`/`insertBatch` 在 92-118 行做 payload hash、重复 batch、rejected retry 和 cached response；`resolveShopObservations` 在 134-136 行；full 每 part 写 `recordSnapshotSessions` 在 154 行；状态处理在 156-160 行；无论是否变化，非 heartbeat 都在 162-166 行调用 `markListingsObservedBulk`；170 行 `completeBatch`，171 行 full 触发 finalize。
* batch schema 的唯一键是 `UNIQUE(source_id,batch_id)` 与 `UNIQUE(source_id,snapshot_id,part_index)`：`migrations/0001_initial.sql:124-142`。
* part 完整性：`apps/worker/src/services/snapshot-reconciler.ts:8-18` 检查所有 accepted part、`part_count` 一致、index 无重复且覆盖 `[0, part_count)`；31-37 行再取 `snapshot_sessions`、reconcile、finalize。

### Shop/vendor/session

* 单条 fallback：`apps/worker/src/db/d1-repository.ts:104-130` vendor/shop upsert 与 session heartbeat。shop upsert 无论值是否变化都设置 `updated_at`/`last_seen_at`；session 复用时 120 行 UPDATE `last_seen_at`。
* protocol-2 shop resolution：`d1-repository.ts:132-172` 对已存在 shop UPDATE 多个 identity/status/位置字段，并附带 `shopSearchIndexStatements`（147 行）；新 shop 169 行重建索引。
* bulk resolution：`d1-repository.ts:187-312`。`reindex` 仅按 title/vendor normalized 判断，但 vendor/shop upsert（234-245 行）仍对所有 applied 输入写；FTS/token 四条语句在 246-267 行；session heartbeat/close、listing expire 和 new session 在 268-280 行。
* session 工具：`d1-repository.ts:734-744` 复用 session 仍 UPDATE `last_seen_at`；关闭 session 同时把 active/missing listings 置 expired：725-731 行。

### Listing、history、sold、reconciliation

* 批量状态服务：`apps/worker/src/services/state-transition.ts:33-83,86-218`。`makePlan` 仅 price/quantity transition 非 unchanged 时设置 history；`state_version` 乐观冲突后 reload/retry。新 listing 走 `insertNewListingsBulk`，随后 history/options。
* unchanged observed 写：`d1-repository.ts:356-375` 的 `markListingsObservedBulk`/`markListingsObserved` 无条件更新四个生命周期字段。
* 新 listing：`d1-repository.ts:406-417` 三条 batch SQL 写 listings/history/options；options 使用 `INSERT OR REPLACE`。
* 变化 listing：`d1-repository.ts:479-524` 先 UPDATE listings，再 history、sold event，最后 SELECT 验证；`state_version`、`expectedVersion`、`last_batch_id` 和唯一 transition key 提供并发/重试保护。
* full reconciliation：`d1-repository.ts:564-605` 读取 `snapshot_sessions` scope；baseline 未完成则短路；对未出现在 batch ids 的 listing 增加 `missing_streak`，第二次缺失变 `missing`，第一次缺失且 quantity>0 生成 inferred sold event；随后 expired session listings。
* finalize：`d1-repository.ts:560-563` 更新 source 的 `last_full_snapshot_at`，并把 snapshot_sessions 覆盖的 open sessions 标为 `initial_sync_complete=1`。
* history API：`d1-repository.ts:678-689` 返回 price history 与 sold events；search API：`apps/worker/src/routes/search.ts:6-15` -> `searchListings`，items API：`apps/worker/src/routes/items.ts:7-24` -> `searchItems`。

### 搜索索引调用方

* schema：`migrations/0006_search_indexes.sql:1-20` 建立 `search_short_tokens`、`item_search_fts`、`shop_search_fts`；`0008_query_indexes.sql:70-82` 重建 item FTS rowid。
* shop index 写：`d1-repository.ts:751-778` 的 `shopSearchIndexStatements` 每次 DELETE/INSERT shop FTS，再 DELETE/INSERT 1-2 字符 token；bulk 版本 246-267 行。
* market search：`d1-repository.ts:615-623`，长度 <=2 强制 short-token，同时查 item/shop token；更长 query 同时查 item/shop FTS。
* catalog item search：`d1-repository.ts:698-711`，<=2 用 item short token，>2 用 item FTS；只读 catalog，不依赖 shop。
* web query contract：`packages/protocol/src/types.ts:15-21` 暴露 `qMode: short_token|fts`、`searchIndexVersion`；`apps/worker/src/domain/search.ts:98-134` 默认按长度选择，并把版本写入 cursor context；`apps/web/src/api.ts`/`apps/web/src/main.ts` 透传搜索参数。
* 测试/行为：`apps/worker/test/d1-search.test.ts:66-93`、`d1-repository.test.ts:119-122`、`migrations.test.ts:39-98` 明确当前表和 SQL 行为，删除/替换必须更新契约和测试。

## 3. 当前写入预算（估算）

以下先算逻辑数据行，再乘以索引放大系数。D1 官方口径是 rows_written 包含索引行；`changes` 只是修改行近似值，不能用来代替计费。真实系数需 Phase 0 在本地 D1/远程 staging 采集。

设 `N=4000` listing、`S=400` shop、`P=16` parts、每 listing 平均 `O=1.5` options；基础表索引/唯一键每次主表写暂按 `k=1.5--3` 额外行估算，FTS/trigram 另列。

| 场景 | 当前逻辑写入下界 | 主要放大 | 估计 D1 rows_written |
|---|---:|---|---:|
| 首次 full | 4,000 listings + 4,000 history + 约 6,000 options + 400 shop/session + 4,000 snapshot_sessions + FTS/token | listing/历史/option/唯一索引；每 shop FTS 重建和 token | 约 18k--35k，schema/索引实现不同会更高 |
| 第二次 no-change full | 4,000 observed UPDATE + 400 shop/vendor/session upsert + 4,000 snapshot_sessions INSERT IGNORE 尝试 + 400 FTS delete/insert + 每 shop 数十 token | UPDATE 触发 listings/session/shop/FTS/token 索引 | 约 10k--30k；不能以 `changes=0` 推断为零 |
| 10 listing 变化 | no-change 基线 + 10 listing UPDATE + 10 history + sold（若有） | 同上 | 约 10k--30k，变化量被基线淹没 |
| 3 shop 关闭 | 3 shop 状态 + session close + 其 listings expire + 可能 sold | 关闭 shop 的 listing 数量相关 | `O(3 + listings_in_closed_shops)` |
| 1 shop 重开 | shop active + 新 session + 该 shop FTS/token + listings 重现/变更 | 若错误重建全索引则额外几十行 | `O(1 + listings_changed + index_delta)` |
| 同 upload retry | 正确缓存 response 时 0 业务写；rejected retry 会重跑 | 若 retry 已部分提交但 batch 未原子收敛会重复 | 目标 0（accepted duplicate）或仅一次真实 diff |
| 16 parts full | 上述 listing 写分散到 16 次；每 part 都有 observed/session 写 | 每 part 重复 metadata/index | no-change 仍按 N 成本；目标约 16 batch + 1 manifest |

这些是工程预算，不是 D1 账单承诺。Phase 0 必须将每条 D1Result.meta 的 rows_written 记录到阶段聚合，校准 `k`。

## 4. FTS 和短 token 结论

**结论：shop FTS 与 shop short-token 从 upload 热路径删除；item catalog FTS 暂保留但改为 catalog 发布/异步批量构建；short-token 作为 market search 默认能力废弃，协议保留兼容读取一段时间后移除。**

理由和影响：

1. `shop_search_fts` 只服务 shop title/vendor 的任意子串过滤（`d1-repository.ts:621-622`），没有参与 listing identity、history、sold 或 reconciliation。shop title/vendor 变更是低频管理事件，不能让每次市场上传都产生 FTS delete/insert。建议默认 search 只支持 `item_id`、catalog item、map/shop_type、价格和精确/前缀字段；shop title 管理查询走 `LIKE prefix` + `(source_id,status,title_normalized)` 索引，任意 substring 迁移到外部搜索/缓存或后台重建。前端若依赖 `q` 搜 shop，先返回 `search_index_unavailable`/降级精确过滤，不能静默扩大扫描。
2. `search_short_tokens` 同时服务 <=2 字符 item autocomplete 和 market item/shop query（`d1-repository.ts:621`, `698-705`）。它的每个汉字/双字 token 都是独立 D1 行；shop 重建还 DELETE 全部旧 token。建议：item catalog 的 <=2 字符 autocomplete 改为 `item_catalog.name_normalized` 的受控前缀表（或只保留 item-only 低频 token，catalog 发布时一次批量生成）；market listing 不允许 <=2 的任意 substring，要求 `item_id`/完整 catalog item 或最少 3 字符。这样不会为每个 shop 写 token。
3. `item_search_fts` 仍有真实用途：catalog item/alias 的 3+ 字符任意 Unicode substring，查询只读 `item_catalog`；但它应在 catalog import/publish job 中按 content hash 变化重建，不在 upload transaction 中改写。若 catalog 规模小且前缀搜索足够，可 Phase 4 完全删除 item FTS，并同步移除 `qMode=fts`。
4. 不删除表直到迁移和 API 兼容完成：先停止写入/读路由，保留只读 fallback 和 feature flag；观察 7 天零调用后再 drop。删除 FTS 表本身也是 DDL/写成本，应在维护窗口一次执行。

## 5. 推荐数据模型

### 5.1 snapshot-level manifest（最终推荐）

新增两表，替代每 shop 一行 `snapshot_sessions`：

```sql
CREATE TABLE snapshot_manifests (
  source_id TEXT NOT NULL REFERENCES market_sources(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 16),
  accepted_parts_mask INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('open','complete','reconciled','expired')),
  observed_at INTEGER NOT NULL,
  shop_count INTEGER NOT NULL DEFAULT 0,
  listing_count INTEGER NOT NULL DEFAULT 0,
  shop_manifest_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  previous_snapshot_id TEXT,
  reconciled_at INTEGER,
  PRIMARY KEY(source_id, snapshot_id)
);
CREATE TABLE snapshot_shop_manifests (
  source_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  shop_identity_hash TEXT NOT NULL,
  session_id INTEGER,
  listing_manifest_json TEXT NOT NULL,
  listing_count INTEGER NOT NULL,
  shop_content_hash TEXT NOT NULL,
  PRIMARY KEY(source_id, snapshot_id, shop_identity_hash),
  FOREIGN KEY(source_id, snapshot_id) REFERENCES snapshot_manifests(source_id, snapshot_id)
);
```

生产实现可将 `snapshot_shop_manifests` 压缩为单行 JSON（方案 B），但 400 shop * fingerprint 的 payload 必须做大小检查：D1 单行约 2 MB 限制，超过阈值自动分片为 part rows 或 R2 引用。推荐 B/C 混合：每 part 在 `upload_batches` 保存 compact shop/listing manifest hash + JSON（C），finalize 只写一条 `snapshot_manifests` 汇总/引用（B）；若压缩后 >1.5 MB，转 R2（D）并在 D1 保存 ETag/对象 key。

### 5.2 shops/vendors/sessions

在 `shops` 增加：

```sql
presence_misses_remaining INTEGER NOT NULL DEFAULT 3 CHECK(presence_misses_remaining BETWEEN 0 AND 3),
missing_full_count INTEGER NOT NULL DEFAULT 0 CHECK(missing_full_count >= 0),
profile_hash TEXT NOT NULL,
presence_generation INTEGER NOT NULL DEFAULT 0,
last_complete_snapshot_id TEXT,
```

保留 `status`, `closed_at`, `close_reason`, `identity_hash`, `shop_id`, `last_status_observed_at`, `last_status_batch_id` 直到迁移完成。`last_seen_at` 改为仅在新 session/状态/资料变化时写；heartbeat 不更新它。vendors 增加 `profile_hash`，使用 `ON CONFLICT ... DO UPDATE ... WHERE vendors.profile_hash IS NOT excluded.profile_hash`，避免 no-op UPDATE。

`shop_sessions` 保留用于 client_run 生命周期和 initial sync；复用 session 不更新 heartbeat 时间。只有新 session、结束 session、initial sync complete 或 `last_complete_snapshot_id` 变化时写。

### 5.3 listings/options/history

保留：`item_fingerprint` 唯一键、price/quantity/status、`state_version`、`missing_streak`（迁移期）、`last_seen_at`（迁移期兼容读）、`last_batch_id`（幂等/审计）、history、sold_events。新增：

```sql
options_hash TEXT NOT NULL DEFAULT '',
content_hash TEXT NOT NULL,
last_observed_snapshot_id TEXT,
last_changed_snapshot_id TEXT
```

options 是 fingerprint 的一部分（`computeItemFingerprint`），因此 options 变化默认创建新 listing identity；如果产品确认“同一 item、options 改变仍视为同一 listing”，则改为保留 listing id、先比较 `options_hash`，仅 hash 改变时事务性地删除/插入该 listing 的 options，并写 `status_changed`/`options_changed` history。推荐前者，因为现有 fingerprint 已将 options 纳入 identity，能避免篡改历史语义。

### 5.4 可废弃字段

* `last_seen_at`、`last_batch_id`、`missing_streak` 不能在第一阶段删除：搜索 updated_desc、reconciliation、旧客户端和测试仍依赖。Phase 3 引入 manifest 后将它们标为兼容列，仅在真实变更/缺失时更新，连续两个迁移周期无读后再删除。
* `snapshot_sessions` 迁移后只读保留，完成历史 snapshot backfill 后删除；不要在完整性判定前删除。
* shop/item FTS/token 按第 4 节 feature flag 下线后再 drop。

## 6. 推荐 full snapshot 算法

```text
acceptPart(source, request, idempotencyKey):
  assert idempotencyKey == snapshot_id + "/" + part_index
  payloadHash = SHA256(canonical(request))
  claim upload_batches(source,batch_id) with unique key
    - existing + same hash + accepted response => return cached response, duplicate=true
    - existing + different hash => 422 idempotency_key_reused
    - processing by another request => 423 batch_in_progress
    - rejected => CAS rejected -> processing, then retry once
  upsert snapshot_manifests(source,snapshot_id,part_count,observed_at) with WHERE
    existing part_count/observed_at are compatible; stale snapshot is read-only
  resolve each shop by identity_hash:
    - profile_hash equal => no vendor/shop/index UPDATE
    - profile/status changed => one conditional UPDATE
    - opening with reusable client_run => no session heartbeat UPDATE
    - new/reopened => create session; only then write
  normalize/fingerprint items
  diff against current listing rows by (session_id,fingerprint)
    - new => listing + first_seen history + options once
    - price/quantity/status changed => CAS transition + history + sold event if applicable
    - unchanged => no listing write
  persist this part's compact shop union and listing fingerprints idempotently
  complete upload_batches row (accepted, response_json)
  tryFinalize(source,snapshot):
    lock/claim snapshot row via CAS open -> reconciling
    read all upload_batches for snapshot
    if not every index [0..part_count) is accepted: release/no-op; NEVER reconcile
    merge part shop identities and listing fingerprints (dedupe by hash)
    if this snapshot observed_at < source.last_full_snapshot_at: mark stale/reconciled-noop
    else:
      compare complete shop union with previous complete union
      for each absent shop: decrement missing_full_count once for this snapshot
      threshold reached => status='closed', closed_at, close_reason='full_snapshot_missing'
      for each shop present after closed => status='active', reset counters, create/reuse session
      compare per-shop listing fingerprint sets
      for absent active listing: increment missing_streak only once per snapshot; at threshold
        set missing, create inferred sale exactly once by transition_key
      set initial_sync_complete/last_complete_snapshot_id only for sessions in complete union
      mark snapshot reconciled and source last_full_snapshot_at only if newer
    release claim
  duplicate part retry after accepted: cached response; no manifest/listing write
  part out of order: accepted and stored, no finalize until complete
  partial failure/timeout: snapshot remains open; sweeper expires after TTL, no closure
  concurrent client_run: unique identity and CAS profile/state; stale observed_at ignored
```

The existing `completeInput` invariant remains mandatory. A per-snapshot `finalize_claim`/`reconciled_at` prevents two Worker requests from running reconciliation twice; every mutation includes `snapshot_id` or transition key so a second finalize is a no-op.

## 7. 推荐 listing diff 算法

1. **Identity**：继续使用 `computeItemFingerprint(sourceId, shopSessionId, item_key/item_id/upgrade/slots/cards/options)`。same fingerprint means same listing identity; options hash is derived from canonical sorted options.
2. **Unchanged**：load existing row; compare `price`, `quantity`, derived status and `options_hash`. If all equal, do not update `last_seen_at`, `last_batch_id`, `missing_streak`, or history. The manifest records presence instead.
3. **Changed**：single conditional `UPDATE ... WHERE state_version=expectedVersion` sets price/quantity/status/state_version/last_changed_at/last_changed_snapshot_id. Insert one history row with unique `(listing_id,batch_id,event_type)`. Quantity decrease and `quantity -> 0` use existing `buildSoldEvent` and unique `transition_key`; no duplicate on retry.
4. **New**：insert listing, exactly one `first_seen` history, options once. `INSERT OR IGNORE` is acceptable only when subsequent history/options are guarded by the inserted row/content hash; never blindly `INSERT OR REPLACE` options for an existing listing.
5. **Missing**: only complete full manifest can identify absent listings. For each active listing in a shop whose `last_observed_snapshot_id != snapshot_id`, atomically increment `missing_streak` once per snapshot (`last_missing_snapshot_id` guard). At threshold 2 preserve current inferred-sale behavior; at threshold 3 (recommended lifecycle threshold separate from sold threshold) mark `missing`. A listing quantity decrease to zero is immediate sold_out; reappearance resets `missing_streak=0`, status active, only if status actually changes.
6. **Shop quantity reduction**: present shop + absent item fingerprints goes through missing state; shop closed expires remaining active/missing rows once. Reopened shop gets new or explicitly reused session according to `client_run_id`; old session history remains queryable.
7. **Concurrency**: retain `state_version` CAS and retry once on conflict. A stale/out-of-order snapshot never overwrites newer `last_changed_snapshot_id`; its part can remain audit-only.

### Alternatives

| 方案 | no-change full | 10 listing changes | 优点 | 缺点/结论 |
|---|---:|---:|---|---|
| 1. generation/last-observed only | 4,000 if observed updated；0 if presence external | 10+ | 最小迁移 | 若仍逐 listing 更新没有收益；作为兼容列可保留 |
| 2. shop snapshot manifest fingerprints | `O(P + S)` | `O(P + 10 + missing)` | 直接支持缺失/sold，易审计 | JSON/2MB 与合并；**推荐** |
| 3. bitset/hash/Bloom | `O(P + S)` | `O(P + 10)` | 很小 | Bloom 有误报，不能作为 sold 的唯一证据；只可作预过滤 |
| 4. shop content hash | `O(P + changed shops)` | 若 1 shop hash 变则 diff 该 shop | 极低读写 | 无法仅凭 hash 得到缺失 item，仍需 manifest；作为前置短路 |
| 5. content-addressed snapshot/version | `O(P + manifests)` | 版本 diff 清晰 | 历史/回滚好 | migration/存储较复杂；可作为 manifest 的实现细节 |
| 6. 组合：content hash + exact manifest | `O(P + changed shops)` | `O(changed shops + 10)` | 保留精确业务语义、写入最低 | 需 compact encoding；**最终方案** |

## 8. shop lifecycle 状态机

采用 `presence_misses_remaining`（默认 3）与 `missing_full_count`，不使用含义模糊的 `opening` 计数器。

| 事件 | 条件 | 写入/状态 |
|---|---|---|
| 新 shop opening | identity 不存在 | insert active/opening-equivalent，`remaining=3, missing=0`; 建 session；FTS 不在热路径 |
| full 中出现 | complete union 包含 identity | 若 closed 则 active/reopen；`remaining=3, missing=0`; 仅状态/计数变化才 UPDATE |
| 完整 full 缺失 | snapshot complete 且 shop 不在 union | `missing_full_count += 1`, `remaining -= 1`；达到 0 -> closed；正常缺失不更新 listings 之外的数据 |
| dismissed | 客户显式 dismissed | 立即 closed/close_reason explicit_dismissed；结束当前 session，过期 active/missing listings；旧 full 不得重开 |
| closed 重新出现 | 新er observed_at 且非 dismissed | active，计数重置，创建/复用合法 session；写一次 |
| stale/out-of-order | `observed_at < last_status_observed_at` 或同时间冲突 | ignored，无写；返回 `stale_event_ignored` |
| delta | 不参与 shop 缺失判定；只更新它实际观察到的 shop/listing变化 | 不改变 presence counter |
| heartbeat | 只作为 liveness/read，不更新 `last_seen_at`；不得创建 full manifest | 无业务写，除非真实 session 生命周期变化 |
| 多 part full | part 缺失/未 accepted | 不 decrement，不 finalize，不关闭 shop |
| part retry/乱序 | 同 batch/hash | 幂等 no-op；不同 hash 422；index union 只在 finalize 合并 |
| 并发 client_run | identity unique + CAS | 一个 session active；旧 run stale/close 只在 TTL/observedAt 规则成立时写 |

`opening` 是协议中的 `shop_status`，不是数据库生命周期计数器；数据库只保留 `active/stale/closed` 和上述计数。

## 9. snapshot manifest 方案对比

| 方案 | rows written | rows read | payload/2MB | 多 part/幂等 | 缺失 shop/listing | sold/history | CPU/subrequest | migration/rollback |
|---|---:|---:|---|---|---|---|---|---|
| A 删除 snapshot_sessions，从 batches 计算 | 最低 | finalize 需扫所有 part payload | part JSON 可能接近限制 | 依赖 JSON merge，retry 需 hash | 可，前提 payload 含完整 union | 可 | CPU 高，D1 JSON1 高 | 中；回滚难恢复历史覆盖 |
| B 一条 snapshot manifest row | 1/snapshot | 1 + JSON parse | 2MB 风险最高 | CAS row + content hash 简单 | 可，listing set 精确 | 可 | Worker CPU 中 | 高，单行损坏影响 snapshot |
| C part compact manifest + snapshot 汇总 | `P + 1` | P + 1 | 单 part 受限，易控 | 与 upload_batches 天然对齐 | 可 | 可 | 中 | **推荐基线** |
| D R2/KV manifest + D1 reference | D1 1 reference/snapshot | R2/KV 读 + D1 | 最大/压缩自由 | ETag/object key 幂等 | 可 | 可 | subrequest/外部一致性复杂 | 回滚简单但依赖外部存储 |
| E 保留 snapshot_sessions，仅 changed session | 接近出现 shop 数 | 现有 query | 小 | 兼容最好 | 可，但仍逐 session rows | 可 | 低 | 最易实施，长期收益有限 |

最终采用 **C，超大 payload 自动 D**；B 仅用于小 snapshot。保留 E 作为 Phase 1 fallback，直到 manifest 经过灰度验证。

## 10. D1 写入量模型（推荐方案）

令 `C` 为真实变化 listing 数，`M` 为首次出现/缺失/关闭/重开 shop 数，`H` 为真实 history/sold/options 行，`I` 为受影响索引行，`P` 为 parts：

```text
rows_written ≈ batch metadata(P)
              + manifest(P + 1)
              + changed_shop/vendor/session(M)
              + changed_listing(C)
              + history/options/sold(H)
              + affected_indexes(I)
              + one-time migration/DDL
```

建议在预算中使用区间：主表每写 1 行至少可能写 1 个 rowid/unique/secondary index row；FTS 一行可能扩展多个 shadow-table 行，因此必须以 meta 实测。

| 场景 | 推荐逻辑行 | 推荐 D1 rows_written 预算（校准前） |
|---|---:|---:|
| 首次 full, 400/4000 | 4000 listing + 4000 history + `O` options + 16 batch + 16/1 manifest + shops/sessions | 14k--25k（仍是 O(N)，一次性） |
| no-change full | 16 batch accepted + 1 manifest/reconcile marker；listing/shop/session/history/options 0 | 17--40 + manifest index rows |
| 10 listing price/qty change | no-change + 10 listing + 10 history + sold/options only if changed | 40--100 |
| 3 shop close | 3 shop + up to 3 session + active/missing listings actually expired + 1 manifest | `O(3 + listings_closed)` |
| 1 shop reopen | 1 shop + 1 session + changed listings | `O(1 + C_shop)` |
| accepted retry | cached response | 0 |
| 16 parts | 16 batch rows + one manifest; no-change independent of 4000 | `O(16)` |
| partial parts | accepted part rows only; no reconcile | `O(parts_received)` |
| options changed | if fingerprint identity: new listing + first history + options; else one guarded options replacement + history | `O(1 + option_count)` |
| quantity -> 0 | one listing UPDATE + history + one sold event | 3 logical + indexes |

这些目标明确拒绝“通过大范围 DELETE/INSERT 伪装降写入”；所有 DELETE 仅针对真实关闭/过期数据或一次性 schema migration。

## 11. migration 方案

### 顺序

1. **Phase 0 schema-safe observability**：不改语义，包装 `db.prepare().run/first/all` 与 `db.batch`，累计 `meta.rows_written`, `rows_read`, `duration`, `changes`；加 request/batch/snapshot/phase 标签。
2. 加 nullable `profile_hash`, `options_hash`, `content_hash`, lifecycle counters 和 `snapshot_manifests`/part manifest 表；回填只读 hash 时分批执行，每批预算/可暂停。
3. dual-write manifest（仍保留 `snapshot_sessions`），shadow reconciliation 对比结果，不影响 response/error contract。
4. conditional vendor/shop/session/listing writes；停止 unchanged observed UPDATE，但继续维护兼容列仅在真实变化/缺失时更新。
5. manifest 成为 reconciliation source of truth；`snapshot_sessions` 只读 fallback。
6. feature flag 下线 shop FTS/token 写入；保留 read fallback；catalog FTS 迁移到发布任务。
7. 灰度确认零旧查询后，删除旧表/列和索引，清理 migration-only 代码。

### 迁移成本/回滚

* 不能在生产请求内 `ALTER TABLE ... rebuild`；D1 migration 一次执行，预估按被复制/重建行数计费，安排低峰并先在 clone/staging 量化。
* hash backfill：按 `id` cursor 每批 100--500 rows，若超预算停止；可重复执行（`WHERE hash IS NULL`）。
* dual-write 可回滚到旧 reconciliation；manifest 表保留，旧 `snapshot_sessions` 不删。
* 删除 FTS/token/snapshot_sessions 属不可逆 migration，必须有备份/time-travel bookmark、7 天观察和明确批准。
* 旧 OpenKore 不改协议：仍上传 full/delta/heartbeat，服务端内部计算 manifest；可选新 response 字段仅追加，不改变既有 HTTP error code。

### 兼容性

保留 idempotency key、same-key/different-payload 422、duplicate cached response、423 in-progress、428 full-required、409 state conflict、full multi-part/乱序/retry、delta/heartbeat、history/sold、分页和 catalog API。OpenKore 不需要修改；若未来传输 client-side manifest，可增加可选字段并由旧客户端省略。

## 12. OpenKore 兼容性

无需修改现有客户端。`UploadRequest` 的 `snapshot_id`, `part_index`, `part_count`, `snapshot_mode`, `client_run_id`, `observed_at` 已足以建立 manifest。服务端可以继续返回当前 `UploadResultLike`（`accepted`, `duplicate`, counts, shop resolutions, next）。新实现不得把 manifest hash 暴露为客户端必须理解的字段；可追加 `reconciliation_pending`/`snapshot_complete`，但不改变旧字段含义。

## 13. 测试计划

* **单元**：fingerprint/options hash 稳定性；shop lifecycle 状态表；stale/out-of-order；counter 阈值；part mask/乱序/重复；manifest merge；Bloom 若采用则验证只作预过滤。
* **D1 repository**：Fake D1 返回完整 `meta`；断言 conditional UPDATE 的 WHERE；unchanged listing/shop/vendor/session 产生 0 mutation；options hash 相同不写；history/sold transition key 幂等；`changes != rows_written` 时仍累计正确预算。
* **集成**：400/4000 fixture 首次 full、no-change、10 changes、3 close、1 reopen、quantity->0、options change；搜索精确/前缀/item_id/旧 qMode fallback。
* **并发**：同 batch 双请求；不同 payload reuse；16 parts 任意顺序；同 snapshot finalize 双请求；两个 client_run；stale snapshot 在新 snapshot 后到达。
* **失败/retry**：part accepted 后 Worker 超时；rejected retry；部分 parts 永不到齐；manifest 超过 2MB 转 D；D1 batch 中单语句失败回滚。
* **容量**：400 shops/4000 listings/多 options，测 Worker CPU、SQL duration、rows_read、rows_written、subrequest、payload size。
* **budget gate**：no-change full `rows_written <= 2P + 2*metadata`；10-change `<= no_change_budget + 20 + indexes`；首次 full 以 fixture 基线的 ±10% 回归阈值；任何 FTS/token hot-path 写入测试失败。

## 14. 可观测性方案

在 repository 层引入：

```typescript
type D1Meta = { rows_read?: number; rows_written?: number; changes?: number; duration?: number };
type DbStage = 'shop_resolution'|'shop_lifecycle'|'listing_insert'|'listing_transition'|'history'|'options'|'snapshot_manifest'|'reconciliation'|'finalize';
type DbMetric = { requestId: string; sourceId: string; batchId?: string; snapshotId?: string; stage: DbStage; statementKind: string; rowsRead: number; rowsWritten: number; changes: number; durationMs: number };
```

* `run`, `first`, `all` 和 `batch` wrapper 读取每个 result 的 meta；batch 按 statement index 归属 stage，汇总 request/batch/snapshot。
* SQL label 只用固定 statement kind（如 `listing_transition_bulk`），不记录 SQL 参数、payload、API key、title/item name；哈希 source/batch identifiers 或使用内部 request id。
* request context 从 route 传入 `request_id`，ingestion 增加 `batch_id`/`snapshot_id`；日志只输出聚合：count、rows_written/read、p50/p95 duration、changed/new/missing/sold counts。
* 本地测试 Fake D1 的 `run()`/`batch()` 必须返回可配置 meta，测试每阶段预算和 `changes` 与 `rows_written` 不等时的行为。
* 生产默认采样 1--5% 明细，始终保留按天/来源/route/stage 聚合；发生预算越界只输出阈值、stage 和 ids 的不可逆 hash，不输出商品 payload。

## 15. 风险和未决问题

1. 需要确认当前 `updated_desc` API 是否把 `last_seen_at` 当作用户可见“最近观察”而非“最近变化”；若必须保留实时语义，可把它移到非 D1/低频 heartbeat 聚合，但不能继续逐 listing 写。
2. 需要确认 options 变化是否业务上应创建新 listing；现有 fingerprint 暗示“是”，但产品历史展示可能期望同一 listing id。
3. 需要实测 D1 2MB 行限制、FTS shadow rows、JSON1 CPU 和 R2 subrequest 延迟；不能用 SQLite `changes` 代替。
4. 多 client_run 同时上传相同 shop 的 session 选择规则目前依赖 TTL/observedAt；应由产品确认“新 run 是否立即结束旧 session”。
5. shop title/vendor 任意 substring 搜索若是公共核心功能，删除 shop FTS 会改变可用性；需产品选择前缀/精确降级、缓存搜索或外部索引。
6. inferred sale 的缺失阈值当前是 2（`missing_streak+1>=2`）；shop 关闭阈值建议 3，不应未经批准统一改变 listing 语义。
7. 需要决定 manifest 保留期限、历史查询期限、R2 清理责任和 snapshot 超时值。

## 16. 分阶段实施计划

* **Phase 0：rows_written 观测**：repository meta wrapper、stage labels、request/batch/snapshot correlation、预算测试；零业务行为变化。
* **Phase 1：消除明显无意义更新**：vendor/shop `WHERE profile_hash differs`；session reuse 不 heartbeat UPDATE；listing unchanged 不调用 observed UPDATE；options hash guard；保留旧 reconciliation。
* **Phase 2：shop lifecycle + full manifest**：新增 counters、part compact manifest、snapshot finalize CAS；dual-write `snapshot_sessions`，shadow compare；完整 full 后才关闭。
* **Phase 3：listing diff/reconciliation**：manifest exact fingerprint diff、missing guard、只在真实变化写 history/sold/options；保留 state_version/idempotency。
* **Phase 4：FTS/token**：停止 shop FTS/token 热写；catalog item FTS 改异步发布或前缀索引；更新 qMode/searchIndexVersion 与前端降级；观测旧调用。
* **Phase 5：迁移/灰度**：backfill hashes，分 source 灰度，比较旧/新 reconciliation 结果与 rows_written；确认 7 天稳定后删除 `snapshot_sessions`、shop FTS/token、兼容列/索引。

### 最终验收标准

* no-change full rows_written 不再与 4,000 listings 成正比；
* listing options 不在每次 upload 重复写；
* shop/vendor/session 只有 profile/lifecycle/session 真变化才写；
* shop 关闭只在完整 full union 后按缺失次数写入；part 缺失绝不关闭；
* accepted retry 为零业务写，same-key/different-payload 仍报错；
* history、sold-out、inferred sale、并发 CAS、full integrity、分页/catalog search 和现有 HTTP error contract 全部通过回归测试；
* 本地/灰度报告同时给出 `rows_written`、`rows_read`、`duration`，而不是只给 `changes`。

## 参考

Cloudflare D1 定价与计费口径：[`developers.cloudflare.com/d1/platform/pricing`](https://developers.cloudflare.com/d1/platform/pricing/)；D1 API meta 字段（`rows_read`, `rows_written`, `changes`, `duration`）：[`developers.cloudflare.com/api/resources/d1`](https://developers.cloudflare.com/api/resources/d1/)。

## 修订说明（2026-09-21）

以下结论 supersede 本文前面对搜索索引和兼容迁移的保守假设：项目尚未正式运营，允许清空 D1 重建，因此不需要旧版数据库/客户端兼容层、dual-write、shadow reconciliation 或保留旧字段等待观察期。

### 1. item name 搜索必须保留

搜索“波利”不能退化成只按 `item_id`。推荐直接使用 catalog 的规范化名称和别名：

```sql
SELECT item_id FROM item_catalog
WHERE name_normalized LIKE ?1 || '%'
UNION
SELECT item_id FROM item_aliases
WHERE alias_normalized LIKE ?1 || '%'
LIMIT 20;
```

`migrations/0005_catalog_core.sql:42-45` 已有 `name_normalized`/`alias_normalized` B-tree 索引。查询使用前缀 `波利%`，不使用前导 `%`，可以支持两字中文且不会为了 item name 搜索扫描整个 listing 表；先得到最多 20 个 item_id，再使用 `listings(item_id, status, price, id)` 查询市场结果。

产品应明确承诺“前缀搜索”而不是任意位置 substring。若以后确实需要“超级波利”中间匹配，再单独为 catalog 建 item-only FTS；它只在 catalog import/publish 时批量维护，绝不由 market upload 写入。

### 2. shop 搜索与 FTS

如果 shop title/vendor 查询要求至少两个字符，`shop_search_fts` 可以删除。默认实现为规范化字段前缀查询：

```sql
WHERE s.title_normalized LIKE ?1 || '%'
   OR v.name_normalized LIKE ?1 || '%'
```

并添加 `(status, title_normalized)`、`(status, name_normalized)` 索引；长度小于 2 直接返回 400。这样 shop 搜索不再产生 FTS shadow-table 写入。若未来产品坚持任意位置 substring，才重新评估只读 FTS；不能用 `LIKE '%词%'` 作为高频公共 API，因为它可能扫描全表并消耗 rows_read/CPU。

`search_short_tokens` 也可以删除：它只为 <=2 字符任意 token 服务，而“波利”走 catalog 前缀索引；长度 <2 拒绝，长度 >=2 走 prefix。`item_search_fts` 在 prefix-only 方案下同样删除；如果需要 item 任意 substring，只保留 item-only FTS，不保留 shop FTS/token。

### 3. 可直接删除的旧字段/表

允许清空重建后，以下不再需要兼容保留：

* 删除 `snapshot_sessions`，由 snapshot-level manifest 的 accepted-part mask、shop union 和 listing fingerprint 集合承担完整性/缺失检测。
* 删除 listing 的 `last_seen_at`、`last_batch_id`、`missing_streak`。`updated_desc` 改为 `last_changed_at`/`state_version`；幂等由 `upload_batches`、history 唯一键和 sold transition key 提供；缺失次数存入 manifest diff 的 presence state，仅在缺失/恢复时写。
* 删除 `shop_search_fts`、`search_short_tokens`；prefix-only 时删除 `item_search_fts`。同时移除 `qMode=short_token|fts` 和 `SEARCH_INDEX_VERSION` 的旧分支，新的 `q` 语义就是 catalog/item/shop prefix。
* `shop_sessions.last_seen_at` 也不应作为 heartbeat 计数器；只保留 session start/end 和 complete snapshot 标记。

### 4. manifest 方案重选：不要每次全表扫描

方案 A“每次从所有 upload_batches payload 重新计算”确实会在实现不当时反复扫描历史 batches/payload，累积几十万行后会消耗 rows_read 和 Worker CPU，因此不推荐作为运行时算法。它只能作为一次性 backfill/repair 工具。

最终推荐 **方案 C 的简化版：每个 part 一行 compact manifest，snapshot 完成时一行汇总 manifest；不扫描历史 snapshots**：

```sql
CREATE TABLE snapshot_manifests (
  source_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 16),
  accepted_parts_mask INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('open','complete','reconciled','expired')),
  observed_at INTEGER NOT NULL,
  shop_count INTEGER NOT NULL,
  listing_count INTEGER NOT NULL,
  shop_union_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  previous_snapshot_id TEXT,
  PRIMARY KEY(source_id, snapshot_id)
);

CREATE TABLE snapshot_part_manifests (
  source_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  shop_manifest_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY(source_id, snapshot_id, part_index),
  FOREIGN KEY(source_id, snapshot_id)
    REFERENCES snapshot_manifests(source_id, snapshot_id)
);
```

每个 part accepted 时以 `(source_id,snapshot_id,part_index,content_hash)` 幂等写一行；重复 part 相同 hash 为 no-op，不同 hash 报错。finalize 只读取当前 snapshot 的最多 16 个 part rows 和 `previous_snapshot_id` 指向的**一行汇总 manifest**，不扫描 `upload_batches` 全历史，不扫描所有 listings。汇总 manifest 中保存每个 shop 的 content hash 和精确 listing fingerprint 集合；只有 hash 变化的 shop 才读取该 shop 的 listing manifest并做 diff。

如果 JSON 行接近 D1 单行 2 MB 限制，把每个 shop manifest 单独拆成 `snapshot_shop_manifests(source_id,snapshot_id,shop_hash,listing_manifest_json)`；这仍然是当前 snapshot 的最多 400 行读取，而不是历史全表扫描。400 行/4000 fingerprint 对这个项目是可控的；若要进一步降低读取，使用 64-bit fingerprint hash 列表或压缩二进制/base64，但不能使用 Bloom filter 作为 sold/missing 的唯一依据，因为误报会漏掉真实缺失。

**读取/CPU 预算**：no-change full 读取 16 part rows + 1 previous summary（或最多 400 shop manifest rows），不读取 4000 listing rows，不读取历史 batches；Worker CPU 为 JSON merge + hash 比较，约 `O(parts + shops)`。只有变化 shop 才进入 `O(listings_in_changed_shop)` diff。首次 full 必须读/写新 listing，这是不可避免的 `O(N)`。

因此最终选择不是“最少 D1 行但每次全表扫描”的 A，而是“当前 snapshot 增量 manifest + previous summary pointer”的 C；D/R2 只有在真实 payload 超过 D1 单行限制时才启用，不为小项目预先引入外部存储复杂度。

## 搜索架构再次修订：删除 n-gram 明细表，同时保留两字符任意子串

本节 supersede 上述“catalog/shop prefix”结论。产品要求已经明确：最短查询为 2 个字符，但必须支持任意位置子串。例如 `利卡` 必须命中物品 `波利卡片`、商店 `利卡特价` 和商人 `杰利卡`。

### 1. 对现有 `search_short_tokens` 的纠正

现有 `search_short_tokens` 已经是 1-gram/2-gram 倒排索引。重新设计一张只保存 2-gram 的表，最多只会省掉单字 token；它仍然按文本长度展开多行，仍有 token 行和索引写放大，并没有解决本项目希望消除的复杂度。因而不采用新的 bigram 表，直接删除 `search_short_tokens` 及其 lookup index。

普通 B-tree 索引也不能加速 `LIKE '%利卡%'` 的前导通配符查询。精确的两字符任意子串搜索只有三类成本位置可选：写入时物化 n-gram、查询时扫描候选文本、或交给外部搜索服务。本项目不需要引入外部搜索服务，因此选择“只扫描小型目录数据”，不扫描 listings/history。

### 2. 最终推荐的简单分层

1. **物品联想只读静态 catalog 资源**：catalog 发布时生成版本化的 `item-search.json`，仅包含 `item_id`、规范化名称和别名。页面加载一次并缓存；输入至少 2 个字符后，在浏览器端执行 `includes(normalizedQuery)`，加 debounce 和结果上限。输入纯数字时同时匹配 `item_id`。这样每次按键不访问 D1，也不消耗 Worker 的 D1 rows read/write。
2. **正式市场搜索复用 catalog resolver**：提交 `q` 时，由同一静态 catalog 资源解析匹配的 `item_id`。官方页面可以提交已解析的候选 ID；API 端也可从版本化静态资源/Cache API 解析，并限制候选数量和请求大小。catalog 更新低频，因此不需要让 market upload 维护任何物品搜索索引。
3. **商店名/商人名只在提交搜索时查询**：维护一个极小的 `active_shop_search(shop_id PRIMARY KEY, title_normalized, vendor_name_normalized)`，每个活跃商店只有一行。创建、标题/商人变化、关闭或重开时才 INSERT/UPDATE/DELETE；heartbeat、价格和库存变化都不写它。查询 `LIKE '%利卡%'` 确实是扫描，但只扫描当前约 400 行，而不是历史 shops、listings 或 history。
4. **最终 listings 查询走 ID 索引**：将候选 `item_id` 和 `shop_id` 作为两个受限集合，分别通过 `listings(item_id, status, price, id)` 和 `listings(shop_id, status, price, id)` 查询，再合并去重、排序和分页。不要写成对 listing 文本列的 `%q%`，也不要扫描几十万 listing。
5. **缓存正式查询**：按规范化 `q + filters + cursor` 对匿名 GET 使用短 TTL Cache API。缓存是减少重复读取的优化，不是正确性依赖；失效后单次最坏成本仍是 catalog 静态资源扫描 + 约 400 行 active shop directory 扫描 + 索引命中的 listing rows。

在这一方案中，`item_search_fts`、`shop_search_fts` 和 `search_short_tokens` 都可以删除。FTS5 trigram 对至少 3 个 Unicode 字符的 substring 有价值，但无法独立满足本项目必须支持的 2 字符查询；同时保留“两字符目录扫描 + 三字符 FTS”会增加两套路径和写入维护，不符合当前小项目的简单性目标。

### 3. 读取、写入和 CPU 边界

| 操作 | D1 rows read | D1 rows written | CPU 位置 |
|---|---:|---:|---|
| 输入框联想 | 0 | 0 | 浏览器扫描静态 item catalog；最短 2 字符、debounce、limit |
| 正式搜索的 item 解析 | 0（静态资源缓存命中） | 0 | 浏览器或 Worker 仅在提交时扫描 catalog |
| 正式搜索的 shop/vendor 解析 | 约等于活跃商店数（当前约 400） | 0 | D1 执行小表 substring 比较 |
| listing 结果读取 | 只读候选 ID 的索引范围和返回行 | 0 | D1 索引查询、受 pagination limit 约束 |
| 无变化 full upload | 0 个搜索索引写入 | 0 个搜索索引写入 | 无搜索维护 CPU |
| 商店资料变化/关闭/重开 | 0 | 1 个 `active_shop_search` 行及其主键 | 常数级 |
| catalog 发布 | 0 | 0 个搜索索引行 | 离线生成一个版本化静态文件 |

`active_shop_search` 不是倒排索引，也不需要给 `title_normalized` 或 `vendor_name_normalized` 建普通 B-tree；前导 `%` 用不到该索引。它的意义是把扫描集合硬性限制在活跃商店的一行一店，避免历史数据增长后扩大扫描。若未来活跃商店从 400 增长到数万，届时再用实测决定采用外部搜索或重新接受 n-gram 写放大，而不是现在预先承担它。

## 最终收敛架构：shop 状态 hash + 小集合扫描

本节 supersede 前文中长期保存 listing fingerprint manifest、保留 vendor/shop session 表和单独 `active_shop_search` 表的方案。项目允许清库重建，因此最终实现应直接使用更小的 schema，而不是为旧结构建立兼容层。

* 删除 `vendors`、`shop_sessions`、`snapshot_sessions`、catalog/FTS/token 表。`vendor_account_id`、`vendor_name` 和规范化名称直接存到 `shops`，listing 直接引用 `shop_id`。
* 不再单独维护 `active_shop_search`。在 `shops` 上建立只包含 active 行的 covering partial index；两字符 substring 查询扫描该索引当前约 400 行，不扫描历史 shop 或 listing。
* catalog 和 option definitions 变成版本化构建产物。浏览器加载 catalog 后完成 item name/alias/id 联想和 substring 解析；Worker 只接收受限的候选 `item_id` 集合。
* 每个 shop 保存 `profile_hash` 和 `full_state_hash`。full upload 先计算完整 shop 状态 hash；hash 相同则不读取、不更新该 shop 的 listings。只有 hash 变化的 shop 才读取其现有 listings 并做精确 diff。
* multipart full 的每个 accepted batch 只保存该 part 的内部 shop ID 列表。所有 part 到齐后读取最多 16 个 batch rows，并扫描当前 active/stale shops（约 400 行）判断整店缺失；不保存长期 listing manifest，也不扫描 upload 历史。
* 正常出现且未变化的 shop/listing 不写。缺失、恢复、资料变化、价格/数量变化、新 listing、关闭/重开才写。delta 改变 listing 后将该 shop 的 `full_state_hash` 条件置空，使下一次 full 做一次精确 diff。
* 精确 per-listing `last_seen_at` 与 `updated_desc` 必须删除，否则每次 full 都被迫更新所有 listing。替代语义是 listing `last_changed_at`/`changed_desc`，以及 source 级 `last_full_snapshot_at` 表示整体数据新鲜度。
* price/quantity/history/sold information 合并为一个 `listing_events` 表；同一次状态转换只写一个 event。listing options 属于 fingerprint identity，新 listing 时写一次，之后不重复替换。

推荐资源目标：no-change full 的 listing reads/writes 都为 0；D1 只读取每个 part 的 shop identity/state rows、写入 batch claim/completion，并在完整 full 最后更新一行 source。正式文本搜索的目录扫描上限等于 active shop 数；autocomplete 的 D1 read/write 均为 0。
