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
| 0 | complete | 8a2155f..f22aaa9 | 基线见下，真实DB skip | 独立6.1-sol/high Spec PASS / quality PASS，无Critical/Important |
| 1 | complete | f22aaa9..3b18249 | 18pass0skip/typecheck/targeted lint；见报告 | 初审1 Important，fix1复审Spec/quality Approve |
| 2 | complete | 3b18249..2c26a92 | 7unit/1真实MySQL，均0skip；migration/typecheck/lint exit0 | 初审1Important/2Minor，fix1全部ADDRESSED；Spec/quality Approve |
| 3 | complete | 2c26a92..8e16202 | 12unit/1真实MySQL，0skip；type/lint；fix无SQL重跑 | 独立初审PASS；管理人补验收fix1 fresh复审PASS |
| 4 | complete | 8e16202..e0fdc21 | 22focused/2真MySQL0skip/type/lint，fault模拟 | 初审经补查改1Important，fix1复审PASS |
| 5 | complete | base e0fdc21；本次feature提交 | 39focused/3REQUIRE MySQL，0skip/type/lint | 初审1Important，fix1 fresh Spec PASS/quality APPROVE |
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

Task 1 implementer：/root/task1_implement，显式gpt-6-luna/max fresh context；brief/report见该计划scratch目录。

## 本地真实MySQL测试环境
- 官方archive下载MySQL8.4.5 minimal，当前用户启动独立daemon，bind127.0.0.1:13306；专用lastroweb_auth_test，独立临时随机测试凭据，不使用VPS/生产URL。
- 版本查询8.4.5；未迁移任何生产数据。运行包装器 .superpowers/sdd/2026-10-12-ltsd-account-system-plan/with-test-env.mjs 只向child环境注入MYSQL_TEST_URL、AUTH_TEST_DB_ALLOW_RESET=1、REQUIRE_AUTH_MYSQL_TESTS=1，URL不打印。
- 后续schema及竞争测试使用此专用实例，尚未声称通过。

- 技能资料检索：Cloudflare官方Workers best practices/limits，确认HTTP与Cron Free完整CPU10ms、每账户Cron5；Resend官方errors确认daily/monthly/rate_limit分类，日额度UTC午夜恢复。参考 https://developers.cloudflare.com/workers/platform/limits/ 与 https://resend.com/docs/api-reference/errors 。最新Workers types 5.20261012.1仅在本地cache核查，不升级项目依赖。

Ruling: Task1文本明确previous邮件key解密验收，虽接口列表未列AES helper，仍在crypto.ts实现最小sealMailPayload/openMailPayload以闭合该要求；模板/HTTP/outbox留Task5 — 避免伪测key映射充当解密证据，后续复用 — 若错仅需重构内部helper，无公开契约变化。固定UTF8正文≤8192、AES-GCM随机12-byte IV，AAD=UTF8(JSON.stringify([mailId,purpose]))；sealed字段payloadCiphertext/payloadIv/payloadKeyVersion，current写入、严格按版本读取。

Task1已报告17pass0skip/typecheck/targeted ESLint/diff-check exit0，独立task1_review审查中；完整报告与diff在该计划scratch。Task2允许对types.ts的mail行占位作必要字段补齐，不扩大原语行为，避免重复互不兼容同名契约。

Task1 review Request Changes：Important: validatePassword允许孤立UTF16 surrogate，但TextEncoder静默改为U+FFFD，不同输入可验证同一凭据。reviewer已运行createPasswordMaterial/verifyPassword复现 originalMatches/differentSurrogateMatches/replacementCharacterMatches均true。位置crypto.ts:73,input.ts:68。
Ruling: 拒绝孤立surrogate这类非良构Unicode字符串，再按有效Unicode原样UTF8编码；不改HMAC规定message或加密码复杂度 — 解决已复现输入碰撞，合法emoji/空格/U+FFFD仍可用 — 若解释错误需修订非法编码错误契约，但不影响正常用户密码。
Task1 fix round1：原Luna修复与focused验证，待复审。

Task1 fix round1 evidence：18pass/0skip、typecheck、input/test targeted lint及diff-check exit0；原Important非良构UTF16碰撞已补回归并拒绝。独立fresh task1_fix_review复审中。

Task 1: complete（feat: add account contracts and native crypto；18pass0skip；独立review原Important已解决，fix round1 clean）。
Task 2: 开始DDL/repository/专用MySQL验证，依赖Task1已通过。

Task1 commit：3b1824906bbe93623344a5447df835fa2f0cf57e。Task2 implementer /root/task2_implement，显式gpt-6-luna/max fresh context。

Ruling: Task2提前交付真实只读mail availability，并为createAuthRepository增加兼容的可选日/月budget options；公开provider/budget使用固定32-byte零键，个人标识仍HMAC — Task4先于Task5却依赖额度、Task9可配置预算不能与读取漂移，固定公开键避免rate秘密轮换重置整站额度 — 若错只需内部接口/范围适配，未改变公开响应或鉴权。

## 2026-10-13恢复记录
- Task2原Luna因usage limit terminal error停止，无最终报告/commit/review；保留所有源码改动。
- 管理人22:03:59 UTC（Europe/Tallinn 01:03:59）查询ordinaryUsageAllowed=true、primary used0%，恢复原代理，不换模型、不购买额度/重置credits。
- Task2 schema验收需按计划从空专用_test库运行全部迁移；当前helper先runner后TRUNCATE+ALTER会掩盖DDL首ID错误，要求修正为 guarded专用测试schema清空→runner001–009→首插自然10000。不改009为迁就元数据NULL。

Task2独立review Request Changes，1Important digest owner未绑定已锁user；2Minor 写入阶段覆盖不全/存在性读取ID。当前任务三项一并最小修复，不带未解决load-bearing进入Task3/4。fix round1交原Luna。

Ruling: Task4 authenticate返回请求内含sessionToken的内部身份子类型，refresh用原Cookie值重发；Repo基础identity保持摘要 — 原推荐refresh(identity)仅有摘要无法生成同值Cookie，明确请求内数据解决不轮换要求 — 若错需内部签名适配；不得改变JSON/SQL原文不落库规则。

Task2 fix round1：Repository owner锁谓词/digest归属记录/写阶段守卫/SELECT1已修；schema+repository7pass0skip/typecheck/targeted lint/diff-check exit0；真实MySQL8.4.5从空库001–009全applied，1pass0skip。scoped复审待结论。

Task 2: complete（feat: add MySQL account schema and repository；真实MySQL8.4.5/001–009全applied/自然ID10000/大ID/唯一/rollback证据；review fix1 clean）。

Ruling: Task3允许repository.ts新增共享限流/冷却操作，补原Files漏项 — rate-limit需多实例MySQL事务且SQL必须集中repository，Task2基础接口尚无该操作 — 若错仅多一个任务归属调整，无公开API/数据格式变化。

Task2 commit2c26a92f479b10a899558ca11eddf8960e419635。Task3单个fresh Luna，scope/clock/guard前置见brief。

Task3过程证据：指定unit9pass0skip；真库第一次测试期望混淆60s/3600s，修正断言后REQUIRE MySQL8.4.5单流程1pass0skip。等待最终报告与独立review，尚未提交Task3。GETcsrf无DB，非法UTF8严格拒绝已明确。

Task3独立review PASS，报告措辞Minor需收窄为锁后时钟跨桶；管理人实际HTTP补验收：error.request_id不存在、runtime.now=1000被忽略。补1Important/1Minor，交Luna fix1，未提交。
Ruling: CSRF issue/assert在原四参数后增加可选now回调（默认Date.now），router转发AuthRuntime.now；保持原调用兼容及wire格式 — 所有账号时间可注入，避免GETcsrf无视受控时钟 — 若错仅内部签名调整，无cookie/权限语义变化。

Ruling: Task4使readIdentity的显式JOIN同时返回expiresAt（内部LiveAuthIdentity子类型）；authenticate再携带仅请求内sessionToken形成AuthenticatedSessionIdentity，me/refresh复用已查期限 — 原最小AuthIdentity没有expires_at且只有摘要，无法在不再查同一session/重设随机值的前提返回期限与Cookie — 若错需内部类型适配，公开wire仍expires_at，SQL仅新增显式期限列而不读图片。

Task 3: complete（feat: add bounded account request security；12unit/1 REQUIRE MySQL均0skip；errorEnvelope/runtimeClock/报告Minor已修复，fix1复审PASS）。

Task3 commit8e16202e50bdd2bc9b93513df3bbad52bf2be17b。Task4 fresh Luna max，仅五个会话接口，live expiry/request Cookie接口已明确。

Ruling: 无有效会话POST logout仍强制可信Origin，缺失/跨源403；仅免session CSRF，不采用GET的optional Origin — plan写操作缺Origin失败关闭、幂等logout例外只是不授权限 — 若错仅非浏览器需补可信Origin，不改合法浏览器退出行为。

Task4初审PASS因管理人补传漏掉Spec§10的审计要求后被reviewer修正为Spec FAIL/quality REQUEST CHANGES；1Important当前login/logout/logoutAll无持久security event。fix1交原Luna，三现有状态事务补appendEvent并证明失败回滚、幂等不重复。不新增权限/API，不依赖后续route metric。

Task4 fix1：三成功状态事务内append security events，当前logout仅实际revoke；audit故障不发/清Cookie并模拟事务rollback。22focused/type/lint/diff exit0；REQUIRE MySQL8.4.5 2pass0skip、LOGIN/LOGOUT_ALL事件实际持久。audit故障是模拟，未真实DB失败注入；scoped复审待结论。

Task 4: complete（feat: add rolling account sessions；22focused/2REQUIRE MySQL0skip；audit fix1独立review PASS）。

Task4 commit e0fdc217673d31710cc685efab8a53a767a2143c。Task5开始，fresh Luna/max 单写代理。

Ruling: 缺sender时密文保存投递intent，首次HTTP前按lease及attempt_count=0 CAS冻结完整body到现有sealed字段，随后同job永远复用body/key；无sender/APIkey仅暂停保留密文 — 排队通知不得回滚密码变更且供应商幂等要求完整body一致 — 若错需内部payload契约调整，不新增schema或虚构邮箱。

Task5前置接口补齐：同意可选AuthConfig.mailDelivery: MailDeliveryConfig={apiKey:string|null;from:string|null;replyTo:string|null}，缺项暂停投递而不破坏core login；prepare动作输入由调用方传精确expiresAt，通知无token默认24h。理由是原Task仅函数名未定义shape，Task6/7消费最终导出契约；无公开wire/数据库schema变化。

Task5 RED（代理报告）：auth-mail.test.ts指定Vitest exit1，新增mail模块缺失；预期模板/官方fragment链接/昵称转义/通知无token及24h行为，未声称行为实现通过。

Task5阶段证据（代理报告，待管理人核验）：tsc-b exit0；mail/repository/session/security共33pass0skip。唯一专用MySQL流程验证进行中，未提交/未review。

Task5真库首次跨日断言失败根因：fixture Date.UTC秒参数错误使用59_000，boundary实际落入queryNow同一UTC日；管理人读测试确认，并指出oldPause须按attempt.dayBucketStart查、日边界断言须从bucket起点算。Luna修正测试并移除诊断，无修改正确产品逻辑迁就错误期望；待GREEN证据。

Task5管理人补查：409 concurrent_idempotent_requests须有限同key/body重试；invalid_idempotent_request永久失败。401/403按计划配置暂停，管理人曾建议5min后有限HTTP重试但当即撤回：复查配置不等于向未修复凭据持续发HTTP；允许原任务暂停到TTL，配置恢复后主动新动作，或代理先提出无需新schema的配置变化条件恢复。不为此扩架构。

Task5局部验证代理报告：真库按name筛选1pass2skip（非全suite绿色），含旧lease quota与4次crash；focused单测39pass0skip。后续accepted-before-finish测试类型错误已修，待编译及最后完整REQUIRE flow suite0skip；管理人明确不接受将筛选skip描述为全门禁通过，不继续扩用例。

Task5最终代理报告：39focusedpass0skip/typecheck/targetedlint/diffcheck exit0；完整REQUIRE MySQL8.4.5 auth-account-flow3pass0skip（先前name筛选1pass2skip单独保留），所有外部fetch为fake。已生成Task5六文件diff并派fresh task5_review（6.1-sol/high），尚未提交。401/403暂停到TTL、配置恢复需主动新动作限制交review核对，不自动重复HTTP。

Task5 independent task5_review：Spec FAIL/quality REQUEST CHANGES，1Important：过期/耗尽任务终结后return null让ready积压饥饿（repo811/837/841），只读复现31次claim空、ready查询0次。管理人已源码确认，接受finding；预算/lease/稳定body/迟到周期无新阻塞。fix1交原Luna，最小有界领取修复，不进入Task6。

Ruling: 预算锁等待跨UTC周期允许同短事务仅提交旧bucket零值行初始化与本lease CAS释放后返回stale，而不强制SQL rollback — reviewer核对该分支在次数/预算递增前，零值行等价缺行、不覆盖已有计数/暂停/密文/历史，不发HTTP且下一tick完整再校验 — 若错仅产生额外可清理零值行；不放宽发送额度或授权。独立补核查不新增Spec/质量缺陷，仍须修领取饥饿Important。

Task5 fix1代理证据：真实RED复现过期任务后有效lateJob未领取；GREEN完整REQUIRE MySQL3pass0skip，过期+有效同tick领取、耗尽priority0不挡有效priority1；39focused/type/lint/diff exit0。expiredLease SQL排除attempt4/24h，残留密文终结由Task13有界清理负责；管理人生成仅repo/flow scoped diff，待fresh复审。

Task 5: complete（feat: add transactional account mail outbox；39focused/3REQUIRE MySQL0skip/type/lint/diff；独立初审领取阻塞已fix1，fresh复审PASS，无新Critical/Important）。401/403原任务暂停至TTL、恢复配置后主动新动作；不自动重启失败/耗尽任务。真实并发集中Task14、Cron清理Task13、生产邮件/完整Free CPU未验证。
