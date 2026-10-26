# 账号操作日志 + 后台角色转移 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 在账号关键操作上记录明文 IP、城市、运营商、浏览器指纹与设备 ID；在管理员后台提供"查角色 → 关联分析 → 人工审核 → 确认转移"的角色转移工具；KE `start` 增加角色归属检查。

**Architecture：** 新增 `apps/worker/src/activity/`（日志表的类型、请求网络信息解析、MySQL 仓库、尽力而为的记录器），各路由在操作成功/指定失败后调用记录器。关联分析是 `apps/worker/src/admin/transfer-analysis.ts` 中的纯函数；转移的查询与事务在 `admin/transfer-repository.ts` / `admin/transfer-service.ts`，路由挂在现有 `registerAdminAccountRoutes` 下。网页端新增 `device-identity.ts` 给写请求附加设备头，管理员页面新增 `admin-transfer.ts` 区块。一次性补数脚本在 `scripts/`。

**Tech Stack：** TypeScript、Hono（Cloudflare Workers）、MySQL（`migrations/mysql/`，自研 `MysqlDatabase` 客户端）、Vitest、jsdom、Node 24 脚本（`mysql2`、`mmdb-lib`）。

**Spec：** `docs/superpowers/specs/2026-10-26-account-activity-log-and-character-transfer-design.md`

## Global Constraints

- Node 24.x / pnpm（见 `.nvmrc`、`package.json`）；每个任务结束前 `pnpm lint`、`pnpm typecheck` 通过。
- 在当前分支 `Development` 上工作，每个任务一个提交；提交信息沿用仓库风格 `type(scope): 中文说明`，末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。push 需用户明确同意。
- 面向管理员和用户的文案用简体中文；隐私政策页保持英文。
- 日志保留期 **180 天**（`ACTIVITY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000`）。
- 记录是**尽力而为**：任何日志写入异常只调用 `logError('lastroweb.activity_log_error', error, {...})`，不得改变主流程的状态码和响应；记录要在返回响应前 `await` 完成（请求结束时数据库连接会被关闭，见 `apps/worker/src/index.ts` 的 `fetch`）。
- 设备头：`x-ltsd-device`（小写 UUID，`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`）、`x-ltsd-fp`（64 位小写十六进制）。服务端格式不符即当作没带，绝不因此拒绝请求。
- KE `start` 归属检查**不新增错误码**：复用 `KE_CHARACTER_BOUND`、HTTP 409、文案 `该角色 30 天内已被其他账号绑定`、附带 `{ bound_at }`。心跳不加检查。`user_id` 为空的无主角色不拦截。
- "后台角色转移"日志行不带任何网络字段，分析时忽略 `ADMIN_CHARACTER_TRANSFER` 事件。
- 永久保存的审计快照里只允许脱敏 IP（`maskIp`），不得出现完整 IP、指纹、设备 ID。
- 管理员页面中所有来自接口的文本一律 `textContent` 渲染，禁止拼进 `innerHTML`（`apps/web/src/admin-page.ts` 文件头规则）。
- MySQL 集成测试运行方式（共用一个测试库，需串行）：
  `set -a; . ./.dev.vars; set +a; AUTH_TEST_DB_ALLOW_RESET=1 pnpm vitest run --no-file-parallelism <测试文件>`
  （`.dev.vars` 里已有 `MYSQL_TEST_URL`；不要打印其内容。）
- 生产库只读、有界查询；补数脚本只生成 SQL 文件，由用户审阅后执行。

## Review Focus

1. 网络信息缺失或畸形：请求没有 `cf`、`cf.latitude` 是字符串、`cf-connecting-ip` 是 IPv4 映射的 IPv6（`::ffff:1.2.3.4`）或压缩 IPv6 —— 期望字段为 null 或被正确规范化，不抛错。→ Task 1 `readActivityNetwork` / `ipNetOf` 测试。
2. 伪造或超长的设备头（10 KB 字符串、大写十六进制、带引号）—— 期望当作没带，请求照常成功。→ Task 1 测试。
3. 日志表写入失败时注册/登录 —— 期望状态码与正常一致。→ Task 4 集成测试 `register still returns 202 when the activity insert fails`。
4. 预览后、确认前角色已被别人绑走 —— 期望确认返回 404 `ADMIN_CHARACTER_NOT_FOUND`，什么都不改。→ Task 7 集成测试。
5. 搬配置时同名冲突且原名已接近 64 字符上限 —— 期望改名后仍 ≤ 64 个码点且唯一。→ Task 7 集成测试。

---

### Task 1: 日志表迁移、类型与请求网络信息解析

**Files:**
- Create: `migrations/mysql/022_account_activity_log.sql`
- Create: `apps/worker/src/activity/types.ts`
- Create: `apps/worker/src/activity/hosting.ts`
- Create: `apps/worker/src/activity/network.ts`
- Test: `apps/worker/test/activity-schema.test.ts`, `apps/worker/test/activity-network.test.ts`

**Interfaces:**
- Produces（`activity/types.ts`）：
  ```ts
  export const ACTIVITY_RETENTION_MS: number; // 180 天
  export type ActivityEvent = 'REGISTER' | 'EMAIL_VERIFIED' | 'LOGIN' | 'PASSWORD_RESET_REQUEST' | 'PASSWORD_RESET'
    | 'PASSWORD_CHANGE' | 'KE_DEVICE_APPROVE' | 'KE_DEVICE_TOKEN' | 'KE_BIND' | 'KE_START' | 'KE_HEARTBEAT'
    | 'GUESTBOOK_POST' | 'GUESTBOOK_REPLY' | 'ADMIN_CHARACTER_TRANSFER';
  export type ActivityResult = 'SUCCESS' | 'FAILURE';
  export interface ActivityNetwork {
    ip: string | null; ip_net: string | null; country: string | null; region: string | null; city: string | null;
    latitude: number | null; longitude: number | null; asn: number | null; as_org: string | null; is_hosting: boolean;
    device_id: string | null; fingerprint: string | null; user_agent: string | null;
  }
  export const EMPTY_NETWORK: ActivityNetwork; // 全 null，is_hosting=false
  export interface ActivityCharacter { aid: number; cid: number; nid: number }
  export interface ActivityRow extends ActivityNetwork {
    user_id: number; event: ActivityEvent; result: ActivityResult;
    aid: number | null; cid: number | null; nid: number | null;
    ref: string | null; source: 'live' | 'backfill'; request_id: string | null; created_at: number;
  }
  export interface ActivityRecord extends ActivityRow { id: number }
  ```
- Produces（`activity/hosting.ts`，**不得 import 任何模块**——Task 10 的 `.mjs` 脚本会直接 import 这个 `.ts` 文件）：
  `export const HOSTING_ORG_KEYWORDS: readonly string[]`、`export function isHostingOrg(org: string | null): boolean`（不区分大小写的子串匹配）。
- Produces（`activity/network.ts`）：
  `export function ipNetOf(ip: string): string`、`export function maskIp(ipOrNet: string): string`、
  `export function readActivityNetwork(request: Request, environment: string): ActivityNetwork`、
  `export function parseDeviceId(value: string | null): string | null`、`export function parseFingerprint(value: string | null): string | null`。

- [ ] **Step 1: 写失败的 schema 测试** `apps/worker/test/activity-schema.test.ts`（仿 `admin-audit-schema.test.ts` 读 DDL 文本）：
  ```ts
  it('建表与索引', () => {
    expect(ddl).toMatch(/CREATE TABLE account_activity_log \(/u);
    for (const column of ['user_id', 'event', 'result', 'ip', 'ip_net', 'country', 'region', 'city', 'latitude', 'longitude',
      'asn', 'as_org', 'is_hosting', 'device_id', 'fingerprint', 'user_agent', 'aid', 'cid', 'nid', 'ref', 'source', 'request_id', 'created_at']) {
      expect(ddl).toContain(column);
    }
    for (const index of ['(user_id, created_at)', '(ip_net, user_id)', '(device_id, user_id)', '(fingerprint, user_id)', '(aid)', '(ref, created_at)', '(created_at)']) {
      expect(ddl).toContain(index);
    }
    expect(ddl).toMatch(/FOREIGN KEY \(user_id\) REFERENCES auth_users \(id\) ON DELETE CASCADE/u);
    expect(ddl).toMatch(/CHECK \(result IN \('SUCCESS', 'FAILURE'\)\)/u);
    expect(ddl).toMatch(/CHECK \(source IN \('live', 'backfill'\)\)/u);
  });
  ```
- [ ] **Step 2: 运行确认失败** `pnpm vitest run apps/worker/test/activity-schema.test.ts` → FAIL（文件不存在）。
- [ ] **Step 3: 写迁移 `022_account_activity_log.sql`**。文件头用中文注释说明用途与 180 天保留期（仿 018 的写法）。列类型：`id BIGINT UNSIGNED AUTO_INCREMENT`、`user_id BIGINT UNSIGNED NOT NULL`、`event VARCHAR(32)`、`result VARCHAR(8)`、`ip`/`ip_net VARCHAR(45)`、`country CHAR(2)`、`region`/`city VARCHAR(64)`、`latitude`/`longitude DECIMAL(9,6)`、`asn INT UNSIGNED`、`as_org VARCHAR(128)`、`is_hosting TINYINT(1) NOT NULL DEFAULT 0`、`device_id CHAR(36)`、`fingerprint CHAR(64)`、`user_agent VARCHAR(512)`、`aid/cid/nid INT UNSIGNED`、`ref VARCHAR(80)`、`source VARCHAR(8) NOT NULL DEFAULT 'live'`、`request_id VARCHAR(64)`、`created_at BIGINT UNSIGNED NOT NULL`；ascii 列用 `CHARACTER SET ascii COLLATE ascii_bin`（与 009/018 一致）；索引名前缀 `idx_account_activity_`。
- [ ] **Step 4: 运行确认通过**，并 `pnpm test:migration`、`pnpm db:mysql:migrate -- --dry-run`（需 `MYSQL_URL` 时可跳过 dry-run，CI 会跑）。
- [ ] **Step 5: 写失败的网络解析测试** `apps/worker/test/activity-network.test.ts`，构造 `new Request(url, { headers })` 并用 `Object.defineProperty(request, 'cf', { value: {...} })` 注入 cf：
  - `ipNetOf('113.87.1.2') === '113.87.1.2'`；`ipNetOf('2408:8207:1234:5678:abcd::1') === '2408:8207:1234:5678::/64'`；`ipNetOf('2408:8207::1') === '2408:8207:0:0::/64'`；`ipNetOf('::ffff:1.2.3.4') === '1.2.3.4'`；`ipNetOf('localhost') === 'localhost'`。
  - `maskIp('113.87.1.2') === '113.87.x.x'`；`maskIp('2408:8207:1234:5678::/64') === '2408:8207:x:x::/64'`。
  - production + `cf-connecting-ip: 113.87.1.2` + cf `{ country: 'CN', region: 'Guangdong', city: 'Shenzhen', latitude: '22.5', longitude: '114.1', asn: 4134, asOrganization: 'Chinanet' }` + 合法设备头 → `{ ip: '113.87.1.2', ip_net: '113.87.1.2', country: 'CN', city: 'Shenzhen', latitude: 22.5, longitude: 114.1, asn: 4134, as_org: 'Chinanet', is_hosting: false, device_id: <uuid>, fingerprint: <64hex> }`。
  - `asOrganization: 'Vultr Holdings LLC'` → `is_hosting: true`；`'Alibaba US Technology'` → true。
  - 无 `cf`、environment `'test'` → `ip: null, ip_net: null`，地理字段全 null，不抛错。
  - 设备头为 `'A'.repeat(10000)`、大写 UUID、`'"; DROP'` → `device_id: null`；`x-ltsd-fp` 为 63 位或大写 → `fingerprint: null`。
  - `user-agent` 超过 512 字符 → 截断为 512。
- [ ] **Step 6: 运行确认失败**。
- [ ] **Step 7: 实现 `types.ts`、`hosting.ts`、`network.ts`**。`readActivityNetwork` 用 `trustedAuthClientIp(request, environment)`（`apps/worker/src/auth/rate-limit.ts`），返回 `'unknown'` 时 ip 为 null；cf 字段逐个做类型收窄（数字字符串转 number，非有限值为 null；`country` 只接受两位字母；字符串截断到列长度）。`HOSTING_ORG_KEYWORDS` 至少包含：`alibaba`、`aliyun`、`tencent`、`huawei cloud`、`amazon`、`aws`、`google cloud`、`google llc`、`microsoft`、`azure`、`digitalocean`、`vultr`、`choopa`、`linode`、`akamai`、`ovh`、`hetzner`、`oracle`、`contabo`、`m247`、`leaseweb`、`cloudflare`。
- [ ] **Step 8: 运行确认通过**：`pnpm vitest run apps/worker/test/activity-network.test.ts apps/worker/test/activity-schema.test.ts`。
- [ ] **Step 9: 提交** `feat(activity): 新增账号操作日志表与请求网络信息解析`。

---

### Task 2: 日志仓库、记录器与定时清理

**Files:**
- Create: `apps/worker/src/activity/repository.ts`
- Create: `apps/worker/src/activity/recorder.ts`
- Modify: `apps/worker/src/index.ts`（`scheduled` 的 `*/5 * * * *` 分支）
- Modify: `docs/deployment.md`（迁移说明处补一句 022 在部署前执行，命令块保持 PowerShell）
- Test: `tests/integration/activity-mysql.test.ts`、`apps/worker/test/activity-recorder.test.ts`

**Interfaces:**
- Consumes：Task 1 的全部类型与 `readActivityNetwork`、`EMPTY_NETWORK`、`ACTIVITY_RETENTION_MS`。
- Produces（`activity/repository.ts`）：
  ```ts
  export type ActivityHeatField = 'ip_net' | 'device_id' | 'fingerprint';
  export interface ActivityRepository {
    insert(row: ActivityRow): Promise<void>;
    latestIpNetForRef(ref: string): Promise<{ ip_net: string | null } | null>;
    listForUser(userId: number, limit: number): Promise<{ records: ActivityRecord[]; truncated: boolean }>; // 按时间升序返回最近 limit 条
    countUsers(field: ActivityHeatField, value: string): Promise<number>; // COUNT(DISTINCT user_id)
    cleanup(before: number, batchSize: number): Promise<number>; // 返回删除行数
  }
  export function createActivityRepository(database: MysqlDatabase): ActivityRepository;
  export function insertActivityRow(database: MysqlDatabase, row: ActivityRow): Promise<void>; // 供事务内复用
  ```
- Produces（`activity/recorder.ts`）：
  ```ts
  export interface ActivityEntry {
    userId: number | string; event: ActivityEvent; result?: ActivityResult; // 默认 SUCCESS
    character?: ActivityCharacter | null; ref?: string | null; requestId?: string | null;
  }
  export interface ActivityRecorder {
    record(request: Request, entry: ActivityEntry): Promise<void>;                 // 永不抛错
    recordHeartbeat(request: Request, entry: ActivityEntry & { ref: string }): Promise<void>; // 与该 ref 最近一条的 ip_net 相同则跳过
  }
  export function createActivityRecorder(repository: ActivityRepository | null, environment: string, now?: () => number): ActivityRecorder;
  export const NOOP_ACTIVITY_RECORDER: ActivityRecorder;
  ```

- [ ] **Step 1: 写失败的记录器单测** `apps/worker/test/activity-recorder.test.ts`（用内存 fake `ActivityRepository`）：
  - `record` 写入一行：`user_id` 由字符串 `'10001'` 转为 `10001`，`result` 默认 `SUCCESS`，`source: 'live'`，`created_at` 取注入的 `now()`，网络字段来自 `readActivityNetwork`，`character` 展开到 `aid/cid/nid`。
  - fake 的 `insert` 抛错时 `record` resolve 为 undefined（不抛）。
  - `repository` 为 null 时 `record` 不做任何事。
  - `recordHeartbeat`：`latestIpNetForRef` 返回相同 `ip_net` → 不插入；返回不同或 null → 插入一条 `KE_HEARTBEAT`。
- [ ] **Step 2: 写失败的仓库集成测试** `tests/integration/activity-mysql.test.ts`（`describe.skipIf(!runMysqlTests)`，用 `withAuthTestDatabase`，先 `INSERT INTO auth_users` 造用户，仿 `admin-mysql.test.ts:12`）：
  - insert 后 `listForUser(u, 10)` 按 `created_at` 升序返回、数值列为 number、`is_hosting` 为 boolean、`latitude` 为 number。
  - 插入 5 条后 `listForUser(u, 3)` → 最近 3 条且 `truncated: true`。
  - 两个用户共用 `ip_net` → `countUsers('ip_net', net) === 2`；`device_id`、`fingerprint` 同理。
  - `latestIpNetForRef('inst-1')` 返回最近一条的 `ip_net`；无记录返回 null。
  - `cleanup(before, 2)` 只删 `created_at < before` 的行，且一次最多删 2 行，返回值等于删除行数。
- [ ] **Step 3: 运行确认失败**（单测直接跑；集成测试按 Global Constraints 的命令跑）。
- [ ] **Step 4: 实现 `repository.ts` 与 `recorder.ts`**。`cleanup` 用 `DELETE FROM account_activity_log WHERE created_at < ? ORDER BY created_at LIMIT ?`；`countUsers` 用对应列的等值条件（列名来自白名单，不拼接用户输入）；`listForUser` 用 `ORDER BY created_at DESC, id DESC LIMIT limit+1` 再反转。记录器失败时 `logError('lastroweb.activity_log_error', error, { event })`。
- [ ] **Step 5: 定时清理**：在 `index.ts` 的 `*/5 * * * *` 分支，`createKeRepository(database).cleanup(now)` 之后追加 `await createActivityRepository(database).cleanup(now - ACTIVITY_RETENTION_MS, 1000)`。
- [ ] **Step 6: 运行确认通过**（单测 + 集成测试），再跑 `pnpm test:docs`。
- [ ] **Step 7: 提交** `feat(activity): 操作日志仓库、尽力而为的记录器与 180 天清理`。

---

### Task 3: 网页端设备 ID / 指纹与请求头

**Files:**
- Create: `apps/web/src/device-identity.ts`
- Modify: `apps/web/src/auth/api.ts`（`AuthApi.write`）
- Modify: `apps/web/src/ke-device-page.ts:213-217`（设备授权决定请求）
- Test: `apps/web/test/device-identity.test.ts`、`apps/web/test/auth-api.test.ts`（新增用例）、`apps/web/test/ke-device-page.test.ts`（新增用例）

**Interfaces:**
- Produces：
  ```ts
  export const DEVICE_ID_STORAGE_KEY = 'ltsd.device_id';
  export const DEVICE_HEADER = 'x-ltsd-device';
  export const FINGERPRINT_HEADER = 'x-ltsd-fp';
  export function readDeviceId(storage?: Storage | null): string | null;   // 无则生成 crypto.randomUUID() 并保存；存储不可用时返回本页会话内固定的临时 ID
  export function computeFingerprint(): Promise<string | null>;           // SHA-256 小写 hex；crypto.subtle 不可用时 null
  export function readDeviceHeaders(): Promise<Record<string, string>>;   // 首次计算后缓存；任何异常返回 {}
  export function resetDeviceIdentityForTests(): void;
  ```

- [ ] **Step 1: 写失败的测试** `device-identity.test.ts`（jsdom，参考 `admin-page.test.ts` 的 `vi.stubGlobal('window'/'document')` 写法）：
  - 首次 `readDeviceId(localStorage)` 生成并写入 `ltsd.device_id`；再次调用返回同一值。
  - `localStorage.getItem` 抛错时仍返回同一个合法 UUID（同一页面内两次调用相等）。
  - `computeFingerprint()` 返回 `/^[0-9a-f]{64}$/`，同一环境两次结果相同；canvas `getContext` 返回 null 时仍返回 64 位 hex。
  - `readDeviceHeaders()` 返回两个头；`crypto.subtle` 被 stub 为 undefined 时只返回 `x-ltsd-device`。
- [ ] **Step 2: `auth-api.test.ts` 新增用例** `write requests carry device headers`：fake fetcher 记录 `init.headers`，调用 `sessionRequest('/api/v1/guestbook', 'POST', {...})` 后断言 `headers.get('x-ltsd-device')` 匹配 UUID 正则；`getCsrf` 的 GET 请求不带该头。
- [ ] **Step 3: `ke-device-page.test.ts` 新增用例**：批准设备时 `/api/v1/ke/device/decision` 请求带 `x-ltsd-device`。
- [ ] **Step 4: 运行确认失败** `pnpm vitest run apps/web/test/device-identity.test.ts apps/web/test/auth-api.test.ts apps/web/test/ke-device-page.test.ts`。
- [ ] **Step 5: 实现**。指纹特征按固定顺序用 `|` 拼接后哈希：`screen.width`、`screen.height`、`screen.colorDepth`、`devicePixelRatio`、`Intl.DateTimeFormat().resolvedOptions().timeZone`、`navigator.language`、`navigator.languages.join(',')`、`navigator.platform`、`navigator.hardwareConcurrency`、`navigator.deviceMemory`、canvas（固定文字与图形后 `toDataURL()`）、WebGL `UNMASKED_VENDOR_WEBGL`/`UNMASKED_RENDERER_WEBGL`；每项单独 try/catch，失败记空串。`AuthApi.write` 在构造 `headers` 后 `await readDeviceHeaders()` 并逐个 `headers.set`。设备授权页的请求头合并 `...(await readDeviceHeaders())`。
- [ ] **Step 6: 运行确认通过**，并跑一遍 `pnpm vitest run apps/web` 确认既有网页测试不受影响。
- [ ] **Step 7: 提交** `feat(web): 写请求附带设备 ID 与浏览器指纹`。

---

### Task 4: 账号与留言板操作接入日志

**Files:**
- Modify: `apps/worker/src/auth/account-service.ts`（`register` 返回值）
- Modify: `apps/worker/src/auth/action-service.ts`（`requestReset` 返回值）
- Modify: `apps/worker/src/auth/router.ts`（`registerAuthRoutes` 增加第 5 个参数并接入记录）
- Modify: `apps/worker/src/routes/guestbook.ts`（`GuestbookRouteConfig.activity`）
- Modify: `apps/worker/src/index.ts`（创建记录器并传给 auth / guestbook）
- Modify（跟随返回值变化）：`apps/worker/test/auth-register.test.ts`、`apps/worker/test/auth-mail-wake.test.ts`、`tests/integration/auth-account-races.test.ts`、`tests/integration/admin-password-mysql.test.ts` 中对 `register` / `requestReset` 的断言
- Test: `tests/integration/activity-auth-hooks-mysql.test.ts`、`apps/worker/test/guestbook-route.test.ts`（新增用例）

**Interfaces:**
- Consumes：Task 2 的 `ActivityRecorder`、`createActivityRecorder`、`createActivityRepository`、`NOOP_ACTIVITY_RECORDER`。
- Produces：
  - `createAccountService(...).register(input): Promise<{ response: AuthAcceptedResponse; userId: UserId | null }>`（邮箱已存在时 `userId: null`；路由只把 `response` 发给客户端）。
  - `createActionService(...).requestReset(email): Promise<{ response: AuthAcceptedResponse; userId: UserId | null }>`（真正写入重置令牌时才有 `userId`）。
  - `registerAuthRoutes(app, env, database?, runtime?, activity?: ActivityRecorder): void`（未传时用 `database` 创建真实记录器，无数据库时用 `NOOP_ACTIVITY_RECORDER`）。
  - `GuestbookRouteConfig.activity?: ActivityRecorder`。

**记录点（全部在主操作成功后、返回响应前 `await recorder.record(c.req.raw, {...})`，`requestId` 取 `requestId(c.req.raw)`）：**

| 路由 | 事件 | userId 来源 |
|---|---|---|
| `POST /api/v1/auth/register` 成功且 `userId !== null` | `REGISTER` | `register` 返回值 |
| `POST /api/v1/auth/email-verification/confirm` 成功 | `EMAIL_VERIFIED` | `identity.userId` |
| `POST /api/v1/auth/login` 成功 | `LOGIN` | `result.response.user.id` |
| `POST /api/v1/auth/login` 抛 `AUTH_INVALID_CREDENTIALS` | `LOGIN` + `FAILURE` | catch 里 `repository.readCredentialByEmail(normalized)`，不存在则不记；记完照常返回原错误 |
| `POST /api/v1/auth/password-reset/request` 且 `userId !== null` | `PASSWORD_RESET_REQUEST` | `requestReset` 返回值 |
| `POST /api/v1/auth/password-reset/confirm` 成功 | `PASSWORD_RESET` | `result.changedUserId` |
| `POST /api/v1/auth/password/change` 成功 | `PASSWORD_CHANGE` | `identity.userId` |
| `POST /api/v1/guestbook` 成功 | `GUESTBOOK_POST` | `identity.userId` |
| `POST /api/v1/guestbook/:id/replies` 成功 | `GUESTBOOK_REPLY` | `identity.userId` |

- [ ] **Step 1: 写失败的集成测试** `tests/integration/activity-auth-hooks-mysql.test.ts`。用 Hono + `registerAuthRoutes(app, testAuthBindings(), database, runtime, capturing)`，`capturing` 是把 `ActivityEntry` 推进数组的 fake 记录器；CSRF、注册、登录、从邮件发件箱取令牌的写法照抄 `tests/integration/auth-account-flow.test.ts`（csrf 获取见约 104-120 行；`actionMail`/`userIdFor` 见 860-880 行）。用例：
  - `records REGISTER only for a newly created account`：注册新邮箱 → 1 条 `{ event: 'REGISTER', userId: <新 id> }`；用同一邮箱再注册 → 仍是 1 条。
  - `records EMAIL_VERIFIED after confirm`。
  - `records LOGIN success and wrong-password failure, ignores unknown email`：正确密码 → `SUCCESS`；错误密码 → `FAILURE` 且 userId 为该账号；不存在的邮箱 → 不新增。
  - `records password reset request/confirm and password change`。
  - `register still returns 202 when the activity insert fails`：这一条不用 capturing，而是不传第 5 个参数、并用 `failOutboxInserts` 同样的包装方式让 `INSERT INTO account_activity_log` 抛错 → 注册仍返回 202。
- [ ] **Step 2: 留言板单测** 在 `guestbook-route.test.ts` 新增：配置 `activity: capturing` 后发帖成功 → 1 条 `GUESTBOOK_POST`；回复成功 → 1 条 `GUESTBOOK_REPLY`；发帖校验失败（400）→ 不记录。
- [ ] **Step 3: 运行确认失败**。
- [ ] **Step 4: 实现**：改两个服务的返回值，修正所有调用方与既有测试断言；路由按上表接入；`index.ts` 里 `const activity = database ? createActivityRecorder(createActivityRepository(database), env.ENVIRONMENT) : NOOP_ACTIVITY_RECORDER`，传给 `registerAuthRoutes` 和 `registerGuestbookRoutes`。
- [ ] **Step 5: 运行确认通过**：新测试 + `pnpm vitest run apps/worker/test/auth-*.test.ts apps/worker/test/guestbook-*.test.ts` + 受影响的集成测试。
- [ ] **Step 6: 提交** `feat(auth): 注册、登录、邮箱验证、密码与留言板操作记录日志`。

---

### Task 5: KE 操作接入日志 + `start` 归属检查

**Files:**
- Modify: `apps/worker/src/ke/service.ts`（`start` 事务内）
- Modify: `apps/worker/src/ke/router.ts`（`registerKeRoutes` 增加第 5 个参数 `activity?: ActivityRecorder` 并接入记录）
- Modify: `apps/worker/src/index.ts`（把同一个记录器传给 `registerKeRoutes`）
- Test: `apps/worker/test/ke.test.ts`（新增用例）、`tests/integration/activity-ke-hooks-mysql.test.ts`

**Interfaces:**
- Consumes：Task 2 的记录器；`KeFailure`、`CharacterReport`（`aid/cid/nid`）。
- Produces：`registerKeRoutes(app, env, database?, runtime?, activity?: ActivityRecorder): void`（未传时与 auth 相同：有 `database` 就用 `createActivityRecorder(createActivityRepository(database), env.ENVIRONMENT)`，否则 `NOOP_ACTIVITY_RECORDER`）。

**记录点：**

| 路由 | 事件 | 说明 |
|---|---|---|
| `POST /api/v1/ke/device/decision`，`approve === true` 且成功 | `KE_DEVICE_APPROVE` | userId = 会话 `identity.userId` |
| `POST /api/v1/ke/device/token`，结果 `status === 'approved'` | `KE_DEVICE_TOKEN` | userId 通过 `tokenService(handlers).authenticate('Bearer ' + result.access_token)` 取得 |
| `POST /api/v1/ke/instances/bind` 成功 | `KE_BIND` | `character` = `input.report` 的 aid/cid/nid，`ref` = instanceId |
| bind 抛 `KE_CHARACTER_BOUND` | `KE_BIND` + `FAILURE` | 在 catch 里记（事务已回滚），记完照常返回原错误 |
| `POST /api/v1/ke/instances/:id/start` 成功 / 抛 `KE_CHARACTER_BOUND` | `KE_START` / `KE_START` + `FAILURE` | 同上 |
| `POST /api/v1/ke/instances/:id/heartbeat` 成功 | `KE_HEARTBEAT` | 用 `recordHeartbeat`（IP 未变则跳过），`ref` = instanceId |

- [ ] **Step 1: 写失败的单测**（`ke.test.ts`，沿用文件里的 `serviceAndClock`、`bindInput`、`INST_A`）：
  - `start rejects a character now owned by another account`：账号 10000 bind+start INST_A 后 stop；把 `repository.characters` 里该角色改为 `user_id: 10001, bound_at: now()`；10000 再 `start` INST_A → rejects `{ code: 'KE_CHARACTER_BOUND', status: 409, message: '该角色 30 天内已被其他账号绑定' }`，且错误 details 含 `bound_at`。
  - `start still works for an ownerless character`：角色 `user_id: null` 时 10000 `start` 成功。
  - `heartbeat is not blocked by the ownership check`：角色改归 10001 后，10000 正在运行的 INST_A 心跳仍返回 license。
- [ ] **Step 2: 写失败的集成测试** `tests/integration/activity-ke-hooks-mysql.test.ts`：环境用 `apps/worker/test/ke-routes.test.ts` 的 `bindings(true)` 同款（生成 KE 密钥）；用户、权益（`slots` + `module:core`）按 `tests/integration/ke-mysql.test.ts:31-50` 的方式插入；Bearer 令牌直接插 `ke_tokens`（`token_digest = digestToken(opaque)`，请求头 `authorization: Bearer ke1_<opaque>`，`credential_version`/`auth_version` 与用户一致）。传入 capturing 记录器，用例：
  - bind 成功 → 1 条 `KE_BIND` 带 aid/cid/nid 与 ref。
  - 另一账号 30 天内 bind 同一角色 → 409，且记一条该账号的 `KE_BIND` `FAILURE` 带 aid。
  - start 成功 → `KE_START`；角色被改归他人后 start → 409 且记 `KE_START` `FAILURE`。
  - 心跳成功 → capturing 记录器的 `recordHeartbeat` 被调用一次，`ref` 为 instanceId、`character` 为该角色（"IP 未变则跳过"的逻辑已由 Task 2 的记录器单测覆盖）。
  - device/decision 批准 → `KE_DEVICE_APPROVE`；拒绝 → 不记录。device/token 兑换成功 → `KE_DEVICE_TOKEN`，userId 为批准者。
- [ ] **Step 3: 运行确认失败**。
- [ ] **Step 4: 实现** `start`：在 `assertSameCharacter(found, input.report)` 之后 `const character = await tx.findCharacter(found.aid, found.cid, found.nid)`，若 `character?.user_id != null && character.user_id !== ownerId` 抛 `new KeFailure('KE_CHARACTER_BOUND', 409, '该角色 30 天内已被其他账号绑定', { bound_at: character.bound_at })`。路由按上表接入。
- [ ] **Step 5: 运行确认通过**：新测试 + `pnpm vitest run apps/worker/test/ke*.test.ts` + `tests/integration/ke-mysql.test.ts`。
- [ ] **Step 6: 提交** `feat(ke): 启动时校验角色归属，KE 授权与绑定操作记录日志`。

---

### Task 6: 关联分析算法（纯函数）

**Files:**
- Create: `apps/worker/src/admin/transfer-analysis.ts`
- Test: `apps/worker/test/transfer-analysis.test.ts`

**Interfaces:**
- Consumes：`ActivityRecord`（Task 1）、`maskIp`（Task 1）。
- Produces：
  ```ts
  export type EvidenceKind = 'strong' | 'weak' | 'counter';
  export type RuleId = 'SAME_DEVICE' | 'SAME_FINGERPRINT' | 'NEAR_SAME_IP' | 'CHARACTER_AID' | 'OTHER_AID'
    | 'REGISTRATION_CHAIN' | 'SHARED_IP' | 'MAIN_CITY' | 'MAIN_ASN' | 'SAME_UA'
    | 'PUBLIC_IP' | 'HOSTING_IP' | 'COMMON_DEVICE' | 'COMMON_FINGERPRINT' | 'CONCURRENT_COUNTRY' | 'CONCURRENT_CITY';
  export interface Evidence { rule: RuleId; kind: EvidenceKind; points: number; text: string; redacted_text: string; event_ids: number[] }
  export type Verdict = 'HIGH' | 'POSSIBLE' | 'NONE' | 'INSUFFICIENT';
  export interface TransferAnalysis { score: number; verdict: Verdict; evidence: Evidence[]; notes: string[] }
  export interface AnalysisSide { userId: number; records: ActivityRecord[]; truncated: boolean; aids: number[] }
  export interface AnalysisInput {
    source: AnalysisSide; target: AnalysisSide; characterAid: number;
    heat: { ip_net: Record<string, number>; device_id: Record<string, number>; fingerprint: Record<string, number> };
  }
  export const ANALYSIS_RULES: { /* 下表全部常量 */ };
  export function verdictFor(score: number, insufficient: boolean): Verdict;
  export function analyzeTransfer(input: AnalysisInput): TransferAnalysis;
  ```

**算法（所有分值写进 `ANALYSIS_RULES` 常量）：**

- 只用"有效记录"：排除 `event === 'ADMIN_CHARACTER_TRANSFER'`。
- 热度缺省值：`heat.*[value] ?? 2`。
- IP 系数 `ipFactor(net)`：热度 ≤ 2 → 1；3–5 → 0.5；> 5 → 0；若两侧任一有效记录在该 `ip_net` 上 `is_hosting` 为真，再 ×0.3。
- 规则（每条命中产出一条证据；`points = Math.round(原始分)`）：

| 规则 | kind | 判定与分值 | event_ids |
|---|---|---|---|
| SAME_DEVICE | strong | 两侧共有的 `device_id` 中按热度取最高档：≤2 → 45；3–5 → 15；>5 → 不产出本条 | 两侧带该 device_id 的记录（每侧最多 5 条） |
| COMMON_DEVICE | counter | 每个热度 > 5 的共有 device_id，0 分 | 同上 |
| SAME_FINGERPRINT | strong | 同理，档位：≤3 → 30；4–10 → 10；>10 → 不产出 | 同上 |
| COMMON_FINGERPRINT | counter | 每个热度 > 10 的共有指纹，0 分 | 同上 |
| NEAR_SAME_IP | strong | 存在 A、B 各一条记录 `ip_net` 相同且时间差 ≤ 30 分钟；取 `ipFactor` 最大（并列取时间差最小）的一对，25 × 系数；文本里写出满足条件的配对次数 | 最佳那一对 |
| CHARACTER_AID | strong | `target.aids` 含 `characterAid` → 30 | B 侧 `aid === characterAid` 的记录 |
| OTHER_AID | strong | `source.aids ∩ target.aids` 去掉 `characterAid` 后非空 → 20 | 两侧带这些 aid 的记录 |
| REGISTRATION_CHAIN | strong | 任一侧的 `REGISTER` 记录 r，与另一侧任一记录 o 时间差 ≤ 24 小时，且 `ip_net` 相同（系数 = `ipFactor`）或 `device_id` 相同（系数 = 1）；15 × 最大系数 | [r.id, o.id] |
| SHARED_IP | strong | 两侧共有的非空 `ip_net` 集合，分值 = min(24, Σ 8 × `ipFactor`)，为 0 时不产出 | 每个共有 IP 每侧取 1 条 |
| PUBLIC_IP | counter | 每个热度 > 5 的共有 IP，0 分，说明"视为公共 IP，相关证据未计分" | 每侧 1 条 |
| HOSTING_IP | counter | 每个机房/VPN 的共有 IP，0 分，说明"相关加分 ×0.3" | 每侧 1 条 |
| MAIN_CITY | weak | 两侧各自出现次数最多的 `city`（不区分大小写，并列取最近出现的）相同 → 5 | 无 |
| MAIN_ASN | weak | 两侧出现最多的 `asn` 相同 → 3 | 无 |
| SAME_UA | weak | 存在完全相同的非空 `user_agent` → 3 | 一对 |
| CONCURRENT_COUNTRY | counter | 存在时间差 ≤ 10 分钟的一对，`country` 都非空且不同 → −20（只算一次） | 那一对 |
| CONCURRENT_CITY | counter | 未命中上一条时：时间差 ≤ 10 分钟、两边都有经纬度、`city` 不同、球面距离 ≥ 300 km → −10（只算一次） | 那一对 |

- `score = clamp(Σ points, 0, 100)`；任一侧有效记录 < 3 → `INSUFFICIENT`；否则 ≥ 70 `HIGH`、≥ 40 `POSSIBLE`、其余 `NONE`。
- `evidence` 排序：strong → weak → counter，同类内按上表顺序。
- `notes`：某侧 `truncated` 时加一句"账号 A（或 B）的日志超过上限，只分析了最近的部分"。
- `text` 可含完整 IP（`ip_net`）、城市、运营商；`redacted_text` 用 `maskIp`；两者都**不得**包含 device_id 或指纹的任何字符。
- 配对比较先按 `ip_net` 分组，时间窗口规则先按时间排序再滑动窗口，不做全量 N×M 配对。

- [ ] **Step 1: 写失败的测试** `transfer-analysis.test.ts`。写一个 `rec(side, overrides)` 工厂生成 `ActivityRecord`（默认 `EMPTY_NETWORK` + 递增 id + 给定 user_id），每条规则至少一个命中用例和一个不命中用例，断言 `rule`、`kind`、`points`、`event_ids`。另加：
  - 热度 3 的设备 → SAME_DEVICE 15 分；热度 6 → 无 SAME_DEVICE、有 COMMON_DEVICE。
  - 机房 IP 上的 NEAR_SAME_IP → `Math.round(25 * 0.3) === 8`，并有 HOSTING_IP。
  - IP 热度 4 → NEAR_SAME_IP 13 分（`Math.round(12.5)`）；热度 6 → NEAR_SAME_IP 不产出（0 分）且有 PUBLIC_IP。
  - SHARED_IP 4 个热度 ≤ 2 的共同 IP → 24 分（封顶）。
  - 北京与广州 5 分钟内各有一条（带经纬度、同为 CN）→ CONCURRENT_CITY −10；CN 与 JP → CONCURRENT_COUNTRY −20 且没有 CONCURRENT_CITY。
  - 分档边界（直接测 `verdictFor`）：70 → HIGH，69 → POSSIBLE，40 → POSSIBLE，39 → NONE，`insufficient=true` → INSUFFICIENT。
  - 截断：设备 + 指纹 + 近时同 IP + 共同 IP + 角色 aid 全部命中 → `score === 100`；只有 CONCURRENT_COUNTRY → `score === 0`。
  - 一侧只有 2 条有效记录（另有 1 条 `ADMIN_CHARACTER_TRANSFER`）→ `INSUFFICIENT`；一侧 0 条 → `INSUFFICIENT` 且不抛错。
  - 所有证据的 `redacted_text` 不含完整 IPv4（`/\d+\.\d+\.\d+\.\d+/` 不匹配），所有 `text`/`redacted_text` 不含测试用的 device_id 与指纹子串。
- [ ] **Step 2: 运行确认失败** `pnpm vitest run apps/worker/test/transfer-analysis.test.ts`。
- [ ] **Step 3: 实现 `analyzeTransfer`**（中文证据文案自拟，风格参考设计稿："B 在 A 注册 6 分钟后，用同一 IP 注册"）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(admin): 一人多号关联分析算法`。

---

### Task 7: 角色转移的仓库、服务与管理员接口

**Files:**
- Create: `apps/worker/src/admin/transfer-repository.ts`
- Create: `apps/worker/src/admin/transfer-service.ts`
- Modify: `apps/worker/src/admin/router.ts`（`registerAdminAccountRoutes` 增加第 4 个参数）
- Modify: `apps/worker/src/index.ts`（创建并传入转移服务）
- Test: `tests/integration/admin-transfer-mysql.test.ts`、`apps/worker/test/admin-routes.test.ts`（新增用例）

**Interfaces:**
- Consumes：`analyzeTransfer`、`TransferAnalysis`（Task 6）；`ActivityRepository`、`insertActivityRow`、`EMPTY_NETWORK`、`maskIp`（Task 1/2）；`insertAdminAudit`（`admin/audit.ts`）；`AdminUserRow`、`AdminAuditEntry`、`AdminFailure`（`admin/types.ts`）；`normalizeEmail`（`auth/input.ts`）。
- Produces：
  ```ts
  // transfer-repository.ts
  export interface TransferCharacter { aid: number; cid: number; nid: number; char_name: string; base_level: number | null; job_level: number | null; job_id: number | null; bound_at: number | null }
  export interface TransferTx {
    lockUsers(ids: number[]): Promise<void>;                        // 按 id 升序 FOR UPDATE
    lockCharacter(aid: number, cid: number, nid: number): Promise<(TransferCharacter & { user_id: number | null }) | null>;
    moveCharacter(aid: number, cid: number, nid: number, toUserId: number, now: number): Promise<void>; // user_id、bound_at、updated_at
    listProfilesForUpdate(userId: number, aid: number, cid: number, nid: number): Promise<Array<{ id: number; name: string; is_active: boolean }>>;
    moveProfile(id: number, toUserId: number, name: string, isActive: boolean, now: number): Promise<void>;
    detachShares(profileIds: number[]): Promise<number[]>;          // 返回被断开的 ke_shared_profiles.id
    insertAudit(entry: AdminAuditEntry): Promise<void>;
    insertActivity(row: ActivityRow): Promise<void>;
  }
  export interface TransferRepository {
    resolveUser(account: string): Promise<AdminUserRow | null>;      // 纯数字按 id；含 @ 按 email_normalized
    listCharacters(userId: number): Promise<TransferCharacter[]>;
    findCharacter(aid: number, cid: number, nid: number): Promise<(TransferCharacter & { user_id: number | null }) | null>;
    listAids(userId: number): Promise<number[]>;                     // ke_characters ∪ ke_instances 当前值
    transaction<T>(work: (tx: TransferTx) => Promise<T>): Promise<T>;
  }
  export function createTransferRepository(database: MysqlDatabase): TransferRepository;

  // transfer-service.ts
  export interface TimelineRow {
    id: number; side: 'source' | 'target'; event: ActivityEvent; result: ActivityResult; created_at: number; source: 'live' | 'backfill';
    ip: string | null; country: string | null; region: string | null; city: string | null; as_org: string | null; is_hosting: boolean;
    fingerprint_short: string | null; device_short: string | null; aid: number | null;  // short = 前 4 个字符
  }
  export interface TransferPreview { source: AdminUserRow; target: AdminUserRow; character: TransferCharacter; analysis: TransferAnalysis; timeline: TimelineRow[] }
  export interface TransferRequest { source: string; target: string; aid: number; cid: number; nid: number }
  export interface TransferResult { moved_profile_ids: number[]; detached_share_ids: number[] }
  export const TRANSFER_LOG_LIMIT = 2000;
  export function createTransferService(repository: TransferRepository, activity: ActivityRepository, now?: () => number): {
    listCharacters(account: string): Promise<{ user: AdminUserRow; characters: TransferCharacter[] }>;
    preview(request: TransferRequest): Promise<TransferPreview>;
    confirm(actorId: number, request: TransferRequest & { note: string }, requestId: string): Promise<TransferResult>;
  };
  export type TransferService = ReturnType<typeof createTransferService>;
  ```
- `registerAdminAccountRoutes(app, service, auth, transfer?: TransferService | null)`：三个新路由始终注册；`transfer` 缺失时（在管理员校验通过后）返回 `jsonError('auth_unavailable', '账号服务暂不可用', 503, id)`。
- 路由（全部走现有 `guarded`）：
  - `GET /api/v1/admin/transfer/characters?account=` → `{ user, characters }`（只读）
  - `GET /api/v1/admin/transfer/preview?source=&target=&aid=&cid=&nid=` → `TransferPreview`（只读）
  - `POST /api/v1/admin/transfer`，body 只允许 `{ source, target, aid, cid, nid, note }` → `TransferResult`（写，需 CSRF）
  - `aid/cid/nid` 必须是 0–4294967295 的整数，否则 `ADMIN_BAD_REQUEST`。

**错误（只新增一个码 `ADMIN_CHARACTER_NOT_FOUND`）：**
- 账号解析不到 → `ADMIN_USER_NOT_FOUND` 404 `账号不存在`
- 源与目标相同 → `ADMIN_BAD_REQUEST` 400 `源账号和目标账号不能相同`
- 目标不是 `status === 'ACTIVE'` 且 `email_verified_at !== null` → `ADMIN_BAD_REQUEST` 400 `目标账号必须是已验证邮箱的正常账号`
- 角色不存在，或此刻不属于源账号（预览和确认事务内都要查）→ `ADMIN_CHARACTER_NOT_FOUND` 404 `角色不存在或已不属于源账号，请重新查询`
- 备注 trim 后为空或超过 200 个码点 → `ADMIN_BAD_REQUEST` 400 `请填写审核备注（最多 200 字）`

**`preview` 数据组装：** 两侧各 `activity.listForUser(id, TRANSFER_LOG_LIMIT)`；`aids` = 记录里的非空 aid ∪ `repository.listAids(id)`；只对两侧**共有**的 `ip_net`/`device_id`/`fingerprint` 调 `activity.countUsers` 得到热度；`timeline` = 两侧记录合并按 `created_at` 升序。

**`confirm` 步骤（一个事务内）：** 先在事务外重新算一次 `analyzeTransfer`（不信任前端）→ 事务：`lockUsers([A,B])` → `lockCharacter` 校验仍归 A → `moveCharacter(..., B, now)` → `listProfilesForUpdate(A, 角色)` 与 `listProfilesForUpdate(B, 角色)`：搬过来的配置若与 B 已有名称冲突，改名为 `${base}（转移）`、`${base}（转移2）`…（base 截断使总长 ≤ 64 个码点，且与 B 现有及本次已搬的名字都不重复）；B 已有激活配置时搬来的全部设为非激活，否则保留原值 → `detachShares(搬动的配置 id)` → `insertAudit({ actor_user_id: actorId, action: 'CHARACTER_TRANSFER', target_user_id: A, request_id, created_at: now, detail: { from_user_id: A, to_user_id: B, aid, cid, nid, char_name, note, analysis: { score, verdict, notes, evidence: evidence.map(({ rule, kind, points, redacted_text }) => ({ rule, kind, points, text: redacted_text })) }, moved_profile_ids, detached_share_ids } })` → 给 A、B 各 `insertActivity({ ...EMPTY_NETWORK, user_id, event: 'ADMIN_CHARACTER_TRANSFER', result: 'SUCCESS', aid, cid, nid, ref: requestId, source: 'live', request_id: requestId, created_at: now })`。

- [ ] **Step 1: 写失败的集成测试** `tests/integration/admin-transfer-mysql.test.ts`（用户与权益插入仿 `admin-mysql.test.ts`；`ke_characters`、`ke_profiles`、`ke_shared_profiles` 直接 INSERT；日志直接调用 `createActivityRepository(database).insert`）：
  - `lists characters by id or email`：按 id、按邮箱（大小写混合）都能查到 A 名下的角色；查不存在的账号 → `ADMIN_USER_NOT_FOUND`。
  - `preview analyses both accounts`：给 A、B 造共同设备与同 IP 近时记录 → `analysis.verdict === 'HIGH'`，`timeline` 两侧记录齐全、升序、`fingerprint_short` 长度 4。
  - `confirm moves character, profiles and detaches shares`：A 有该角色的两份配置（一份激活、一份已发布到大厅），B 已有同名配置且有激活配置 → 确认后 `ke_characters.user_id === B` 且 `bound_at === now`；两份配置归 B、同名那份被改名、全部非激活；大厅分享仍是 A 作者、`status` 不变、`source_profile_id` 为 NULL；`admin_audit_log` 有一行 `CHARACTER_TRANSFER`，`detail` 的 JSON 文本不含任何完整 IPv4、不含测试用 device_id/指纹；`account_activity_log` 里 A、B 各一条 `ADMIN_CHARACTER_TRANSFER` 且 `ip`、`device_id` 为 NULL；A 名下该角色的 `ke_instances` 行未被改动。
  - `confirm renames within 64 code points`：B 已有一个 63 字符的同名配置 → 改名后长度 ≤ 64 且不重名。
  - `confirm rejects stale character`：预览后把角色改归第三个账号，再确认 → `ADMIN_CHARACTER_NOT_FOUND`，配置与审计都没变。
  - `confirm validates target, sameness and note`：目标为 `PENDING_EMAIL` 账号、源=目标、备注为空白 → 各自的 400。
- [ ] **Step 2: 路由单测** `admin-routes.test.ts` 新增：非管理员访问三个新路由都得到 404；`POST /api/v1/admin/transfer` 带多余字段 → 400；`aid=abc` → 400。（沿用该文件现有的 fake 写法。）
- [ ] **Step 3: 运行确认失败**。
- [ ] **Step 4: 实现** 仓库、服务、路由与 `index.ts` 接线（`registerAdminAccountRoutes(app, adminService, adminAuth, createTransferService(createTransferRepository(database), createActivityRepository(database)))`）。
- [ ] **Step 5: 运行确认通过**：新测试 + `tests/integration/admin-mysql.test.ts` + `apps/worker/test/admin-*.test.ts`。
- [ ] **Step 6: 提交** `feat(admin): 后台角色转移接口（关联分析、人工确认、配置随角色迁移）`。

---

### Task 8: 管理员页面"角色转移"区块

**Files:**
- Create: `apps/web/src/admin-transfer.ts`
- Modify: `apps/web/src/admin-page.ts`（在"审计日志"卡片之前插入转移卡片并挂载；把 `adminGet` 传给新模块）
- Test: `apps/web/test/admin-transfer.test.ts`

**Interfaces:**
- Consumes：Task 7 三个接口的响应结构（`TransferPreview` 等，在网页端以同名 interface 声明）。
- Produces：
  ```ts
  export interface AdminTransferDeps { get<T>(path: string): Promise<T>; auth: Pick<AuthApiClient, 'sessionRequest'> }
  export function transferSectionMarkup(): string;              // 静态骨架（无任何接口数据）
  export function mountAdminTransfer(root: HTMLElement, deps: AdminTransferDeps): void;
  ```

**页面（按设计稿 v2 定稿）：**
1. 第 1 步：`#adm-tr-source` 输入框（占位"源账号 ID 或邮箱"）+"查询角色"→ `#adm-tr-character` 下拉，每项文字 `${char_name}（aid ${aid} · Lv ${base_level ?? '?'}/${job_level ?? '?'}）`，value `${aid}:${cid}:${nid}`；无角色时提示"该账号名下没有绑定角色"。
2. 第 2 步：`#adm-tr-target` 输入框 + "转移（先分析）"→ 调预览。
3. 报告 `#adm-tr-report`：
   - 结论条：`结论：${标签}　关联分 ${score} / 100`，标签 `HIGH 高度疑似同一人`、`POSSIBLE 可能是同一人`、`NONE 无明显关联`、`INSUFFICIENT 数据不足，无法判断`（此时分数加 `adm-tr-muted` 类）。
   - 证据两栏：左"强证据"（kind=strong），右"弱证据"（weak）与"反向 / 降权"（counter）。证据显示 `text` 与分值（如 `+25`、`-10`、`0`）。有 `event_ids` 的证据按出现顺序编号 ①②③…（超过 20 用 `(21)` 形式），时间线中对应行加同样编号和 `adm-tr-hl` 类。
   - notes 列表。
   - 时间线表格：列"时间 / 账号 A / 账号 B"，单元格内容 `${事件中文名}${FAILURE ? '（失败）' : ''} · ${ip ?? '—'} · ${[city, region, country].filter(Boolean).join(', ')} · ${as_org ?? ''}${is_hosting ? ' · 机房/VPN' : ''}${fingerprint_short ? ` · 指纹 #${fingerprint_short}` : ''}${source === 'backfill' ? ' · 补数' : ''}`；右上角复选框"只看高亮行"；先渲染 200 行，"显示更多"每次再加 200 行。
   - 事件中文名：REGISTER 注册、EMAIL_VERIFIED 验证邮箱、LOGIN 登录、PASSWORD_RESET_REQUEST 申请找回密码、PASSWORD_RESET 重置密码、PASSWORD_CHANGE 修改密码、KE_DEVICE_APPROVE 批准 KE 设备、KE_DEVICE_TOKEN KE 设备授权、KE_BIND KE 绑定角色、KE_START KE 启动、KE_HEARTBEAT KE 运行（IP 变化）、GUESTBOOK_POST 留言板发帖、GUESTBOOK_REPLY 留言板回复、ADMIN_CHARACTER_TRANSFER 后台角色转移。
   - 底部：`#adm-tr-note`（maxlength 200，占位"例：玩家提供了截图，同一人，同意转移"）+"确认转移"+"取消"。备注为空时不发请求并提示"请填写审核备注"。
4. 确认成功：状态提示"已转移：${char_name} → ${目标邮箱}"，清空报告与输入；失败显示接口返回的中文 message。

- [ ] **Step 1: 写失败的测试** `admin-transfer.test.ts`（jsdom；`get` 与 `auth.sessionRequest` 用 fake 记录调用）：
  - 查询角色 → 请求 `/api/v1/admin/transfer/characters?account=<编码后>`，下拉项文字与 value 正确。
  - 预览 → 请求路径带 source/target/aid/cid/nid；结论条文字正确；strong 证据在左栏、counter 在右栏；第一个带 event_ids 的证据显示 ①，时间线对应行有 ① 和 `adm-tr-hl`。
  - 勾选"只看高亮行"后只剩高亮行；250 行数据初始显示 200 行，点"显示更多"后 250 行。
  - 备注为空点确认 → 不调用 `sessionRequest`；填写后 → `sessionRequest('/api/v1/admin/transfer', 'POST', { source, target, aid, cid, nid, note })`。
  - XSS：`char_name`、证据 `text`、`as_org`、`city` 都设为 `<img src=x onerror="window.__adm_xss = 1">`，渲染后 `window.__adm_xss` 未定义且页面里没有 `img` 元素。
- [ ] **Step 2: 运行确认失败** `pnpm vitest run apps/web/test/admin-transfer.test.ts`。
- [ ] **Step 3: 实现**；样式写进 `admin-page.ts` 现有 `<style>` 块，沿用 `adm-` 前缀与现有配色变量。
- [ ] **Step 4: 运行确认通过**，并跑 `pnpm vitest run apps/web/test/admin-page.test.ts`、`pnpm --filter web build`。
- [ ] **Step 5: 提交** `feat(web): 管理员后台新增角色转移审核页面`。

---

### Task 9: 隐私政策更新

**Files:**
- Modify: `apps/web/src/privacy-page.ts`
- Modify: `apps/web/src/legal-constants.ts`（`LEGAL_UPDATED_DATE` 改为实施当天日期）
- Test: `apps/web/test/legal-pages.test.ts`（新增用例）

**文案（英文，原样使用）：**
- 第 2 节在 2.2 之后新增：`<p><strong>2.3 Security and Anti-Abuse Data.</strong> When you register, log in, verify your email, request or change a password, authorize or bind KoreEngine, or post in the guestbook, we record your IP address, approximate location (city level) and network provider derived from it, your browser user agent, a random device identifier stored in your browser's local storage, and a hash of browser characteristics (browser fingerprint). We use this data only to prevent abuse and fraud, such as one person operating many accounts, and to resolve disputes about account or game-character ownership.</p>`
- 第 3 节表格新增一行：`<tr><td>Security and anti-abuse records (IP address, approximate location, device identifier, browser fingerprint)</td><td>Legitimate interest (Art. 6(1)(f)) — preventing abuse and resolving ownership disputes</td></tr>`
- 第 6 节表格新增两行：`<tr><td>Security and anti-abuse records</td><td>180 days</td></tr>`、`<tr><td>Character-transfer review decisions (IP addresses partially masked)</td><td>Retained with administrative audit records</td></tr>`
- 第 8 节在 Essential cookies 之后补一句：`<strong>Local storage</strong>: A random device identifier used solely for security and abuse prevention — strictly necessary, no consent required.`

- [ ] **Step 1: 写失败的测试**：`legal-pages.test.ts` 新增用例断言隐私页文本包含 `2.3 Security and Anti-Abuse Data`、`browser fingerprint`、`180 days`、`Local storage`。
- [ ] **Step 2: 运行确认失败** `pnpm vitest run apps/web/test/legal-pages.test.ts`。
- [ ] **Step 3: 按上方文案修改**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `docs(privacy): 说明安全与防滥用数据的收集与保留`。

---

### Task 10: 一次性补数脚本

**Files:**
- Create: `scripts/activity-backfill-lib.mjs`
- Create: `scripts/backfill-activity-from-ke.mjs`
- Modify: `package.json`（root `devDependencies` 加 `mmdb-lib`；`scripts` 加 `"activity:backfill": "node scripts/backfill-activity-from-ke.mjs"`）
- Modify: `docs/deployment.md`（新增"操作日志补数"小节，PowerShell 命令块）
- Test: `tests/scripts/activity-backfill.test.ts`

**Interfaces:**
- Consumes：`isHostingOrg`（`apps/worker/src/activity/hosting.ts`，Node 24 直接 import `.ts`）。
- Produces（`activity-backfill-lib.mjs`）：
  ```js
  export function reverseIpv4Hashes(targetHexes, { from = 0, to = 0xffffffff } = {}) // => Map<hex, ip>，遍历 [from, to] 的整数 IPv4
  export function buildBackfillSql(rows, lookups) // rows: [{ kind: 'instance'|'token', key, user_id, aid, cid, nid, ip, created_at }]
                                                 // lookups: { city(ip) => {country, region, city, latitude, longitude} | null, asn(ip) => {asn, as_org} | null }
                                                 // => string（多条 INSERT ... SELECT ... WHERE NOT EXISTS）
  ```
- CLI：`MYSQL_URL=... pnpm activity:backfill -- --city-db <dbip-city-lite.mmdb> --asn-db <dbip-asn-lite.mmdb> --out .generated/activity-backfill.sql`

**行为：**
- 只读查询（各带 `LIMIT 50000`，命中上限即报错退出）：`SELECT instance_id, user_id, aid, cid, nid, ip_hash, COALESCE(last_heartbeat_at, updated_at) AS at FROM ke_instances WHERE ip_hash IS NOT NULL LIMIT 50000`；`SELECT id, user_id, ip_hash, created_at FROM ke_tokens WHERE ip_hash IS NOT NULL LIMIT 50000`。
- 用 `worker_threads` 按首段八位组分片并行调用 `reverseIpv4Hashes`；还原不出的哈希（IPv6）跳过并计数。
- 生成的行：instance → `event 'KE_HEARTBEAT'`、带 aid/cid/nid、`ref = 'backfill:ke_instances:<instance_id>'`；token → `event 'KE_DEVICE_TOKEN'`、`ref = 'backfill:ke_tokens:<id>'`；`source 'backfill'`、`result 'SUCCESS'`、`ip_net = ip`、`is_hosting = isHostingOrg(as_org)`、`created_at` 取原时间。每条 `INSERT INTO account_activity_log (...) SELECT ... FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM account_activity_log WHERE ref = ? AND source = 'backfill')`，值以 SQL 字面量安全转义写入。
- 结束时输出统计：读取行数、还原成功数、跳过（IPv6）数、写出的语句数。脚本**不执行**任何写入。

- [ ] **Step 1: 写失败的测试** `tests/scripts/activity-backfill.test.ts`：
  - `reverseIpv4Hashes([sha256('10.0.0.5'), sha256('2408:8207::1')], { from: ip2int('10.0.0.0'), to: ip2int('10.0.0.255') })` → 只还原出 `10.0.0.5`。
  - `buildBackfillSql` 生成的文本包含 `NOT EXISTS`、`'backfill:ke_instances:<id>'`、`'backfill'`；对 `as_org = "O'Reilly Cloud"` 正确转义单引号；`lookups` 返回 null 时地理字段为 `NULL`。
  - 在 MySQL 测试库上执行生成的 SQL 两次（`describe.skipIf(!runMysqlTests)`），行数不变。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现 lib 与 CLI**；`pnpm install` 加入 `mmdb-lib`；`docs/deployment.md` 写明：下载 DB-IP City Lite / ASN Lite（mmdb）到被忽略的目录、生成 SQL、人工审阅后再执行、可重复执行。
- [ ] **Step 4: 运行确认通过**，再跑 `pnpm test:docs`。
- [ ] **Step 5: 提交** `feat(scripts): 从历史 IP 哈希补全操作日志`。

---

### 收尾：全量验证

- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:docs`、`pnpm --filter web build`、`git diff --check` 全部通过。
- [ ] 按 Global Constraints 的命令串行跑全部 `tests/integration/*mysql*.test.ts`，记录结果（若有与本计划无关的既有失败，原样报告）。
- [ ] 对照设计文档第 7 节验收标准逐条确认。
