# LTSD Stripe KE 商务系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 LTSD 实现 KE 实例额度和全平台离线 KoreEngine 功能的一次性 CNY 购买、不可变订单、Stripe Checkout、自动权益交付/退款和购买记录。

**Architecture:** 在现有 Cloudflare Hono Worker 与 MySQL 账号/权益系统中新增 commerce 模块，`ke_entitlements` 继续作为既有鉴权读取的当前投影，订单及贡献账本保存商业历史。`GET /ke/buy` 返回 Worker 注入商品、价格版本、会话与权益的 HTML bootstrap；用户确认时由服务端重新报价，Stripe webhook 与持久 cron 自动结算、交付及退款重算。

**Tech Stack:** TypeScript、Hono、Cloudflare Workers、MySQL 8/mysql2、Vite、Vitest、Stripe REST API/Checkout；不新增 Stripe SDK。

**Spec:** `docs/superpowers/specs/2026-10-30-stripe-ke-commerce-design.md`

## Global Constraints

- 本任务按用户明确要求，在独立 managed worktree 中执行；不在源 checkout 修改实现。所有 shell 命令以 `rtk` 开头。
- 使用仓库声明的 Node 24.x 与 pnpm 12.4.2；TypeScript/Worker 代码按现有 Hono、mysql2、Vitest 模式实现。
- 一个计费月固定 30×24 小时；金额为 CNY 分，时长与中间乘除使用 BigInt；每个项目四舍五入到分后求和。
- 实例额度 ¥50/30 天，standalone 功能 ¥30/30 天；单项新增时长满 180 天八折，满 360 天七折。
- 每名正式用户的 99 年赠送额度与 `module:core` 不收费、不续期、不纳入统一到期目标。
- 订单确认后商品、目标、时长、价格、优惠及预览不可变；同一用户可有多笔 30 分钟待支付订单，不能为平衡日期少交付已付款时长。
- Checkout 是 CNY `mode=payment`；Alipay 使用普通商户付款配置；Managed Payments 保持关闭，不实现订阅。
- HTML 个性化响应及用户 API 必须 `private, no-store`；Webhook 按原始 body 验签；不得把密钥、session token、其他用户数据写入 HTML 或日志。
- 用户看到的日期时间按浏览器本地时区显示；服务端权益时长仍按固定毫秒数计算。
- 只修改商务接入所需文件；不得修改 KE 授权协议或把捐赠 Stripe key 扩权复用。

## Review Focus

- 金额舍入和期限门槛：`commerce-money.test.ts` 锁定 30/90/180/360 天和 35 天 12 小时的逐项结果。
- 旧数量流水拆分与赠送/负数流水：`commerce-units.test.ts` 锁定拆分前后 signed SUM 完全相同且赠送权益不进入商品单元。
- 支付通知重复、乱序及创建响应丢失：`commerce-webhook.test.ts` 与 `commerce-orders.test.ts` 锁定每个 order item 最多交付一次、每笔已付款订单完整追加时长。
- 累计部分退款、失败后恢复和其他订单贡献：`commerce-refunds.test.ts` 锁定累计目标差额与按订单来源重放，不缩放账号总权益。
- HTML bootstrap 注入、缓存和会话隔离：`commerce-page.test.ts` 锁定 XSS 安全序列化、`private, no-store`、匿名/登录态以及不重复请求首屏账号/商品/权益 API。

## File Structure

- `migrations/mysql/023_ke_commerce.sql`：订单、商品客户映射、报价、订单项、unit、贡献事件、退款、Webhook 收件箱与 job 表。
- `packages/commerce/`：Worker 与浏览器共同使用的商品目录 DTO、期限常量、BigInt 金额/折扣计算；保持纯函数，不依赖运行环境。
- `apps/worker/src/commerce/`：按 `types/config/catalog/money/pricing/repository/units/projection/stripe-client/quotes/orders/webhook/refunds/jobs/router/page` 分职责实现。
- `apps/worker/src/env.ts`、`apps/worker/src/index.ts`、`wrangler.toml`：隔离商务配置、路由注册、cron 与 `/ke/buy` worker-first。
- `apps/worker/test/commerce-*.test.ts`：纯规则、仓储、HTTP、账本、Stripe adapter 和 Worker 生命周期测试。
- `apps/web/index.html`、`apps/web/src/main.ts`、`apps/web/src/auth/store.ts`：bootstrap placeholder、购买路由和账号态初始化。
- `apps/web/src/commerce-page.ts`、`apps/web/src/commerce-page.css`、`apps/web/src/commerce-api.ts`：购买、付款前预览、成功返回状态和购买记录 UI。
- `apps/web/test/commerce-*.test.ts`：bootstrap、金额交互、全量权益变化预览、记录分页和窄屏行为。
- `.dev.vars.example`、`docs/api.md`、Worker 配置与部署说明：只记录非机密占位字段和对外契约。

## Implementation Tasks

### Task 1: 商务目录与精确金额规则

**Files:** Create `packages/commerce/package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/catalog.ts`, `src/money.ts`, `src/pricing.ts`, `test/money.test.ts`, `test/catalog.test.ts`; modify `apps/web/package.json`, `apps/worker/package.json`, `pnpm-lock.yaml`.

**Interfaces:**
- `COMMERCE_MONTH_MS: bigint = 30n * 24n * 60n * 60n * 1000n`。
- `tierForDuration(durationMs: bigint): 100 | 80 | 70`。
- `priceLineCents(monthlyCents: bigint, durationMs: bigint, tierPercent: 100 | 80 | 70): bigint`，一次完成有理数计算并 half-up 舍入到分。
- `chooseDiscountStrategy(tierTotalCents: bigint, promoTotalCents: bigint | null): 'term' | 'promotion_code'`，相同时选择期限价。
- `getCommerceCatalog(pricingVersion: string): CommerceCatalog` 返回价格版本、公开文案、期限和 CNY 月基价，不返回 Stripe ID。

- [x] **Step 1: 写失败测试**：6 个额度×30 天=30000 分；1 个额度×180 天八折=24000 分；2 个额度×90 天=30000 分；30 天 standalone=3000 分；35 天 12 小时额度=5917 分；179 天 23:59:59 原价、180 天八折、360 天七折；优惠价格相同选择期限价。
- [x] **Step 2: 运行 `rtk pnpm exec vitest run packages/commerce/test/money.test.ts packages/commerce/test/catalog.test.ts`**，确认缺少实现导致失败。
- [x] **Step 3: 实现共享 `money.ts`、`pricing.ts`、`catalog.ts` 与公开类型**；前端和 Worker 共用计算，内部始终用 BigInt，JSON 边界金额/时长用十进制字符串。
- [x] **Step 4: 将 `@lastroweb/commerce` 加入 web/worker workspace dependencies 并更新 lockfile；重跑上述测试、`rtk pnpm typecheck` 和两应用 build**。
- [x] **Step 5: 提交 `feat: add commerce catalog and exact pricing`**。

### Task 2: 商务表与 MySQL 仓储基础

**Files:** Create `migrations/mysql/023_ke_commerce.sql`, `apps/worker/src/commerce/repository.ts`, `apps/worker/src/commerce/mysql-repository.ts`; create `apps/worker/test/ke-commerce-schema.test.ts`, `commerce-repository.test.ts`; modify `apps/worker/test/mysql-schema.test.ts` only if needed for migration sequence assertions.

**Interfaces:**
- `createCommerceRepository(db: MysqlDatabase): CommerceRepository`。
- `CommerceRepository.transaction<T>(work: (tx: CommerceTransaction) => Promise<T>): Promise<T>`。
- transaction methods use decimal-string user/row IDs and lock `auth_users` before account-owned commerce rows.
- Create the nine logical tables defined in the spec: `commerce_customers`, `commerce_quotes`, `commerce_orders`, `commerce_order_items`, `commerce_units`, `commerce_unit_events`, `commerce_refunds`, `commerce_provider_events`, `commerce_jobs`.

- [x] **Step 1: 写迁移与仓储失败测试**：每表的 owner/FK、幂等唯一键、订单快照、退款 revision、provider event 去重、job lease/fencing 字段及查询索引均存在；SQL 不含 SQLite-only 语法。仓储测试锁定用户并在异常时 rollback。
- [x] **Step 2: 运行 `rtk pnpm exec vitest run apps/worker/test/ke-commerce-schema.test.ts apps/worker/test/commerce-repository.test.ts`**，确认失败。
- [x] **Step 3: 编写 023 migration 和最小仓储接口/实现**；金额、时间及 duration 用无符号 BIGINT 或有符号 BIGINT 按字段语义区分，API 大整数全部用字符串传输。
- [ ] **Step 4: 重跑目标测试、`rtk pnpm test:migration` 与 `rtk pnpm typecheck`**；在隔离 MySQL 8 数据库应用所有迁移并检查 `SHOW CREATE TABLE`、外键和索引，不连接正式库。

> 本机没有可用 MySQL 8 测试服务（`MYSQL_TEST_URL` 未设置、Docker daemon 未运行、`mysqld` 未运行）；SQL 应用验证待有隔离测试库时补跑。
- [x] **Step 5: 提交 `feat: add commerce persistence schema`**。

### Task 3: 旧权益单元接管与投影写入

**Files:** Create `apps/worker/src/commerce/units.ts`, `unit-repository.ts`, `projection.ts`; modify `apps/worker/src/commerce/repository.ts`, `apps/worker/src/ke/entitlements.ts`, `apps/worker/src/admin/types.ts`, `apps/worker/src/admin/repository.ts`, `apps/worker/src/admin/service.ts`, and `migrations/mysql/023_ke_commerce.sql`; create `apps/worker/test/commerce-units.test.ts`, `commerce-projection.test.ts`, `commerce-admin-projection.test.ts`; extend `apps/worker/test/admin-service.test.ts` and `ke-commerce-schema.test.ts`.

**Interfaces:**
- `normalizeLegacySlotUnits(tx: CommerceTransaction, userId: string, now: bigint): Promise<CommerceUnit[]>` lazily converts only active positive paid slot rows; gift and negative adjustment rows remain untouched.
- `applyUnitProjection(tx: CommerceTransaction, unitId: string, projection: UnitProjection): Promise<void>` updates the linked current `ke_entitlements` projection without changing auth read semantics.
- `recordAdminEntitlementChange(tx, change: AdminEntitlementChange): Promise<void>` writes the effective contribution/cutoff using the admin operation timestamp and existing before/after audit facts.

- [x] **Step 1: 写失败测试**：quantity=6 的正向付费行拆为 6 个 unit 后 signed SUM 仍为 6；99 年 signup unit 与负数行不拆分、不收费；重复/并发接管只生成一组 unit；同一 unit 续期更新当前投影而不插入重叠新行；管理员编辑锁序、有效期限差额、退款零权益与管理员撤销互不覆盖。
- [x] **Step 2: 运行目标 Vitest 文件并确认失败**：首次运行因 `units.ts` / `projection.ts` 尚不存在而红；管理员锁序断言也确认旧流程直接锁权益行。
- [x] **Step 3: 实现按账户锁定的惰性接管和投影更新**；保留既有授权查询的 resource 聚合契约；管理员的有效增减与 cutoff 作为不可变事件记录。
- [x] **Step 4: 实现/验证投影回放纯函数：第 0 天买 30 天、第 5 天管理员加到第 35 天、购买全退后仍保留管理员贡献；第 100 天管理员设到第 130 天，重放结果仍为第 130 天；负向管理员调整不会形成后续购买欠额。**
- [x] **Step 5: 运行上述测试及 `rtk pnpm exec vitest run apps/worker/test/ke-entitlements.test.ts apps/worker/test/ke-routes.test.ts`，确认既有鉴权不变；提交 `feat: model commercial entitlement units`**：全仓 Vitest 1247 passed / 66 skipped，TypeScript、lint、docs、migration 脚本检查均通过。

### Task 4: Stripe REST adapter、客户映射与促销预览

**Files:** Create `apps/worker/src/commerce/stripe-client.ts`, `customers.ts`, `promotion-preview.ts`; create `apps/worker/test/commerce-stripe-client.test.ts`, `commerce-promotion-preview.test.ts`.

**Interfaces:**
- `createStripeClient(options: { secretKey: string; apiVersion: string; fetch: typeof globalThis.fetch }): StripeClient`。
- `ensureCommerceCustomer(userId: string, identity: AuthSessionResponse['user'], ...): Promise<CommerceCustomer>` uses `commerce_customers` and a stable idempotency key; never searches/reuses donation customers by email.
- `previewPromotion(input: { customerId: string; items: readonly StripePreviewItem[]; promotionCode: string }): Promise<PromotionPreview>` uses only this order's one-time CNY items.

- [x] **Step 1: 写失败测试**：REST form encoding、Authorization/API-Version headers、idempotency key、Stripe error 转固定公开错误、超时与无效 JSON；客户创建重复请求得到同一 customer；促销预览只纳入本单项目且没有订阅、税、余额抵扣。
- [x] **Step 2: 运行目标测试并确认失败**。
- [x] **Step 3: 实现通用 REST adapter 与 customer/promotion service**；adapter 通过依赖注入接收密钥、API version 和 fetch，不复用捐赠渠道配置。
- [x] **Step 4: 核对 Stripe API Reference 的 one-time Invoice Preview、Product 关联、Promotion Code 限制及金额字段；测试 GET 不带幂等键、客户创建使用稳定幂等键。隔离 test-mode API 联调并入 Task 13：当前 Stripe connector 仅提供 `livemode=true` 的正式账号上下文，因此本任务未调用任何 live API，也未修改 Stripe 对象。**
- [x] **Step 5: 运行目标测试并提交 `feat: add Stripe commerce adapter`**：新增目标测试 10 passed；全仓 Vitest 1257 passed / 66 skipped；TypeScript、lint、docs 58 assertions、migration 脚本及 diff 检查通过。隔离 test-mode API 联调留在 Task 13；未修改 Stripe live 对象。

### Task 5: 服务端报价与购买规则

**Files:** Create `apps/worker/src/commerce/quotes.ts`, `quote-repository.ts`, `quote-input.ts`, `apps/worker/test/commerce-quotes.test.ts`; modify `apps/worker/src/env.ts` only for commerce catalog version/config types.

**Interfaces:**
- `QuoteSelection` is a discriminated union for `slot_add`, `slot_renew`, `standalone`, and `align_all_paid`; standard `termDays` accepts only 30/90/180/360; client never sends amount, `duration_ms`, expiry target, user ID, or discount percent.
- `createQuote(input: { userId: string; selection: QuoteSelection[]; promotionCode?: string }, deps: QuoteDependencies): Promise<CommerceQuote>` returns an immutable short-lived quote and complete before/after account preview.
- `POST /api/v1/commerce/quotes` requires an active session, same-origin/CSRF protection, bounded JSON body, and rate limit.

- [ ] **Step 1: 写失败测试**：赠送额度不可续、只有赠送额度时报无可续项目；只续指定 paid unit；standalone 与 slots 独立；align 排除 gift、期限取 max paid expiry + term；跨度小于 24 小时拒绝 align；至少一项补足超过 30 天；同一 unit 重复出现拒绝；1000 unit 上限；本地期限折扣与 Stripe promotion 全单择优、平价用期限价。
- [ ] **Step 2: 运行 `rtk pnpm exec vitest run apps/worker/test/commerce-quotes.test.ts` 并确认失败**。
- [ ] **Step 3: 实现服务端选择解析、权益快照、逐项计价、促销比较和完整账户预览**；quote 保存 `pricing_version`、输入摘要、expiry 和快照，初始有效期 2 分钟。
- [ ] **Step 4: 接入 Hono route；测试跨用户 unit ID、pending/disabled 用户、缺 CSRF/跨源、过期 quote、数据库错误均不泄露订单或权益数据。**
- [ ] **Step 5: 运行目标测试并提交 `feat: add authoritative commerce quotes`**。

### Task 6: 固定订单与一次性 Checkout

**Files:** Create `apps/worker/src/commerce/orders.ts`, `checkout.ts`, `apps/worker/test/commerce-orders.test.ts`; add route in `apps/worker/src/commerce/router.ts`.

**Interfaces:**
- `createOrderAndCheckout(input: { userId: string; quoteId: string; idempotencyKey: string }, deps: OrderDependencies): Promise<CheckoutOrderResult>`。
- `POST /api/v1/commerce/orders` validates the stored quote and creates an immutable order before returning `{ orderId, checkoutUrl, expiresAt }`.
- Stripe request is one-time CNY Checkout; `managed_payments.enabled=false`, adaptive pricing off, allow-promotion-codes off; pass native promotion only when promotion strategy won; use ordinary Alipay-capable merchant payment configuration.

- [ ] **Step 1: 写失败测试**：quote 不属于当前用户/已过期/金额版本变化时不能下单；重复 confirmation key 且相同 hash 返回同单，hash 不同拒绝；Stripe 幂等重试返回同 Session；多个 pending order 并存且互不关闭；每单 Session 30 分钟，订单 line items 与 quote cents/currency/product 逐项一致。
- [ ] **Step 2: 运行目标测试并确认失败**。
- [ ] **Step 3: 实现事务化固定订单和 Checkout 创建**；Session metadata 只关联 order ID/namespace，不把用户隐私放入 metadata；创建失败保留 checkout failed 事实，不能改写订单条款。
- [ ] **Step 4: 在 test mode 验证 `payment_method_configuration` 保持普通商户 Alipay 能力，禁止只信用卡的硬编码方法；验证零金额促销与 `no_payment_required` 回应。**
- [ ] **Step 5: 运行目标测试并提交 `feat: create immutable Stripe checkout orders`**。

### Task 7: Webhook 收件与支付交付

**Files:** Create `apps/worker/src/commerce/webhook.ts`, `fulfillment.ts`, `apps/worker/test/commerce-webhook.test.ts`, `commerce-fulfillment.test.ts`; register `/api/v1/commerce/stripe/webhook` in `router.ts`.

**Interfaces:**
- `receiveStripeEvent(request: Request, deps: WebhookDependencies): Promise<Response>` reads original bytes, verifies Stripe signature/timestamp, persists `event_id` and coalesced order job before 2xx.
- `reconcilePaidOrder(orderId: string, deps: FulfillmentDependencies): Promise<FulfillmentResult>` reads authoritative latest Session/PaymentIntent state and applies every immutable order item once.

- [ ] **Step 1: 写失败测试**：签名错误/过期拒绝；重复 event_id 去重；数据库不可用返回 non-2xx；仅 completed+paid 或 async succeeded 发放；completed+unpaid/failed/expired 不发放；付款事件先于完成页面仍完整交付；交付从 `delivered_at` 起新购完整期限、续期按 `max(latest_end, delivered_at)+duration`。
- [ ] **Step 2: 运行目标测试并确认失败**。
- [ ] **Step 3: 实现 webhook inbox 和 account-lock 下的幂等交付事务**；多个 unit 的订单完整写 order item contribution 与 `ke_entitlements` projection。
- [ ] **Step 4: 模拟重复、乱序和事务提交后响应丢失，确认不漏发、不双发；运行目标测试。**
- [ ] **Step 5: 提交 `feat: fulfill paid commerce orders idempotently`**。

### Task 8: 自动比例退款与贡献重放

**Files:** Create `apps/worker/src/commerce/refunds.ts`, `apps/worker/test/commerce-refunds.test.ts`; extend `projection.ts` tests.

**Interfaces:**
- `syncOrderRefunds(orderId: string, deps: RefundDependencies): Promise<RefundSyncResult>` fetches the authoritative paginated Stripe refund set, stores latest state by `refund_id`, and increments refund revision only when the set changes.
- `replayCommerceUnit(unitId: string, events: readonly CommerceUnitEvent[], refundRevision: number): UnitProjection` computes the current paid/admin contributions without editing original events.

- [ ] **Step 1: 写失败测试**：实付 180 元、90/30 天，退款 36 元回收 18/6 天，再退 18 元再回收 9/3 天；同样累计 30% 的一次/分次结果一致；其他订单与 gift 不变；失败退款恢复本单贡献；0 实付不除零；部分 Stripe 分页完成前不提交半套退款状态。
- [ ] **Step 2: 运行目标测试并确认失败**。
- [ ] **Step 3: 实现累计成功退款比例、每项 floor 毫秒目标差额、revision 去重和受影响单元重放**；退款事件只更新 projection，不改原订单或 PURCHASE 事件。
- [ ] **Step 4: 测试退款先于交付、退款事件乱序、同 refund 多事件和新订单交错续期；运行目标测试。**
- [ ] **Step 5: 提交 `feat: reverse commerce entitlements for Stripe refunds`**。

### Task 9: 持久 job、租约和周期补偿

**Files:** Create `apps/worker/src/commerce/jobs.ts`, `commerce-job-repository.ts`, `apps/worker/test/commerce-jobs.test.ts`; modify `apps/worker/src/index.ts` and `wrangler.toml`.

**Interfaces:**
- `runCommerceJobTick(env: AppEnv, options?: { now?: number; limit?: number }): Promise<CommerceTickResult>` claims bounded due jobs with lease owner, expiry and fencing token; opens/closes a DB connection scoped to its invocation.
- `enqueueCommerceReconcile(orderId: string, now: number): Promise<void>` coalesces duplicate events by order and increments dirty generation.

- [ ] **Step 1: 写失败测试**：过期 lease 可接管、旧 fencing token 不能提交、同订单多事件合并但 dirty generation 不丢、失败按 5s/30s/2m/10m/1h 退避、不超过每轮 20 单/20 秒、连接关闭。
- [ ] **Step 2: 运行目标测试并确认失败**。
- [ ] **Step 3: 实现持久 job runner；接入现有每分钟 cron，商务处理失败单独记录，不能阻止 auth/mail/market job。Webhook waitUntil 仅用新建连接加速，不作为持久状态。**
- [ ] **Step 4: 扩展 Worker lifecycle 测试，模拟 DB 暂断、worker 终止、重启后 cron 补偿；运行目标测试。**
- [ ] **Step 5: 提交 `feat: reconcile commerce orders with durable jobs`**。

### Task 10: `/ke/buy` 动态 HTML bootstrap

**Files:** Create `apps/worker/src/commerce/page.ts`, `apps/worker/test/commerce-page.test.ts`; modify `apps/worker/src/index.ts`, `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/auth/store.ts`, `apps/web/src/auth/types.ts`, `wrangler.toml`.

**Interfaces:**
- `buildCommerceBootstrap(request: Request, env: AppEnv, db: MysqlDatabase | undefined): Promise<CommerceBootstrap>` returns public catalog/pricing version plus anonymous or authenticated session and effective detailed entitlements.
- `renderCommerceHtml(request: Request, env: AppEnv, db: MysqlDatabase | undefined): Promise<Response>` fetches built `index.html`, injects `<script type="application/json" id="commerce-bootstrap">`, and sets `text/html; charset=UTF-8`, `Cache-Control: private, no-store`.
- `AuthStore.initializeFromBootstrap(session: AuthSessionResponse | null): void` initializes `active`/`pending`/anonymous state so `mountAuthNav` does not issue duplicate bootstrap `GET /api/v1/auth/me`.

- [ ] **Step 1: 写失败测试**：anonymous 页面仍有商品目录；登录态页面包含本人 profile/CSRF 和全部当前收费/赠送权益；`</script><script>` 作为数据不执行；缺 Asset/DB 按固定错误处理；响应 no-store；初始化后 auth store 不调用 `me()`。
- [ ] **Step 2: 运行目标测试并确认失败**。
- [ ] **Step 3: 实现 Worker HTML 注入和 AuthStore hydration**；注入只用安全 JSON serializer，不含 session token、Stripe ID/key；前端 bootstrap 仅用于即时交互展示。
- [ ] **Step 4: 配置顶层、staging、production 的 Assets `run_worker_first` 包含 `/ke/buy`；配置 Vite 本地代理；测试无独立 catalog/entitlements/auth-me 首屏 JSON 请求。**
- [ ] **Step 5: 运行 Worker/web bootstrap 测试、`rtk pnpm --filter web build`；提交 `feat: serve commerce bootstrap at ke buy route`**。

### Task 11: 购买、续期与统一到期界面

**Files:** Create `apps/web/src/commerce-api.ts`, `commerce-page.ts`, `commerce-page.css`; modify `apps/web/src/main.ts`, `apps/web/src/ke-page.ts`, `apps/web/test/commerce-page.test.ts`.

**Interfaces:**
- `readCommerceBootstrap(doc: Document): CommerceBootstrap` validates embedded JSON version/schema and fails closed on malformed data.
- `quoteCommerceSelection(selection: QuoteSelection, promotionCode?: string): Promise<CommerceQuote>` calls quote API only when user proceeds to final review.
- `mountCommercePage(root: HTMLElement, bootstrap: CommerceBootstrap, api: CommerceApi): void` renders purchase modes and owned-unit review.

- [ ] **Step 1: 写失败 UI/API 测试**：逐个显示所有额度（包括同日）；赠送行不可选；期限分段常显 30/90/180/360 天及折扣；加购数量使用共享 BigInt 函数即时计算；功能独立于额度；统一模式按各自补足时长计价；差距 <24h 点击提示而不发 quote；全账户变化表列出购买前/后；本地时区；促销与期限整单择优不叠加。
- [ ] **Step 2: 运行目标 web 测试并确认失败**。
- [ ] **Step 3: 使用批准的 renewal prototype 布局实现 UI，并从 `/ke/my` 提供 `/ke/buy` 入口；不得复用假 VIP 静态支付链接。**
- [ ] **Step 4: 验证 390px/320px 无横向溢出；测算 2 个额度×180 天显示 ¥480；15/20/3 天统一续期 30 天分别补 35/30/47 天，总价 ¥155.33；付款前赠送额度与未选择项目均保留在完整预览中。**
- [ ] **Step 5: 运行 web 测试和 build；提交 `feat: add KE commerce purchase page`**。

### Task 12: 支付返回与购买记录

**Files:** Extend `apps/worker/src/commerce/router.ts`, `orders.ts`; extend `apps/web/src/commerce-page.ts`, `commerce-page.css`; create `apps/worker/test/commerce-order-history.test.ts`, extend `apps/web/test/commerce-page.test.ts`; modify `docs/api.md`.

**Interfaces:**
- `getCommerceOrder(userId: string, orderId: string): Promise<CommerceOrderView>` verifies ownership and returns order/payment/fulfillment/refund facts.
- `listCommerceOrders(userId: string, cursor?: string): Promise<CommerceOrderPage>` returns bounded created_at/id cursor pagination.
- `/ke/buy` includes a lazily loaded purchase-history view; Checkout return identifies an order, then the browser polls only that user's order status.

- [ ] **Step 1: 写失败测试**：无法查看其他用户 order；invalid cursor 拒绝；原订单快照不可变；退款记录显示累计比例与各项抵扣；success page 在 processing/paid/fulfilled 状态正确轮询；取消支付不关闭或修改旧订单。
- [ ] **Step 2: 运行目标测试并确认失败**。
- [ ] **Step 3: 实现购买记录分页和返回状态 view**；页面日期使用 `Intl.DateTimeFormat` 的浏览器本地时区，标出 timezone。
- [ ] **Step 4: 更新 `docs/api.md`，运行目标测试；提交 `feat: show commerce order history and status`**。

### Task 13: 配置、测试环境联调与发布前验证

**Files:** Modify `apps/worker/src/env.ts`, `wrangler.toml`, `.dev.vars.example`, `docs/api.md`; create/extend `apps/worker/test/commerce-deployment-preflight.test.ts` and required migration/deployment checks.

**Interfaces:**
- `resolveCommerceConfig(env: AppEnv): CommerceConfig | null` validates mode/account pairing and required test/live secrets without falling back to donation `STRIPE_SECRET_KEY`.
- Test/staging/live `stripe_account_id`, `livemode`, Product/Price mapping, payment configuration and webhook secret must be explicit and environment-scoped.

- [ ] **Step 1: 写失败配置测试**：commerce disabled 时不接受新报价/建单但 webhook/已存在 job 仍运行；缺失 key/价格版本/Alipay-capable payment configuration 在新建单前返回固定 unavailable；test/live ID 混用拒绝；Managed Payments 永远为 false。
- [ ] **Step 2: 运行配置测试并确认失败**。
- [ ] **Step 3: 实现环境解析和占位模板**；只从独立 `COMMERCE_STRIPE_SECRET_KEY` 取商务密钥，不输出密钥或完整 Stripe error body。
- [ ] **Step 4: 在隔离 test mode 完成 1/6 个额度、180/360 天、促销码胜出/不胜出、Alipay 能力、付款成功/失败/过期、重复 webhook、部分/全部退款闭环；在独立 MySQL 8 数据库执行 migration 与故障补偿测试。**
- [ ] **Step 5: 跑 `rtk pnpm lint`、`rtk pnpm typecheck`、`rtk pnpm test`、`rtk pnpm test:docs`、`rtk pnpm test:migration`、`rtk pnpm --filter web build`、`rtk git diff --check`；检查 Wrangler dry-run 和工作区。**
- [ ] **Step 6: 测试与审核通过后，在已指定的 LTSD.Ro 正式账号创建两个 Product 与常用 CNY 一次性 Price（实例额度 30/90/180/360 天分别 ¥50/¥150/¥240/¥420，standalone 分别 ¥30/¥90/¥144/¥252）；不启用 Managed Payments，不创建订阅，不进行正式扣款或部署。**

## Self-Review

- Spec coverage: Tasks 1–6 覆盖两类商品、期限/价格、整单 promo 优选、不可变并行订单与一次性 Checkout；Tasks 3、7–9 覆盖 gift/旧记录、完整交付、自动退款重放和后台补偿；Tasks 10–12 覆盖 `/ke/buy`、bootstrap、购买交互、浏览器时区、完整预览和记录；Task 13 覆盖环境隔离、Alipay、Managed Payments 禁止项和正式 Product 配置。
- Step scan: 每个 Task 先有失败测试，再实现对应边界，最后运行目标测试；不把正式 Stripe 联调或部署当成单元测试替代品。
- Type consistency: `packages/commerce` 为 Worker 和浏览器共享的纯规则包；金额/duration 内部为 bigint，HTTP/JSON 为 decimal string；数据库 ID/owner 用 decimal string；quote -> immutable order -> Checkout -> provider event/job -> contribution/projection 的引用均使用同一 order/item/unit IDs。
- Review focus: 五类高风险输入均在对应 Task 的测试中覆盖；另外明确覆盖 identity ownership、CSRF/origin、活动报价过期、签名重放、refund pagination 和 worker connection lifecycle。
- Scope: 一个贯通商务闭环而非数个独立可发布产品；任务按可以单独审核的接口和失败模式拆分，依赖顺序固定，不并行修改共享 migration/service。
