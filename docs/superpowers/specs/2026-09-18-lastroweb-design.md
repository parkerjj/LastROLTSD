# LastROWeb 设计方案

状态：历史基线设计；涉及商品目录、商店身份、上传 v2、中文搜索和 option 定义的内容由 `docs/superpowers/specs/2026-09-19-lastroweb-catalog-search-design.md` supersede。
日期：2026-09-18
范围：将 `croserver` 与 `croweb` 的市场上传、存储、查询功能整合为可开源、可部署到 Cloudflare 的单体 Web 项目。

## 1. 结论摘要

推荐采用以下组合：

| 层 | 选择 | 原因 |
| --- | --- | --- |
| 运行时 | Cloudflare Workers | 无服务器、全球边缘、部署简单，适合读多写少的市场查询 |
| HTTP 框架 | Hono + TypeScript | 体积小、路由和中间件成熟，适合 10ms CPU 约束 |
| 数据库 | Cloudflare D1（SQLite） | 与 Workers 同区域、无需维护 MySQL；SQL 足以表达市场查询 |
| 前端 | Vite + TypeScript | 静态资源体积小；由同一个 Worker 提供 HTML 和 API |
| 数据访问 | 小型 repository 接口 + D1 实现 | 便于测试，也保留未来切换 Turso/libSQL 的可能性 |
| 部署 | Wrangler + D1 migrations + Workers Static Assets | 一个项目、一个域名、一个发布流程 |

不建议使用 Next.js：本项目不需要 SSR、复杂路由或 Node 服务端运行时，Vite 静态构建更轻。也不建议保留 MySQL、Java 或 Flutter 作为线上依赖。

核心原则：

1. OpenKore 只上传实时市场观测；商品中文名称、说明、别名和词条中文标签由 Worker/D1 静态字典维护。
2. 第一次运行必须提交完整快照；后续可以提交增量，但必须定期提交完整快照以处理关店、断线和删除。
3. 任何状态都按 `source_id` 隔离，禁止全局关闭商店。
4. 词条以 `(type, value, param)` raw tuple 保存，中文定义按 `option_type` 管理，不能从商品名称中的 `[x Option]` 反解析。
5. 首次完整快照只建立基线，不产生售出事件；售出事件必须是同一商店会话内的后续状态变化。
6. 商店每次上传带必选 `uuid` 和 `shop_status`；服务端按规范化身份生成/解析 `shop_id` 并在响应中回显 uuid 映射。

## 2. 目标与非目标

### 2.0 项目边界

LastROWeb 只负责网页、Worker 服务端、D1 数据库和公开的上传 API 契约。本项目不修改、编译、打包或维护 OpenKore 代码；OpenKore 适配器由独立协作者根据本设计的请求结构实现。仓库中可以保存脱敏的 JSON fixture 和协议文档，但不得把 OpenKore 源码作为运行时依赖。

### 2.1 目标

- 接收 OpenKore 市场数据并持久化当前在售状态。
- 支持商品名、商品 ID、商店名、摊主名、地图和词条筛选。
- 保存价格/数量变化历史，并在证据足够时推断售出事件。
- 对重复上传、网络重试、客户端重启、多个数据源并发上传保持幂等。
- 在 Cloudflare Workers Free + D1 Free 的预期规模内运行。
- 提供可开源的 TypeScript 项目、迁移脚本、测试和部署文档。

### 2.2 非目标（首版）

- 不实现聊天 WebSocket、短信监控、用户登录、支付和后台管理界面。
- 不做实时推送；查询结果以短缓存和客户端刷新为主。
- 不承诺从商品名称推断装备精炼、卡片或词条。
- 不把 D1 当作无限历史仓库；历史数据按保留策略清理或归档。
- 不支持任意 SQL 查询和管理员上传未经验证的原始数据库文件。

## 3. 负载估算与平台判断

### 3.1 已知参数

- 上传周期：每 10 分钟一次，即每天 144 个周期。
- 当前可见商店：约 300 个。
- 每店平均商品：8 个。
- 全量上限：约 2,400 个商品/周期。
- 客户端去重后：约 10 个有变化的商店，即约 80 个商品/周期。
- 商品价格或数量实际变化概率：约 2%。
- “售出 5%”语义尚未固定，因此分为两种情景计算。

### 3.2 写入量

| 情景 | listing 状态处理 | 每日 listing 记录量（近似） |
| --- | --- | ---: |
| 每次全量 | 2,400 × 144 | 345,600 |
| 客户端增量 | 10 × 8 × 144 | 11,520 |
| 仅写变化历史 | 2,400 × 2% × 144 | 6,912 |

如果 5% 表示“每个上传周期中有 5% 商品售出”，则约为 `2,400 × 5% × 144 = 17,280` 个售出事件/天；如果 5% 表示“每天有 5% 商品售出”，则约为 120 个事件/天。设计和压测采用前一个更保守的情景。

预计增量情景的 D1 行写入预算（每个受影响行按一次写入估算）：

| 来源 | 每日行写入近似 |
| --- | ---: |
| 300 个商店的存在心跳（300 × 144） | 43,200 |
| 变化商店的 listing 状态（80 × 144） | 11,520 |
| 售出事件（保守情景） | 17,280 |
| 价格历史（2% 变化） | 6,912 |
| source/vendor/batch/会话等元数据 | < 3,000 |
| 合计 | 约 81,900 |

D1 Free 的日写入配额按约 100,000 行估算，故该方案在增量情景有余量但不应浪费写入。每次上传仍需带所有商店 ID 的轻量心跳；如果实测接近配额，可将心跳改为每 30 分钟一次，并用源级快照时间判断过期。重复全量写入明确不在 Free 配额内。

### 3.3 结论

- Workers Free 的 10ms CPU 对 Hono 路由、校验、短查询足够；必须限制 JSON 体积、查询页大小和复杂排序。
- D1 Free 足够支撑“增量同步 + 当前状态查询 + 有限历史”，不适合每天 345,600 行持续写入。
- 首次 2,400 商品的全量上传可接受，但应分片；后续必须使用增量协议。
- 若数据源增加到几十个、历史保留期延长或客户端无法增量，迁移到付费 D1 或 Turso/libSQL。

## 4. 总体架构

```text
OpenKore 插件/适配器
        |
        | HTTPS POST /api/v1/market/upload
        v
Cloudflare Worker (Hono)
  - API key 认证、body 限制、schema 校验
  - canonical fingerprint
  - 分片、幂等、乐观并发重试
  - 查询 API、Cache-Control、ETag
        |
        +--> D1 (SQLite)
        |      sources / vendors / shops / sessions
        |      listings / listing_options / price_history / sold_events
        |
        +--> Workers Static Assets
               Vite 构建的 HTML/CSS/JS
```

目录建议：

```text
LastROWeb/
  apps/
    worker/              # Hono Worker、repository、迁移
    web/                 # Vite 前端
  packages/
    protocol/            # 上传/查询共享类型与 schema
  migrations/            # D1 SQL migrations
  docs/
    superpowers/specs/
  wrangler.toml
  package.json
```

生产环境由 Worker 同时处理 `/api/*` 和静态资源。开发环境用 Vite proxy 将 `/api` 转到 Wrangler dev，避免跨域。

## 5. 数据模型

所有时间使用 UTC ISO 8601 或 Unix milliseconds，接口返回 ISO 8601。所有外部字符串先做长度限制和 Unicode 规范化；搜索字段另保存小写、去空白的 `*_normalized` 值。

### 5.1 `market_sources`

| 字段 | 类型 | 约束/用途 |
| --- | --- | --- |
| `id` | TEXT | PK；服务端从 API key 映射，不能信任客户端传入 |
| `name` | TEXT | 数据源显示名 |
| `api_key_hash` | TEXT | 只保存哈希，不保存明文 |
| `status` | TEXT | `active`/`disabled` |
| `last_upload_at` | INTEGER | 最近接收时间 |
| `last_full_snapshot_at` | INTEGER | 最近完成的完整快照 |
| `created_at` | INTEGER | 创建时间 |

### 5.2 `vendors`

逻辑摊主信息。`UNIQUE(source_id, vendor_key)`。`vendor_key` 必须由适配器稳定生成，例如 OpenKore 的 owner ID；没有稳定 ID 时使用规范化的 owner/map/坐标组合，并承认坐标变化会开启新身份。

字段：`id`、`source_id`、`vendor_key`、`name`、`name_normalized`、`map_name`、`x`、`y`、`updated_at`。

### 5.3 `shops`

逻辑商店信息。`UNIQUE(source_id, identity_hash)`，内部主键继续使用 `shops.id`，对外返回由服务端生成的稳定 `shop_id`。字段包括：

- `id`、`source_id`、`identity_version`、`identity_hash`、`shop_id`、`vendor_id`、`title`、`title_normalized`；
- `vendor_account_id`（稳定账号标识）和可变的 `vendor_name`；
- `shop_type`、`map_name`、`x`、`y`；
- `status`（`active`/`stale`/`closed`）、`close_reason`；
- `last_seen_at`、`last_status_observed_at`、`last_status_batch_id`、`closed_at`、`updated_at`。

canonical identity 使用 `source_id`、`vendor_account_id`、`shop_type`、规范化地图、整数坐标和规范化商店标题；`vendor_name` 不参与 identity。`shop_id = "shop_v1_" + SHA-256(canonical_identity_json)`。客户端传入的 `shop_id` 仅作提示，服务端以 `(source_id, identity_hash)` 为准。禁止存在不带 `source_id` 的商店唯一键或全局 `closeAllShop()` 逻辑。

### 5.4 `shop_sessions`

同一个逻辑商店每次连续营业对应一个会话，用于隔离售出推断。

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | INTEGER PK | 会话 ID |
| `shop_id` | INTEGER | 所属商店 |
| `client_run_id` | TEXT | OpenKore 重启时变化 |
| `started_at` / `last_seen_at` | INTEGER | 会话时间 |
| `ended_at` | INTEGER NULL | 会话结束 |
| `initial_sync_complete` | INTEGER | 1 后才允许售出推断 |
| `last_complete_snapshot_id` | TEXT NULL | 最近完整快照 |

同一 `shop_id` 在客户端重启或超过 TTL（默认 30 分钟）后创建新会话；显式 `dismissed` 也结束当前会话，之后新的 `opening` 建立新会话。售出事件永远不能跨会话比较。

### 5.5 `listings`

当前或最近状态中的商品，每个变体一行。唯一键：

```text
UNIQUE(shop_session_id, item_fingerprint)
```

字段：

- `id`、`shop_session_id`、`item_fingerprint`；
- `item_id`；商品名称、说明和别名通过 `LEFT JOIN item_catalog/item_aliases` 动态解析；迁移窗口内允许存在 nullable 的 `item_name_legacy` 字段，但不能写入、搜索、展示或参与 fingerprint；
- `upgrade`、`slots`、`card0`、`card1`、`card2`、`card3`；
- `price`、`quantity`、`last_quantity`、`status`（`active`/`missing`/`sold_out`/`expired`）；
- `first_seen_at`、`last_seen_at`、`last_changed_at`；
- `missing_streak` INTEGER，记录连续完整快照缺失次数；
- `state_version` INTEGER，用于并发更新和事件幂等；
- `last_batch_id`。

如果游戏允许同一商店里出现完全相同的商品变体但价格不同，协议必须额外提供 `item_key`/`item_index`；此字段加入指纹。服务端不能把两个相同变体强行合并。

### 5.6 `listing_options`

每条商品的词条明细，一行一个词条：

```text
UNIQUE(listing_id, option_index)
```

字段：`listing_id`、`option_index`、`option_type`、`option_value`、`option_param`。v2 不接受客户端 `display_value`；v1 即使接收也不能作为展示权威。

OpenKore 的 `[x Option]` 只表示数量。真实数据来自每个 5 字节记录解析出的 `(type, value, param)` 三元组，上传协议必须携带三元组，不能只上传标题。

### 5.7 `option_definitions`（取代旧 `option_dictionary`）

旧的按精确 `(option_type, option_value, option_param)` 建字典模型由 `option_definitions` 取代。新模型按 `option_type` 保存 `data_version`、`handle`、`label_zh`、`description_template`、`value_type`、`unit`、`scale`、`allowed_operators`、`param_policy`、`repeat_policy` 和 `display_template`。raw tuple 永久保存在 `listing_options`；未知 type 仍可入库并以 raw tuple 展示。字典通过显式外部输入 importer 生成，不能在请求期间抓取网页。

### 5.8 历史表

`listing_price_history`：只在首次出现、价格变化、数量变化或状态变化时写入；字段为 `listing_id`、`observed_at`、`price`、`quantity`、`event_type`、`batch_id`。

`sold_events`：不可变事件，字段为 `listing_id`、`sold_quantity`、`from_quantity`、`to_quantity`、`reason`、`observed_at`、`transition_key`。`UNIQUE(transition_key)` 防止重试重复生成。

`upload_batches`：上传幂等和分片状态表，字段为 `source_id`、`batch_id`、`snapshot_id`、`part_index`、`part_count`、`snapshot_mode`、`payload_hash`、`status`、`processed_shops`、`processed_listings`、`changed_listings`、`sold_events`、`response_json`、`received_at`。唯一键为 `(source_id, batch_id)` 和 `(source_id, snapshot_id, part_index)`；同一幂等键重试时必须匹配 `payload_hash`；只有同一 snapshot 的所有 part 都是 `accepted` 时才能完成 full 对账。

历史表按保留期清理：Free 方案默认价格历史 90 天、售出事件 90 天；实际部署可通过环境变量延长，延长前必须重新评估 D1 存储和读写配额。长期数据导出为 R2 JSONL/CSV，而不是继续堆在 D1。

### 5.10 必要索引

```sql
CREATE INDEX idx_shops_source_status_seen
  ON shops(source_id, status, last_seen_at);
CREATE INDEX idx_listings_search_item
  ON listings(item_id, status);
CREATE INDEX idx_listings_session_status
  ON listings(shop_session_id, status, last_seen_at);
CREATE INDEX idx_listings_price
  ON listings(price);
CREATE INDEX idx_options_type_value
  ON listing_options(option_type, option_value, option_param, listing_id);
CREATE INDEX idx_history_listing_time
  ON listing_price_history(listing_id, observed_at DESC);
CREATE UNIQUE INDEX idx_sold_transition
  ON sold_events(transition_key);
```

中文包含搜索使用 D1 可验证的 FTS5 trigram 派生表处理三个或更多字符，并使用 `search_short_tokens` 处理一个或两个字符。商品和商店查询通过 `EXISTS`/JOIN 留在 SQLite 内完成，不把 item IDs 拉到 Worker 后拼接巨大 `IN` 列表。FTS/token 表可以从 catalog、alias、shop title 和 vendor name 权威字段重建；不能依赖 listing 上传名称。

## 6. 商品身份与词条规范化

### 6.1 指纹输入

服务端对以下字段做规范化后生成指纹：

```text
source_id
shop_session_id
item_key（若协议提供）
item_id
upgrade
slots
card0..card3
sorted(options: option_type, option_value, option_param)
```

规范化规则：数字转整数；缺省卡片填 0；词条按三元组字典序排序；删除无意义空格；使用固定 JSON 序列化和 SHA-256。排序保证客户端改变词条发送顺序不会制造新商品，三元组保证不同词条不会错误合并。

### 6.2 兼容旧协议

协议迁移期间可在 Worker 内兼容 `protocol_version=1`，但 v1 的 `items[].name`、`shop_key` 和客户端 option display text 不能参与身份、fingerprint、展示、catalog 导入或搜索。新客户端使用 `/api/v1/market/upload` 的 protocol v2；具体 v1 截止日期和 v2 字段见 2026-09-19 新设计文档。

## 7. 上传协议

### 7.1 请求头

```text
POST /api/v1/market/upload
Authorization: Bearer <source-api-key>
Content-Type: application/json
Idempotency-Key: <batch-id>
```

API key 只用于映射 `source_id`；请求 JSON 中的 `source_id` 即使存在也被忽略。单请求 body 默认上限 512 KiB，单批次最多 16 个 part；超限返回 413，并提示客户端分片。

### 7.2 请求结构

```json
{
  "protocol_version": 2,
  "client_run_id": "openkore-run-20260918-001",
  "snapshot_id": "snap-20260918-1200",
  "snapshot_mode": "full",
  "part_index": 0,
  "part_count": 1,
  "observed_at": "2026-09-18T12:00:00Z",
  "shops": [
    {
      "shop_id": "shop_v1_optional-client-cache",
      "uuid": "5f2e7d65-0b98-4ff4-a6c3-3b0b92e7d2f1",
      "shop_status": "opening",
      "vendor_account_id": "account-123",
      "vendor_name": "Vendor",
      "title": "Selling equipment",
      "shop_type": "buy",
      "map_name": "prontera",
      "x": 100,
      "y": 120,
      "items": [
        {
          "item_key": "slot-0",
          "item_id": 1234,
          "upgrade": 7,
          "slots": 2,
          "cards": [0, 0, 0, 0],
          "price": 100000,
          "quantity": 1,
          "options": [
            {"type": 1, "value": 5, "param": 0}
          ]
        }
      ]
    }
  ]
}
```

`snapshot_mode`：

- `full`：包含该数据源当前可见商店和商品；可以触发缺失处理。首次运行必须是 full。
- `delta`：只包含变化商店和商品；只更新收到的对象，不因缺失生成售出。
- `heartbeat`：v2 使用带 `uuid`、canonical identity 和 `shop_status=opening` 的轻量 `shops[]` 对象，只更新商店/session 保活，不改变 listing 集合；v1 的 `shops_seen` 仅在兼容窗口内保留。
- `shop_status=dismissed` 必须携带空 `items`，立即关闭当前 session、将 active/missing listings 标记为 `expired`，不产生售出事件。

每个 shop 的 `uuid` 每次新 batch 随机生成，重试同一 batch 必须复用；服务端按规范化身份返回 `shop_id`。完整快照分片时，只有所有 part 都成功接收后才执行对账；未出现商店仍不能解释为 dismissed。

### 7.3 成功响应

```json
{
  "accepted": true,
  "batch_id": "snap-20260918-1200/0",
  "duplicate": false,
  "processed_shops": 10,
  "processed_listings": 80,
  "changed_listings": 3,
  "sold_events": 1,
  "shops": [
    {
      "uuid": "5f2e7d65-0b98-4ff4-a6c3-3b0b92e7d2f1",
      "shop_id": "shop_v1_3c2d...",
      "shop_status": "opening",
      "resolution": "matched",
      "applied": true
    }
  ],
  "next": null
}
```

重复 `Idempotency-Key` 必须返回原结果，不重复写入，并保持原始 uuid 与 shop_id 映射。part 之间使用 `snapshot_id + part_index` 作为唯一键；缺 part 的快照不能标记商店关闭。每个响应 `shops[]` 按请求顺序返回，至少包含 `uuid`、最终 `shop_id`、`shop_status`、`resolution` 和 `applied`。

## 8. 去重、幂等与并发

### 8.1 客户端去重

客户端缓存上一次成功上传的商品指纹和价格/数量，只发送新增、删除或字段变化的商店。客户端重启后可以丢失缓存，服务端仍必须正确处理全量基线。

### 8.2 服务端去重

- `upload_batches(source_id, batch_id)` 唯一，重复批次直接返回已保存结果。
- `shops`、`sessions`、`listings` 依靠带 source/session 的唯一约束。
- 词条先按规范化三元组去重，再批量 upsert `listing_options`。
- `sold_events.transition_key` 唯一；同一状态转换最多产生一次售出事件。

### 8.3 并发上传

同一 source 的两个上传请求可能同时到达。更新 listing 时携带读取到的 `state_version`，SQL 只在版本匹配时更新；影响行数为 0 时重新读取并重试一次。重试仍失败返回 409，由客户端稍后重传。不同 `source_id` 之间完全隔离。

D1 写入按小批次执行，使用 `D1Database.batch()` 保证一组相关 SQL 原子提交。不要为每个商品发送独立 HTTP 请求，也不要在 Worker 中执行无界 N+1 查询。JSON1 可用于将整组商品作为一个 bound JSON 参数传给 SQLite；若实现选择动态 `VALUES`，必须把每条 SQL 的 bound 参数控制在 100 以内。

## 9. 售出判定与首次全量规则

### 9.1 直接证据

同一 `listing_id` 在同一会话中出现数量下降 `old_quantity > new_quantity >= 0` 时，记录 `old_quantity - new_quantity` 的 `sold_events`。价格变化但数量不变只写价格历史，不计售出。

### 9.2 缺失证据

只有 `full` 快照的所有 part 都成功、会话已经 `initial_sync_complete=1`、且同一商店连续两次完整快照都缺失该商品时，才将其标记为 `missing` 并按最后数量生成低置信度售出事件。单次网络丢包、delta 缺项或商店关闭不能直接算售出。

商店会话结束时，剩余商品标记为 `expired`，默认不计售出；这样不会把摊主下线误报成全部卖光。

### 9.3 事件幂等

`transition_key = SHA256(listing_id + state_version + old_quantity + new_quantity + reason)`。事件写入与 listing 状态变更放在同一批次；重复批次、Worker 重试或客户端超时重传都不会重复计数。

### 9.4 首次全量

会话的第一份完整快照只插入当前 listing、设置 `initial_sync_complete=0`。所有 part 完成且基线写入成功后，将其设为 1；这之前不产生缺失或售出事件。这样 OpenKore 重启后不会把“旧客户端没有保留的历史数据”错误地解释成售出。

## 10. API 设计

### 10.1 公共 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | Worker、D1 连通性和版本 |
| POST | `/api/v1/market/upload` | 新上传协议，需要 API key |
| GET | `/api/v1/market/search` | 当前在售查询 |
| GET | `/api/v1/market/listings/:id/history` | 单商品价格/数量历史 |
| GET | `/api/v1/options` | 词条字典和可选值 |
| GET | `/api/v1/items` | 静态商品名称/别名 autocomplete |

### 10.2 搜索参数

```text
q                  catalog 名称/别名/说明或当前商店标题/摊主名，长度 <= 80
item_id            精确商品 ID
option             `<option_type>:<operator>:<value>[:<param>]`，最多 8 条
option_mode        all/any，默认 all
price_min/price_max
map                地图
shop_type          buy/sell
include_stale      默认 false
limit              默认 20，最大 50
cursor             keyset 分页游标
```

服务器根据 `/api/v1/options` 的 option definition 验证比较符、值类型、缩放和 param policy，再用 raw tuple 的 `EXISTS` 查询。默认返回当前 active listing；结果通过 `item_catalog` JOIN 返回名称/说明 fallback、raw/定义化词条、价格、数量、`shop_id`、商店位置和 `observed_at`。q 的一/二字符使用 `search_short_tokens`，三字符以上使用 FTS5 trigram；所有匹配在 D1 内完成，不生成巨大 `IN` 列表。不允许 offset 深分页，不允许用户提交排序字段原文；排序字段使用白名单（默认价格升序、更新时间降序）。cursor 必须绑定规范化后的完整 q、option、catalog/option/index version 和分页边界。

### 10.3 缓存策略

- `/api/v1/market/search`：`Cache-Control: public, max-age=30, s-maxage=30`，查询参数进入缓存键。
- `/api/v1/options`：`max-age=86400`，option definition 版本变化时通过 ETag 失效。
- `/api/v1/items`：`max-age=86400`，catalog version 变化时通过 ETag 失效，单页最多 20 条。
- 上传接口：禁止 CDN 缓存。
- 不记录每次搜索到 D1；诊断使用 Workers Logs，必要时只做采样指标。

## 11. 前端设计

Vite 单页应用首屏直接提供查询工具，不保留 Flutter 运行时。

首版页面：

- 搜索框、商品 ID、价格范围、地图、商店类型；
- 词条条件使用服务器提供的中文词条下拉框、比较符下拉框和值输入，支持“匹配全部/匹配任一”；
- 结果表格显示 catalog 商品名称或 `未知物品 #<id>`、raw/定义化词条、价格、数量、地图、摊主、`shop_id`、更新时间；
- 商品详情抽屉显示历史价格、数量变化和售出推断的置信原因；
- 空结果、加载、网络错误、限流和过期数据均有明确状态。

前端通过 `packages/protocol` 共享 zod/JSON schema 类型，避免把数据库列名直接暴露为 UI 契约。默认移动端可读，桌面端使用表格；首版不加入 WebSocket 和登录。

## 12. 安全与滥用控制

- API key 只保存在 Worker Secret，数据库只存 hash；支持禁用单个 source。
- 每个 source 限制 body 大小、单批次商品数、每日批次和错误次数。
- `/upload` 按 source 做速率限制；超限返回 429 和 `Retry-After`。
- 对 `item_id`、价格、数量、坐标、文本长度和词条数量做 schema 校验；拒绝 NaN、负数、超大整数和未知字段的危险嵌套。
- SQL 全部使用参数绑定；搜索排序字段只能从白名单映射到 SQL 片段。
- 公开搜索不返回 API key、内部 source ID、原始请求和隐藏坐标字段。
- CORS 默认同源；需要第三方查询时配置明确的允许来源。

## 13. D1 查询和 CPU 约束

实现必须遵守以下硬限制（部署时以 Cloudflare 最新文档为准）：

- Workers Free 每请求 CPU 约 10ms，代码避免大规模排序、重复 JSON 序列化和无界日志。
- D1 单次 Worker invocation 的查询数约 50；上传采用 JSON1/批量 SQL 和分片，不为每条商品执行查询。
- 单 SQL bound 参数上限约 100；动态 SQL 分块或绑定单个 JSON 参数。
- 单 SQL 文本约 100 KiB；商品批次和词条数组需限制 body 大小。
- Workers Free 每日请求约 100,000；上传和搜索均计入，需要监控。

搜索先利用 `item_id`、option、status、price 等索引缩小候选，再做有限文本过滤；单页最大 50 条。若真实数据使查询或 CPU 超限，优先增加预计算 `search_items`，其次切换付费 Workers/D1，不通过取消校验来换取速度。

## 14. 错误处理与可观测性

错误响应统一：

```json
{
  "error": {
    "code": "INVALID_UPLOAD",
    "message": "part_count must be between 1 and 16",
    "request_id": "..."
  }
}
```

状态码：400 参数错误、401/403 认证失败、409 版本冲突、413 body 过大、429 限流、500 内部错误、503 D1 暂时不可用。

记录的指标：每批次耗时、商品数、变化数、售出数、D1 错误、429 次数、body 大小、查询命中数；日志中不记录 API key 和完整商品 payload。保留一个可关闭的 `request_id` 贯穿 Worker 与 D1 错误日志。

## 15. 测试策略

### 15.1 单元测试

- 字符串、数字、缺省值和词条排序的 canonical fingerprint。
- fingerprint 不包含 item 中文名称、说明、别名、词条标签或客户端 display text。
- 同一词条换顺序仍为同一 fingerprint；任一三元组变化则不同。
- 首次 full 不产生 sold；数量下降只产生一次事件；重试不重复事件。
- 缺失一次不售出，连续两次完整快照缺失才进入 missing 规则。
- 不同 source 的同名商店不会互相关闭；客户端重启且缺少 shop_id 时不会创建重复商店。
- uuid 到 shop_id 的 response 关联、dismissed 关店、迟到 opening 和重新 opening 的 session 规则正确。
- 未知 item/option 可入库并使用 fallback/raw 展示；catalog 更新能改变已有 listing 的显示名称。
- 一字符、两字符、三字符以上 q 分别走短 token、短 token、FTS 路径；option metadata 控制 operator 和 repeat policy。

### 15.2 集成测试

- D1 migrations 在本地 SQLite/Wrangler D1 模拟器完整执行。
- 80 商品增量批次和 2,400 商品首个 full 分片均在查询数、body 大小和参数限制内。
- 并发同 source 上传触发版本冲突时，重试后最终状态正确。
- 搜索组合词条、价格、地图和 keyset cursor 返回稳定结果。

### 15.3 浏览器测试

- Vite production build 后由 Worker 提供根页面和静态资源。
- 桌面/移动端搜索、空结果、错误、历史抽屉和刷新流程。
- API 响应延迟、缓存头和 ETag。

## 16. 部署、迁移与回滚

1. `wrangler d1 create lastroweb-prod` 创建数据库并绑定 `DB`。
2. 通过 migration 创建表、索引、触发器（如确有必要）和字典初始数据。
3. 设置 `SOURCE_API_KEY_*` 等 Worker secrets；不把 key 写入仓库。
4. `pnpm --filter web build` 构建 Vite；Worker 配置 Static Assets 目录。
5. 先部署 staging，运行 schema/协议/查询压测，再 `wrangler deploy --env production`。
6. 旧 Java API 在迁移窗口内作为兼容客户端；新 Worker 验证稳定后再切换域名。
7. 回滚只回滚 Worker 版本；数据库 migration 采用向前兼容，破坏性变更先加列/双写，再清理旧列。

### 16.1 备份

D1 每日导出 schema 和关键数据快照到 R2 或本地加密存储。部署脚本记录 migration 版本、Worker 版本、catalog version 和 option definition version。恢复演练至少覆盖：误批次、错误 catalog/词条导入、FTS/token 重建和部分快照未完成。

## 17. 平台备选

| 平台 | 结论 |
| --- | --- |
| Cloudflare Workers + D1 | 首选；部署和静态资源简单，当前预估可行，但受日写入和历史容量约束 |
| Cloudflare Workers + Turso | D1 超过写入/容量时的最小迁移路径；需处理外部数据库延迟和连接凭据 |
| Render Free + SQLite | 不推荐；免费实例磁盘是临时的，重启会丢数据库 |
| GitHub Pages | 只能托管静态前端，不能承担上传 API 和持久化 |
| 普通 VPS | 运行 SQLite/单体服务最自由，但失去免运维和全球边缘优势；可作为数据量增长后的选择 |

## 18. 版本路线

### MVP

- 新上传协议、API key、full/delta/heartbeat。
- D1 schema、当前商品搜索、词条结构化筛选。
- 数量下降售出事件、90 天历史、Vite 查询页。
- Wrangler 部署、迁移、单元/集成测试。

### 第二阶段

- 旧 `/API_Kore/UploadMarket` 完整兼容适配器。
- 连续缺失判定、数据源管理、管理员导出。
- catalog/option importer、FTS/token 重建、R2 历史归档、监控告警。

### 第三阶段

- 多服/多地区数据隔离与切换。
- 可选登录、收藏、价格提醒和实时刷新。
- 根据真实配额决定付费 D1、Turso 或 VPS。

## 19. 设计评审记录（自审）

本稿提交前执行以下检查，结果均为通过：

| 检查项 | 结果 | 证据/处理 |
| --- | --- | --- |
| 是否存在未解决空白项 | 通过 | 文档中没有未解决空白项；未决的售出比例明确分为两种情景并选择保守压测值 |
| 数据模型与 API 是否一致 | 通过 | 上传包含 source/run/snapshot/shop/item/options；表结构覆盖 current、history、sold、dictionary |
| D1 查询/绑定参数限制 | 通过 | JSON1 单参数或 <=100 参数分块；单请求 body、part、查询数均有上限 |
| 多客户端上传是否互相关闭商店 | 通过 | 所有唯一键和状态更新包含 `source_id`；不使用全局关闭逻辑 |
| 词条排序是否误造商品 | 通过 | 三元组排序后生成 fingerprint，选项独立保存并按 type/value/param 索引 |
| 首次全量是否生成虚假售出 | 通过 | `initial_sync_complete=0` 基线阶段禁止缺失/售出事件 |
| 重试是否重复售出事件 | 通过 | upload batch 唯一、state_version 乐观并发、transition_key 唯一 |
| 全量和增量的语义是否可区分 | 通过 | `snapshot_mode`、part 完整性和 v2 shop objects 明确规定；`shops_seen` 只作为 v1 heartbeat 兼容字段 |
| 历史数据是否可能耗尽 D1 | 通过 | 90 天默认保留、R2 归档路径和配额预算已写明 |
| CPU/查询是否有失控路径 | 通过 | 分页上限、索引、JSON1、无 N+1、日志不写 D1 |

评审结论：方案可进入实现规划阶段。实现前仍需把 LastRO 实际词条字典导出为可版本化数据，并接收独立 OpenKore 适配器提供的脱敏 payload fixture 进行协议兼容测试；适配器代码本身不属于 LastROWeb 的实现范围。
