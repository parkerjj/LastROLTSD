# Market upload 64 分片与异步 full snapshot

状态：已获用户批准并实施；本文已按实施期间的最新澄清更新。只做代码实现和静态 review，不安装本地 MySQL，不执行数据库集成测试，不部署。

## 处理边界

1. full HTTP 请求只做认证、结构校验、幂等校验、稳定 shop identity 计算和 MySQL 持久化。返回 `202 reconciliation.pending` 及按输入顺序排列的 `uuid -> shop_id`。
2. 最后一个分片只确认分片齐全、更新任务状态并投递一条 Queue 消息，不执行整份快照的整合。
3. 一个客户端上传分片对应一次 `materialize_parts` Queue 调用。服务端不将收到的分片再次按 20 家商店、200 个商品等固定数量切分。客户端配置决定该阶段的处理粒度。
4. 客户端不负责的全量整合由服务端按游标分页。每次 invocation 只执行一个阶段的一页，页大小通过 `SNAPSHOT_RECONCILE_BATCH_SIZE` 配置，默认 200。
5. delta/heartbeat 保持同步处理。D1 TypeScript runtime 删除；历史迁移和导出工具保留。

## HTTP 契约

- 协议允许最多 64 parts，索引为 0..63。原有 body/shop/item/options 结构限制保留。
- 同一个 full 的 `part_count`、`client_run_id`、`observed_at` 一致；接受乱序，禁止跨分片重复 canonical shop identity。
- HTTP 不生成 item fingerprint，不更新 listing，也不做成交推断。
- 公开 shop ID 本来就是确定性 identity hash，因此可先返回公开 ID，数值型数据库 ID 留到后台解析。轻量 manifest 存入 staging 行，不需要在 HTTP 更新 live shop/session。
- full 响应中 `processed_shops/processed_listings/changed_listings/sold_events` 都为零；映射中的 `applied=false`、`resolution=pending` 明确表示尚未应用。客户端应据 `accepted=true` 缓存映射，不能将 pending 当成失败。
- 相同分片重传返回原响应并设置 `duplicate=true`，不重复 enqueue。原响应不会在后台完成后自动改成 complete。
- OpenKore 适配器不在本仓库。需要核对其接受 pending 的行为，不能宣称客户端兼容性已经验证。

## 数据与事务

前向迁移 `004_upload_part_limit.sql` 更新旧 CHECK；`005_async_snapshots.sql` 新增异步状态。已执行迁移的 checksum 不变。

- `upload_batches.payload_json` 保存经过 schema 校验的分片，兼容已有行的 NULL。
- `market_snapshots` 同时保存 snapshot 状态和当前任务的 stage/cursor/generation/lease/attempts。无需再为每个阶段创建另一张 job 表。
- `market_snapshot_shops` 保存当前快照的分片位置、identity、shop 元数据、items JSON、内容 hash、处理结果和 baseline。
- `market_snapshot_listings` 保存已处理的精确 fingerprint presence，供缺失判断使用；不读取所有分片后在 Worker 内构建全量集合。
- `market_queue_budget` 保存 UTC 日的预留操作数。它不是 Cloudflare 账户实际计量。

receipt 事务以源行锁串行化 part 声明，唯一键和 accepted_parts 计数保证 64-part 完整性，不用 JavaScript 位掩码。

后台每次 claim 取得 lease token，处理事务再次验证 generation/token。该事务内同时提交 market 写入和 cursor，提交后才投递下一消息。内部 repository 的 transaction 调用复用当前连接，不另开连接提交半套状态。

同源 delta/heartbeat 与后台 chunk 使用相同源锁。旧 full 不覆盖较新的商品观察；商店保活与商品观察分别处理，防止 heartbeat 让未完成的初始 full 丢失商品基线。
source 的 `active_full_snapshot_id` 在 chunk 之间保留整轮 full 的任务归属，防止迟到的旧快照或重排任务与已开始的新快照交错。失败达到上限或最终完成后释放归属。

## 后台阶段

| 阶段 | 每次工作 |
| --- | --- |
| materialize_parts | 一个客户端分片；解析 shop、规范化 item、保持现有 fingerprint 标识并应用状态，保存 presence |
| reconcile_shops | 至多一页缺失 shop，按稳定 identity 判断 |
| reconcile_listings | 至多一页 missing/expire 候选，状态变化和对应推断事件在同一事务提交 |
| publish_hashes | 至多一页内容 hash 和 full baseline 标记 |
| finalize | 常数规模地更新 source 与 snapshot 完成状态 |

缺失判断与成交推断合并在一个有界事务，避免分成两个阶段时被中间 delta 改写证据。最后 finalize 没有全量扫描。hash 保持内容语义，不能被 snapshot ID 覆盖；delta 内容改变会使旧 hash 失效，仍待第二次缺失确认的商店不能通过 unchanged shortcut 跳过。

搜索可以逐分片看到更新，不提供整份快照一次性切换的读视图。source 的 last-full 字段只在最终成功时推进。

## Queue、Cron 与恢复

- 消息仅含 `{sourceId, snapshotId, generation}`。115KB 级 payload 保存在 MySQL。
- `max_batch_size=1`，误配置成多消息 batch 时不处理这些 chunk，要求重试并记录错误。
- 重复、旧 generation、失效 lease 的消息不重复应用。超时执行可重领；连续失败达到八次后标记 failed。
- `* * * * *` 每次领取一个待处理 chunk。Queue 发送失败、缺少绑定或预算不足时通过此 Cron 恢复。
- `*/5 * * * *` 单独清理 staging；每日 history retention 使用 `0 3 * * *`。
- 共三个 Cron，避免原草案的五个 stage Cron 加 retention 超过 Free 账户五个 trigger 上限。多个部署环境共享此上限。
- 管理员可查询状态和重排失败的完整快照，保留游标。接收超过 24 小时仍不完整的快照不能触发缺失判断，需要客户端发送新快照。

## 操作数与 CPU

对于 P 个客户端分片、S 个快照商店、L 个缺失/过期商品候选、A 个缺失商店、服务端页大小 B，正常处理约需：

`P + ceil(L/B) + ceil(A/B) + ceil(S/B) + 5` 条消息。

按 9 片、500 店、B=200、每天 58 full：无缺失约 17 条/full，即 2,958 operations/day；5,000 个缺失商品候选约 42 条/full，即 7,308 operations/day。delta 同步处理，不额外消耗 Queue。每条小消息按写/读/删除三次估算，重试和同账户其他应用另计。

客户端改为 20 店一片，500 店约 25 片，无缺失约 5,742 operations/day；5,000 个缺失商品候选约 10,092 operations/day。分片越细 CPU 压力越低，但操作数越高。默认预留预算 9,000 后转 Cron；Cron 只有每天 1,440 chunk 的容量，持续超过这个速率会积压。详见 [性能说明](../../upload-performance.md)。

不能仅由 Queue 或 chunk 数量保证 CPU 小于 10ms。p95<6ms、p99<8ms 是目标，不是静态检查可以证明的结果。用户指定本次仅实现与静态审查，因此不执行 runtime benchmark，不宣称生产 CPU 达标。
