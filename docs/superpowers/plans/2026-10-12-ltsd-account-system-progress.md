# SDD ledger — plan: docs/superpowers/plans/2026-10-12-ltsd-account-system-plan.md

# LTSD账号系统实施进度

## 基线
- 当前分支：feat/ltsd-account-system（从Development创建，无worktree）。
- implementationBase：8a2155fcdd84d30193070c1bbca0defeeb28fbd7。
- 预先修改：README.md；未跟踪：Spec、plan、plan-review、development-prompt。本功能文档，保留原文；不stash/reset/覆盖。
- Node v24.21.0 / pnpm 12.4.2。迁移最高008，009未占用；规则只有根agent.md，无更近子规则。
- 初次六个基线检查exit1：exFAT不支持pnpm executable symlink，未执行产品检查。环境变量pnpm_config_prefer_symlinked_executables=false安装exit0，不改.npmrc/lock。重跑完成，实际结果见Task0实际基线。
- MYSQL_TEST_URL/MYSQL_URL环境未设置；不读取生产连接作为测试目标。

## 执行裁决
- Ruling: 本次明确新分支/MySQL规则覆盖agent.md历史catalog必须main及D1描述；按当前代码执行 — 避免改变架构及误部署 — 若错需分支/兼容性返工。
- Ruling: 用户已审阅计划直接执行，技能默认worktree、子代理提交、升级实现模型和Obsidian写回不适用；管理人提交、仅Luna实施、docs永久记录 — 本次明确授权 — 若错需重新组织执行，无外部副作用。
- Ruling: 本地exFAT安装用pnpm环境变量关闭可执行符号链接，保持checkout及锁文件 — 已复现根因且安装成功 — 仅本地运行参数，不影响CI。

## 任务账本
| Task | 状态 | 提交范围 | 验证 / skip | review |
|---|---|---|---|---|
| 0 | complete | 本文档基线提交 | 基线见下，真实DB skip | 独立6.1-sol/high Spec PASS / quality PASS，无Critical/Important |
| 1 | 未开始 | — | — | — |
| 2 | 未开始 | — | — | — |
| 3 | 未开始 | — | — | — |
| 4 | 未开始 | — | — | — |
| 5 | 未开始 | — | — | — |
| 6 | 未开始 | — | — | — |
| 7 | 未开始 | — | — | — |
| 8 | 未开始 | — | — | — |
| 9 | 未开始 | — | — | — |
| 10 | 未开始 | — | — | — |
| 11 | 未开始 | — | — | — |
| 12 | 未开始 | — | — | — |
| 13 | 未开始 | — | — | — |
| 14 | 未开始 | — | — | — |
| 15 | 未开始 | — | — | — |

## 已审计划前置核对
复用已有PASS review，不重做通用计划；补核查当前接口与文件归属。

| Task | 内部一致性核查 |
|---|---|
| 0 | 分支/基线/账本纯文档，用户修改保留 |
| 1 | types/config/crypto/input契约明确；AppEnv字符串解析Task9接入 |
| 2 | 八表/CAST ID/单连接Tx与后续事务一致 |
| 3 | 固定匿名/session CSRF分类与Task10一致 |
| 4 | 30天不换token；锁后时间与Task7竞争一致 |
| 5 | HTTP前次数/预算持久，迟到quota绑定原bucket |
| 6 | 注册原子outbox，头像明确暂待Task8接入 |
| 7 | 用户锁优先/凭据版本/同用户确认 |
| 8 | 注册头像补齐，独立公开读取不泄露资料 |
| 9 | 入口晚于服务完成，公开route不鉴权 |
| 10 | 匿名可重试一次/session不可重放，清身份草稿 |
| 11 | 令牌闭包+URL清理，认证页禁analytics |
| 12 | 浏览器真编码另验，Worker仅有界检查 |
| 13 | 独立Cron与市场不同调用，配置默认关闭 |
| 14 | 专用MySQL REQUIRE，CI阻断skip |
| 15 | 本地验证与真实Free预算分别报告 |

| 任务间共享文件/接口 | 生产者 → 消费者 / 检查结果 |
|---|---|
| 1/2 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/3 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/4 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/5 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/6 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/7 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/8 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/9 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/10 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/11 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/12 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/13 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 1/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 2/3 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 2/4 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 2/5 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 2/6 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 2/7 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 2/8 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 2/9 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 2/10 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 2/11 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 2/12 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 2/13 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 2/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 2/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 3/4 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 3/5 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 3/6 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 3/7 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 3/8 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 3/9 | types/config/runtime；Task1契约后续消费，各自范围不同时改；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 3/10 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 3/11 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 3/12 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 3/13 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 3/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 3/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 4/5 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 4/6 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 4/7 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 4/8 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 4/9 | types/config/runtime；Task1契约后续消费，各自范围不同时改；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 4/10 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 4/11 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 4/12 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 4/13 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 4/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 4/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 5/6 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 5/7 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 5/8 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 5/9 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 5/10 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 5/11 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 5/12 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 5/13 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 5/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 5/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 6/7 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 6/8 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 6/9 | types/config/runtime；Task1契约后续消费，各自范围不同时改；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 6/10 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 6/11 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 6/12 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 6/13 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 6/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 6/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 7/8 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 7/9 | types/config/runtime；Task1契约后续消费，各自范围不同时改；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 7/10 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 7/11 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 7/12 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 7/13 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 7/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 7/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 8/9 | types/config/runtime；Task1契约后续消费，各自范围不同时改；router：安全入口→各service→index集成；按Task顺序，无当前发现矛盾 |
| 8/10 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 8/11 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 8/12 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 8/13 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 8/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；按Task顺序，无当前发现矛盾 |
| 8/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 9/10 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 9/11 | types/config/runtime；Task1契约后续消费，各自范围不同时改；index/env：账号注册→HTML头→Cron生命周期；按Task顺序，无当前发现矛盾 |
| 9/12 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 9/13 | types/config/runtime；Task1契约后续消费，各自范围不同时改；index/env：账号注册→HTML头→Cron生命周期；按Task顺序，无当前发现矛盾 |
| 9/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 9/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 10/11 | types/config/runtime；Task1契约后续消费，各自范围不同时改；store/api/pages/styles：客户端契约→页面→头像集成；按Task顺序，无当前发现矛盾 |
| 10/12 | types/config/runtime；Task1契约后续消费，各自范围不同时改；store/api/pages/styles：客户端契约→页面→头像集成；按Task顺序，无当前发现矛盾 |
| 10/13 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 10/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 10/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 11/12 | types/config/runtime；Task1契约后续消费，各自范围不同时改；store/api/pages/styles：客户端契约→页面→头像集成；按Task顺序，无当前发现矛盾 |
| 11/13 | types/config/runtime；Task1契约后续消费，各自范围不同时改；index/env：账号注册→HTML头→Cron生命周期；按Task顺序，无当前发现矛盾 |
| 11/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 11/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 12/13 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 12/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 12/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；按Task顺序，无当前发现矛盾 |
| 13/14 | types/config/runtime；Task1契约后续消费，各自范围不同时改；repository：基础Tx后追加rate/mail/jobs，锁序固定；workflow/docs：配置→MySQL门禁→最终证据；按Task顺序，无当前发现矛盾 |
| 13/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；workflow/docs：配置→MySQL门禁→最终证据；按Task顺序，无当前发现矛盾 |
| 14/15 | types/config/runtime；Task1契约后续消费，各自范围不同时改；workflow/docs：配置→MySQL门禁→最终证据；按Task顺序，无当前发现矛盾 |

## 待生产条件
账号开关默认关闭；远端Secrets/邮件账户域名DNS及测试投递/Cron账户总配额/真实Free完整调用cpuTime，全部待用户未来授权验证，不以本地mock或wall时间冒充。

## Task 0实际基线
- pnpm install --frozen-lockfile（本地环境变量关闭executable symlink）：exit0。
- pnpm lint：exit1，366 errors，全部来自既有ignored .generated/mysql-lock-fix/index.js；尚未改产品代码。
- pnpm typecheck：exit0。
- pnpm test：exit0，71 files passed/3 skipped，419 passed/8 skipped；真实MySQL未配置，skip不能当集成通过。
- pnpm test:migration：exit0，5 passed/0 skipped。
- pnpm test:docs：exit0，58 assertions。
- pnpm --filter web build：exit0。
- 日志：/tmp/ltsd-baseline-{lint,typecheck,test,test:migration,test:docs,build}.log。

- 基线lint根因：既有ignored .generated/mysql-lock-fix/index.js，被eslint默认扫描；不擅自删除或修复用户产物。补充源码检查 eslint . --ignore-pattern .generated/** --ignore-pattern .superpowers/**，exit0。

- 排除既有.generated及本计划scratch后源码eslint exit0；git diff --check exit0。Task1配置接口：导出AuthBindings，与AppEnv交叉类型输入，Task9才接全局解析，公开页面不受账号secret缺失影响。

- 真实DB前置：环境URL未设置，Docker Desktop socket不存在，default daemon socket当前用户无权限；不能运行真实MySQL验收。正在探查无特权专用本地MySQL8.4.5，不使用生产连接。

Task 0: complete（基线文档提交，独立preflight review clean）。
Task 1: 即将派发fresh Luna max；管理人保留提交职责。
