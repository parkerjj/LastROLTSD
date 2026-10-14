# LTSD 账号系统实施计划 Review

- 日期：2026-10-12。
- 最终结论：**PASS，计划审阅通过**；本次用户修订经两轮复审通过，R1–R10均已闭合，没有未解决的 Critical / Important。
- 审查对象：[实施计划](2026-10-12-ltsd-account-system-plan.md)，依据[账号系统规格 v0.3](../specs/2026-10-12-ltsd-account-system-design.md)及当前代码。
- 代码基线：`8a2155fcdd84d30193070c1bbca0defeeb28fbd7`；未来开发时重新核对，不回退覆盖用户修改。
- 审阅方式：独立只读 reviewer，fresh context；管理人修改计划原文后提交复审。Reviewer 不改文件、不派其他代理、不执行实现或生产操作。
- 本次不修改业务代码、不创建开发分支、不运行尚未存在的账号实现测试；实施任务仍全部未勾选。

## 审阅轮次与裁决

| 轮次 | 结论 | 处理 |
|---|---|---|
| 第一轮 | CHANGES_REQUIRED：3项 Important、5项 Minor，无 Critical | R1–R8逐项修改计划对应章节 |
| 第二轮 | CHANGES_REQUIRED：R1–R8均已闭合，发现新增R9 Important | 收紧CSRF自动重试范围，补跨身份竞争验收 |
| 第三轮（原版） | PASS：R1–R9均已闭合，无新增 Critical / Important | 全文复审，确认类型澄清与规格覆盖无冲突 |
| 第四轮（v0.3修订） | CHANGES_REQUIRED：新增R10 Important | 轻量测试/邮件日额度提示/Serverless会话说明总体通过；补迟到额度拒绝的UTC bucket契约 |
| 第五轮（本次复审） | PASS：R10闭合，R1–R9仍有效，无新增需修订问题 | 全文审阅Spec/plan/prompt，确认跨周期共享暂停、CAS和轻量测试一致 |

本次最终 reviewer 结论：

> PASS。R10 已闭合，R1–R9 修订仍有效；未发现新增 Critical、Important 或需修订的 Minor。

## 问题与最终修正

| 编号 | 级别 | 问题 | 最终修正 / 计划位置 |
|---|---|---|---|
| R1 | Important | 邮件发送后崩溃可能绕过尝试次数和预算 | Task 5/13：HTTP前同事务预留预算并持久次数与first_attempt_at；领取限定少于4次和幂等窗口；崩溃不返还，耗尽租约转终结并标记结果未知；补崩溃及第4次尝试测试 |
| R2 | Important | 邮件与密码密钥版本、配置和轮换规则未闭合 | §3、Task 1/5/9/13：存储版本，当前＋最多一个previous版本映射；严格按行版本选key，未知版本不猜；定义旧key退休条件及版本测试 |
| R3 | Important | 匿名与会话CSRF共用缓存，流程互相覆盖 | §2.2、Task 3/10：固定路由mode，anonymousCsrf与sessionCsrf两份缓存，已登录的匿名写也使用匿名token；补恢复、重登等测试 |
| R4 | Minor | 一次性动作缺少锁前定位接口 | §2.3、Task 7：readActionSnapshot仅定位userId，事务按用户→动作→session锁序重新校验授权 |
| R5 | Minor | schema可空字段描述不够明确 | §3：版本与必要时间NOT NULL，只有撤销/消费等终结时间可空 |
| R6 | Minor | 新测试库仅加载账号迁移，原市场fixture会失败 | §4、Task 14：受控子进程加载全部迁移，测试URL仅传给子进程；独立测试库和不可skip模式 |
| R7 | Minor | 匿名nonce、跨小时冷却和锁等待后的时间语义不清 | Task 3/4/7：复用有效nonce，冷却独立于小时桶，关键锁后读取fresh now；补跨窗口、锁等待过期测试 |
| R8 | Minor | 旧401响应可能删除新登录Cookie | Task 4/10/14：普通401不返回删除Cookie；显式退出/凭据变更按规定处理；补迟到响应竞争测试 |
| R9 | Important | 会话CSRF失配后自动重试，可能把A编辑内容写到B | Task 3/10：只允许匿名CSRF在业务副作用前拒绝后重试一次；会话写绝不自动重放；身份改变清旧草稿/头像预览，用户重新确认；A→B跨标签测试断言无第二次写、A/B均未误改 |
| R10 | Important | 午夜/月末前的额度拒绝迟到，可能暂停新UTC周期 | §2.3/Task5：预留返回本次MailAttemptContext，拒绝只写原bucket；跨周期锁等待返回stale，旧拒绝不阻止新周期尝试；共享暂停和job lease CAS分别返回，复用跨UTC流程验证 |

第三轮另确认：MailPurpose、current版本字段名称、TypeScript payloadKeyVersion→SQL payload_key_version映射，以及claim/finish/reserve返回类型相互一致。

## 本次用户修订

- 测试只覆盖关键节点和关键逻辑流程，优先复用/合并，不按用例数量或覆盖率评分；Task里的测试路径可合并，不机械逐文件创建。
- Resend日/月/瞬时429区分处理；日超限保留PENDING登录与资料权限，传mail_availability到前端并提示次日登录重发；UTC恢复、异步202、有界查询、有效旧链接和失败任务规则一致。
- 首版不引入KV、不用Worker内存Map授权；MySQL只在账号/受保护API校验，不因登录额外鉴权公开页面。免查库短HMAC token及撤销延迟保留为Q10，未经确认不实施。

## 通过范围

- AUTH-01–11与AC-01–29都有责任任务和证据要求。
- Task 0–15包含前置依赖、文件职责、接口、具体步骤、失败测试/验证、review和提交安排。
- MySQL ID精度、事务连接与锁序、凭据版本、会话撤销、动作单次消费、outbox租约/预算/密文、跨标签身份、头像和CPU边界已给出可实施约束。
- 后续使用6.1 Sol high管理人、Luna max实现子代理，本地新分支、共用checkout、单个写代理，不创建worktree。
- 必须在未来逐任务及全分支代码review中重新核验；本次PASS不是代码验收或上线许可。

## 仍需未来实施验证的事项

真实MySQL并发测试、浏览器WebP产物、Resend发信域名/额度与实际配置、Worker Secrets、Cron账户额度及完整调用10ms CPU证据，按Task 14/15执行。缺少外部条件时如实报告，不用mock或本地wall时间冒充真实结果；不擅自部署、发玩家邮件或修改生产数据库。

本轮永久文档保存于项目docs；[开发交接Prompt](2026-10-12-ltsd-account-system-development-prompt.md)供用户复制到新会话。
