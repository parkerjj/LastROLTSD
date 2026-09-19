# LastROWeb 商品目录、商店身份与搜索设计

状态：已批准的架构设计 v1.0
日期：2026-09-19
范围：重新设计 LastROWeb 的商品静态元数据、商店上传契约、商店生命周期、中文包含搜索和结构化词条搜索。

## 1. 结论摘要

本设计保留 Cloudflare Workers、Hono、D1/SQLite、Vite、TypeScript、Zod、Vitest 和 Wrangler 的现有技术边界，重点调整数据责任：

| 责任 | 权威来源 |
| --- | --- |
| 商品 ID、价格、数量、强化、插槽、卡片 ID、raw option tuple | OpenKore 上传的实时观测 |
| 商店标题、玩家名、地图、坐标、营业状态、观测时间 | OpenKore 上传的实时观测 |
| 商品中文名称、说明、别名 | Worker/D1 静态 item catalog |
| 词条中文标签、值类型、单位、显示模板、允许运算符 | Worker/D1 option definitions |
| 当前 listing 是否可检索 | Worker/D1 根据 shop/listing/session 状态判断 |
| 外部稳定商店标识 `shop_id` | Worker 根据 source-scoped canonical identity 生成 |

推荐采用：

1. `item_catalog`、`item_aliases` 和版本化的 `option_definitions` 作为静态权威字典。
2. `item_search_fts`/`shop_search_fts` 使用 FTS5 trigram 处理三个或更多字符的包含搜索。
3. `search_short_tokens` 处理一个或两个字符，避免把短中文查询交给不适合的 trigram 查询。
4. Worker 通过 SQLite `JOIN`/`EXISTS` 查询静态字典和实时 listing，不把匹配出的 item ID 拉到应用层再拼接巨大 `IN` 列表。
5. 协议版本 2 移除 `items[].name`，每个商店必须携带 `uuid` 和 `shop_status`，`shop_id` 可选。
6. `shop_status=dismissed` 是显式关店事件；它立即关闭当前 session、过期 active/missing listings，并且不生成售出事件。

本设计不修改、复制、编译、打包或引入 OpenKore 源码，也不把任何固定的 OpenKore 本地路径作为运行时依赖。

## 2. 目标与不变量

### 2.1 目标

- OpenKore 只上传实时市场观测和 raw option tuple。
- OpenKore 重启后不携带 `shop_id` 时，服务端仍能找到已有逻辑商店，不能创建重复商店。
- full、delta、heartbeat 的成功响应都按输入顺序返回每个商店的 `uuid -> shop_id` 解析结果。
- 显式关店后，查询默认结果不再显示该商店的商品；重新开店可以建立新的 shop session。
- 静态字典更新后，已有 listing 通过 JOIN 自动显示新名称、别名或词条标签，无需重新上传。
- 未知 `item_id` 和未知 `option_type` 都可以入库，并以明确的 raw/fallback 形式展示。
- 查询最多返回 50 条，所有 SQL 值使用 bound parameters，保留 D1 Free 的查询、绑定参数、SQL 大小、body 大小和写入预算边界。

### 2.2 必须继续保持的不变量

- 所有状态更新按认证后的 `source_id` 隔离。
- 首个完整 full snapshot 只建立基线，不产生售出事件。
- delta 中没有出现的商品不被解释为售出。
- 不完整的 full 分片集合不能触发 snapshot reconciliation。
- 只有同一 shop session 内的状态变化可以产生售出事件。
- upload batch 的幂等键、payload hash、分片唯一性和失败重试语义保持不变。
- listing fingerprint 不包含中文名称、说明、别名、词条中文标签或客户端 `display_value`。
- heartbeat 只保活，不清空商品，也不把未出现的商店解释为 dismissed。

## 3. 商店身份、`shop_id`、`uuid` 和生命周期

### 3.1 v2 商店输入

协议版本 2 的每个 `shops[]` 元素包含：

```json
{
  "shop_id": "shop_v1_optional-client-cache",
  "uuid": "5f2e7d65-0b98-4ff4-a6c3-3b0b92e7d2f1",
  "shop_status": "opening",
  "vendor_account_id": "account-123",
  "vendor_name": "可上传的玩家显示名",
  "title": "可上传的商店标题",
  "shop_type": "sell",
  "map_name": "prontera",
  "x": 100,
  "y": 120,
  "items": []
}
```

- `uuid` 必选，每次新建上传 batch 时随机生成；重试同一个 batch 必须复用原 payload 和原 uuid。
- `shop_id` 可选。客户端可以缓存服务端返回值，但服务端不把它当作身份权威。
- `shop_status` 必选，只允许 `opening` 和 `dismissed`。
- `vendor_account_id` 必选，是稳定的售卖人账号标识；它不是展示用的玩家名称。
- `vendor_name` 和 `title` 可以是上传文本，但都不是 OpenKore 提供的商品元数据权威。
- `items` 在 delta 中只表示该商店本次变化的商品；在 full 中表示该商店完整可见商品；在 heartbeat 中不改变 listing 集合。
- `dismissed` 商店必须携带空 `items`；服务端拒绝将带商品的 dismissed 请求当成有效关店事件。

### 3.2 canonical identity

服务端将以下字段按固定顺序组装为 versioned canonical JSON：

```text
identity_version = 1
source_id
vendor_account_id
shop_type
map_name_normalized
x
y
title_normalized
```

规范化规则：

- 文本使用 Unicode NFKC。
- 去除首尾空白，连续空白折叠为一个 ASCII 空格。
- `map_name`、`vendor_account_id` 和 `title` 使用稳定的 Unicode case folding 规则；中文字符保持原值。
- 坐标序列化为十进制整数，不使用浮点数或本地化数字格式。
- JSON key 顺序、数组顺序、数字格式和 UTF-8 编码固定。

`vendor_name` 不参与身份，因为玩家改名不应创建新商店。`title`、地图、坐标、账号、商店类型参与身份；如果这些固定身份字段确实改变，服务端把它视为新的逻辑商店身份，而不是猜测合并。

```text
identity_hash = SHA-256(canonical_identity_json)
shop_id = "shop_v1_" + lowercase_hex(identity_hash)
```

`source_id` 包含在 hash 中，因此不同 source 永远不会合并。数据库仍使用内部整数 `shops.id` 作为外键主键，并建立 `(source_id, identity_hash)` 唯一约束。客户端传入的 `shop_id` 只能作为查找提示；如果它与 canonical identity 不匹配，服务端以 canonical identity 为准并返回正确的 `shop_id`，不创建额外商店。

### 3.3 服务端响应

每个成功 upload response 都包含与本次请求 `shops[]` 一一对应的 `shops[]` 结果，顺序不变：

```json
{
  "accepted": true,
  "batch_id": "snap-20260919-1200/0",
  "duplicate": false,
  "processed_shops": 1,
  "processed_listings": 0,
  "changed_listings": 0,
  "sold_events": 0,
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

`resolution` 允许：

- `created`：首次根据 canonical identity 创建逻辑商店。
- `matched`：找到已有逻辑商店，包括客户端重启后没有 `shop_id` 的情况。
- `dismissed`：关店事件已应用。
- `stale_event_ignored`：请求中的 observed time 早于已应用的更新，不能重新打开已关闭商店。

重复 batch 必须返回数据库中保存的原始 response，并保持原始 uuid；不能为重复 response 重新生成 shop 解析结果。

### 3.4 opening、dismissed、heartbeat 和乱序

- `opening`：刷新 `shops.last_seen_at`，将 shop 标记为可营业；如果此前已 dismissed 且本次 `observed_at` 更新，则结束旧 session 并建立新的 session。
- `dismissed`：在同一 D1 batch 中设置 shop 为 closed、记录 `closed_at`/`close_reason=explicit_dismissed`、结束当前未结束 session，并把该 session 的 active/missing listings 改为 `expired`。不写 `sold_events`。
- full/delta 中没有出现某个商店不是 dismissed；只有显式 dismissed、会话 TTL 或现有完整快照缺失规则可以改变存活状态。
- heartbeat 使用完整身份字段、uuid、shop_status=opening 的轻量 shop 对象，只更新 shop/session 的保活时间，不改变 listing 集合。
- 旧 v1 的 `shops_seen` 在兼容窗口内继续支持，仅用于 heartbeat 保活，不生成 shop resolution 结果；v2 heartbeat 使用 `shops[]`，因此可以返回 `shop_id`。
- 每个 shop 保存 `last_status_observed_at` 和 `last_status_batch_id`。较新的 `observed_at` 胜出；相同时间戳下 `dismissed` 优先于 `opening`；较旧 opening 不能重新打开已 dismissed 的 shop。
- 同一 batch 内重复 uuid 或重复 canonical identity 会被拒绝，避免一个 response 无法确定对应关系。

## 4. 商品静态目录

### 4.1 权威表

`item_catalog` 每个 `item_id` 一行，至少包含：

```text
item_id INTEGER PRIMARY KEY
canonical_name_zh TEXT NOT NULL
name_normalized TEXT NOT NULL
description TEXT NOT NULL DEFAULT ''
data_version TEXT NOT NULL
updated_at INTEGER NOT NULL
```

`item_aliases` 保存多个别名：

```text
item_id INTEGER NOT NULL REFERENCES item_catalog(item_id)
alias TEXT NOT NULL
alias_normalized TEXT NOT NULL
alias_kind TEXT NOT NULL
data_version TEXT NOT NULL
updated_at INTEGER NOT NULL
PRIMARY KEY(item_id, alias_normalized)
```

别名可以包括旧名称、常用简称和经过审核的中文变体。规范化冲突不会静默覆盖：同一个规范化别名属于多个 item 时 importer 必须报错，除非输入显式标记该别名为可歧义 alias；可歧义 alias 只用于 autocomplete，不用于唯一解析。

### 4.2 版本更新

`catalog_versions` 保存 release version、输入 checksum、导入时间、item/alias 行数和 importer 版本；`catalog_state` 保存当前生效版本。每次导入在一个事务中：

1. 验证全部输入并生成确定性 manifest。
2. upsert 当前 item 名称、说明和数据版本；从不根据上传 listing 名称填充 catalog。
3. 替换该 item 的 active aliases，保留 item 行以便历史 listing 仍可显示最后已知名称。
4. 重建受影响 item 的 FTS 和短 token 行。
5. 更新 `catalog_state.current_version`。

现有 listing 只保存 `item_id`，查询使用 `LEFT JOIN item_catalog`。因此静态字典更新后已有 listing 自动显示新名称；未知 item 显示 `未知物品 #<item_id>`。item catalog 不要求 listing 有外键约束，这样未知 ID 仍可入库。卡片 ID 复用同一 `item_catalog`，卡片显示也使用相同 fallback。

### 4.3 搜索索引

- `item_search_fts` 是派生的 FTS5 trigram 表，文本包括 canonical name、别名和允许搜索的说明文本；它不是数据权威。
- `shop_search_fts` 是派生的 FTS5 trigram 表，每个 shop 的文本由 title 和当前 vendor name 组成。
- `search_short_tokens(scope_type, scope_id, token)` 保存一个和两个 Unicode code point 的规范化 token。`scope_type` 至少支持 `item` 和 `shop`。
- FTS 表和 token 表可以从权威表完整重建；迁移、恢复和 catalog import 必须提供重建步骤。
- 任何搜索 SQL 都通过 `EXISTS`/JOIN 使用这些表；Worker 不读取匹配 item IDs 后拼接 `IN (...)`。

## 5. Listing 与指纹迁移

### 5.1 listing 存储

`listings` 不再把上传的 `item_name` 或 `item_name_normalized` 作为有效字段。迁移窗口内可以保留为 `item_name_legacy` 和 `item_name_normalized_legacy`，用于回滚审计，但：

- 新协议不会发送这些字段。
- 新写入不填充这些字段。
- 搜索、展示、fingerprint 和 API response 都不读取这些字段。
- catalog 不从 legacy 字段自动导入。

在 v2 兼容窗口结束并完成数据备份后，通过 SQLite table rebuild 删除 legacy 列；如果生产数据量暂时不允许重建，列可以继续存在，但必须保持 nullable、不可读、不可作为权威来源。

### 5.2 listing fingerprint

fingerprint 输入仍为：

```text
source_id
shop_session_id
item_key（存在时）
item_id
upgrade
slots
card0..card3
sorted(raw option tuples: option_type, option_value, option_param)
```

不包含 `item_name`、说明、alias、option label、option display text、shop title、vendor name 或 `shop_id`。这样静态字典改名不会把一个 listing 变成新 listing，客户端显示名变化也不会制造重复商品。

### 5.3 listing options

`listing_options` 永久保存上传的 raw tuple：`option_type`、`option_value`、`option_param`、`option_index`。客户端 `display_value` 在 v2 不再接收；v1 即使携带也只能兼容解析，不能写成展示权威。未知 option type 仍保存并展示为：

```text
未知词条 type=<type> value=<value> param=<param>
```

## 6. Option definitions 和结构化词条查询

### 6.1 定义模型

option dictionary 改为按 `option_type` 定义，而不是按每个确切 `(type,value,param)` 组合建字典。建议表为：

```text
option_definitions(
  data_version,
  option_type,
  handle,
  label_zh,
  description_template,
  value_type,
  unit,
  scale,
  allowed_operators_json,
  param_policy_json,
  repeat_policy,
  display_template,
  updated_at,
  PRIMARY KEY(data_version, option_type)
)
```

字段语义：

- `handle` 是稳定机器标识，例如 `atk_plus`。
- `label_zh` 是 UI 中文标签，例如 `ATK +`。
- `value_type` 使用 `integer` 或 `scaled_integer`；raw option value 永远以整数保存。
- `scale` 是正整数，查询输入按固定 scale 转换，不使用浮点比较。
- `unit` 用于展示，例如 `%`、`points`。
- `allowed_operators_json` 只能包含 `eq`、`neq`、`gt`、`gte`、`lt`、`lte` 的子集。
- `param_policy_json` 明确 param 是 `ignored`、`required_exact`、`optional_exact` 还是由服务端规则解释；客户端不能自行决定。
- `repeat_policy` 使用 `same` 或 `distinct`。`same` 表示同一 type 的多个范围条件必须由同一 raw option 满足；`distinct` 表示每个条件需要不同 occurrence。当前不实现隐式 aggregate。
- `display_template` 是服务端控制的展示格式，例如 `ATK + {value}`。

### 6.2 `/api/v1/options` 响应

```json
{
  "version": "options-2026-09-19",
  "options": [
    {
      "type": 12,
      "handle": "atk_plus",
      "label_zh": "ATK +",
      "value_type": "integer",
      "unit": "points",
      "scale": 1,
      "allowed_operators": ["eq", "neq", "gt", "gte", "lt", "lte"],
      "param_policy": {"mode": "ignored", "filterable": false},
      "repeat_policy": "same",
      "display_template": "ATK + {value}"
    }
  ]
}
```

UI 必须根据该响应渲染 `[中文词条下拉框] [比较符下拉框] [数值输入]`。不允许把 option type、中文标签或 allowed operators 硬编码成客户端权威字典。

### 6.3 搜索条件协议

新条件使用重复的 query parameter：

```text
option=<option_type>:<operator>:<value>[:<param>]
option_mode=all|any
```

例如：`option=12:gte:50`。服务器先加载当前 option definition，再验证 type、operator、value type、scale 和 param policy，之后转换为 raw tuple 的 `EXISTS` 条件。比较符只属于查询协议，上传端仍然只传 raw tuple。

`value` 使用十进制 ASCII 字符串。`integer` 类型只接受整数；`scaled_integer` 类型允许小数位数不超过 `scale` 所要求的精度，服务端使用定点转换为整数后比较，禁止浮点计算和指数记法。例如 `scale=100` 时，查询 `1.50` 转为 raw value `150`。

- `all`：所有条件都必须匹配。
- `any`：至少一个条件匹配。
- 同一 type 的多个条件依照该 type 的 `repeat_policy` 处理，不由 SQL 偶然行为决定。
- 未知 option type 不出现在新下拉框中，但其 raw tuple 仍可展示和保留。
- 旧 `option_type`/`option_value`/`option_param` 参数在兼容期内解释为一个 `eq` 精确 raw tuple 条件；新 `option` 与旧参数同时出现时返回 400，避免语义冲突。兼容期结束后删除旧参数。

## 7. 中文包含搜索

### 7.1 范围和索引

`GET /api/v1/market/search?q=...` 的 q 同时搜索：

1. `item_catalog.canonical_name_zh`。
2. `item_aliases.alias`。
3. 允许搜索的 item description。
4. 当前 shop title。
5. 当前 vendor name。

q 不搜索 listing 上传名称，因为该名称不存在于 v2 契约且从未具有权威性。词条中文标签通过 option 下拉框选择，不混入 listing 文本 q。

### 7.2 一字符、两字符和更长关键词

- q 规范化为空则不启用文本条件。
- 一个或两个 Unicode code point：查询 `search_short_tokens`，通过 `EXISTS` 绑定到 item ID 或 shop ID。
- 三个或更多 Unicode code point：查询对应 FTS5 trigram 表；item 和 shop 两个 scope 各自使用 `MATCH`，再用 `EXISTS` 与 listing JOIN。
- 不承诺编辑距离纠错、拼音自动转换或未审核的同义词；这些功能只能通过 importer 添加 alias。
- 短 token 生成按 Unicode code point，不按 UTF-8 byte，避免中文被拆成无效 byte 片段。

### 7.3 `q` 的组合 SQL

查询必须保持在 D1 内完成，逻辑等价于：

```sql
WHERE l.status = 'active'
  AND (
    EXISTS (
      SELECT 1
      FROM item_search_fts f
      WHERE f.item_id = l.item_id
        AND f.text MATCH ?item_query
    )
    OR EXISTS (
      SELECT 1
      FROM shop_search_fts sf
      JOIN shop_sessions ss2 ON ss2.shop_id = sf.shop_id
      WHERE ss2.id = l.shop_session_id
        AND sf.text MATCH ?shop_query
    )
  )
```

短词路径使用 `search_short_tokens` 的对应 `EXISTS`，不生成 `item_id IN (...)`。查询先使用 status、item、option、map、price 等索引条件缩小范围，再执行有界文本 EXISTS。每页最多 50 条，最多 8 个 option conditions。

### 7.4 cursor 和版本绑定

签名 keyset cursor 必须绑定完整规范化上下文：

```text
q_normalized
q_mode (short_token|fts|none)
catalog_version
option_version
search_index_version
item_id
map
shop_type
include_stale
price_min
price_max
normalized option conditions and option_mode
sort
last sort value
last listing id
```

任何搜索上下文、catalog version 或 search index version 不一致都拒绝 cursor。cursor 不是 offset，也不允许跨查询复用。

## 8. 上传协议迁移

### 8.1 v2 契约

协议版本 2 保留现有顶层的 `client_run_id`、`snapshot_id`、`snapshot_mode`、分片、`observed_at` 和幂等语义，但：

- 删除 `items[].name`。
- item 只包含 `item_id`、可选 `item_key`、price、quantity、upgrade、slots、cards 和 raw `options`。
- shop 使用 `vendor_account_id`、`vendor_name`、`title`、地图、坐标、`shop_type`、可选 `shop_id`、必选 `uuid` 和必选 `shop_status`。
- v2 heartbeat 使用 shop objects，不依赖 `shops_seen`。
- 服务器 response 增加 `shops[]` 解析结果。

### 8.2 v1 兼容窗口

截至 2026-10-31，Worker 可以继续接受 `protocol_version=1`，但只用于短期迁移：

- v1 的 `items[].name` 接收后不得参与 fingerprint、身份、展示、catalog 导入或搜索。
- v1 的 `shop_key` 只作为旧记录查找线索；新 canonical identity 仍使用上传的账号、标题、地图、类型和坐标。
- v1 没有 `shop_status`/`uuid` 时不能表达显式 dismissed；只能使用旧 full/delta/heartbeat 语义。
- v1 请求在内部转换为 v2 domain object，并在日志中计数但不记录原始名称或完整 payload。
- 从 2026-11-01 起，上传和旧 exact option query 参数都返回明确的 deprecated/protocol error；文档、fixture 和测试在切换前同步更新。

### 8.3 幂等和 response 关联

`Idempotency-Key` 仍为 canonical `snapshot_id/part_index`。uuid 不是幂等键，也不作为 shop identity。新 batch 使用新 uuid；网络重试复用原 batch、原 uuid 和原 payload。`upload_batches.response_json` 保存完整 response，使重复请求仍能把 uuid 与服务端 shop_id 正确关联。

## 9. 显式关店、售出和 session 规则

- `dismissed` 只产生 shop/session/listing 状态变化，不产生 `sold_events`。
- 关闭时 active/missing listing 设置为 `expired`，历史可记录 `status_changed`，但售出数量为零。
- 被 dismissed 的 shop 仍保留逻辑 shop row 和历史 session；重新 opening 时新建 session，不能跨 session 进行售出比较。
- full 缺失、delta 缺失、heartbeat 不出现和客户端断线不能直接产生 dismissed。
- 现有“首个 full 基线、连续完整 full 缺失、数量下降、session TTL、transition_key 幂等”继续执行；只有 explicit dismissed 增加了一个更高优先级的关闭路径。
- 迟到的旧 opening 不得覆盖较新的 dismissed；较新 opening 可以重新打开同一逻辑 shop 并创建新的 session。

## 10. Importer 和数据治理

### 10.1 输入边界

Importer 只接受显式 `--input-file` 或 `--input-dir`，不读取写死的 `D:\openkore`，不将该路径写入配置，也不复制完整 OpenKore 数据文件。输入是通用的外部 item/option 数据文件；仓库只保存小型脱敏 fixture。

支持：

- JSON/JSONL/CSV/TSV 中的明确字段映射。
- `--encoding utf8|utf8-bom|utf16le|utf16be|auto`；`auto` 只接受可确定的 BOM 或严格 UTF-8，无法确定时失败，不猜测本地代码页。
- `--dry-run`，只验证和输出统计，不写生产 SQL/JSON。
- 显式 `--version`；没有版本参数时使用输入 manifest 的确定性版本字段，不使用当前时间作为唯一版本。

### 10.2 严格校验和确定性输出

Importer 必须报告文件名、行号、字段名和错误原因，拒绝：

- 非法或重复 item ID。
- 空 canonical name、无法规范化的字符串、超出长度的描述。
- 同一 item 的重复 alias。
- 未声明的列、错误的 option type/value/param、重复 option type 定义。
- 规范化后发生未声明的 alias 冲突。

输出按 item ID、规范化名称、option type 的固定顺序排序，生成 manifest：输入文件 checksum、每个文件大小、记录数、错误数、importer 版本、catalog/option data version 和输出 SHA-256。输出不包含 secret、API key、真实玩家名、商店快照或真实坐标。

生产 SQL/JSON 只能生成到被 gitignore 的本地目录；仓库提交脱敏 fixture 和 manifest schema，不提交真实生成物。

## 11. API、缓存和 UI

### 11.1 API

保留：

- `POST /api/v1/market/upload`
- `GET /api/v1/market/search`
- `GET /api/v1/market/listings/:id/history`
- `GET /api/v1/options`

增加：

- `GET /api/v1/items?q=<normalized-query>&limit=<1..20>`，只返回 item ID、canonical name、有限 alias 和当前 catalog version，不返回 listings。

`/api/v1/options` 和 `/api/v1/items` 使用版本 ETag 与 24 小时缓存。市场搜索使用现有 30 秒 public cache；upload 使用 no-store。Autocomplete 只返回最多 20 条，市场结果最多 50 条。

### 11.2 搜索响应

listing response 使用 catalog JOIN 后的 `item_id`、名称、别名摘要、description 摘要、价格、数量、raw/定义化 options、shop_id、shop title、vendor name、地图、坐标和 observed time。未知 item 和 option 必须带 fallback/raw 表示。默认只返回 active shop/session/listing；`include_stale=true` 仍不得包含 dismissed shop。

### 11.3 UI

页面加载当前 `/api/v1/options`，每个 option 条件显示：

```text
[中文词条下拉框] [比较符下拉框] [数值输入]
```

比较符下拉框只显示服务器 metadata 允许的运算符；param policy 为 filterable 时才显示 param 控件。UI 不暴露 raw option tuple 作为首选输入，也不硬编码中文词条名称。搜索结果显示明确的 `opening`/最近观测时间；dismissed shop 不出现在默认结果中。

## 12. D1 Free 预算和实现限制

实现继续使用现有硬上限：

- upload body 512 KiB。
- 每个 snapshot 最多 16 parts。
- 单页搜索最多 50 条。
- 每个搜索最多 8 个 option conditions。
- Worker invocation 的 D1 查询数保持在 50 以内。
- 每个 SQL statement 的 bound values 保持在 100 以内，复杂数组优先绑定一个 JSON 参数并使用 JSON1。
- 动态 SQL 保持在 100 KiB 以内。
- 任何 listing 结果都不能执行 per-row N+1 查询；option hydration 使用一个有界批量查询。
- FTS/token 索引是派生数据，catalog/shop 更新使用批量写入；不能在每个搜索请求重建索引。
- 价格历史和 sold events 继续按 90 天默认 retention 分块清理，当前 listings 永不按 retention 删除。

如果生产测量接近 D1 Free 读写或存储配额，先降低 heartbeat 写入频率和历史保留期，再评估付费 D1/Turso；不能通过移除验证、放宽分页或拼接巨大 SQL 来换取容量。

## 13. 迁移顺序

1. 新增 catalog/version/alias、option definition、search index 和 shop identity/lifecycle 表列，保持旧代码可读。
2. 为既有 shops 生成 canonical identity；检测冲突并停止迁移，不静默合并。
3. 新增 v2 protocol parser、response shop mapping 和 source-scoped shop resolver。
4. 双读 catalog JOIN 与 legacy listing name，但只允许 catalog/unknown fallback 出现在 API/UI。
5. 启用 explicit dismissed 原子关闭和新的 full/delta/heartbeat response。
6. 切换搜索到 catalog/alias/FTS/token EXISTS，并绑定 cursor context 版本。
7. 上线 importer 和脱敏 fixture，导入第一版静态 catalog/option definitions。
8. 在 2026-10-31 前完成 v1 客户端迁移；2026-11-01 起拒绝 v1/name/exact option compatibility。
9. 备份并重建 listings 表，删除 legacy item name 列；清理旧 `option_dictionary` 精确组合模型。
10. 运行 D1 migration、协议、搜索、关店、重启去重、游标和浏览器验证后再部署。

所有迁移向前兼容；不使用 destructive reset，不修改或写入 OpenKore 目录。

## 14. 测试策略

### 协议和规范化

- v2 缺少 uuid/shop_status、带 item name、dismissed 带 items、重复 uuid、重复 canonical identity 时拒绝。
- 每次新 batch 的 uuid 必须回显；重复 batch 返回保存的原 uuid。
- canonical identity 对空白、NFKC、坐标和标题变化具有确定结果；不同 source 即使所有其他字段相同也不相同。
- v1 name 即使变化也不影响 fingerprint、展示或 q 搜索。

### D1 和 ingestion

- OpenKore restart 后不带 shop_id 可以匹配同一 `(source_id, identity_hash)`。
- 错误 client shop_id 被纠正，不插入第二个 shop。
- opening、dismissed、迟到 opening、重新 opening 的 session 和状态正确。
- dismissed 过期 listing 且 sold_events 数量为零；delta/full 缺失不触发 dismissed。
- full 分片缺失、首个 baseline、连续 full missing、quantity decrease 和 retry 幂等继续通过。

### Catalog、option 和搜索

- catalog 更新后既有 listing 立即使用新名称。
- 未知 item/option 可入库并以 fallback/raw 展示。
- 波利类 query 通过 catalog alias/name 的 EXISTS 找到 listing，不读取上传 item_name。
- 一字符、两字符和三字符以上中文 query 各自走正确索引路径。
- option metadata 控制可用 operators、scale、param 和重复 type 语义。
- all/any、keyset cursor、catalog version 变化和 option version 变化均有测试。

### Importer 和配额

- UTF-8 BOM、UTF-16 BOM、显式 encoding、非法行、重复 ID、alias 冲突和 dry-run 有确定输出。
- 生产输出目录被 gitignore，fixture 不含真实玩家数据或 secret。
- SQL bound 数、statement 数、body、page、option 数和无 N+1 查询有回归测试。

## 15. 评审结论

该设计已经得到用户批准。后续实现必须先执行本设计对应的实施计划，完成一项并验证一项；本设计不授权在未更新契约、迁移和 fixture 前修改 OpenKore 或访问 `D:\openkore`。
