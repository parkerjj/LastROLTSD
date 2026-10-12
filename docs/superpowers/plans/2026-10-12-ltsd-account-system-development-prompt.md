# LTSD 账号系统开发交接 Prompt

以下内容可完整复制到新开的 6.1 Sol high 会话。计划通过情况见同目录 review 文档；本文件不启动开发。

---

你是本次 LTSD 账号系统开发的管理人。当前会话请使用 **gpt-6.1-sol / high**；实现子代理必须使用 **gpt-6-luna / max**。你负责理解需求、拆任务、回答技术问题、审查与验收，让 Luna 按清晰 brief 实施，不把整个项目一次性丢给它。

项目：/run/media/parker/7A9F-F871/Development/LastROWeb
请先完整读取：
1. 全局/项目/子目录规则，包括 /home/parker/.codex/AGENTS.md、RTK.md 和当前仓库 agent.md。
2. docs/superpowers/specs/2026-10-12-ltsd-account-system-design.md
3. docs/superpowers/plans/2026-10-12-ltsd-account-system-plan.md
4. docs/superpowers/plans/2026-10-12-ltsd-account-system-plan-review.md
然后核对最新 README、部署、迁移、源码。已有 CodeGraph 索引，定位代码先使用它。不要把 agent.md 的历史 D1 架构或 catalog“必须main”指令套到本次；以当前 MySQL 代码、Specs 和我本次明确指令为准。

请现在执行已审阅的实施计划，不再重新做一份泛泛计划。**本地当前 checkout 新建 feat/ltsd-account-system 分支，不创建 worktree。** 分支已存在时按计划核对/选择后缀，不重置；先记录当前分支、HEAD、未提交修改和基线测试。保留已有 README/Specs/计划/review文档及用户其他修改，不自动 stash、reset 或覆盖。不修改 OpenKore 项目。

按 Task 0–15 顺序执行，严格完成前置接口再做依赖任务。使用 subagent-driven-development 技能，但我的“不用worktree、共用本地新分支”要求覆盖其默认隔离方式。一次最多一个写代码的 Luna 子代理；管理人负责分支、提交和任务账本，子代理不能再派子代理、不换分支、不擅自提交或部署。

派实现代理时，如当前工具支持，使用 collaboration.spawn_agent，参数 model="gpt-6-luna"、reasoning_effort="max"、fork_turns="none"。每个任务发 fresh context，携带 Task 全文、Global Constraints、相关 Spec、前置接口、允许/禁止文件、当前分支、测试命令、报告路径和具体验收值。不要只写“实现账号系统”。如果指定模型不可用，明确报告，不能偷偷换模型。

每个实现任务：先复用关键行为测试（缺覆盖时补最少的有意义失败用例）→ 最小实现 → 相关验证（纯文档和分支准备按对应验收检查） → Luna 自查报告 → 独立只读 review（Spec合规与代码质量两项） → 修复与复审 → 你核验证据后提交。审阅代理可用 gpt-6.1-sol / high、fresh context，只读且不再派代理。真实 Critical/Important 不能带到下游；不合理建议由你给出技术依据并记裁决，不静默忽略。修复由 Luna 完成；若卡住，你定位根因、缩小 brief 再让它改，不让它反复盲猜。

**测试只需要覆盖关键节点和关键逻辑流程，不需要航天级别测试。** 不追求100%覆盖或用例数量，不穷举输入组合，不为普通文案/布局/getter或每个内部函数写用例，不在单元/API/端到端重复同一行为。Task中测试点可合并、参数化或复用；关键主流程、鉴权/撤销、一次性动作、邮件额度/幂等、头像大小边界与少量真实MySQL竞争必须有证据。相关检查通过后推进任务；没有新变更/失败/具体风险时，不不断扩写、重跑测试。此要求优先于技能的机械化逐条TDD流程。

实现必须遵守：
- Worker/Hono＋Vite＋现有 MySQL8，不换框架。单数 /account 是网站账号，复数 /accounts 是原游戏监控台，不覆盖或读取其游戏密码作为网站身份。
- 密码仅5–256 Unicode code point，无复杂度/弱密码名单/历史/新旧不同限制。Worker 原生 HMAC-SHA-256＋GitHub→Worker固定Secret＋随机用户盐，不加大密码库/慢KDF，不在浏览器算密码摘要。
- 用户ID数据库自增，新表首个10000，保留已有ID；API十进制字符串，规避现有insertId Number精度损失。
- 昵称/主要游戏角色名一个必填可修改display_name；头像可选可改可删。浏览器正方形裁剪为256×256静态WebP≤32KiB，API纯Base64，MySQL TEXT；Worker只做有界格式/权限检查，不做图片重编码。
- Cookie与数据库会话30天滚动自动续期，撤销与过期不能复活；CSRF、本人授权、凭据版本、并发标签页遵守计划；session CSRF失配不得自动重放本人写操作，跨标签账号变化必须清除旧身份草稿。首版沿用MySQL立即可撤销会话，不引入KV、不用Worker全局字典缓存鉴权；只在账号/受保护API查身份，公开页面/静态资源不额外鉴权，同一请求和浏览器页面复用查询。无查库短token是Spec Q10待确认项，不擅自实现。
- 邮件默认Resend原生HTTPS＋可靠MySQL outbox/短期密文、稳定幂等、租约/额度/有限重试。日额度耗尽保留PENDING、仍可受限登录，准确提示“今天发送邮件的数量已达到上限，请明天重新登录账号，再进行 Email 身份验证”；按UTC恢复后主动重发。区分daily_quota_exceeded、monthly_quota_exceeded和瞬时rate_limit_exceeded，不把所有429当短时间重试，月额度不能承诺明天。把共享额度状态传给前端，202只能说受理；测试不得给真实玩家发信。
- 每个新增Worker调用按Free完整10ms CPU设计，不能把wall时间或本地mock当真实CPU。密码运算、安全授权仍在服务器。真实MySQL集成测试必须开启REQUIRE模式，不许skip后声称通过。
- 不实现交易、机器人、支付、提现、余额、钻石、游戏角色绑定或邮箱换绑。永久文档只写项目docs，不写Obsidian。

请持续执行到所有可本地完成的任务结束，不在任务间反复询问“继续吗”。配置缺失、真实Free测量/邮件域名尚未完成时，继续完成不依赖它们的开发，准确列为生产条件。不要因此假装全部上线验收通过，也不要为满足指标擅自付费、删校验或改架构。

**本次授权是本地分支开发、测试、必要的本地feature提交。不得push、merge到main、部署、修改生产数据库、配置远端真实Secrets/DNS或给玩家发邮件。** main push当前会自动部署，请避免触发；最终保留本地分支供我审阅。

用 docs/superpowers/plans/2026-10-12-ltsd-account-system-progress.md 持续记录任务、提交范围、实际测试/skip、review、裁决和剩余条件；不要在Specs末尾不断追加聊天。完成后跑计划的全量门禁，进行整个分支独立review并修复/复审，给出：
- 分支、提交和功能完成情况；
- 实际测试证据，明确哪些未测/被跳过；
- review通过范围及剩余生产邮件/Secrets/Cron/10ms条件；
- 所有影响实现的裁决及风险。
