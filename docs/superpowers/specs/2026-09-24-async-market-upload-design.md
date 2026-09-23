# Market upload 64 分片与异步 full snapshot 设计

状态：待用户审阅后实施。

## 目标

1. 将 full snapshot 的 HTTP upload 请求限制为认证、结构校验、幂等声明和 MySQL 持久化，避免最后一个分片触发全量 reconcile。
2. 将 full snapshot 的耗时工作拆成多个有界、可重试、可幂等的后台阶段，每次 Worker invocation 只处理有限数量的 shop/listing。
3. 将分片上限从 16 提高到 64，并同步协议校验、Worker 限制、MySQL schema、文档和测试。
4. 删除运行时 D1 TypeScript 实现及其仅用于 D1 的测试；生产路径继续只使用 MySQL。

## 现状与原因

当前 `ingestUpload()` 在每个分片内执行 shop identity/profile/full-state hash、shop/session resolution、item fingerprint、listing transition、observed 标记和 batch completion。full 的最后一个分片随后调用 `finalizeSnapshot()`，该函数读取所有分片范围并执行缺失 shop、缺失 listing、inferred sale、session close 和 source finalize。CPU benchmark 已显示：约 400 个 listing 时单次 JS CPU 已接近或超过 10ms，约 1,000 个 listing 明显超过 10ms；减少单片 shop 数只能线性降低单次工作量，不能消除最后一个分片的全量工作。

当前 `full_state_hash` 还存在语义问题：ingestion 先写实际内容 hash，finalize 又把同一字段覆盖为 snapshot id，导致下一次 full 无法可靠判断 unchanged shop。异步改造会同时修复该问题，并确保 presence 使用稳定的 `identity_hash`/内部 shop key，而不是 `profile_hash`。

## HTTP upload 契约

### full snapshot

每个 full part 的 HTTP 请求执行以下步骤：

1. 认证、限流、body 大小限制、JSON/schema 校验和 64-part 边界校验。
2. 使用 `snapshot_id/part_index` 作为幂等 key，计算 payload hash，并以唯一键 CAS claim 该 part。
3. 将原始规范化 payload 和必要的轻量 manifest 写入 MySQL。HTTP 请求不计算 item fingerprint，不解析 listing options，不执行 listing transition，不更新 missing/sold 状态。
4. 创建或更新 snapshot job 元数据。分片可以乱序到达；重复相同 payload 返回缓存结果，重复不同 payload 返回 `422 idempotency_key_reused`。
5. 只在确认 `[0, part_count)` 全部已接收时，把 snapshot 标记为 `queued` 并创建第一阶段 job。最后一个分片仍只做有界的 part-count/accepted 状态检查和 job enqueue。

响应保持 `202`。已有字段继续存在；full part 的 `processed_listings`、`changed_listings`、`sold_events` 在后台完成前为 0，`shops` 可以为空。新增可选字段：

```json
{
  "reconciliation": {
    "status": "pending",
    "snapshot_id": "...",
    "stage": "materialize_parts"
  }
}
```

重复请求返回相同的响应并设置 `duplicate: true`。后台失败不会让已经持久化的 part 重新变成可写的 HTTP batch；由 job retry/repair 处理。

### delta 与 heartbeat

本次改造只改变 full snapshot 的热路径。delta/heartbeat 保留现有同步语义和响应统计，避免无关的客户端行为变化；后续可复用同一 job 基础设施迁移 delta。

## MySQL 数据模型

### upload part payload

扩展 `upload_batches`，保存 full part 的原始 payload 和接收状态：

* `payload_json MEDIUMTEXT NOT NULL`：经过 schema 校验、可稳定重放的 JSON。
* `received_at`、`completed_at` 保留；`status` 对 full 接收阶段使用 `received/processing/accepted/rejected`。
* 继续使用 `(source_id,batch_id)` 与 `(source_id,snapshot_id,part_index)` 唯一键。
* `shop_ids_json`/`shop_hashes_json` 不再作为 HTTP 热路径必须生成的完整 manifest；后台 materialize 阶段按 cursor 写入紧凑 manifest。

### snapshot job

新增 `market_snapshot_jobs`：

* 主键 `id`，唯一键 `(source_id,snapshot_id,stage)`。
* `stage`：`materialize_parts`、`reconcile_shops`、`reconcile_listings`、`infer_sales`、`finalize`。
* `status`：`queued`、`running`、`done`、`failed`。
* `cursor_json` 保存 part/shop/listing continuation cursor；`attempts`、`available_at`、`lease_until`、`last_error` 支持重试和超时回收。
* `claim` 使用事务内 `UPDATE ... WHERE status='queued' OR (status='running' AND lease_until < now)`，随后读取被 claim 的 job；同一 stage 同时只有一个有效 lease。
* job key 和每个状态转换 key 都带 `source_id/snapshot_id`，重复投递只会得到 no-op。

新增 `market_snapshots`：

* 主键 `(source_id,snapshot_id)`，记录 `part_count`、`observed_at`、`status`（`receiving/queued/running/completed/failed`）、当前 stage、`accepted_parts` 计数或位图、`lease_until`、`last_error`。
* 接收 part 时用事务更新 accepted mask/count；part_count、observed_at 不兼容时拒绝。
* 所有 part 到齐后只创建一次 `materialize_parts` job。每个阶段完成后创建下一阶段 job；只有 `finalize` 成功才更新 source 的 `last_full_snapshot_id/last_full_snapshot_at`。

manifest 使用当前 snapshot 的 part/shop 增量记录，不扫描历史 upload batches：

* 每个 part 保存 shop identity、稳定 shop id、`full_state_hash` 和 listing fingerprint 集合的紧凑 JSON/hash。
* snapshot 汇总只引用当前 snapshot 的 part manifests和上一份已完成 snapshot 的 summary。
* unchanged shop 不读取 listing 表；只有 hash 变化的 shop 进入 listing diff。
* JSON 接近单行大小上限时拆为 shop rows，不能把无界 payload 放入单行。

## 后台阶段

每阶段都设置最大处理数量和 continuation cursor，单次执行达到预算即保存 cursor 并返回；阶段不能依赖一次 invocation 完成整份 snapshot。

1. `materialize_parts`：按 part index 读取 payload，解析并规范化 shop/item，执行 shop resolution 和 listing upsert/transition；为该 part 写 compact manifest。每次最多处理一个 part 或配置的有限 shop 数。
2. `reconcile_shops`：读取当前 snapshot 的 shop union，与上一份 summary 比较；只更新真正缺失、恢复、资料变化的 shop。part 未到齐时禁止执行。
3. `reconcile_listings`：仅对 changed/present shop 读取 active listings，按 fingerprint 做 missing/reappeared 判定；每次只处理有限 shop/listing。
4. `infer_sales`：对确认缺失且数量减少的 listing 生成唯一 transition key 的 inferred sale，并处理关闭 shop 的 listing expire；每次只处理有限候选。
5. `finalize`：CAS 标记 snapshot completed，写入 summary、source last-full 字段和初始同步标记。重复执行只返回已完成状态。

每个阶段失败都保留错误和 cursor，按指数退避重试；超过最大尝试次数标记 snapshot failed，并提供管理员 repair/requeue 入口。任何阶段不得依赖 HTTP 最后分片继续执行。

## Queue 与 Cron

代码同时支持两种调度方式：

* 若部署环境提供 `SNAPSHOT_QUEUE: Queue<SnapshotJobMessage>`，最后一个 part 和每个阶段完成时向 Queue 投递 `{jobId, sourceId, snapshotId, stage}`。Queue consumer 只负责 claim job、运行一个有界批次、再次投递 continuation/下一阶段；消息重复安全。
* 若没有 Queue binding（Cloudflare Queues 当前通常需要 Workers Paid 计划），使用 MySQL job table + Cron Trigger。每个 stage 使用独立 cron expression/handler 分支，互不在同一次 invocation 中串行执行；每次 cron 只领取对应 stage 的一个或有限 jobs。现有每日 retention cron 保留独立 schedule。

Queue 是加速投递和重试的可选 transport，不是正确性依赖。Cron fallback 必须始终可处理 queued/running lease-expired job，因此免费计划没有 Queue 时不会丢 snapshot。

## 并发、幂等与失败语义

* part claim、snapshot accepted-mask 更新、job claim、stage completion 都使用数据库条件更新；禁止“先读后写”的无 CAS finalize。
* 全部 domain 写入带 snapshot/part 作用域；listing transition 使用现有 state version 和唯一 transition key。
* stale snapshot（`observed_at` 早于 source 最新完成 full）只记录为 completed-noop，不回退较新的市场状态。
* 乱序分片、重复分片、Queue 重复消息、Cron 重跑、Worker 超时都必须得到相同最终结果。
* snapshot 超时只标记 failed/expired，不据此关闭 shop；只有完整 accepted union 才能触发 missing 判定。

## 64 分片同步修改

以下位置统一使用 `MAX_PARTS = 64`、`part_index 0..63`：

* `packages/protocol/src/schema.ts`
* `apps/worker/src/middleware/limits.ts`
* `migrations/mysql/001_initial.sql` 的 `part_index/part_count CHECK`
* 测试 fixture、upload error/limit 测试、API 文档和任何硬编码 16 的完整性逻辑

accepted mask 不使用 32-bit JavaScript number；实现使用数据库计数或 64-bit-safe 表示（例如两个 32-bit 字段或 part rows 查询），避免位移溢出。

## D1 删除边界

删除运行时 D1 TypeScript：

* `apps/worker/src/db/d1-repository.ts`
* `apps/worker/src/db/d1-meter.ts`

同时删除仅依赖这些实现的 D1 单元/生命周期/search/meter 测试，并移除 `repository.ts` 中仅为 D1 batch bound 保留的 helper。保留 MySQL schema、MySQL tests、协议 tests 和历史设计文档；`migrations/0001_initial.sql` 是否作为历史导出工具输入保留，不进入 Worker bundle。

## 验收标准

* 64-part schema、protocol、limits、docs、tests 全部一致。
* full part HTTP 请求不调用 `reconcileSnapshot`、不更新 listing missing/sold、不扫描其他 part payload。
* 最后一个 full part 只执行 bounded completeness check + job enqueue，并返回 `202 reconciliation.pending`。
* 任意 part 乱序/重试/重复投递后，后台最终只产生一次 listing transition/history/sold event。
* 每个后台阶段均有 cursor、lease、retry、CAS 和独立测试；单次 invocation 处理数量有上限。
* `pnpm test`、`pnpm typecheck`、相关 MySQL schema/integration tests 和 docs checks 通过；lint 仅允许记录已有 generated-file 问题。

