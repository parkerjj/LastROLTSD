# 配置大厅实施计划

> **For agentic workers:** Use task-scoped implementation and independent code review; steps use checkbox syntax. 用户已经批准完整设计和交互草图，并明确要求开发，不再对同一范围重复请求批准。

**Goal:** 将已确认的大厅与分享交互接入真实 MySQL、账号会话和 KE 编辑器。

**Architecture:** 保留现有个人配置 API，追加可选 sharing 请求字段与返回元数据；共享快照、账号点赞/使用关系和复制回执分别落库，关联写操作同事务提交。大厅独立模块复用站点登录与设计风格，主线程整合路由和验证。

**Tech Stack:** Hono / Cloudflare Worker、MySQL 8 / mysql2、Vite / TypeScript、Vitest / jsdom。

**Spec:** [design.md](design.md)，[ux-notes.md](ux-notes.md)，用户已确认的 [交互原型](prototype/README.md)。

## Global Constraints

- 当前分支 `codex/profile-hall`，用户明确在此分支开发；不另建工作树、不部署、不修改生产数据库。
- 所有功能需网页登录；允许 PENDING_EMAIL，不检查 permission level、邮箱验证或 KE 运行权益。
- 分享码 `ABC-1234`，三个大写字母与四位数字，Web Crypto 随机、唯一约束、8 次碰撞重试。
- checkbox 默认勾选；文案“同时将此配置共享给他人”/“同时更新共享的配置”；说明选填、标题沿用 name；取消只影响本次保存。
- 五份文本原文镜像，保留 NULL/空字符串；复制结果独立且未激活，允许跨职业。
- 一账号一个赞，可取消，禁止自赞；使用人数按账号去重，不计作者；不增加共享条目数量配额。
- 共享更新/恢复保留码与统计；删除源配置同事务撤回；重复复制请求幂等。
- 沿用现有 MySQL 连接、账号、日志与限流，不新增依赖/存储服务，不改变运行授权规则。

## Review Focus

- 并发复制与撤回/更新：副本来自一个完整快照，回滚不留下人数或回执；由 Task 1 的真实 MySQL 测试覆盖。
- 原配置与共享保存任一步失败：两者一起回滚；Task 1 注入失败/真实事务验证。
- 响应丢失的复制重试：同 request_id 返回原副本，同键不同目标拒绝；Task 1 与 Task 2 覆盖。
- 会话失效后重新登录与快速切换过滤：不显示旧账号结果、不让旧响应覆盖新选择；Task 3 DOM 测试覆盖。
- NULL/空职业、Unicode 重名及存储型 HTML：不阻止跨职业复制，不截断标题后缀，不执行 HTML；Task 1 / Task 3 覆盖。

## 文件与接口边界

数据实现负责 `migrations/mysql/019_ke_shared_profiles.sql`、`apps/worker/src/ke/shared-profile-{types,repository,service}.ts`、原 `profile-{repository,service}.ts`，以及数据相关测试。前端实现只修改 `apps/web/src` 和 `apps/web/test`。主线程负责 `apps/worker/src/ke/router.ts`、新 `shared-profile-router.ts`、路由测试、文档与最终验证；互不修改对方负责文件。

固定跨任务接口：

- `ProfileInput.sharing?: ProfileSharingInput`，其中 `{ enabled: boolean; description?: string }`。现有 create/update 函数签名不变；旧请求无 sharing 只保存个人配置。
- `ProfileRow.sharing?: ProfileSharingMetadata | null`；元数据 `{ id: number; share_code: string; status: 'PUBLISHED' | 'WITHDRAWN'; updated_at: number; description?: string }`。列表可以省略 description，详情返回完整说明。
- `SharedProfileSummary` 为设计 §6.2 的摘要字段；`SharedProfileDetail` 追加与个人配置同名的五份文本列（control 列可为 NULL），不使用另一套文件字段命名。
- `createSharedProfileRepository(database: MysqlDatabase): SharedProfileRepository`。
- `createSharedProfileService(repository: SharedProfileRepository, now?: () => number): SharedProfileService`。
- service：`list(userId: string, query: { sort: 'newest'|'uses'|'likes'; page: number; job_id?: number })` → `{ items, page, page_size: 20, total }`；`getById(userId, id)` / `getByCode(userId, code)` → detail；`setLike(userId,id,liked)` → `{ liked, like_count }`；`copy(userId,id,{aid,cid,nid,request_id})` → `{profile_id,name,use_count,duplicate}`；`withdraw(userId,sourceProfileId)` → void。
- 大厅 URL `/ke/hall`，编辑定位 `/ke?aid=<n>&cid=<n>&nid=<n>&profile=<id>`；分享 URL `/ke/hall?code=ABC-1234`。

## Task 1: 数据与事务实现

**Files:** 上述 migration 与数据实现文件；`apps/worker/test/shared-profile.test.ts`、`shared-profile-schema.test.ts`；`tests/integration/shared-profile-mysql.test.ts`。

**Interfaces:** 生产上述共享 service / types；扩展个人 profile 保存、读取与删除，保持既有签名。

- [x] 先写回归测试并运行确认红灯：快照保真、取消不更新、更新/恢复保留码、单源唯一、20 套与重名、点赞/人数按账号、复制幂等、原配置删除撤回。
- [x] 新增四表 migration 与摘要排序索引、FK/唯一约束；不修改旧 migration 或回填公开数据。
- [x] 实现 repository/service，组合单连接事务，账号→角色/个人配置→共享条目顺序加锁，不嵌套事务。保持 NULL/空值、明确复制回执冲突，使用数据库实际变化更新计数。
- [x] 个人 profile 保存与共享更新同事务；公开元数据不暴露角色标识；服务端读取职业，角色解绑/记录缺失时保存 NULL 快照。
- [x] 在一次性本地 MySQL 测试库验证迁移、冲突、回滚、并发同请求、撤回/复制、更新/复制；不触碰生产连接。
- [x] 运行相关数据测试；最终测试结果见本计划“最终验证”。

## Task 2: 会话鉴权与路由整合

**Files:** 修改 `apps/worker/src/ke/router.ts`；创建 `shared-profile-router.ts`；创建 `apps/worker/test/shared-profile-routes.test.ts`，必要时调整现有 `ke-routes.test.ts` 夹具。

**Interfaces:** 消费 Task 1 service；HTTP 路径/JSON 完全遵循设计 §6。共享路由由 registerKeRoutes 注册，共用已有 setup 与 request 生命周期，不增加 DB 全局连接。

- [x] 先写测试并确认红灯：401/PENDING_EMAIL/不同等级、Origin、错误 JSON、非法排序/页码/职业、分享码归一化、204 兼容、复制 201/200、私有响应 no-store。
- [x] 注册列表/码/详情/点赞/复制/撤回路由；code 路径早于 :id。固定参数白名单，解析非负职业与安全整数、分享请求字段。
- [x] 仅发布/更新条件新增写请求 Origin/按账号频率保护，旧无 sharing 保存保持兼容；大厅所有写都校验 Origin。
- [x] 在个人列表的 map 中保留 sharing 元数据；POST/PUT 响应形状不变。所有数据库与 JSON 异常沿用现有安全 envelope。
- [x] 路由与既有 KE 路由单元/真实 MySQL 集成、typecheck 均通过。

## Task 3: 编辑器、大厅与站点导航

**Files:** 新建 `apps/web/src/profile-hall-{api,page}.ts`、`profile-sharing.ts`、`profile-hall.css`；修改 `ke-page.ts`、`main.ts`、相关导航（按现有实现定位）；新建/扩展对应 `apps/web/test` 测试。

**Interfaces:** 消费 §6 API 和上面的 metadata/detail；路由与定位参数固定。复用现有 AuthApi / 登录浮层，不要求邮箱验证，兼容站点会话失效事件。

- [x] 先写 DOM/API 失败测试：默认两种 checkbox 文案，说明可空；关闭只保存个人；异步切换错误防护；匿名不泄露列表；复制目标与请求 UUID；XSS 纯文本。
- [x] 从已确认草图移植真实大厅，使用真实 API，分页每页20、按职业/人数/点赞/时间查找。
- [x] 详情折叠五文件；角色选择、无角色/满额/重名错误可理解；复制重试复用 UUID，成功后定位现有编辑器，不自动激活或再分享。
- [x] 用聚焦小模块将分享区域接入完整编辑器，默认勾选、标题沿用 name、说明保存、分享码/撤回/恢复明确；保存时发 sharing 对象，取消勾选 enabled=false；保留未保存防护。
- [x] 沿用站点 topbar/登录/字体配色，增加大厅入口；真实 UI 在 1440/768/390 检查并完成跨账号复制、计数、点赞/取消操作。
- [x] 运行相关 web 测试、定向 ESLint 与 build。

## Task 4: 整体验证、文档与独立审阅

**Files:** `docs/api.md`、`docs/mysql-migration.md`、`docs/operations.md`、本目录状态/验证记录；必要的整合修正。

- [x] 更新 API/迁移顺序/回滚说明与运行频率保护值；设计、需求与原型文档同步实际状态。
- [x] 运行相关真实 MySQL 测试和现有 KE MySQL 集成；`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm test:docs`、`pnpm test:migration`、`git diff --check`。本次 `pnpm lint` 还扫描本地工具目录副本与 Wrangler 临时 bundle，产生 227 个环境文件错误；全部变更的应用和测试源文件单独 ESLint 通过。
- [x] 在真实页面检查会话、详情/分享码、跨账号跨职业复制、唯一人数、点赞/取消、作者撤回入口与更新时间；跨账号账号级流程验证记录见 [UX 验收记录](ux-notes.md)。
- [x] 独立审阅完整实现，优先关注账号隔离、事务竞态与客户端重试；上轮指出的 nullable job snapshot 与大厅作者控制问题已补测试修复；最终审阅未发现 Critical/Important/Minor 问题。
- [x] 保留 `codex/profile-hall` 分支，完成审阅后提交可审阅结果，不自动合并、推送或部署。

## 执行记录

2026-10-23：用户已批准设计、草图并授权开发；分支从 `codex/ke-profile-hall` 改名为 `codex/profile-hall`。计划已对照规格逐项检查；数据层/路由/前端接口如上，文件范围分离。使用原 checkout 的用户指定功能分支，不另建 worktree。实现使用有界分工与独立审阅；claude-mem work_state 为任务状态的唯一清单，本文件步骤用于恢复接口与验证依据。

## 最终验证

- 本地 MySQL 8：`shared-profile-mysql.test.ts` 5/5、`shared-profile-routes-mysql.test.ts` 2/2、既有 `ke-mysql.test.ts` 5/5；运行前通过 `mysql-test.env` 配置到一次性 `_test` schema，未连接生产库。
- 单元测试：`pnpm test` 861 passed、38 skipped；typecheck、build、docs 58 assertions、migration 检查 5/5 和 `git diff --check` 通过。
- lint：全仓命令受 ignored 工具目录副本和本地 Wrangler 临时 bundle 中的 227 个错误阻塞；所有本次变更的应用/测试源文件单独 ESLint 通过。
- 浏览器：本地真实 Worker + MySQL 登录页面在 1440/768/390 CSS px 下无横向溢出；跨账号账号级复制与计数验收见 [UX 验收记录](ux-notes.md)。
- 独立审阅：复核全部已修改与新增实现，无 Critical、Important、Minor 问题；确认来源归属、分享码碰撞处理、纯文本渲染和锁/事务边界符合设计。
- 功能已提交到 `codex/profile-hall`；不自动合并、推送、部署，也不应用生产 migration。
