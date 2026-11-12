# 市场数据 30 天清理实施计划

> **For agentic workers:** 使用 executing-plans 在当前会话逐项实施。

**Goal:** 市场历史保留 30 天，通过现有 Worker Cron 分批清理，避免 MySQL 无界增长。

**Architecture:** 历史事件继续走 `runRetention`；新增源锁内的市场状态清理，按子表到父表顺序删除。每个源保存清理水位，旧上传不能在回执删除后重新创建数据。

**Tech Stack:** TypeScript、MySQL 8、Cloudflare Workers、Vitest。

**Spec:** 用户在本会话批准：历史事件 30 天、按最后观测清理失效店铺/商品、保留当前有效状态及处理中快照、终态快照/回执 30 天、分批并记录数量。生产部署及生产即时删除不在本轮执行范围。

## Global Constraints

- 不修改账号、订单、权益及其保留策略。
- 当前 active 店铺/商品不按创建时间删除；有近期事件/快照引用的数据保留。
- 源锁与 full/delta 上传共用，清理和上传不可并发修改同一源。
- 最新 full 凭据每源保留一份；处理中快照及其源状态跳过清理。
- 清理水位前上传返回 422、`snapshot_expired`、`action=new_snapshot`。
- 使用当前工作目录；实现阶段不直接删除生产数据。用户在实现完成后授权提交并依次推送 Development、main，由现有 CI 先执行 migration 再发布 Worker。

## Review Focus

- 30 天边界严格小于，边界当天不删。
- 旧回执删除后重放不会复活旧店铺。
- 店铺创建很早但仍有近期观测/在售商品时保留。
- 子表分批清理，避免父表级联放大；处理中快照不得被清理。
- Cron 失败仍释放 MySQL 连接，日志只含数量/截止时间。

### Task 1: 30 天历史与分批循环

**Files:** `apps/worker/src/services/retention.ts`、`apps/worker/test/retention.test.ts`。

- [x] 写失败测试：30 天截止、满批继续、不满批停止、达到批数上限停止。
- [x] 运行定向测试确认失败。
- [x] 默认保留 30 天，历史/销量/留言限流表分别在有界循环内清理。
- [x] 运行定向测试确认通过。

### Task 2: MySQL 市场实体与回执清理

**Files:** 新增 `apps/worker/src/db/market-retention.ts`、`migrations/mysql/031_market_retention.sql`、`tests/integration/market-retention-mysql.test.ts`；修改 `snapshot-repository.ts`、`upload-handler.ts`、`ingestion.ts`。

- [x] 使用连接私有临时表写失败测试：旧/新/活跃/处理中、子表完整性、保留最新 full、清理水位及旧上传拒绝。
- [x] 运行失败测试并实现最小清理：源锁、水位、有限行数、子表先删。
- [x] 增量 migration 加水位及按时间清理所需索引；不改历史 migration。
- [x] 验证 full/delta 在源锁内拒绝早于清理水位的请求。
- [x] 运行 MySQL 与定向单元测试。

### Task 3: Cron、日志与运行说明

**Files:** `apps/worker/src/index.ts`、`wrangler.toml`、`docs/operations.md`、`docs/api.md`。

- [x] 复用原 retention trigger，改为 UTC 每 6 小时，输出各表删除计数。
- [x] 写 Worker 生命周期测试，验证成功/失败均关闭数据库。
- [x] 更新保留策略、最大工作量、最新凭据例外及 migration 部署顺序。
- [x] 执行 typecheck、lint、文档与 migration 检查、Vitest；独立 review 后修正问题。

发布按用户后续明确授权执行：LTSD 先推送 Development，再推送 main；OpenKore 推送 master。

## 验证记录

- OpenKore 插件完整 13 组通过，包含 64/65 分片、874 店、Spool 恢复/FIFO 和过期码恢复。
- LTSD 全仓 Vitest 1690 项通过；MySQL 专项 13 项在独立 MySQL 8.4 的临时表及真实外键模式均通过。
- TypeScript、ESLint、文档、migration 检查、Wrangler production dry-run 和 diff-check 通过。
- 实现阶段未提交、推送、部署或执行生产 migration/持久数据删除；后续发布使用用户授权的分支顺序及既有 CI。
