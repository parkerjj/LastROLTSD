# LTSD Account System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户指定方式：6.1 Sol high 管理 Luna max 子代理；本地新分支，共用当前 checkout，禁止创建 worktree。

**Goal:** 按已批准 Specs 交付独立网站账号、邮箱验证/恢复、30 天滚动登录和首期可编辑昵称/头像，保留原公开市场及游戏监控台。

**Architecture:** 当前 Hono Worker 内增加独立 auth 模块，用现有 invocation-scoped MySQL 8 客户端；数据库事务承担凭据版本、会话和一次性动作的一致性。密码用原生 HMAC，邮件用原生 HTTPS＋MySQL outbox；图片处理由浏览器完成。Vite 保留现有路径分派，增加单数 /account 和认证页面，不替换复数 /accounts。

**Tech Stack:** Node 24.x、pnpm 12.4.2、TypeScript、Hono、mysql2/MySQL 8、Web Crypto、Vite/原生 DOM、Vitest/jsdom、Resend HTTPS API；不换框架。

**Spec:** [账号系统规格 v0.3](../specs/2026-10-12-ltsd-account-system-design.md)。遇到冲突以用户当前要求及 Spec 为准，由管理人记录裁决并同步对应原文。

**状态:** 原版经三轮独立review通过；本次修订经两轮复审通过（PASS），R1–R10已闭合。全部实现任务尚未开始。本文件描述将来应做的工作，不证明代码、生产邮件或 CPU 已验证。

## Global Constraints

- 密码只限 **5–256 个 Unicode code point**，不 trim、不截断，不加复杂度、弱密码列表、历史、新旧不同或周期更换要求；计算只在 Worker。
- 固定秘密 `AUTH_PASSWORD_SECRET` 由 GitHub Actions Secret 注入 Worker Secret；原生 HMAC-SHA-256＋每用户 16 字节随机盐，不引入大型密码库或高迭代 KDF。
- 一个必填 `display_name` 展示“昵称/主要游戏角色名”，trim 后 1–32 code point，可重名、可登录后改；不证明游戏角色归属。
- 可选头像：浏览器裁剪为静态 **256×256 WebP ≤32 KiB**；标准纯 Base64 最大 **43,692 字符**，MySQL TEXT；无原图、磁盘头像、R2或 Worker 图片 codec。
- 注册/头像正文最大 **64 KiB**，其他账号 JSON 最大 **8 KiB**，按实际流字节计数，不能仅信 Content-Length。
- 用户 MySQL 自增整数 ID，新表初始 **10000**；保留已有 ID，允许空缺，API 使用十进制字符串。
- 登录 Cookie 与服务器会话 **30 天**：`Max-Age=2592000`；真实访问续为 now＋30 天，无7天绝对期限/24小时空闲期限，撤销不能续活。
- Workers Free 完整 HTTP/Cron 调用 **10ms CPU**；网络等待与CPU分别测量；目标 p99≤5ms、观测最大≤8ms。
- Free Worker 直接 fetch Resend；Free额度当前100封/日、3000封/月，上线前复核。验证24小时、恢复30分钟，GET不消费令牌。
- 账号 Cookie 与现有上传源 Bearer、管理员 secret、LastRO 游戏密码完全分离；不改市场公开CORS/cache契约。
- 不做机器人、游戏角色绑定、交易、支付、提现、余额、钻石、邮箱换绑、社交登录、MFA和管理员门户。
- 当前任务仅计划与review；实施时本地新分支，不用worktree，不擅自push/merge/deploy或写生产DB，不写Obsidian。

- 测试只覆盖关键节点与关键逻辑流程；优先复用、合并已有用例，不追求覆盖率/用例数，不穷举无实际风险的组合，不为普通文案、布局、getter或每个内部函数单独建测试。
- 首版不引入KV、不用Worker全局字典缓存登录鉴权结果；MySQL只用于账号/受保护API，公开页面/静态资源不因登录额外鉴权。

## Review Focus

以下是 Specs 未穷举但会影响玩家的输入/条件，任务中给出明确测试：

1. 浏览器多标签页、旧响应与改密/退出竞争：撤销优先，不能续活旧身份（Task 4/7/10/14）。
2. MySQL `insertId` 数字精度和嵌套事务：新ID保真、同一事务不再次借连接，真实并发不能只靠假数据库（Task 2/14）。
3. 站点全局51.la初始化与邮件令牌：认证页不加载统计SDK，fragment令牌只在本页面内存，不进入跳转/日志（Task 11）。
4. 两个Cron任务共享一次CPU预算、邮件超时结果未知：邮件独立调用、有限领取、稳定幂等、不能累加任务（Task 5/13/15）。
5. 浏览器Canvas无法在jsdom真实编码、动画/伪WebP：单元测试不能代替真实浏览器产物与服务端头部检查（Task 8/12/14）。

---

## 0. 执行组织与当前代码基线

本次只读基线 HEAD：`8a2155fcdd84d30193070c1bbca0defeeb28fbd7`。启动开发时重新核对，不强制回退到此SHA。

已确认：
- `apps/worker/src/index.ts` 的 createApp 注册Hono路由；fetch/queue/scheduled创建本次调用数据库并finally关闭；search/upload有独立快路径。
- `db/mysql-client.ts` 提供 `all/first/run/transaction/close`；`run().insertId` 是 Number，不能直接作为BIGINT用户ID。
- `middleware/cors.ts` 对 `/api/*` 添加 `*`，OPTIONS提前204。新增账号必须先分类，不能让它给Cookie接口添加通配符。
- `middleware/errors.ts` 已有 `jsonError(code,message,status,requestId)`，error内为 `code/message/request_id`；沿用。
- `apps/web/src/main.ts` 用路径分派，`nav.ts` 是公共导航；`accounts-page.ts`/复数 `/accounts` 是游戏监控台，与本功能无关。
- `analytics.ts` 的 `initAnalytics()` 加载51.la；认证页面必须在调用它之前识别。
- `apps/web/vite.config.ts` 已把 `/api` 代理到本地Worker。浏览器开发站点与API同源，不需要开放任意credentialed跨域。
- MySQL迁移目前到 `008_item_catalog_fulltext.sql`；新增编号默认009，实施前确认未被占用。
- `wrangler.toml` 目前三个Cron表达式：每日、每分钟、每5分钟，已有snapshot队列。不复用snapshot消息发送邮件。
- `.github/workflows/ci.yml` 验证通过后的main push会自动迁移/部署，因此本功能只在本地分支开发，不能为了测试push main。
- 常规Vitest允许无 `MYSQL_TEST_URL` 时跳过部分集成测试；新增账号的真实MySQL测试必须单独有“不许跳过”的运行模式。

管理人负责：分支/基线、任务依赖、给子代理具体brief、独立review、修复循环、提交与最终证据。所有改代码的子代理共用当前分支，**一次最多一个写代理**；review只读，不另派reviewer、不换分支、不建worktree。不能并行改相同文件或并行运行会重置同一测试DB的任务。

每个实现Task按：复用关键行为测试（缺覆盖时才补有意义的失败测试）→最小实现→相关验证→自查→独立Spec/质量review→修订/复审→管理人提交。管理人不能仅凭子代理“完成”就打勾。提交仅显式列出任务文件，不用 `git add .`。轻量UI文案无需逐字符串镜像测试，但权限、状态、边界、迁移和并发必须测试。

运行所有命令时遵守RTK；本文给出的是Linux/zsh调用（README历史PowerShell示例不用于本次终端）。计划中的目标测试文件实施时才新增，当前不应运行并声称通过。

## 1. 文件职责与依赖

以下均为仓库相对路径。新文件只按所列职责建立，不增加通用框架/ORM/DI容器。

| 文件/目录 | 创建或修改 | 职责/拥有任务 |
|---|---|---|
| docs/superpowers/plans/2026-10-12-ltsd-account-system-progress.md | 创建 | 管理人持久进度、基线、review、待生产条件，Task 0 |
| apps/worker/src/auth/types.ts、config.ts、crypto.ts、input.ts | 创建 | 共享契约、路由分级配置、原生秘密运算与字段校验，Task 1 |
| migrations/mysql/009_account_system.sql | 创建 | 仅账号新表、约束/索引，Task 2 |
| apps/worker/src/auth/repository.ts | 创建 | 下述事务入口和显式SQL；不做密码计算/外部HTTP，Task 2 |
| apps/worker/src/auth/body.ts、csrf.ts、rate-limit.ts、router.ts | 创建 | 有界正文、CSRF、共享限流、独立Hono路由入口，Task 3 |
| apps/worker/src/auth/session-service.ts | 创建 | 登录/me/refresh/logout，Task 4 |
| apps/worker/src/auth/mail.ts | 创建 | 模板、短期AES-GCM、outbox领取/投递，Task 5 |
| apps/worker/src/auth/account-service.ts | 创建 | 注册/本人资料，Task 6/8 |
| apps/worker/src/auth/action-service.ts | 创建 | 验证、恢复、改密，Task 7 |
| apps/worker/src/auth/avatar.ts | 创建 | 有界Base64/WebP检查和字节响应，Task 8 |
| apps/worker/src/auth/jobs.ts | 创建 | 独立邮件Cron、单项清理，Task 13 |
| apps/worker/src/env.ts、index.ts、middleware/cors.ts | 修改 | 解析账号配置、注册入口/Cron、公开CORS排除，Task 3/9/13 |
| apps/web/src/auth/types.ts、api.ts、store.ts、nav.ts | 创建 | 账号客户端、内存状态/续期、独立导航挂载，Task 10 |
| apps/web/src/auth/pages.ts | 创建 | 注册/登录/验证/恢复/账号/改密路由表单，Task 11 |
| apps/web/src/auth/avatar-editor.ts | 创建 | 浏览器裁剪、缩放、压缩、清理资源，Task 12 |
| apps/web/src/main.ts、nav.ts、styles.css | 修改 | 新路径分派、账号占位/样式，Task 10/11/12 |
| apps/web/public/_headers | 创建或按已有文件修改 | 认证页面no-store/no-referrer，Task 11；先确认是否已有规则 |
| apps/worker/test/auth-*.test.ts | 创建 | Worker单元/路由/事务边界测试，各Task |
| apps/web/test/auth-*.test.ts | 创建 | 新UI/客户端行为测试，Task 10–12 |
| tests/integration/auth-account-flow.test.ts、auth-account-races.test.ts | 创建 | 真MySQL流程/并发，Task 14 |
| tests/fixtures/auth/*、tests/helpers/auth-mysql.ts | 创建 | 合成头像/用户、独立测试DB生命周期，Task 2/8/14 |
| scripts/benchmark-auth-cpu.mjs | 创建 | 本地CPU近似及读取Worker真实CPU证据，Task 15 |
| .dev.vars.example、wrangler.toml、.github/workflows/ci.yml | 修改 | 占位/非秘密设置/仅配置的部署与CI，Task 13/14 |
| docs/api.md、deployment.md、operations.md、README.md | 修改 | 账号契约和操作说明，Task 13/15 |

不要修改现有 `session-manager.ts`（市场会话）、`middleware/auth.ts`（上传源）、`lastro-accounts.ts`、`accounts-page.ts` 的身份逻辑。若基线变化，仅由管理人更新文件映射并记录，不让每个Luna自行改名。

## 2. 先固定契约，再逐任务实现

### 2.1 公共类型

所有服务器认证时间为UTC毫秒，注入 `now():number` 便于测试；SQL列用 `BIGINT UNSIGNED`。API时间为整数毫秒，ID始终字符串。下列类型放Worker `auth/types.ts`，Web `auth/types.ts` 保持wire一致；通过契约测试检查字段，避免引入新的共享包。

```ts
type UserId = string;
type AccountStatus = 'PENDING_EMAIL' | 'ACTIVE' | 'DISABLED';
type ActionPurpose = 'VERIFY_EMAIL' | 'RESET_PASSWORD';
type MailPurpose = ActionPurpose | 'PASSWORD_CHANGED';
type CsrfMode = 'anonymous' | 'session';
interface AccountProfile {
  id: UserId; email: string; display_name: string;
  status: AccountStatus; email_verified_at: number | null;
  created_at: number; has_avatar: boolean;
  avatar_version: number; avatar_url: string;
}
interface AuthIdentity {
  userId: UserId; status: AccountStatus;
  credentialVersion: number; authVersion: number;
  sessionDigest: Uint8Array;
}
interface MailAvailability {
  code: 'AVAILABLE' | 'MAIL_DAILY_QUOTA' | 'MAIL_MONTHLY_QUOTA';
  retry_at: number | null;
}
interface MailAttemptContext {
  reservedAt: number; dayBucketStart: number; monthBucketStart: number;
}
type MailReservation =
  | {status: 'reserved'; attempt: MailAttemptContext}
  | {status: 'quota' | 'stale' | 'exhausted'};
interface AuthAcceptedResponse {
  accepted: true; mail_availability: MailAvailability;
}
interface AuthSessionResponse {
  user: AccountProfile; expires_at: number; csrf_token: string;
  mail_availability: MailAvailability | null; // pending本人需查；ACTIVE可null
}
interface AuthRuntime {
  now: () => number;
  fetch: typeof globalThis.fetch;
}
```

`AuthFailure` 是含 `code/status/publicMessage` 的错误类型；router复用jsonError包装，只输出预定公开消息。输入字段使用snake_case：`email/password/password_confirmation/display_name/avatar_base64/current_password/new_password/new_password_confirmation/token`。服务内部camelCase，映射一次。

### 2.2 完整API契约

除头像字节和204外返回JSON；账号路径全部no-store。Specs的15条接口保留，另加一个明确的CSRF启动接口；不是替换已有API。

| 方法/路径 | JSON输入或认证 | 响应与状态 |
|---|---|---|
| GET /api/v1/auth/csrf | 同源启动；不要求登录 | 200 `{csrf_token}`；设置匿名CSRF Cookie；不创建账号会话 |
| POST /api/v1/auth/register | email/password/password_confirmation/display_name，可选avatar_base64 | 202 AuthAcceptedResponse，不返回ID/Set-Cookie登录态 |
| POST /api/v1/auth/login | email/password | 200 AuthSessionResponse＋新会话Cookie |
| GET /api/v1/auth/me | Cookie | 200 AuthSessionResponse；无有效身份401 |
| POST /api/v1/auth/session/refresh | Cookie；空JSON | 200 `{expires_at,csrf_token}`＋30天Cookie；不换每次随机值 |
| POST /api/v1/auth/logout | Cookie；空JSON | 204，撤销本次；无会话可幂等清Cookie |
| POST /api/v1/auth/logout-all | 有效本人；空JSON | 204，auth_version++，清本次Cookie |
| POST /api/v1/auth/email-verification/request | 本人；空JSON | 202 AuthAcceptedResponse；已验证200 `{verified:true}` |
| POST /api/v1/auth/email-verification/confirm | 本人＋token | 200 AuthSessionResponse，当前Cookie轮换 |
| POST /api/v1/auth/password/change | ACTIVE＋current_password/new_password/new_password_confirmation | 204，清Cookie、安排通知 |
| POST /api/v1/auth/password-reset/request | email | 202 AuthAcceptedResponse，存在与否相同 |
| POST /api/v1/auth/password-reset/confirm | token/new_password/new_password_confirmation | 204，不登录、不验证、不授予其他身份 |
| PATCH /api/v1/account/profile | 本人＋display_name | 200 `{user:AccountProfile}` |
| PUT /api/v1/account/avatar | 本人＋avatar_base64 | 200 `{user:AccountProfile}` |
| DELETE /api/v1/account/avatar | 本人，无正文 | 200 `{user:AccountProfile}`，NULL头像 |
| GET /api/v1/users/:id/avatar?v=version | 公开 | 200 WebP（含统一默认头像），nosniff；缓存≤300秒 |

CSRF模式固定：register、login、password-reset/request、password-reset/confirm为anonymous，无论浏览器是否已有登录Cookie；所有本人写操作为session，绑定当前sessionDigest。GETcsrf始终签发匿名上下文且不更新登录身份；登录/me响应只返回会话上下文。logout无有效身份时可幂等返回204且不产生授权，但仍验证可信Origin（不以伪会话作为CSRF校验通过）。

写接口只接受JSON（DELETE无正文例外）＋`X-CSRF-Token`。不接受body user_id、verified、status、其他白名单外字段；基础格式错400，长度413，不支持图片415，未认证401，权限/CSRF403，限流429＋Retry-After，依赖缺失503。密码失配为400且不消费动作。

### 2.3 邮件额度状态的前后端契约

Resend的429必须按JSON错误name区分：daily_quota_exceeded、monthly_quota_exceeded、rate_limit_exceeded。只有最后一种属于瞬时限流；禁止所有429都走1/5/15分钟重试。[官方错误说明](https://resend.com/docs/api-reference/errors)

- readMailAvailability(now):Promise<MailAvailability>读取MySQL全站日/月预算及供应商暂停标记，月额度优先于日额度；不按请求Email是否存在改变结果。AVAILABLE仅表示本站尚不知道额度已耗尽，不承诺一定送达。
- 注册/恢复202、待验证本人重发202返回AuthAcceptedResponse；新/旧/不存在Email都按相同全局状态返回，不暴露用户或任务ID。PENDING用户login/me返回mail_availability，ACTIVE可null；me仍校验真实会话，不能变成公开查某邮箱接口。
- 本地预算用尽在reserveMailAttempt事务内记录暂停及终结；实际HTTP返回daily_quota_exceeded则通过recordProviderQuota按该次HTTP尝试的attempt.dayBucketStart原子写供应商scope日暂停至该bucket的下一UTC 00:00，并把当前任务终结FAILED＋MAIL_DAILY_QUOTA、清密文；本地未发出不扣HTTP次数，已预留/已发HTTP不返还预算。已失败任务不能次日自动重发。其他尚未尝试任务暂停，恢复后仅在原动作仍有效时发送，过期取消；重发入口可复用本人同版本仍有效的未发送任务，避免重复排队。
- 使用auth_rate_limits已有字段保存共享暂停：固定公开provider key_digest（32字节零值；用于全站provider/budget，不包含个人Email/IP且不随rate secret轮换改变），scope=mail-provider-daily，bucket_start为UTC日开始，next_allowed_at为次日UTC开始；月scope=mail-provider-monthly，bucket_start为UTC月开始；本站月暂停next_allowed_at为下一UTC月开始，expires_at为暂停结束后24小时。provider月恢复以真实账户为准；缺少更准时间时先保守暂停至下一UTC月开始再允许一次正常尝试，UI retry_at仍为null，若仍被拒绝则再次暂停。日暂停expires_at也为其结束后24小时，缺记录等价未被供应商暂停，预算仍独立校验。provider错误必须绑定该次HTTP预留返回的MailAttemptContext，不用job创建时间、first_attempt_at或响应处理时间来选择周期；旧日/月的迟到拒绝只能记旧bucket，绝不创建或延长新bucket暂停。新周期允许正常尝试后再依据该次真实错误处理额度；me只读当前bucket，因此不会被旧拒绝误伤。邮件领取/预留必须看该共享状态，不能放Worker全局变量。readMailAvailability按同一规则查询，原子预留发现本站日预算已满，也在原事务终结当前job/清密文并写暂停，不采用先返回quota再异步处理的两步流程；reserveMailAttempt返回status=quota后直接结束该次投递。
- monthly_quota_exceeded或本地月预算满写月暂停并FAILED＋MAIL_MONTHLY_QUOTA。本站月预算在UTC月切换；供应商月恢复时点按实际账户确认，无确切时间则retry_at=null，UI不承诺明天恢复。若供应商仍拒绝，重新暂停，不在同一次调用循环探测。
- 日额度统一提示：“今天发送邮件的数量已达到上限，请明天重新登录账号，再进行 Email 身份验证。”另显示retry_at对应用户当地时间，并说明服务商日额度按UTC恢复；已收到的有效验证链接仍可正常使用，不因全站暂停被撤销。受限账号仍能登录、改本人资料和退出；邮件受理/失败都不改变PENDING状态。
- 月额度提示：“本月邮件发送额度已用完，请待额度恢复后重试。”恢复密码页换成“额度恢复后重新申请密码重置”，不要求无法登录的用户先登录。
- outbox异步发送，202只说“已受理，正在等待发送”，不可说“邮件已发送”。待验证页首次读me、显式检查发送状态、重新进入/登录时读取额度；仅用户主动申请后的可见待验证页面可每120秒再查一次、最多3次，随后停止并保留“检查发送状态”按钮，离页/隐藏/已验证/额度耗尽立即停止。不做全站持续轮询，不自动续期或自动重发；供应商错误落库后由此展示准确提示。
- 次日有效/重新登录PENDING账号后，用户主动点重发，在冷却与新预算允许时复用仍可发任务或创建新动作/任务；已失败/过期任务不恢复。不因额度耗尽删除用户或改密码。安全通知失败也不回滚改密，保留脱敏结果。
- 最小新增验收是一条“quota→提示→次日PENDING登录→主动重发→验证”关键流程，加一个429分类参数用例；在同一跨UTC流程加入“午夜/月末前预留、拒绝在新周期才处理”，断言新周期未暂停，不用扩建测试套件。

Resend Free日限额按UTC日恢复；当前额度包括同团队其他发送及收信，本站计数可能比真实额度低，因此必须处理供应商真实拒绝。[官方额度说明](https://resend.com/docs/knowledge-base/account-quotas-and-limits)

### 2.4 必须采用的事务顺序

用 `AuthRepository.transaction(work)` 包装现有 `MysqlDatabase.transaction`，work接收绑定同一连接的 `AuthTx`。AuthTx没有transaction方法，避免嵌套借连接。所有涉及已有用户的认证状态写入先 `lockUser(userId)`（SELECT ... FOR UPDATE），再取得所需动作/session锁，**取得关键锁之后重新调用runtime.now()**检查期限/会话/动作/版本并写；不能用等待锁之前的时间判定授权有效。不得先锁动作再锁用户。用户锁→会话/动作→outbox→审计的顺序全项目一致。

服务端先读凭据、在事务外做单次HMAC（不长时间持用户锁）。事务内重读版本且与已验快照匹配，再写入；不同则重新认证/返回失效错误。登录、改密、恢复、续期、logout-all均按此执行。读取me做一次显式JOIN校验当前版本/状态，既不读取头像也不持长锁。

用 `auth_version` 使全部退出/停用立即失效，用 `credential_version` 使改密及旧动作失效；不要求对全部历史session执行无界UPDATE。验证成功轮换当前session并使同凭据版本全部VERIFY_EMAIL动作失效；不把所有其他session自动改成已验证的静态快照，读权限时看最新用户状态。

### 2.5 账号Repository接口边界

`createAuthRepository(db:MysqlDatabase,options?:AuthRepositoryOptions):AuthRepository`，保持单参数调用兼容；`AuthRepositoryOptions={mailDailyLimit?:number;mailMonthlyLimit?:number}`，默认100/3000，由账号配置接入后传入，额度读取与预留复用同一设置。必须至少给出下列操作。查询返回显式定义行类型，不用any或SELECT *；与SQL表字段映射放repository。

- `readCredentialByEmail(emailNormalized:string):Promise<CredentialSnapshot|null>`：含string userId、status、credentialVersion、authVersion和摘要材料，**不含头像**。
- `readProfile(userId:UserId):Promise<AccountProfile|null>`：只读has_avatar/avatar_version，不读Base64。
- `readIdentity(sessionDigest:Uint8Array,now:number):Promise<LiveAuthIdentity|null>`：JOIN状态/版本/到期校验，同时显式返回expiresAt供me复用；内部`LiveAuthIdentity=AuthIdentity & {readonly expiresAt:number}`，不增加公开字段或读取头像。
- `transaction<T>(work:(tx:AuthTx)=>Promise<T>):Promise<T>`。
- AuthTx：`lockUser(userId):Promise<UserRecord|null>`、`readCredential(userId)`、`insertUser(input):Promise<UserRecord>`、`insertCredential(userId,material)`、`saveCredential(userId,material,nextVersion,now)`。
- AuthTx：`readSessionForUpdate(digest)`、`insertSession(input)`、`renewSession(digest,expiresAt,now)`、`revokeSession(digest,now)`、`bumpAuthVersion(userId,now)`。
- Repository：`readActionSnapshot(digest:Uint8Array):Promise<ActionSnapshot|null>`，无锁返回string userId/用途/Email快照/版本/期限，仅用于定位；不证明动作有效、不用于直接写状态。
- AuthTx：`readActionForUpdate(digest)`、`insertAction(input)`、`consumeAction(digest,now)`、`revokeActions(userId,purposeOrAll,now)`、`markEmailVerified(userId,now)`。
- AuthTx：`saveDisplayName(userId,name,now)`、`saveAvatar(userId,base64OrNull,now)`、`insertMailJob(input)`、`appendEvent(input)`。
- Repository另有readMailAvailability、共享供应商暂停写入、邮件领取/状态条件更新、共享限流/冷却、单批清理；Task5/13给出输入和规则，不能让业务服务直接运行散落SQL。
- `readAvatar(userId):Promise<{base64:string|null;version:number}|null>`：唯一允许读头像文本的路径。

上述input/行类型在Task2按§3字段定义并导出；后续必须用相同类型，不临时重命名。SQL实现集中但不要把HTTP、加密、模板和鉴权规则混进repository。

## 3. 数据结构的具体要求（Task 2落地）

新增8个表，全部InnoDB，明确FK/index；无游戏/支付外键。下面是字段约束，不是要求照抄未经执行的SQL。

1. **auth_users**：id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY，初始10000；email VARCHAR(254)、email_normalized VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin UNIQUE；display_name VARCHAR(32) utf8mb4；status VARCHAR(16) CHECK三态；email_verified_at nullable；credential_version/auth_version INT UNSIGNED默认1；avatar_version默认0；created_at/updated_at UTC毫秒。ID只读，不支持用户删除。
2. **auth_credentials**：user_id PK/FK；scheme固定hmac-sha256-v1；索引(key_version,user_id)用于有界轮换核对；salt VARBINARY(16)、digest VARBINARY(32)；key_version短字符串；updated_at。固定secret不在表内。
3. **auth_avatars**：user_id PK/FK；avatar_base64 TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL，CHECK字符长度≤43692；updated_at。无头像可删除此行（逻辑等同NULL）；以User avatar_version递增并在同一事务写入。
4. **auth_sessions**：token_digest BINARY(32) PK；user_id FK；credential_version/auth_version、created_at/last_seen_at/expires_at均NOT NULL；只有revoked_at可NULL。索引(user_id)、(expires_at,token_digest)。随机值不入库。
5. **auth_action_tokens**：token_digest BINARY(32) PK；user_id FK、purpose、email_snapshot、credential_version、created_at/expires_at NOT NULL，consumed_at/revoked_at可NULL；索引(user_id,purpose)、(expires_at,token_digest)。允许同用途多个未过期动作。
6. **auth_mail_outbox**：id CHAR(36) PK（UUID）、action_digest nullable（不建阻碍TTL清理的FK，仅动作关联摘要）、user_id nullable FK、purpose、payload_ciphertext小型Base64（终结后可NULL）、payload_iv（终结后可NULL）、payload_key_version VARCHAR(16) NOT NULL、priority TINYINT UNSIGNED（通知0、验证/恢复1）、state、lease_id nullable、lease_until、attempt_count、next_attempt_at、created_at/expires_at、first_attempt_at nullable、provider_message_id nullable、last_error_code nullable。索引(state,priority,next_attempt_at,id)、(state,lease_until,id)、(expires_at,id)、(user_id,purpose,state,created_at,id)（本人重发合并未发送任务的有界查询）。供应商幂等key为ltsd-auth/＋id；state取PENDING/CLAIMED/SENT/FAILED/CANCELLED。
7–8. **auth_security_events** 与 **auth_rate_limits**：前6个表加这2个小表，总共8个；事件id自增但无10000要求，user_id nullable、event/request_id/result/reason/created_at，索引(created_at,id)；rate主键(scope,key_digest,bucket_start)、request_count、next_allowed_at、expires_at，索引(expires_at)。scope仅预定义（含§2.3的provider日/月暂停），key_digest BINARY(32)用独立AUTH_RATE_SECRET HMAC；禁止完整IP/邮箱日志。全站公开provider及budget键使用固定32字节零digest，个人Email/IP/session限流键使用独立AUTH_RATE_SECRET HMAC。schema测试断言8个新表。

精度方案：**不要更改现有全项目MysqlWriteResult**。新用户INSERT后，在同一事务用唯一email_normalized读取 `CAST(id AS CHAR) AS id`；所有auth查询的user_id/id均CAST AS CHAR，绑定字符串作为BIGINT参数。既有Number insertId仅忽略。对 >Number.MAX_SAFE_INTEGER 的合成用户测试读回保真。

迁移是纯新增DDL，旧008及更早文件不能改（runner记录checksum）。若009编号已被占用，管理人选择下一个编号，更新本计划所有引用。若已有同名用户表结构不一致，管理人先做迁移映射，禁止用CREATE IF NOT EXISTS掩盖不兼容。回滚程序代码时保留用户新表，关闭AUTH_ENABLED；不用DROP账号数据，不能回滚版本使撤销身份复活。

## 4. 测试约定与运行方式

单元文件位于worker/test或web/test；Vitest root默认node，Web用jsdom注入window/document并finally恢复。不为新模块默认引入Playwright依赖；真实浏览器检查用已有浏览器工具/人工记录，若已有E2E能力可复用。

`tests/helpers/auth-mysql.ts` 输出 `withAuthTestDatabase(work)`：输入只能是显式 `MYSQL_TEST_URL`，数据库名必须以 `_test` 结尾且不能等于当前生产/开发MYSQL_URL的数据库；允许重置还要 `AUTH_TEST_DB_ALLOW_RESET=1`。测试从空的专用DB用现有scripts/mysql-migrate.mjs按文件序加载**全部MySQL迁移（当前001–008＋账号009）**，然后准备/清理合成fixtures，单worker顺序运行。helper用受控child process把MYSQL_URL设为已检查的MYSQL_TEST_URL，不在当前测试进程临时覆盖全局MYSQL_URL；不打印URL。跑runner后才断言旧市场/guestbook/source表存在。并发测试创建至少两个独立MysqlDatabase实例，**不要包在外层rollback事务**，否则无法验证真实并发可见性。

新增集成测试读 `REQUIRE_AUTH_MYSQL_TESTS=1` 时，URL缺失/拒绝/SQL没跑必须FAIL，不能skip或以假数据库替代。管理人运行完整验收必须启用它；普通不带真实DB的pnpm test可以明确skip，并在证据区标注。

Task步骤里的失败测试名是具体测试意图，最终实现用it(...)并准确断言；不要把整份计划编译成测试，更不要用源代码字符串匹配代替API与SQL行为。

测试文件名是推荐组织，不是必须逐文件创建的交付项；允许合并小测试文件，管理人同步相关命令/brief和进度记录即可。Task里多个意图可放同一个参数化测试或共用主流程，不因文档列了多个路径就各写一套。

**轻量测试优先：** 各Task列出的测试点是关键行为检查清单，不要求每个条目独立it、每个文件再写同一流程。管理人先查看已有覆盖；已由集成流程证明的行为，单元只补该层独有风险。大致按输入/鉴权、账号主流程、会话撤销与少量确定性竞争、邮件幂等/额度、头像有界解析、客户端关键状态分组即可。边界用少量代表数据/参数化，UI布局/操作和真实WebP允许一次人工浏览器记录。禁止追求100%覆盖、庞大组合矩阵/模糊测试/重复端到端套件；新增用例必须说清能防止哪一个具体故障。Task步骤中的RED仅针对确实需要新增的关键行为测试，已有充分覆盖则复用，不造形式化失败。真实MySQL关键并发与Free CPU证据仍保留。

## Task 0: 管理人建立分支、基线和任务账本

**Files:** 创建进度文档；不改产品代码。**Interfaces:** 输出branch/baseSHA/preexistingChanges/测试基线，供所有任务使用。

- [ ] 读取全局/当前路径AGENTS、agent.md、Spec、本计划；用CodeGraph定位涉及的代码。记录当前 `rtk git status --short` 和 `rtk git branch --show-current`，保存未提交文件清单，尤其已有README/Spec/本计划。保留非本任务变更，不reset、自动stash或覆盖。
- [ ] 在当前checkout执行 `rtk git switch -c feat/ltsd-account-system`。若此分支已存在，管理人核对是否属于本工作，再直接使用或选 `feat/ltsd-account-system-2`，写入账本；不强行重建。用户的新分支要求覆盖agent.md历史“catalog在main”的特定指令。
- [ ] 记录 `rtk git rev-parse HEAD` 为implementationBase；确认Node24/pnpm12.4.2，运行 `rtk proxy pnpm install --frozen-lockfile`（已有依赖且匹配可不重复安装）。
- [ ] 跑基线 `rtk proxy pnpm lint`、`typecheck`、`test`、`test:migration`、`test:docs`、`rtk proxy pnpm --filter web build`。失败先记录是否既有，不顺手修无关问题。真实DB测试若skip明确记录。
- [ ] 创建progress，表列Task0–15状态、commit范围、测试命令/退出码、review结论、待生产条件。文档基线可独立提交，但只显式包含已核对属于本功能的README、Spec、计划/review/prompt；管理人先检查差异，不能混入用户其他修改。完成只读preflight review后进入Task1。

## Task 1: 固定类型、输入和原生加密

**Files:** 新auth/types.ts、config.ts、crypto.ts、input.ts；测试worker/test/auth-primitives.test.ts、auth-input.test.ts。
**Interfaces:** 提供 `normalizeEmail(value:string):{delivery:string;normalized:string}`、`parseDisplayName(value:unknown):string`、`validatePassword(value:unknown):string`、`createPasswordMaterial(password:string,config):Promise<PasswordMaterial>`、`verifyPassword(password:string,snapshot,config):Promise<boolean>`、`createOpaqueToken():string`、`digestToken(token:string):Promise<Uint8Array>`、`resolveAuthConfig(env:AppEnv):AuthConfig`。

- [ ] 写失败测试：4/5/256/257字符边界、5个emoji通过、前后空格保留、12345通过、确认不匹配失败；display_name空白失败/32通过/33失败/可重名；Email大小写同归一值、加号和点号不合并、非法行分隔符拒绝。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/worker/test/auth-primitives.test.ts apps/worker/test/auth-input.test.ts`，缺模块/功能行为失败即RED。不能用syntax错误代替有效失败测试。
- [ ] 实现§2类型；Email local-part使用有界ASCII常规邮箱格式（长度≤64、总长度≤254，拒绝空点段/控制字符），域名转ASCII并统一大小写；不引入重量RFC解析器。密码长度用code point，不用JS .length或HTML maxlength作为唯一规则；摘要前拒绝孤立UTF-16 surrogate，避免UTF-8替换导致不同输入等同，不改变合法Unicode密码规则。昵称只trim自身，不能连带trim密码。
- [ ] 秘密约定：密码/CSRF/rate/mail秘密均独立32随机字节的标准Base64，服务器导入前严格解码32字节；密码message为UTF8(ltsd-password-v1＋NUL)＋16字节salt＋UTF8原密码；digest用原生HMAC、verify用subtle.verify。会话/动作是32随机字节base64url，摘要SHA-256原token字节，拒绝非法格式再解码。密码AUTH_PASSWORD_KEY_VERSION、邮件AUTH_MAIL_PAYLOAD_KEY_VERSION默认"1"，均为非秘密设置。Config输出passwordKeys/mailPayloadKeys（当前＋最多一个previous的ReadonlyMap<string,Uint8Array>版本→原始key字节映射；异步importKey由crypto函数完成）及currentPasswordKeyVersion/currentMailPayloadKeyVersion；CredentialSnapshot.keyVersion/NewMailJob.payloadKeyVersion必须匹配映射后选择对应key，不能用当前key尝试所有旧记录。可选旧pair为AUTH_PASSWORD_PREVIOUS_KEY_VERSION＋AUTH_PASSWORD_PREVIOUS_SECRET、AUTH_MAIL_PAYLOAD_PREVIOUS_KEY_VERSION＋AUTH_MAIL_PAYLOAD_PREVIOUS_SECRET；每pair必须同时有值，版本不能与current相同，key仍为32字节Base64。首次不配previous即可；不每部署生成或自动轮换。
- [ ] 补测试：同密码两个salt摘要不同、错误pepper/密码拒绝、scheme/版本未知安全失败、token随机值不等于ID、秘密缺失返回预定503，不把secret拼进错误；不循环HMAC、不导入第三方密码库。跑上述测试与typecheck，review通过后提交 `feat: add account contracts and native crypto`。

**配置范围:** env仅解析非秘密/秘密字符串并传给AuthConfig；公开市场不因账号秘密缺失崩溃。核心需求为MYSQL_URL、AUTH_PASSWORD_SECRET、AUTH_CSRF_SECRET、AUTH_RATE_SECRET、AUTH_MAIL_PAYLOAD_SECRET及可信AUTH_SITE_URL。NewMailJob和ClaimedMailJob包含payloadKeyVersion:string，由repository映射到SQL列payload_key_version；邮件prepare只用current key，dispatcher按任务版本选择。PasswordMaterial/CredentialSnapshot含keyVersion:string，verify只选对应key，未知/缺失版本安全失败并记脱敏告警，不回退当前key；邮件未知版本暂停保留密文直到恢复key或TTL到期。首次schema/fixture版本均"1"，测试覆盖previous解密/验证、current新写、混搭版本失败。

RESEND_API_KEY/MAIL_FROM是投递配置，可使任务暂停但不能让现有已登记用户无法登录。AUTH_ENABLED默认false，只是上线开关，不改变用户密码/会话规则。

## Task 2: MySQL迁移与账号Repository

**Files:** 009_account_system.sql、auth/repository.ts、tests/helpers/auth-mysql.ts；worker/test/auth-schema.test.ts、auth-repository.test.ts。
**Interfaces:** 实现§2.5全部基础操作；导出CredentialSnapshot、UserRecord、AuthRepository/AuthTx等明确类型。Task2先交付真实只读readMailAvailability供先于Task5的Task4消费；按当前UTC bucket读取mail-budget-daily/monthly和mail-provider-daily/monthly，月优先，日retry_at下一UTC日、月null。Task5/13再添加有界后台操作。

- [ ] 写失败测试：DDL八表/初始AUTO_INCREMENT10000/唯一email/FK/头像ASCII TEXT长度；SQL查询不含头像；AuthTx不支持嵌套transaction。新表第一用户"10000"，相同邮箱并发最多一人，回滚不留半个Credential。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/worker/test/auth-schema.test.ts apps/worker/test/auth-repository.test.ts` 确认RED；schema字符串测试仅辅助DDL约束，真实SQL结果由集成验证承担。
- [ ] 按§3添加DDL，复用runner排序/checksum机制；不修改老迁移。实现事务绑定与固定锁顺序，参数化SQL和显式列；CAST ID字符串，不能修改mysql-client全局数字约定。用户主表has_avatar通过EXISTS/LEFT JOIN存在性，不能选Base64。
- [ ] 实现专用MySQL helper：只有 *_test且允许reset标志才清理；URL不得输出，测试失败finally关闭全部连接。schema建表清理在fixture阶段完成；并发测试不放外层rollback。真实DB可暂缺但此Task仅“单元通过，集成待证”，不能标生产验证。
- [ ] 跑单元、`rtk proxy pnpm test:migration`，有专用DB时运行后续auth-account-flow最小schema用例（本Task先创建该文件的migration describe）。断言第一个ID、重复约束、>2^53读回、旧市场表仍存在。review后提交 `feat: add MySQL account schema and repository`。

## Task 3: 有界正文、CSRF、共享限流和独立路由入口

**Files:** auth/body.ts、csrf.ts、rate-limit.ts、router.ts，修改middleware/cors.ts及repository.ts的共享限流/冷却操作；worker/test/auth-security.test.ts、auth-body.test.ts、cors.test.ts。
**Interfaces:** `readAuthJson(request,maxBytes):Promise<Record<string,unknown>>`；`issueCsrf(request,config,mode:CsrfMode,identity?):Promise<{token:string;cookie?:string}>`；`assertCsrf(request,config,mode:CsrfMode,identity?):Promise<void>`；`consumeAuthRateLimit(repo,rules,now):Promise<{allowed:boolean;retryAfter:number}>`；`registerAuthRoutes(app,env,database?,runtime?):void`。

- [ ] 写失败测试：chunked无Content-Length的64KiB+1拒绝，谎报Content-Length仍拒绝；坏JSON/未知字段/数组拒绝；跨站origin、缺X-CSRF-Token、错Cookie nonce拒绝；公开搜索仍ACAO*，账号无通配符。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/worker/test/auth-body.test.ts apps/worker/test/auth-security.test.ts apps/worker/test/cors.test.ts` 得到RED。
- [ ] 实现流读取累计超限立即cancel，不先request.text/json读完再测。register/PUT头像64KiB，其他JSON8KiB；JSON不能通过额外字段让用户控制status/user_id。Body/header错误只返回公开code。
- [ ] 首版同源账号CORS：public middleware跳过精确 `/api/v1/auth/`、`/api/v1/account/` 和用户头像模式；auth返回no-store，无ACAO*、无ACAC，不将game.lastro.cn/IWA开放为账号登录源。OPTIONS账号返回适当同源204，不走public预检白名单；未知/api auth路径给JSON404，不回SPA HTML。
- [ ] 匿名CSRF启动设置HttpOnly匿名nonce Cookie（32随机字节，30分钟）；GETcsrf复用格式有效的现有nonce，不每次换Cookie。token为v1.a.issued_at.signature，HMAC绑定可信origin、anonymous用途、Cookie nonce和issued_at，服务端拒绝未来/超过30分钟的issued_at。已登录CSRF token为v1.s.signature，HMAC绑定可信origin、session用途和当前sessionDigest；有效性另外受服务端session版本/期限控制。GETme/登录仅返回会话token到内存，GETcsrf始终返回匿名token，路由按§2.2固定mode选择，不由是否带Cookie自动切换；不能把会话原token返回JSON。生产Cookie均__Host-前缀Secure/HttpOnly/SameSite=Lax/Path=/且无Domain；local用独立不Secure名称，仅ENVIRONMENT=local且可信localhost源，不能在production放宽。
- [ ] 写操作同时验证AUTH_SITE_URL对应Origin＋CSRF token；本地浏览器Origin用Vite地址，不能根据proxy后的Host拒绝正常请求。无Origin的写请求失败关闭（例外仅有明确测试/非浏览器调用不会获得Cookie权限）；GET允许无Origin，不接受任意跨源启动。匿名token只保护注册/登录/恢复申请/恢复确认，不赋账号身份。
- [ ] 共享限流为MySQL有期固定窗口＋60秒冷却，各Scope按Spec§11，Email/IP key用独立HMAC；组合keys固定排序锁定，计数事务独立提交，60秒Email共享冷却独立于小时window使用scope=mail_cooldown、bucket_start=0和next_allowed_at，过小时边界仍拒绝未到60秒重发；后续密码错/业务rollback不能撤掉失败尝试计数。达到limit后clamp到limit+1避免整数溢出；数据库故障503，不用内存fallback。阈值同时覆盖不存在Email。
- [ ] router先仅提供GETcsrf及已知账号路径配置失败503的安全入口，用fake runtime可独立测试；不要伪造成功业务handler。已知剩余路径由下一任务逐个接入。本阶段尚不接生产index，避免发布半成品。补CSRF跨子域/Origin代理、跨小时窗口仍60秒冷却、多连接计数、GETcsrf复用nonce测试。并发首开两个标签尚无nonce时，客户端仅在anonymous mode遇到AUTH_CSRF_INVALID时重新GETcsrf并重试一次；该错误必须在任何业务副作用前返回，随后仍失败正常提示，不能无限重放；GREEN＋review后提交 `feat: add bounded account request security`。

## Task 4: 登录、本人查询、30天会话和退出

**Files:** auth/session-service.ts、router.ts、repository.ts（必要条件操作）；worker/test/auth-session.test.ts。
**Interfaces:** `createSessionService(repo,config,runtime)` 提供 `login(email,password):Promise<{response:AuthSessionResponse;cookie:string}>`、`authenticate(request):Promise<AuthenticatedSessionIdentity>`、`me(identity:LiveAuthIdentity):Promise<AuthSessionResponse>`、`refresh(identity:AuthenticatedSessionIdentity):Promise<{expires_at:number;csrf_token:string;cookie:string}>`、`logout(identityOrNull):Promise<void>`、`logoutAll(identity):Promise<void>`。

- [ ] 写失败测试：ACTIVE正常、PENDING有限、错误/未知/禁用同401；默认到期和Cookie恰为30天；第29天访问续30天、再第29天又续、恰好到期失败；me不刷新DB和Cookie期限。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/worker/test/auth-session.test.ts` RED。
- [ ] 内部`AuthenticatedSessionIdentity=LiveAuthIdentity & {readonly sessionToken:string}`只携带当前请求Cookie原值供refresh重发同值Cookie；Repository/AuthIdentity基础类型仍只含摘要，不写DB、JSON、日志或跨请求字典。
- [ ] login在事务外单HMAC；未知Email使用固定dummy材料验证，错误时同code/message，无忙等。成功事务锁用户、重查credential/authVersion/status，生成32字节token、存摘要、新Cookie；和之前会话无固定继承。版本变化时失败，不使用旧校验快照创建新会话。
- [ ] authenticate/readIdentity JOIN检查最新user状态、session两版本、revoked_at和expires_at>now；PENDING只allow me/refresh/资料头像/验证/logout。refresh在用户锁和session锁均取得后重新读取runtime.now()再判过期、查版本，续期用单调不缩短值（GREATEST原expires_at和本次now＋30天），同步Cookie；不在每次refresh换token，不把expires_at判断改成≥。
- [ ] logout单次撤销该digest；logout-all在用户锁下auth_version++，不无界遍历session；无效Cookie可清且幂等，但不能给不存在身份额外权限。普通me/refresh/鉴权401只清前端内存身份，**不发送删除Cookie的Set-Cookie**，防迟到旧401覆盖刚登录/验证后的新Cookie；只有明确logout/logout-all/成功改密或恢复等操作按契约清理。
- [ ] 加登录与改密版本竞争、refresh与logout-all竞争、多标签相同token续期、等待用户锁跨过到期拒绝、旧me/refresh401晚于新登录/验证响应且不发清Cookie头的测试；last_seen_at最多每日一次，不影响真实refresh。GREEN＋review后提交 `feat: add rolling account sessions`。

## Task 5: 邮件模板、短期密文、可靠outbox和Resend

**Files:** auth/mail.ts、repository.ts；worker/test/auth-mail.test.ts。
**Interfaces:** `prepareActionMail(input,config):Promise<NewMailJob>`、`preparePasswordChangedMail(input,config):Promise<NewMailJob>`；`createMailDispatcher(repo,config,runtime).sendOne(now):Promise<'sent'|'idle'|'retry'|'paused'|'failed'>`。Repository增加 `claimOneMail(now,leaseMs):Promise<ClaimedMailJob|null>`、`finishMail(id,leaseId,result):Promise<boolean>`（CAS是否成功）、`reserveMailAttempt(id,leaseId,now:()=>number):Promise<MailReservation>`；`readMailAvailability(now):Promise<MailAvailability>`；`recordProviderQuota(id,leaseId,kind:'daily'|'monthly',attempt:MailAttemptContext,observedAt:number):Promise<{pauseRecorded:boolean;jobUpdated:boolean}>`。后者事务按attempt所属UTC bucket持久共享暂停并CAS终结当前job/清密文；返回pauseRecorded与jobUpdated独立含义，不能用job CAS是否成功决定整站错误有没有记录。过期claimer不覆盖job结果，供应商确切拒绝仍可记原bucket暂停，不影响新周期。observedAt仅用于审计/更新时间。

- [ ] 写失败测试：VERIFY/RESET模板目的和期限正确、nickname转义、无密码；相同mailId重试body/key不变，超时未知仍同key，服务商返回id不标邮箱已验证；密文解码后payload正确，DB无明文token。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/worker/test/auth-mail.test.ts` RED。
- [ ] 可信链接用 `AUTH_SITE_URL + /verify-email#token=...` 或 `/reset-password#token=...`（fragment不进服务器请求URL）。HTML＋text模板正文小于8KiB，显式不含追踪链接；AES-GCM用独立32字节MAIL秘密、每任务12字节随机IV，AAD绑定mailId/purpose，持久任务保存密文/IV及秘密版本（默认1）。
- [ ] prepare只生成投递意图，不HTTP；由业务事务insertMailJob。授权邮件expires_at等于动作到期；密码变更通知默认24小时投递窗口，无授权token；NewMailJob写current payloadKeyVersion，未知旧版本暂停，不用新key猜解旧密文。成功/永久失败/到期删除密文，可保留结果元数据。
- [ ] claimOneMail：短事务选1条PENDING到时或CLAIMED租约过期任务，必须同时expires_at>新now、attempt_count<4、first_attempt_at为空或距首次预留未超过24小时；priority0通知优先，再priority1，按索引范围各取至多1条，不全表排序。用FOR UPDATE SKIP LOCKED或等效CAS写新leaseId/30秒lease并提交。解密并检查动作未使用/撤销且版本有效，否则取消；不持锁等HTTP。
- [ ] **HTTP之前**调用reserveMailAttempt：同一短事务重查id＋lease_id、lease_until>新now、动作期限、attempt_count<4及24小时窗口，同时原子占日/月预算、attempt_count++、首次预留时写first_attempt_at；预留函数在取得关键锁后调用注入now()计算当前UTC day/month bucket；若等待预算锁期间跨周期，回滚并返回stale，下次tick再处理，不在当前调用循环重试。提交成功status=reserved并返回该次attempt上下文才允许fetch。quota/stale/exhausted不能发信；额度不足按§2.3终结当前任务并共享暂停，不进入短时间重试。预留后crash或还没fetch就终止也不返还次数/预算，这是保守上限。每次重试都重新预留，但仍用同body/key。
- [ ] 原生fetch调用POST Resend，Idempotency-Key=ltsd-auth/mailId，Bearer保留服务端，HTTP超时5秒；quota响应传入本次预留返回的attempt上下文，不能用响应到达时钟重建bucket；finishMail按id＋leaseId条件写，旧claimer不能覆盖后来结果。保持email正文和发送参数原样，不每次重渲染产生差异。成功2xx＋合法消息id记SENT；429按§2.3分类，日/月额度写共享暂停和终结当前任务；仅rate_limit_exceeded、5xx/网络超时按1、5、15分钟有限重试（总最多4次，尊重有界Retry-After）；401/403配置错暂停告警；收件格式永久错FAILED。到期或超过24小时幂等窗口的未知结果不自动重复。
- [ ] budget每天/月原子计数，**每次实际HTTP尝试（含重试）保守占1份**；初始100/3000，全站共享provider scope，其他站点服务占额度时需调低配置。当天/当月用完按§2.3共享暂停和明确UI提示，不无限积压，过期即取消；安全通知优先查询，不能突破总预算。不自动转Brevo，更不创建玩家账户注册邮件到真实地址测试。
- [ ] fake fetch测试响应体限制（≤8KiB）、accepted/failed/timeout/lease重领/错误AAD/密钥缺失/额度竞争；增加HTTP已受理但finish前crash、第4次crash、预留后fetch前crash：attempt/first_at和预算已持久，重领不得突破4次，不把首次时间改成重试时间；投递后auth状态不变、已改密码不因通知失败回滚。GREEN＋review后提交 `feat: add transactional account mail outbox`。

## Task 6: 注册流程与待验证状态

**Files:** auth/account-service.ts、router.ts；worker/test/auth-register.test.ts。
**Interfaces:** `createAccountService(repo,config,runtime).register(input:RegisterInput):Promise<AuthAcceptedResponse>`；RegisterInput包含email/password/password_confirmation/display_name和可选avatar_base64（头像实现Task8后连接，之前有头像输入不得假保存）。

- [ ] 写失败测试：必填昵称和5字密码可以注册；同邮箱并发唯一；匿名重复注册不覆盖密码/不自动重发已存在用户；首次/已存在统一202且无登录Cookie。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/worker/test/auth-register.test.ts` RED。
- [ ] public输入和冷却/rate先验；密码/动作/mail载荷预计算在事务外。事务insertUser(PENDING)、Credential、VERIFY_EMAIL动作、outbox、审计，全部提交或回滚；唯一冲突只转同类受理，不掩盖其他SQL/配置故障。
- [ ] 新注册无会话，提示登录后验证；邮件缺API key可可靠排队并明确生产条件，但核心mail密文secret/域名配置缺失503，不能创建无法恢复的明文任务。账号写入不等待Resend。可选头像Task8前先保留明确unsupported测试分支，接入后必须一起原子保存，不能悄悄丢字段。
- [ ] 测试邮件失败只留pending、不重复账号、未知外字段拒绝、不会输出ID/status存在差异；跟Task8最后整合带头像注册。GREEN＋review后提交 `feat: add email account registration`，账本记录头像集成尚待Task8，不标AUTH-01完整。

## Task 7: 验证、改密、恢复与一次性动作

**Files:** auth/action-service.ts、router.ts、repository.ts；worker/test/auth-actions.test.ts。
**Interfaces:** `createActionService(repo,config,runtime)`：`requestVerification(identity):Promise<AuthAcceptedResponse|{verified:true}>`、`confirmVerification(identity,token)`、`changePassword(identity,current,new,confirmation)`、`requestReset(email):Promise<AuthAcceptedResponse>`、`confirmReset(token,new,confirmation)`；成功验证返回新AuthSessionResponse＋Cookie，密码修改/恢复只返回成功状态并清适当旧Cookie。

- [ ] 写失败测试：GET扫描不消费；24h/30min边界错用途/错用户拒绝；验证需当前同用户会话；成功一次后其他同版本验证动作失效；恢复不自动登录/验证。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/worker/test/auth-actions.test.ts` RED。
- [ ] requestVerification只登记Email，不让body换地址，ACTIVE返回verified；requestReset对存在/不存在/禁用统一202。申请时冷却/配额共有计数，响应带§2.3统一mail_availability；待验证本人重发可复用同版本仍有效的未发送任务，避免重复排队，已FAILED/过期任务不可重启；不撤销现有session，不因重发立刻撤销之前有效动作。
- [ ] confirmVerification用repo.readActionSnapshot(digest)无锁找到userId，仅定位不授权，事务按用户→动作→当前session重查全部身份/版本/期限；原子消费、markACTIVE/verified、撤销同用户VERIFY动作、轮换当前session随机token、安排必要审计。其他会话通过最新状态判断，不保留前端verified。
- [ ] changePassword仅ACTIVE且当前密码HMAC验证成功；新密码允许和当前相同。事务重读版本，保存新随机salt/digest、credential_version++及auth_version++，撤销全部旧动作（可版本无效＋有界逻辑）、安排通知。当前Cookie清除，要求重登录。
- [ ] confirmReset不要求账号登录，但必须匿名CSRF＋合法一次性恢复动作；用repo.readActionSnapshot读取无锁快照后生成新凭据，按用户→动作锁重查版本/状态和锁后新now期限、原子消费并增加两个版本。PENDING仍pending，DISABLED不能恢复；notification和状态同事务，投递失败不回滚。
- [ ] 测试受害者邮箱代注册攻击：未知密码的邮箱所有者通过reset→登录→新VERIFY完成，旧链接/已知旧密码/旧会话均无效；并发两个不同RESET、旧登录快照与改密、旧refresh与logout竞争。所有版本变化必须有事件，敏感载荷不进日志。GREEN＋review后提交 `feat: add account verification and password recovery`。

## Task 8: 本人昵称、可选头像和注册头像接入

**Files:** auth/avatar.ts、account-service.ts、router.ts、repository.ts；worker/test/auth-profile.test.ts、auth-avatar.test.ts；tests/fixtures/auth/*.webp及无害损坏fixtures。
**Interfaces:** `validateAvatarBase64(value:unknown):{base64:string;bytes:Uint8Array}`（同步有界）；accountService提供 `updateDisplayName(identity,name):Promise<AccountProfile>`、`setAvatar(identity,base64OrNull):Promise<AccountProfile>`；`avatarResponse(userId,version,repo):Promise<Response>`。

- [ ] 写失败测试：PENDING/ACTIVE可改本人、禁用/访客不行；相同昵称允许；body user_id越权拒绝；头像输入43692上限、32768字节上限、缺padding/非法字符/多余数据/错尺寸/动画/伪MIME拒绝；删除回默认。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/worker/test/auth-profile.test.ts apps/worker/test/auth-avatar.test.ts apps/worker/test/auth-register.test.ts` RED。
- [ ] Base64只接受标准字母表和正规padding（重新编码等价或等效末尾位校验），先检查长度再解码；检查RIFF长度等于全部文件、WEBP签名、每chunk 8字节头/大小/偶数padding。最多64个chunk、32KiB内迭代，不接受伪装的HTML/SVG/URL。
- [ ] 轻量解析支持VP8有损帧header、VP8L无损头、VP8X扩展canvas及内层图像尺寸；两层都256×256，拒绝动画flag/ANIM/ANMF、多个图像载荷、错边界/重复冲突header；可跳过有界元数据，不做像素解码/EXIF扫描。不是防病毒功能。有效fixtures来自真实浏览器WebP产物，不能只构造magic字节就当“成功照片”。
- [ ] 资料更新事务锁用户并重验identity版本/state，只改白名单。setAvatar写/删一对一row，同时User avatar_version++；失败保持旧图。资料查询用EXISTS，不SELECT图片；回包只profile。把register optional头像校验/写入接入同一事务，并移除Task6临时unsupported分支。
- [ ] public avatar用string userId只读该图；不存在/无图统一默认WebP，不返回Email/status。Content-Type image/webp、nosniff、Cache-Control public,max-age=300；当前版本URL只作换图cache bust，不返回历史图，旧v也仅取当前版本，**不设immutable**。用户头像DEFAULT资源可用同一有效WebP fixture生成静态常量/资源（注明许可，自生成无玩家图）。
- [ ] 跑注册含头像、替换/删除失败回滚、独立读图、Base64不进me/日志测试；GREEN＋review后提交 `feat: add editable account profile and WebP avatars`。此时AUTH-01带头像完整。

## Task 9: Worker入口、配置失败和连接生命周期

**Files:** index.ts、env.ts、auth/router.ts；worker/test/auth-worker-lifecycle.test.ts、auth-routes.test.ts；更新cors/mysql-worker-lifecycle既有测试（仅必要断言）。
**Interfaces:** createApp仍沿用现有签名；registerAuthRoutes内部组装repo/config/services，有可注入AuthRuntime用于测试。

- [ ] 写失败测试：createApp可调用全部16条认证/资料/头像接口，路径不存在JSON404；无MYSQL_URL或核心secret为账号503，公开健康/ASSETS仍既有行为；每次fetch success/error数据库关闭一次。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/worker/test/auth-routes.test.ts apps/worker/test/auth-worker-lifecycle.test.ts apps/worker/test/mysql-worker-lifecycle.test.ts apps/worker/test/cors.test.ts` RED。
- [ ] AppEnv/resolveAppEnv添加下述设置，不将secret必需校验放在全局resolve导致公开路由崩溃：AUTH_ENABLED、AUTH_SITE_URL、AUTH_PASSWORD_KEY_VERSION、AUTH_MAIL_PAYLOAD_KEY_VERSION、4个核心秘密及Task1明确的两组previous版本/secret可选pair、RESEND_API_KEY、MAIL_FROM、MAIL_REPLY_TO、AUTH_MAIL_DAILY_LIMIT/AUTH_MAIL_MONTHLY_LIMIT。文档和example同名；缺限额默认100/3000，不允许负值或超免费套餐默认上限而不记录变更。
- [ ] createApp在ASSETS fallback前无条件注册账号路由（禁用也给明确503）；env enabled才允许行为。保留数据库本次调用作用域与finally.close；不能缓存global pool/跨request socket，不能在已finally.close后再用waitUntil原db发送邮件。
- [ ] 账号请求不套withSearchCache/withCorsHeaders；public search/upload快路径完全原样；静态ASSETS与公开市场不为了显示登录按钮执行服务端身份查询，网站账号鉴权只限账号/受保护API。头像公开读路由与Cookie写路由分别缓存；有Set-Cookie响应始终no-store。普通账号无ctx.waitUntil后台依赖，outbox由独立Cron发送。
- [ ] 统一AuthFailure错误映射、不输出credential/令牌/SQL；auth路由catch不能把500包装为accepted成功。测试日志只含route/requestId/结果，无body/fragment/cookie/头像；CPU仅后续实测，Date.now elapsedMs保持wall标注。GREEN＋review后提交 `feat: integrate independent account routes into Worker`。

## Task 10: 浏览器AuthApi、会话Store和公共导航

**Files:** web/src/auth/types.ts、api.ts、store.ts、nav.ts，修改web/src/nav.ts；web/test/auth-api.test.ts、auth-store.test.ts、auth-nav.test.ts。
**Interfaces:** `AuthApi`依照§2.2每接口一个方法，fetch credentials=same-origin；`AuthStore`提供 `bootstrap():Promise<void>`、`refreshForVisit():Promise<void>`、`setSession(response):void`、`clear():void`、`subscribe(listener):()=>void`。状态是anonymous/loading/pending/active/error/disabled。

- [ ] 写失败测试：首次bootstrap me200保留本人/CSRF到内存并一次refresh；me401为匿名而不是全站故障；503禁用只影响账号入口；三个同时refresh调用只有一次请求，多标签无token每次轮换；logout之后旧me响应不能把UI恢复成已登录。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/web/test/auth-api.test.ts apps/web/test/auth-store.test.ts apps/web/test/auth-nav.test.ts` RED。
- [ ] 实现AuthApi：AuthApi分开缓存anonymousCsrf（GETcsrf）与sessionCsrf（登录/me/refresh响应），mode映射固定按§2.2：匿名写即使已有session也用anonymousCsrf；本人写只用sessionCsrf。GETcsrf不覆盖sessionCsrf，登录不覆盖anonymousCsrf；匿名启动用in-flight合并，只有anonymous mode的AUTH_CSRF_INVALID可重新GETcsrf并重试一次，服务端保证该拒绝发生在业务副作用前。session mode失配可重新查询身份，但绝不自动重放本人写操作；提示会话已更新并由用户重新确认。身份userId改变时清掉旧身份的昵称/密码草稿及头像预览，按新身份重新展示，不能沿用旧稿自动提交。其他错误/网络未知结果不自动重放业务写。所有写带X-CSRF-Token，密码/Base64不进console/analytics/Storage。204不调response.json；错误读现有error envelope。出现session401清store并交页面提示，不能无限retry匿名登录。补跨标签竞争测试：标签页1显示A并编辑资料，标签页2切换登录B后标签页1提交；模拟session CSRF失配并返回B身份，断言无第二次本人写请求，A/B资料均未被误改，旧草稿被清理。
- [ ] Store用共享in-flight Promise合并bootstrap/refresh，状态generation计数拒绝logout/改密前发起的迟到响应；不能通过JS读取HttpOnly Cookie。浏览器内存状态仅用于展示；同一页面/SPA导航复用bootstrap结果和in-flight，刷新文档时可以重新查，不为每个组件/公开API附加me请求。Worker禁止全局Map缓存鉴权结果；单次请求内复用已验证身份可以，不跨请求复用。只memory保留身份/CSRF，不用localStorage/sessionStorage存网站password/token/Base64。可用BroadcastChannel发“请重新查询身份”的事件，无任何秘密；支持失败时无跨标签同步也不能影响server撤销。
- [ ] 真访问触发：页面加载恢复有效登录后refresh；visibility回前台可refresh，合并当次in-flight；长期前台页面通过**用户真实交互后的有界触发**续期（例如距上次成功≥1小时后下一次click/keydown触发），不设持续后台keepalive timer。真实访问必须至少每天生效；网络失败保留可重试状态，不提前宣布新期限。
- [ ] 现有mountSiteNav保留各栏目与/accounts含义，只追加独立登录/账号占位，由auth/nav挂载：匿名登录/注册，pending账号＋待认证提示，active昵称头像＋退出。用textContent，不把昵称插HTML；账号不可用不阻断搜索/监控台/登记簿。
- [ ] 测试已登录打开reset链接仍用匿名CSRF、PENDING申请恢复、内联重新登录后验证切到新sessionCsrf、GETcsrf不覆盖sessionCsrf，以及HTML注入昵称纯文本、菜单移动端和键盘可用、无Storage秘密、同源proxy fetch参数、退出迟到响应；GREEN＋review后提交 `feat: add browser account state and navigation`。

## Task 11: 账号页面、验证恢复交互与令牌防泄露

**Files:** web/src/auth/pages.ts，修改main.ts/styles.css（局部auth前缀）、public/_headers；web/test/auth-pages.test.ts、auth-token-pages.test.ts。
**Interfaces:** `isAuthPage(pathname:string):boolean`；`mountAuthPage(root:HTMLElement,path:string,api:AuthApi,store:AuthStore):()=>void`，返回清理监听函数；页面路径为/register、/login、/verify-email、/forgot-password、/reset-password、/account、/account/password。

- [ ] 写失败测试：必填昵称/密码确认；PENDING资料可改但改密需验证；401账号页引导登录，503有重试；旧/accounts继续调用原mountAccountsPage；认证页不调用initAnalytics且不创建51.la script。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/web/test/auth-pages.test.ts apps/web/test/auth-token-pages.test.ts apps/web/test/accounts-page.test.ts apps/web/test/analytics.test.ts` RED。
- [ ] main先辨别auth路径再初始化analytics；auth页面分支不调用initAnalytics/track，不复用游戏密码Storage；非账号页面沿用原统计。深链走现有ASSETS SPA并加载正确页面，无新前端框架或全站路由重构。
- [ ] 含token页面初始化**先**把fragment读入本页面闭包，再history.replaceState清URL；必要query兼容也须立即清，严禁token进return_to、跳转query、日志/统计/Storage。页面清理时擦除内存引用。刷新后token丢失显示“请重新打开邮件链接”，不装作已验证。
- [ ] /verify-email无登录时在同一页面提供**内联登录表单**，保留内存token；登录成功重验同用户后用户点确认。不要跳到/login导致token丢失，也不能只有打开邮件就自动POST。错账号提供退出/重新登录，隐藏邮箱差异。
- [ ] /reset-password取得匿名CSRF后显示新密码/确认，主动POST后204清所有当前显示会话并提示登录；不能自动登录或active。注册202通用提示＋登录/收信入口；恢复202无存在性提示。渲染§2.3mail_availability日/月额度文案与当地恢复时间；PENDING账号可登录并看到额度原因与重发入口。只按§2.3在可见待验证页有界检查状态，离页清timer，不给全站加轮询；次日重发仅用户点击，不自动注册或验证。改密成功退出，通知失败不误报密码没改。
- [ ] 密码input允许paste/autofill、autocomplete=current-password/new-password；不用原生minlength/maxlength替代code point限制（256个emoji必须可输入）。必填昵称及错误aria-live，submit时禁重复，失败保留可修正输入但成功清password。账号页展示ID/Email/注册/验证，昵称编辑和头像占位；头像完整交Task12。
- [ ] _headers只给上述账号HTML路径配置Cache-Control no-store、Referrer-Policy no-referrer；若SPA fallback使该规则未生效，最小配置run_worker_first账号页面＋专用ASSETS Response头覆盖，并测试真实响应，不靠meta猜测缓存。认证API头另由router设置。测试深链、token无分析、内联登录后仍可确认、手机/键盘。GREEN＋review后提交 `feat: add account authentication and recovery pages`。

## Task 12: 浏览器头像裁剪编辑器与表单集成

**Files:** web/src/auth/avatar-editor.ts、pages.ts、styles.css；web/test/auth-avatar-editor.test.ts、auth-pages.test.ts。
**Interfaces:** `mountAvatarEditor(container,options):{getValue():Promise<string|null>;reset():void;destroy():void}`，返回纯Base64/未选null。注册未选直接省略字段；账号页set/delete分别调用API，不用null串覆盖。

- [ ] 写失败测试：无头像可注册、选择图片后可拖动/缩放正方形、取消不改旧图、输出mime/256尺寸/32KiB限制；上传失败保留旧图和预览；退出页面revokeObjectURL和清监听。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/web/test/auth-avatar-editor.test.ts apps/web/test/auth-pages.test.ts` RED。
- [ ] 输入file accept=image/jpeg,image/png,image/webp，源≤10MiB；由createImageBitmap或HTMLImageElement本地解码，正确方向。用pointer事件＋缩放range控制裁剪，Canvas.drawImage只取选定正方形后输出256×256；keyboard可操作缩放/裁剪调整，移动触控不滚错页面。
- [ ] Canvas.toBlob('image/webp',0.8)，需要时仅浏览器按0.1降低到0.4；仍>32768拒绝/换图。不无限循环，产物mime错误（PNG fallback）明确失败。Base64从blob异步读取并剥data prefix，编码后≤43692；不上传源图、secret或客户端密码摘要。
- [ ] 编辑器异步generation防选A后慢decode覆盖B，取消/离开后不写卸载DOM；释放bitmap/objectURL。昵称保存与头像保存分别提示，头像可删除确认但非复杂身份校验。注册处理好的可选图和其他字段一次提交。
- [ ] jsdom用mock Canvas/Blob只验证控制流；另外在真实浏览器生成至少JPEG带方向/PNG透明/WebP三产物，检查尺寸/字节/MIME、正方形视觉裁剪，过Worker检查并实际PUT/GET。记录桌面/手机viewport、浏览器版本与结果，不以mock压缩证明WebP有效。GREEN＋review后提交 `feat: add client-side avatar cropping`。

## Task 13: 独立邮件Cron、单批清理、Secrets和操作文档

**Files:** auth/jobs.ts、index.ts/env.ts、wrangler.toml、.dev.vars.example、.github/workflows/ci.yml；docs/deployment.md、operations.md、api.md；worker/test/auth-jobs.test.ts。
**Interfaces:** `runAuthJobTick(repo,config,runtime):Promise<{kind:'mail'|'cleanup'|'idle';result:string}>`；`cleanupAuthBatch(now,limit):Promise<number>`。调用拥有数据库并finally关闭。

- [ ] 写失败测试：邮件tick只发一条、发送时不同时执行其他清理/marketjob；无secret/APIkey只暂停自身；租约超时可恢复；过期token/session不能因未清理变有效；旧三个Cron派发原任务不变。
- [ ] 跑 `rtk proxy pnpm exec vitest run apps/worker/test/auth-jobs.test.ts apps/worker/test/auth-worker-lifecycle.test.ts` RED。
- [ ] 默认增加独立 `*/2 * * * *` Cron表达式，scheduled先匹配该表达式并运行AuthJobTick，**不与每分钟snapshotWakeup在同一次event中累加执行**。Cloudflare Free目前是每账户5个Cron，上线前核对账户所有Workers/环境额度；不能假设staging、production各自独立配额。[官方Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [ ] tick先尝试单封邮件；没有可发送任务时只清理**一个表/一种类型**最多50条（清理类别由固定UTC时间slot轮转，不需全局状态），每次总工作一种。过期或attempt_count≥4且lease已过期的邮件由单批清理终结并移除密文；发送结果未知用FAILED＋delivery_unknown原因，UI只说“结果未知/可重新申请”，不能断言绝未发送；不重新生成token。授权table销毁/元数据TTL按Spec；用户和credential永久资料不清。
- [ ] 表清理不踩FK：先outbox/动作再相关已失效session，事件/限流独立；动作元数据删除若outbox FK依赖，使用可空关联/ON DELETE SET NULL或先删对应已终结job，不能批量删除仍待发任务。所有predicate使用expires/nextAt等索引。
- [ ] wrangler vars各environment明确AUTH_ENABLED默认false、可信站点/发信者、key版本/预算；不能把4秘密和Resend key写TOML。local例子仅安全占位，由开发者自己生成真实秘密到ignored .dev.vars。生产4核心secret＋RESEND_API_KEY用GitHubproduction env，经现有标准输入secret put方式；缺值使账号不开启并显式告警，不能覆盖旧有效secret为""。
- [ ] Workflow只编辑配置与检查，main自动发布规则不扩到新开发分支；增加账号配置preflight不影响未启用功能的既有部署。MAIL_REPLY_TO/MAIL_FROM/DNS记录由部署文档指引，无硬编码虚构可用邮箱。秘密轮换文档按Task1同名current/previous pair配置：先保留原key为previous、再以新版本/新secret签发，旧记录按版本继续读；最多保留一个previous。密码旧key不能因时间到了直接删除，需按credentials(key_version,user_id)索引有界核对并通过后续受审迁移或用户改密/恢复升级到current；首版不暗中批量改密码。mail旧key仅在旧版本任务全部终结/过期、密文已清后移除。未完成迁移前不再轮换第三个版本；未知key保留密文到TTL，不猜当前key。线上配置操作需另行授权，本地只写说明与测试。
- [ ] api.md写§2.2、pending权限、CORS/CSRF、avatar/text限制；operations写mailquota/重试/lease/禁用/清理及不打印秘密的诊断；deployment写Resend域名DNS流程、Free原生限制、密钥注入、Cron账户上限、账号开关和回滚保表。测试配置缺失/预算耗尽/任务损坏；GREEN、docs check、review后提交 `feat: configure bounded account background jobs`。
- [ ] 若账户没有新增Cron配额，**仍完成本地代码和其他功能**，上线条件记录“独立认证Cron未配置”。管理人给出调整无用旧Cron或独立VPS调度等具体方案供未来确认，不能擅自停市场任务、买付费或把两任务硬拼10ms。该条件不伪装为生产通过。

## Task 14: 真实MySQL并发、端到端验收和CI强制门禁

**Files:** tests/integration/auth-account-flow.test.ts、auth-account-races.test.ts、tests/helpers/auth-mysql.ts；.github/workflows/ci.yml；补必要worker/web测试。
**Interfaces:** 环境MYSQL_TEST_URL、AUTH_TEST_DB_ALLOW_RESET=1、REQUIRE_AUTH_MYSQL_TESTS=1；CI独立job `verify-auth-mysql`，MySQL8 service仅测试，生产部署needs包含该job。

- [ ] 写并发/整流程失败测试：同Email同时注册、同RESET两请求/两不同RESET、login验旧快照→改密→session插入、refresh/logout-all/停用竞争。给服务层test barrier注入只在测试runtime，不在生产请求暴露调试开关。
- [ ] 按专用DB运行 `rtk proxy pnpm exec vitest run tests/integration/auth-account-flow.test.ts tests/integration/auth-account-races.test.ts --maxWorkers=1 --no-file-parallelism`；三个环境必须先明确配置到专用测试实例。缺MYSQL_TEST_URL在REQUIRE模式应FAIL，这是门禁成功拒绝，不算实现GREEN。
- [ ] 用真实事务提交合成fixtures和两个独立DB/client请求；精确断言数据库行数/版本、获胜一次、败者无会话/密码覆盖、失效Cookie始终401，cleanup顺序/回滚数据保留。不要用setTimeout概率制造race，用barrier固定竞争点，且不能持用户锁后等待另一个也需此锁的barrier导致自造死锁。
- [ ] 流程测试注册→受限登录→验证→正常登录→昵称/头像→续期→改密→恢复→退出，全程fake邮件但真实密文/令牌/MySQL；复用该流程覆盖日额度拒绝→PENDING仍可登录→跨UTC恢复→主动重发→验证，分别确认月额度不显示“明天”、瞬时429不走日额度提示；断言firstID10000与大ID字符串、纯Base64、无秘密回包、停用优先、Avatar查询独立。放合成市场/guestbook/source数据做前后相等核对，不能在游戏监控台读用户本机Storage当网站身份。
- [ ] CI新增独立MySQL8 service，database名lastroweb_auth_test；测试凭据仅临时service、不用production Secrets。配置三个环境并只运行两个新集成suite串行；常规verify job继续原测试。workflow deployment needs=[verify,verify-auth-mysql]，新job失败/skip不能部署。不得修改现有MYSQL_TEST_URL测试为默认真实生产URL。
- [ ] 按§6映射执行全部AC，补mobile/keyboard/CSRF/Token页面真实浏览器证据。修复仅本任务相关失败，保留原公开页面与旧/accountS区分。GREEN＋独立review后提交 `test: enforce account MySQL races and acceptance`。

## Task 15: CPU实测、全量验证和交付

**Files:** scripts/benchmark-auth-cpu.mjs，docs/operations.md/README.md；新docs/superpowers/plans/2026-10-12-ltsd-account-system-validation.md；更新progress。
**Interfaces:** benchmark输出每场景的wall_ms/local_cpu_ms或remote_cpu_ms，证据包含runtime/environment/buildSHA/sampleCount；远端CPU来源不混用elapsed_ms。

- [ ] 写benchmark输入/报告格式测试（node --test或已有Vitest）：没有remote CPU数据时必须输出“production budget UNVERIFIED”，不能根据wall<10或localCPU<10判生产通过；不输出Authorization/Cookie/token/password/Base64。工具不持久保存真实凭据，fixtures全合成。
- [ ] 默认只跑本地worker近似bench：冷/热登录、注册最短/最长Unicode密码、资料/me/refresh、32KiB合法头像与64KiB+1坏请求、改密/恢复/单封邮件/清理50条，比较完整Hono/MySQL成本；使用本地专用DB与fake发信，不能指向生产负载。
- [ ] 真实Free测量是上线门禁：用户未来授权的staging，用合成账户和测试邮箱/可控投递stub（只有测试环境），读取Cloudflare提供的完整invocation CPU，包括init/crypto/driver/路由/jobs；每场景建议≥100个热样本＋≥10冷样本，记录配置、CPU来源、p99/max及不足。不能证明cold isolate的样本标“cold未确认”，不得伪装100%采样；当前5%logs采样不够就记录观测不足，不擅自全量生产日志。
- [ ] 任何新增路径出现≥10ms或资源错误不能验收Free；p99>5或max>8先优化并重新测有变更路径。禁止用slowKDF/图片库、密码移浏览器、global socket、放宽校验或付费偷偷绕过；若驱动最小开销无法达到，完成其他本地功能后报告测量与待架构决策，不能宣称整体上线通过。
- [ ] 跑全量门禁：`rtk proxy pnpm lint`、`typecheck`、`test`、`test:migration`、`test:docs`、`rtk proxy pnpm --filter web build`、专用DB两个新集成suite、`rtk git diff --check`；读输出确认不是“exit0但关键suite skip”。需要wrangler dry-run时先读wrangler技能，使用配置打包干跑，**不部署**。
- [ ] 发全分支review包（implementationBase..HEAD＋任何尚未提交的本功能diff）给独立6.1 Sol high reviewer，附Spec/本计划/测试证据/所有deferred与ruling；修复真实Critical/Important并复审，不靠管理人自称通过。review状态与生产外部条件分别记录；外部条件未满足不构成文档计划缺陷，但功能/安全问题不能挂起当通过。
- [ ] review通过后更新README入口和操作文档、准确勾选完成任务；提交 `docs: record account validation and deployment conditions`。汇报branch/commits/已实现/实测/剩余Secrets/DNS/Cron/CPU条件；不push/merge/deploy、不对生产迁移或发玩家邮件。本地功能完成但生产条件缺失，明确分开，用户无需被反复询问是否继续。

测试点可合并/复用，管理人不得要求每个内部函数或每个验收条目单独增用例；review只要求关键行为有证据，不以覆盖率/用例数量评分。

## 5. 子代理任务派发模板

管理人给每个Luna的brief必须同时带：Spec相关章节、Global Constraints、当前Task全文、前置接口类型、允许修改文件、禁止修改文件、当前branch/baseSHA、具体测试命令、真实DB是否配置、报告路径。只给“按计划写认证”不合格。

```text
你是本地实现子代理，模型由管理人指定为 gpt-6-luna / max。
只执行 Task N，当前 checkout/branch 已由管理人建立，不新建分支/worktree。
先读计划列出的输入/规则。只改允许文件；先复用关键行为测试，缺覆盖时补最少的失败用例→实现→验证；不追求用例数量/100%覆盖。
不dispatch子代理，不自行review其他任务，不push/merge/deploy，不读写生产DB。
接口不确定时向管理人指出具体类型/调用点；不要自行改Spec或密码规则。
完成后写任务报告：文件清单、实际行为、每条测试命令/退出码/是否skip、
自查、尚缺证据、需要管理人裁决的问题。不要将秘密放报告。
管理人负责提交；你只返回修改与证据，不把“做完了”当review通过。
```

Reviewer必须fresh context、只读、不能再spawn。逐任务review同时给Spec合规和代码质量两个结论；管理人评估有理由的分歧并记录。修复由Luna完成，连续重复失败可让管理人缩小brief或用自己的6.1 Sol分析具体根因，再让Luna实施。不要因为某一子代理失败就全仓重写。

## 6. Spec覆盖与验收所有权

| Spec能力/验收 | 主责任务 | 明确证据 |
|---|---|---|
| AUTH-01注册、必填昵称、可选头像；AC-01/02/03/25 | 1/2/6/8/14 | 唯一Email/首ID/大ID/原子注册真实SQL |
| AUTH-02登录；AC-08/09/26 | 1/3/4/14 | 低成本HMAC、版本与状态、未知Email统一失败 |
| AUTH-03退出；AC-10/29 | 4/10/14 | 服务端撤销、滚动30天、并发不续活 |
| AUTH-04验证；AC-04/05/06/07 | 5/7/11/14 | 同用户会话、GET不消费、预注册攻击恢复 |
| AUTH-05/06改密/恢复；AC-11/12/13 | 1/7/11/14 | 5–256/相同新密码允许、一次性/版本竞争 |
| AUTH-07/10资料昵称；AC-21 | 8/10/11 | 本人白名单、重名允许/纯文本、PENDING可编辑 |
| AUTH-08原网站接入；AC-19/20 | 9/10/11/14 | /account不覆盖/accounts，公开CORS/cache保持 |
| AUTH-09安全/资源；AC-15/16/17/18/28 | 1/3/9/13/14/15 | 限流/CSRF/输入/日志、免费完整CPU真实测量 |
| AUTH-11头像；AC-22/23/24 | 8/12/14/15 | 真浏览器WebP、Worker拒坏、Base64与权限 |
| 邮件失败/预算；AC-14/27 | 5/13/14 | outbox密文、stable key、lease/次数/到期和额度 |
| 迁移/回滚/外部条件 | 0/2/13/15 | 新表/索引、保数据、Secrets/DNS/Cron/CPU清单 |

不遗漏Specs的AUTH-01–11与AC-01–29。API路径表、功能类型、实际代码与文档一处改动都同步其所有调用方；更名或破坏兼容不由Luna自行决定。

## 7. 计划review与完成条件

本计划的通过条件：所有功能有任务归属；文件/函数/状态/配置/参数一致；MySQL精度、锁/连接、mail租约、CSRF、匿名响应和CPU边界可实现；测试能失败且能证明关键行为；没有把不存在的库/文件/外部条件伪装成事实。

本次review只审查计划，不代表未来实现代码已通过。review发现问题直接改本文件对应章节，然后复审；最终结论保存同目录 `2026-10-12-ltsd-account-system-plan-review.md`。所有任务checkbox在开发前保持未勾选，未来实施证据写progress/validation，不向Obsidian或计划尾部不断追加聊天记录。
