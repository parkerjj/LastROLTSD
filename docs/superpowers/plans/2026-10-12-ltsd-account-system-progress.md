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
| 5 | complete | e0fdc21..9fdf74b | 39focused/3REQUIRE MySQL，0skip/type/lint | 初审1Important，fix1 fresh Spec PASS/quality APPROVE |
| 6 | complete | 9fdf74b..7c1b6f7 | 23focused/4REQUIRE MySQL0skip/type/lint | 独立Spec PASS/quality APPROVE，无Critical/Important |
| 7 | complete | 7c1b6f7..eac6440 | 42focused；fix12focused/5REQUIRE MySQL0skip/type/lint | 1Important/1Minor，fix1 fresh Spec PASS/quality APPROVE |
| 8 | complete | eac6440..0c44a2a | fix33focused/6REQUIRE MySQL0skip/type/lint，browser两fixture | 3Important+2Minor，fix1 Spec PASS/quality APPROVE；VP8L缺口明示 |
| 9 | complete | 0c44a2a..d5f8e17 | 30targeted/92auth-health0skip/type/lint/diff；无SQL未重跑真库 | fresh独立Spec PASS/quality APPROVE，无Critical/Important |
| 10 | complete | d5f8e17..103db0d | fix12focused0skip/type/lint/diff，JSDOM非browser | I1 ADDRESSED；fresh复审Spec PASS/quality APPROVE |
| 11 | complete | base 103db0d；本条提交 | 初验28focused/fix6pass0skip/type/lint/build/diff；HTML14本地头，JSDOM非browser | I1 ADDRESSED；fresh Spec PASS/quality APPROVE |
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

Ruling: Task5前置接口补齐，采用可选AuthConfig.mailDelivery: MailDeliveryConfig={apiKey:string|null;from:string|null;replyTo:string|null}，缺项暂停投递而不破坏core login；prepare动作输入由调用方传精确expiresAt，通知无token默认24h。理由是原Task仅函数名未定义shape，Task6/7消费最终导出契约；无公开wire/数据库schema变化。

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

Task5 commit 9fdf74ba1594e6f2dfc7ce110457ef7a0efded7c。Task6开始单fresh Luna/max，注册依赖邮件接口已通过。

Ruling: 注册邮件预计算允许ActionMailInput.userId为null未绑定draft，事务INSERT得到自增真实ID后绑定再入库 — 邮件密文/nonce需事务外计算且不可预测自增ID，payload/AAD不依赖userId；现有string调用兼容 — 若错需内部prepare类型适配；不允许虚构0/预测ID或null注册job入库，无schema/API变更。

Task6 RED代理证据：含avatar_base64注册应临时415/AUTH_AVATAR_UNSUPPORTED，当前placeholder503导致1failed（非导入/收集错误）。primitive规则测试复用，不穷举头像；核心注册/重复/事务回滚随后补最小关键覆盖。专用MySQL由唯一Task6 writer独占，管理人/review不同时reset。

Task6真实DB首次新用例因默认5s timeout在migrate阶段结束，其他3例pass约16s/例；不是注册行为RED。按既有120_000ms单例timeout适配全部迁移，确保前进程退出/连接finally关闭才再启动reset，不改产品超时。已有avatar路由行为RED有效。

Task6真实行为RED已确认（代理报告）：合法注册API预期202实际503；同串行REQUIRE file其余3pass，新增测试timeout已120s，前进程退出后才新reset。

Task6阶段GREEN（代理报告）：完整REQUIRE MySQL4pass0skip，新增注册验证5字密码/唯一Email重复统一202无Cookie、密码/任务不重复与outbox冲突rollback；3focused files23pass0skip，type/lint/diff exit0。无新变更不再机械重复suite，待自查报告与独立review。

Task6最终报告已读：23focused/4REQUIRE MySQL0skip/type/lint/diff。顺序重复注册及outbox注入ER_DUP_ENTRY后的真实事务rollback已测，真实同邮箱并发仍Task14；avatar暂415，AUTH-01未标全。已生成七文件diff并派task6_review fresh6.1-sol/high，尚未提交。

Task 6: complete（feat: add email account registration；23focused/4REQUIRE MySQL0skip/type/lint/diff；fresh独立review PASS，顺序duplicate/真实rollback证据，真竞争Task14及头像Task8明确待验收）。

Task6 commit 7c1b6f796cac316b8107b86eef337888d77f96a1。Task7开始fresh单Luna/max，执行VERIFY→改密→RESET；会话helper最小复用允许，无后续任务/外部操作。

浏览器能力预检（非头像GREEN）：Playwright MCP缺/opt/google/chrome/chrome，about:blank/evaluate初始化均失败。CUA IAB可创建空页；data: fixture导航被URL安全策略拒绝，仅HTTP/HTTPS允许，未产生WebP结果，临时空页已关闭。不绕过该导航或用RawCDP/alternate surface执行受阻动作；后续以实际本地HTTP开发页面/真实UI验证头像，当前不声称browser codec通过。此不阻塞Task7服务端开发。

Ruling: confirmReset服务内部返回changedUserId，router仅当先前成功authenticate的当前Cookie属同用户时clear；无/失效/其他用户Cookie不清，changedUserId不进204公开回包 — 匿名恢复不应破坏无关网站身份，也不能提升RESET为通用登录授权 — 若错需内部返回类型适配，无schema/公开wire变更。复用VERIFY查询必须用户锁先行、遵守phase guard，空/失效候选需保留新建动作合法顺序，具体冲突再定位。

Task7阶段证据（代理报告）：关键RED reset/request placeholder503预期统一202；新增MySQL生命周期选例GREEN，2次中间失败为断言对象/匿名CSRF随测试时钟过期的fixture错误，根因修正。完整REQUIRE auth-account-flow最终5pass0skip，涵盖夺回→新密码登录→新VERIFY→改密撤销及30min/24h边界，旧4例全pass。type/lint/diff exit0，待最终自查及独立review，不把模拟/选例当真竞争。

Task7最终自查报告已读：42focused（17+25）/5REQUIRE MySQL0skip/type/lint/diff，真实race与barrier未测留Task14。生成五文件diff；管理人补查reuse nextAt=expiresAt无法再领取可能被错误复用、SELECT全sealed payload大载荷两点交独立review验证，不先猜结论。

Task7 task7_review：Spec FAIL/quality REQUEST CHANGES，1Important/P2：401/403暂停nextAt=expiry的PENDING job仍被readReusableActionMail复用，202不新建而永不可claim；只读内存适配器复现，管理人接受。1Minor/P3：reuse两次SELECT完整ciphertext不必要，应metadata存在性投影；未测真实Free CPU、不声称超标。其他授权/一次性/版本/Cookie/事务/审计无阻塞；fix1原Luna仅repo与现有flow回归，暂不进入Task8。

Task7 fix1代理证据：F1真库RED证明旧暂停job仍reuse action/job count1；GREEN新建count2，正常next=now+5m<expiry第二次仍reuse；401/403状态是测试SQL模拟，不是实际providerHTTP。两处metadata投影不读cipher/IV/key/provider字段，无新schema/index。完整REQUIRE MySQL5pass0skip、12focused/type/targetedlint/diff exit0，无CPU benchmark。生成仅repo/flow scoped diff，待fresh复审。

Task 7: complete（feat: add account verification and password recovery；完整MySQL5pass0skip，42focused初验/12focused fix；独立review F1/F2均ADDRESSED、fresh复审PASS）。真实竞争/CPU未测，401模拟边界明确；不擅自升级账号邮箱或自动登录恢复身份。

Task7 commit eac644053e04518611544a0e3ceb7c5c257fdfef。Task8开始fresh单Luna/max，本人昵称/头像及注册头像原子接入；browser按正常本地HTTP UI验证，不使用受阻data导航/绕过策略，不因Playwright全局Chrome缺失伪造证据。

Task8 browser阶段证据（代理报告）：正常本地HTTP合成图UI在CUA IAB生成并解码两张256×256静态WebP，account2400B/default2376B，页面MIME=image/webp，仅写tests/fixtures/auth白名单文件名。UA/来源metadata整理中，backend RED/权限/size验证未完成；不使用此前受阻data导航，不声称实际前端Crop UI/Free CPU通过。

Task8最终report已读：RED5fail/2pass（415旧注册、缺profile方法、GET503），修一处测试TS语法后仍同RED；GREEN32focused/6REQUIRE MySQL0skip/type/lint/diff。带头像注册outbox/audit故障为wrapper注入、真实DB查询证实rollback；browserChrome155两genuine VP8X/VP8+ICCP 256×256 fixtures，32KiB合法metadata边界和坏样本区分；VP8L头无独立有效fixture，不称完全解码/真实CPU。生成十文件diff；字段size415 vs planned413交独立review核实。

Task8 task8_review：SpecFAIL/qualityREQUEST CHANGES，3Important/P2：字段超限413/基础Base64格式400契约；VP8.show_frame/profile/firstpartition越界头被接受（官方libwebp轻量VP8GetInfo与只读真实fixture变异复现）；注册初始头像缺动作/version审计。管理人接受最小修复，权限/原子/公开缓存无其他阻塞；VP8L正向fixture未测与CPU未测边界明确。Fix1交原Luna，不进入Task9。

Task8 fix1同意顺带最小解决原review两个非阻断直接相关项：公开v可选合法非负十进制格式（仍只返回当前图）；profile/setAvatar兼容可选第三requestId参、router用现有helper关联审计，不扩AuthRuntime或旧模块。接口shape由Luna明确后记录；VP8L有效browser样本尚未独立测，官方位公式静态核对正确，保留Task12/14必要补证，不机械要求每codec组合/全解码。

Task8 fix1代理最终证据：F1格式400/字段413/结构415；F2VP8 profile/show/partition轻量bounds；F3注册带图动作/version/requestID事件同Tx无图片；两个备注optional第三requestId/v数字格式已补。33focused/6REQUIRE MySQL0skip(102.9s)/type/lint/diff exit0；VP8L独立正向fixture未补仍明示。生成七文件scopedfixdiff，待fresh复审，无提交。

## 2026-10-13 复审额度恢复
Task8 fix1 reviewer因usage limit终止，提示15:23恢复；无PASS结论。用户明确“继续”。管理人12:45:35 UTC（Tallinn15:45）核对ordinaryUsageAllowed=true、primary used0%、weekly used16%，恢复同reviewer6.1-sol/high；无购买/使用reset credits/模型替换。分支及未提交Task8所有改动保留，复审完成才提交/进入Task9。

Task 8: complete（feat: add editable account profile and WebP avatars；33focused/6REQUIRE MySQL0skip/type/lint/diff，真实browser产物VP8X/VP8+ICCP；3Important ADDRESSED，复审PASS）。AUTH-01注册头像已原子接入；VP8L正向样本与实际Worker CPU未测，前端Crop/mobile仍Task12/14。
Ruling: profile/setAvatar审计增加兼容可选第三requestId参数，router传既有请求关联helper；v只接受有界数字字符串而仍取当前图 — 修原review直接相关可观测性/格式备注，不改变权限/历史图片语义 — 若错仅内部签名/非法query错误适配，原两参数调用兼容。

Task8 commit 0c44a2a48f9b4c789b5ca3b797b6f55f9cf59f28。Task9开始fresh单Luna/max，沿原createApp签名/生命周期和已有Cors账号例外，auth预算types/config缺项允许补齐；不改公开fastpath/旧环境校验/Cron部署。

Task9自查已核对：真实入口路由、auth raw绑定透传/lazy核心与预算校验、read预算共用、default.fetch成功/认证错误close一次。RED8fail/21pass→30targetedpass，相关92auth-healthpass0skip/type/lint/diff exit0；SQL无改动，生命周期是mysql2 mock，不重跑真库/不声称CPU测量。生成九文件diff并派fresh task9_review，尚未提交。

Task 9: complete（feat: wire account routes into Worker lifecycle；30targeted/92auth-health0skip/type/lint/diff；独立Spec PASS/quality APPROVE，无Critical/Important）。管理人核对报告、源码关键diff与fresh diffcheck；公开无新增鉴权，真库/邮件/Free CPU未测不标通过。后续Task13必须从AuthConfig共用预算。
Ruling: 保留旧 staging/production MYSQL/CURSOR/GUESTBOOK 全局校验，仅在账号命名空间将其异常映射已知503/未知404/OPTIONS204 — 符合账号稳定JSON失败且不放宽现有公开部署校验 — 若错需局部错误映射修正，不伪造环境或secret。auth预算正整数仅可降低至默认100/3000以内，零与提高额度不隐式启用。

Task9 commit d5f8e17。Task10开始fresh单Luna/max；同页面共享AuthApi/Store、CSRF两mode与generation保护、仅明确身份变更广播，后续页面消费清旧稿信号；不接游戏credentials，不提前扩到Task11/12。

Task10关键行为RED（代理报告）：auth-nav1failed，既有导航缺独立data-auth-nav槽，原/accounts仍保留；非missing import/编译错误。允许styles.css仅局部账号槽/头像/长昵称截断及移动断点，不改全站布局；实际mobile证据留Task14。AuthApi/Store关键行为测试继续，未提交。

Task10管理人源码补查退出竞态：logout捕获generation后等待，先前me先resolve/adopt使generation增加，logout204后clear被跳过而残留显示身份。Luna确认接受，用deferred固定旧me→logout204顺序补现有最小失败测试；退出意图须淘汰旧read，期间显式新login需以实际Cookiereconcile，不覆盖新身份。待RED/GREEN与独立review，不算已修复。

Task10补查两项真实RED已复现（代理报告）：deferred旧me先返回/logout后仍active；收到广播logout→reconcile/me401再广播一次，count2预期1。内部clear需区分接收来源，不能反广播。另refresh测试未越1h节流修成显式force后通过，为fixture/调用期望问题，非生产缺陷；未扩大用例矩阵。

Task10最终自查报告已核对：11focused0skip/type/targetedlint/diff exit0；两并发RED修复转绿，same-page单例+身份变更clearDrafts事件供Task11消费。所有auth源码Storage/console/track搜索无命中，CSS仅局部导航；JSDOM菜单不是实际mobile。生成9文件diff并派fresh task10_review，未提交/未真库rerun。中间类型检查mock cast/测试logout后DELETE顺序/跨realm Element问题准确修正，不改变产品去迁就测试。

Task10独立review确定1Important：reconcile in-flight期间后续broadcast复用旧Promise，未invalidate/dirty；reviewer运行真实AuthApi+AuthStore内存适配器确定性复现server B/store A/旧草稿未清、meCalls1。管理人源码确认接受（旧CSRF可阻止误写，仍违反身份同步/清稿契约）；fix1原Luna仅store/既有测试，以有界合并与后续最新查询修复，尚未进入Task11。其他已修竞态独立核对符合，最终report待落盘。

Task10最终独立report已读：Spec FAIL/quality REQUEST CHANGES仅I1 Important。旧两竞态独立名称过滤2pass/3skip（不是完整11测试重跑）；内存probe无网络/DB，输出旧A与draft确认I1；diffcheck fresh exit0。报告落盘后通知Luna完整读取再修复，DOM/移动键盘真实证据缺口不误标通过。

Task10 fix1报告已核对：新deferred RED1fail5名称skip→聚焦1pass5名称skip；完整12pass0skip/type/lint/diff exit0。generation invalidation+API revision清旧token、单dirty位串行latestquery，失败本身不retry、不回发。管理人疑同session清API后不恢复，经真实AuthApi.me revision guard源码核对已自动恢复，撤回假设、不为fake API差异加产品补丁/机械测试。两文件scoped diff已生成（no-index exit1仅表示存在差异），派fresh task10_fix_review，待结论再提交。

Task 10: complete（feat: add browser account state and navigation；12focused0skip/type/lint/diff，独立I1 ADDRESSED/Spec PASS/quality APPROVE，无Critical/Important）。复审独立过滤3pass3skip，真实AuthApi+Store内存probe验证I1 burst合并两次me/B清稿、same-session恢复0误清稿、newlogin/退出迟到隔离、503不自动retry与不更新期限；非实际browser Cookie/页面/Crop/CPU。管理人完整读结论和源码修复、fresh diffcheck核对后提交。
Ruling: reconcile每次真实身份信号使旧generation/API revision失效，后续信号用一个dirty位串行查询最新Cookie，失败本身不触发重试 — 避免旧身份响应覆盖跨标签切换且仍合并请求 — 若错会产生错误展示/旧稿，服务端CSRF仍授权边界；不自动重放写，不回发通知，不扩框架/Storage。

Task10 commit 103db0d6f76b63ebc04d741619e56680e77bf0ca。Task11开始fresh单Luna/max，依共享接口接七账号页面，令牌闭包清URL/无analytics/真实HTML安全头，保留游戏/accounts；头像仅占位到Task12，不提前Cron/DB竞争。

Ruling: Task11成功profile PATCH后复用共享Store.reconcile安全同步一次me — 当前Store没有安全profile-adopt接口，避免新增setter/绕generation；该查询有意同步本人导航，不是组件重复bootstrap — 若错会额外查库或迟到显示错身份，页面仍需身份事件守卫，后续CPU按完整调用分别测。Task11 writer起初只找大写AGENTS遗漏小写agent.md，经管理人指出已补完整读取，未先改源码；历史D1/main覆盖依据再次明确。

Task11初次RED命令2 suites/0tests因pages.ts缺失无法加载，管理人明确不算行为RED。Luna落export最小骨架后实际2files/8tests失败，包含七路径/表单/权限401503/token清URL/mainanalytics分流；poll用例安装JSDOM前访问document为fixture错误，先修再复测，不改产品迎合。已产生关键行为失败证据后实施，不要求逐页机械RED。

Task11行为GREEN阶段（代理报告）：pages4/5、token3项pass，仅旧main在/register调用analytics/LA_COLLECT并进入search初始化真实失败，现最小调整main分流。管理人源码补查：type=password选择器遗漏显示后的type=text密码（身份清稿/成功/cleanup均需稳定语义标记）；subscribe在stopPolling const初始化前bootstrap同步emit的TDZ顺序；本人回调仅UID守卫无法防同UID新session/ABA变化后的旧改密响应清新Store。交Luna最小修正稳定字段、helper初始化、本地identity事件epoch，复用现有关键用例/一deferred顺序，不扩每操作矩阵；待证据，未标完成。

Task11阶段GREEN（代理报告）：9pages/token与规定4文件28pass/type/webbuild exit0；旧catalog动态/静态import警告未改。已修上述稳定密码语义/epoch/初始化；公开202文案只受理/等待、不承诺送达，沿既有流程不新文案测试。真实HTML：Wrangler4.133.0 local8790（已读wrangler技能/官方staticassets文档）navigate GET七路径各含/无尾斜杠14项均200 text/html/no-store/no-referrer；/accounts对照200默认public max-age0 must-revalidate，无覆写，_headers在SPA fallback生效，不需Worker/wrangler改动。owned server已Ctrl-C关闭，共享MySQL未动；非远端/CPU。

Task11管理人后续源码补查：真实bootstrap loading同步emit令pollingStopped永久true，后续PENDING主动受理仍无法startPolling（原mock初态pending掩盖）；交Luna在既有poll用例模拟loading→pending并最小修复用户主动启动条件，仍可见/最多3/隐藏或quota立停、不重发/续期、不重置计数绕上限。待真实RED/GREEN及最终report，不提前称完成。

Task11最终report已读：真实AuthStore bootstrap RED首120s timer0预期1→修复GREEN，当前只终止已有cycle，identity变化即使两者PENDING也停旧cycle；新的主动申请可在页累计<3时重启，不resetcount。9pages/token及规定4files28pass/type/lint/webbuild/diff；HTML14variant既有实际证据不重跑。源码停止，六文件reviewdiff已生成并派fresh task11_review；无DB/Workerfallback/远端，未提交。JSDOM+mock API，poll captured timers+真实Store逻辑，不称实际browser/mobile/邮件/CPU通过。

Task11独立review Spec FAIL/quality REQUEST CHANGES，只有1Important/P2：真实AuthStore.bootstrap me503→disabled，而/account隐藏retry；JSDOM+真实Store probe meCalls1/retryHiddentrue证实，原用例mock error掩盖。管理人当前源码确认接受，fix1仅pages/既有503测试，保留disabled信息/手动retry，禁止自动retry/重构；原文件留scoped diff，未进入Task12。
Ruling: 不接受“ACTIVE错账号缺同页重登”初步疑点 — reviewer完整读真实Nav后已独立复现active同页logout→inline pendinglogin→主动confirm，token保留URL清，不需重复页面按钮或改Task10；此项已排除并记录，非静默忽略。真实Store reconcile轮询独立probe3自动me/0refresh/1request/no剩timer，通过但仍非browser/DB/CPU证据。

Task11 fix1报告已核对：真实Store首503/disabled/no自动retry/me1 RED1fail5名称skip→用户click恢复PENDING/me2 GREEN；原auth-pages全file6pass0skip/type/定向lint/diff exit0。仅pages/既有测试，其他main/styles/_headers原证据不机械重跑。生成两文件scoped diff（no-index exit1为有差异）并派fresh task11_fix_review，未提交。

Task 11: complete（feat: add account authentication and recovery pages；初验28focused/fix6pass0skip/type/lint/build/diff；HTML14variant本地真实no-store/no-referrer；独立I1 ADDRESSED/Spec PASS/quality APPROVE，无Critical/Important）。复审独立过滤1pass5名称skip/sourcehash一致，管理人报告/局部源码/fresh diffcheck核验后提交；browser mobile/keyboard/Crop/CPU仍未声称通过。
Ruling: 页面本人回调用本地identity-changed epoch连同UID挡旧响应，含同UID新session，显示态密码按稳定语义标记清而非input type — 保持跨标签草稿/新身份隔离 — 若错会保留旧密码或误清新显示身份；不暴露token/新增Storage/客户端鉴权。
Ruling: 邮件检查只在主动受理后启动已有cycle，初始loading不锁未来请求；同身份事件/隐藏/quota/离页停，用户新申请可在页累计<3时重启且次数不reset — 修真实bootstrap与PENDING跨用户迁移问题，保留有界查询 — 不续期/自动重发，失效/失败仍靠server授权。
Ruling: _headers真实SPA本地14路径已生效，不增加Worker-first或ASSETS覆写 — 最小改动且/accounts缓存对照不变 — 真实Free部署行为与CPU仍未来条件，不用本地mock/墙钟冒充。
