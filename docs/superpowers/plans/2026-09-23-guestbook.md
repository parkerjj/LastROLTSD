# 登记簿功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 LastROWeb 增加无需登录即可发布、检索和浏览的收购/出售/建议登记簿，并保留及显著标记过期记录。

**Architecture:** MySQL 新迁移创建 guestbook 与匿名限流时间桶表；Worker 以独立领域验证器、签名游标、repository 与 Hono 路由提供读写 API。页面新增独立 `/guestbook` 模块，复用目录自动补全与现有视觉令牌；过期状态由 API 按请求时间计算。

**Implementation status:** 已实现并通过全量测试（294 passed、8 skipped）、类型检查、构建、文档契约及 Wrangler dry-run。由于当前浏览器能力不能设置设备尺寸，390px 视口目视验证仍未完成。

**Tech Stack:** TypeScript、Hono、MySQL 8/InnoDB、Vite、原生 DOM/CSS、Vitest、Wrangler。

**Spec:** `docs/superpowers/specs/2026-09-23-guestbook-design.md`

## Global Constraints

- 三类内容提交后立即公开，不需要登录或人工审核。
- 收购/出售必须有目录 ItemID 或独立 Zeny 项、联系方式、正文及 1/3/7 天或永久期限。
- 建议只要求正文，可完全匿名。
- 过期记录始终保留在数据库、浏览及检索结果中；UI 降低对比度并在正文之外显示“已过期”印章。
- 只扩展当前正式 Worker 使用的 MySQL 存储路径，不增加 D1 第二套实现。
- 列表按 `created_at,id` 稳定排序并使用 HMAC 签名游标，不使用大 OFFSET。
- 限流只存服务器密钥摘要，不存明文 IP；匿名写入限流失败关闭。
- UI 复用现有 Phosphor、目录和 CSS 令牌，不引入新 UI 框架或图标族。
- 正文和联系方式按纯文本转义；SQL 使用参数绑定。

## Review Focus

- 交易类型必须互斥选择 ItemID 或 Zeny，建议不得带交易字段；由 Task 2 的字段矩阵测试覆盖。
- `expires_at = now` 算过期但不能过滤；由 Task 1 repository 和 Task 3 UI 测试覆盖。
- `%`、`_`、反斜线及 SQL 元字符关键词必须字面匹配；由 Task 1 查询测试覆盖。
- 相同时间戳记录以 id 作为游标并列键，不得漏项或重复；由 Task 1 分页测试覆盖。
- 时间桶切换、同 IP 并发不能超发，限流失败不得写入；由 Task 1 事务和 Task 2 路由测试覆盖。

---

### Task 1: MySQL 模式、Repository 与限流桶清理

**Files:**
- Create: `migrations/mysql/002_guestbook.sql`
- Create: `apps/worker/src/db/guestbook-repository.ts`
- Modify: `apps/worker/src/db/mysql-repository.ts`
- Modify: `apps/worker/src/services/retention.ts`
- Modify: `apps/worker/src/index.ts`
- Test: `apps/worker/test/guestbook-repository.test.ts`
- Test: `apps/worker/test/migrations.test.ts`
- Test: `apps/worker/test/retention.test.ts`

**Interfaces:**
- `GuestbookCategory = 'buy' | 'sell' | 'suggestion'`。
- `GuestbookSubmission`: category、`itemId: number | null`、`isZeny: boolean`、`contact: string | null`、`content: string`、`expiresAt: number | null`、`createdAt: number`。
- `GuestbookFilters`: 可选 category、itemId、q、cursor、limit。
- `GuestbookRepository.create(input, rateKey, bucketStart, limit): Promise<'created' | 'rate_limited'>`。限流桶计数与留言插入共用 transaction。
- `GuestbookRepository.search(filters, now): Promise<{items: GuestbookEntry[]; nextCursor: string | null}>`。包含过期行并返回 `isExpired = expiresAt !== null && expiresAt <= now`。
- Worker 路由通过与 Web 相同的 `apps/web/public/catalog/items.json` 目录资源精确检查 ItemID；页面静态资产绑定可读取该资源，不依赖不存在的 MySQL catalog 表。
- `GuestbookRepository.deleteRateLimitBucketsBefore(cutoff, limit): Promise<number>` 仅有界删除旧桶。

- [ ] **Step 1: 写迁移和 repository 失败测试**

在 `migrations.test.ts` 检查迁移有序、建立 `guestbook_entries` 与 `guestbook_rate_limits`、索引筛选/时间字段且不存 IP 明文。repository 测试覆盖参数绑定、字面 LIKE 转义、过期边界、相同时间戳 keyset 游标、精确目录查找以及限流事务回滚。

- [ ] **Step 2: 运行相关测试确认失败**

Run: `pnpm exec vitest run apps/worker/test/migrations.test.ts apps/worker/test/guestbook-repository.test.ts`
Expected: 新迁移/repository 尚不存在，测试失败。

- [ ] **Step 3: 创建 MySQL 迁移**

`guestbook_entries` 含自增 BIGINT id、category、可空 item_id/contact/expires_at、is_zeny、TEXT content、created_at；建立 `(category,created_at,id)`、`(item_id,created_at,id)`、`expires_at` 索引。`guestbook_rate_limits` 以 `(rate_key,bucket_start)` 为主键并索引 bucket_start。使用 InnoDB 与 `utf8mb4_0900_ai_ci`。

- [ ] **Step 4: 实现 repository 和查询测试**

repository 只依赖 `MysqlDatabase`，所有 SQL 参数化。限流事务插入桶或通过 `ON DUPLICATE KEY UPDATE count=count+1` 原子加一，检查计数；超限则回滚并返回 `rate_limited`，未超限才插入留言并提交。关键词对反斜线、`%`、`_` 转义后用于 `LIKE ... ESCAPE`。固定白名单组合筛选，游标按 `(created_at,id)` 下降比较并多取一行；签名上下文包含 category/itemId/q/limit。任何过滤均不加入过期条件。

- [ ] **Step 5: 接入有界桶清理和定时保留测试**

`deleteRateLimitBucketsBefore` 每次最多删传入上限；`runRetention` 每日清理当前时间两天前、最多 500 个桶，并在结果中报告删除数。测试确认超量旧桶需要多轮清理、新桶与 guestbook_entries 不被删除。

- [ ] **Step 6: 运行 Task 1 测试**

Run: `pnpm exec vitest run apps/worker/test/migrations.test.ts apps/worker/test/guestbook-repository.test.ts apps/worker/test/retention.test.ts`
Expected: PASS。

### Task 2: Worker 验证器、API 与路由注册

**Files:**
- Create: `apps/worker/src/domain/guestbook.ts`
- Create: `apps/worker/src/routes/guestbook.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/env.ts`
- Modify: `apps/worker/src/db/mysql-repository.ts`
- Test: `apps/worker/test/guestbook.test.ts`
- Test: `apps/worker/test/guestbook-route.test.ts`

**Interfaces:**
- `parseGuestbookSubmission(value, validItemIds?)` 返回已归一的 `GuestbookSubmissionInput` 或抛 `GuestbookValidationError`。
- `parseGuestbookFilters(params)` 严格解析类别、ItemID、关键词、limit、cursor。
- `encodeGuestbookCursor({createdAt,id,context},secret)` 与 `decodeGuestbookCursor(token,expectedContext,secret)` 使用独立 HMAC-SHA256 格式。
- `GET /api/v1/guestbook` 返回 `{items,nextCursor}`；POST 成功返回 `{item}`，限流返回 429 JSON。

- [ ] **Step 1: 写验证器及路由失败测试**

覆盖 buy/sell 必填字段、建议匿名字段矩阵、无效 ItemID、Zeny/ItemID 冲突、期限组合、超长输入、大小限制、400/413/429、过期结果包含和 cursor 校验。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run apps/worker/test/guestbook.test.ts apps/worker/test/guestbook-route.test.ts`
Expected: guestbook 模块未实现，测试失败。

- [ ] **Step 3: 实现字段验证、期限计算和 cursor**

设置 POST JSON 最大 16 KiB、正文 2,000 字符、联系方式 120 字符、关键词 80 字符、limit 默认 20/最大 50。字符串 NFKC 归一并 trim。建议必须没有交易字段。买卖必须有联系方式和期限；`isZeny=true` 时 itemId 必须为空，否则 itemId 必须是目录主键中存在的安全整数。days 只接受 1/3/7/permanent；单次捕获 `now` 生成 expiresAt。签名游标拒绝伪造、超长或筛选上下文不符的 token。

- [ ] **Step 4: 实现 Hono GET/POST 路由**

POST 流式读取限制体积后解析 JSON；从可信 `cf-connecting-ip` 取 IP，不信任 `x-forwarded-for`，缺失时落入一个固定共享匿名桶；以服务端密钥 HMAC 得 rateKey，不保存 IP。调用 Worker 注入的精确目录 ItemID 集合确认道具，再进行原子限流+插入。返回字段错误 400、超体积 413、超限 429。GET 严格校验筛选与游标并调用 search；数据库异常交由统一 500 handling。

- [ ] **Step 5: 注册生产路由并运行 Worker 验证**

在 `apps/worker/src/index.ts` 的 MySQL repository 分支注册路由并注入同 invocation 数据库、目录 ItemID 集合、CURSOR_SECRET 和 `GUESTBOOK_RATE_SECRET`（至少 32 字符，仅从环境变量读取；staging/production 缺失时 env 解析报错）。运行两个 guestbook 测试及 `pnpm --filter @lastroweb/worker typecheck`，期望 PASS。

### Task 3: `/guestbook` 页面、导航和样式

**Files:**
- Create: `apps/web/src/guestbook-page.ts`
- Modify: `apps/web/src/main.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/release-page.ts`
- Test: `apps/web/test/guestbook-page.test.ts`
- Test: `apps/web/test/api.test.ts`
- Test: `apps/web/test/build.test.ts`

**Interfaces:**
- Web 类型字段与 Worker JSON 保持一致，时间使用 epoch milliseconds。
- `MarketApiClient` 新增 `searchGuestbook(filters, signal?)`、`createGuestbookEntry(input, signal?)`。
- `mountGuestbookPage(root, api?)` 负责显示、检索、提交与分页。

- [ ] **Step 1: 写 API 和页面交互失败测试**

测试 `/guestbook` route mount、两处导航入口、查询/发布 URL 与 JSON、三类表单字段切换、目录选择、动态文本 escaping、过期灰化 class 与独立印章、加载/错误/空/成功/限流/分页状态。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run apps/web/test/guestbook-page.test.ts apps/web/test/api.test.ts apps/web/test/build.test.ts`
Expected: guestbook API 和页面不存在，测试失败。

- [ ] **Step 3: 增加类型及 API 客户端方法**

沿用 MarketApi 错误处理和 AbortSignal；仅序列化声明过的筛选字段，不提交 IP 或客户端派生标识。

- [ ] **Step 4: 实现完整页面交互**

复用 `createCatalogLoader`、`findCatalogMatches`。道具 combobox 支持上下键、Enter、Escape；选择“Zeny”后清空且不显示 ItemID。建议表单只保留正文。提交时禁用重复提交，成功后重置表单并刷新第一页；筛选变化重置游标，分页保留全部筛选。

- [ ] **Step 5: 实现网站一致视觉与无障碍状态**

使用现有暖纸底色、森林绿、红色强调色及 Phosphor 图标；追加 `.guestbook-*` 样式，保持 2px 直角与清楚的分隔列表。过期内容降低对比度，独立红色倾斜印章放在记录头部且不遮挡正文。加入键盘 focus、aria-live、清晰错误/空/加载状态与 390px 布局。运行页面/API 测试及 `pnpm --filter @lastroweb/web build`，期望 PASS。

### Task 4: API 文档与契约检查

**Files:**
- Modify: `docs/api.md`
- Modify: `scripts/check-docs.mjs`

- [ ] **Step 1: 扩展文档契约脚本**

要求文档出现 GET/POST 路由、三个 category、过期状态和 429。

- [x] **Step 2: 写接口文档并验证**

用实际 JSON 样例描述类别字段矩阵、Zeny `item_id:null`、限制值、游标、匿名限流和过期行不隐藏。运行 `pnpm test:docs`，期望 PASS。

### Task 5: 全量验证与本地视觉检查

- [x] 运行 `pnpm test`，294 passed，8 skipped。
- [x] 运行 `pnpm typecheck`，无错误。
- [x] 运行 `pnpm build`，生产构建成功。
- [x] 运行 `pnpm test:docs`，55 条契约断言通过。
- [x] Wrangler `deploy --dry-run` 通过，静态目录读取与 Worker 绑定正常。
- [ ] 浏览器目视检查：本地 Vite 已运行于 `http://localhost:5173/guestbook`；当前 Computer Use 浏览器未能设置 390px viewport，因此移动视口缺少实际浏览器截图验证。移动网格选择器已按代码修正，响应式样式有构建覆盖。

### Task 6: 最终复核

- [x] 按设计规格逐项核对字段、Zeny、期限、匿名建议、检索/分页、过期可见、限流失败关闭、导航、移动和无障碍状态。
- [x] 运行 `git diff --check` 并检查工作区；保留原有未提交变动，不创建提交。
