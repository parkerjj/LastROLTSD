---
type: feasibility-research
project: LastROLTSD
created: 2026-11-14
updated: 2026-11-14
status: deferred
implementation: not-started
---

# LTSD KE：AI / MCP 功能调研与暂缓决定

核验日期：2026-11-14。范围：现有 KE 代码、官方资料、第三方服务商接入指南、GitHub 项目与 Issues、用户论坛。未登录新免费账号、未安装插件、未发起平台合作申请或真实 LTSD 数据调用。本功能没有实施代码、数据库迁移、生产部署或发布。

## 当前决定：暂不实施，调研归档

用户于 2026-11-14 明确决定“这个功能先不做了”，要求总结当前已知内容形成文档。主要顾虑是小网站、低用户量下，为外部平台审核及不确定的免费接入投入开发的收益不明。

本工作到文档归档为止，不继续账号开通、插件申请、免费账号验收或 MCP 功能开发。下文候选排序和验证条件仅供未来重新评估，不构成待执行计划。

**事实边界：没有提交过 LTSD 插件审核，也没有证据表明小网站或低用户量一定无法通过审核。**“担心审核不通过”是暂缓的投入判断，不是平台已拒绝或已公布最低用户量要求。

## 用户要求

最初目标分为两部分：一是为 KE 配置提供 AI 可调用的 MCP 能力；二是在 LTSD 网站提供「询问 AI」入口，让用户在中国可用的 AI 平台获得针对自己角色的配置建议，并能修改配置。讨论后明确的目标体验和约束如下。

LTSD 角色页按钮 → AI 平台网页插件详情 → 安装/连接 → 用户单独授权自己的 LTSD 账号 → AI 读取配置、建议修改、经用户确认后保存。中国用户可使用；无需用户安装客户端、浏览器扩展或本地桥；无需用户申请 API Key；推理消耗当前 AI 网页登录用户自己的免费额度，网站方和用户均不购买模型服务，允许免费用量限制。

“经用户确认后保存”是调研阶段的建议交互，尚未作为实施规格获批。用户核心目标是 AI 能实际修改配置，而非只输出一份需要手动复制的建议。

## 架构边界与额度归属

| 环节 | 责任方 | 身份或额度 |
| --- | --- | --- |
| 对话、模型推理、工具选择 | AI 网页宿主 | 当前登录用户自己的 AI 账号及免费额度 |
| 角色配置读取、校验、保存 | LTSD MCP/API | 该用户授予 AI 宿主的 LTSD 访问权限 |
| 配置含义、支持范围、分析方法 | LTSD 提供的知识或 Skill | 需要对齐实际 KE 版本及服务器规则 |

AI 平台的登录额度与 LTSD OAuth 访问令牌是两个独立概念。OAuth 解决配置访问授权，MCP/API 解决工具调用；它们本身不决定模型费用归谁。不能仅通过“登录 AI 账号”就假定 LTSD 站内聊天能调用用户的网页免费额度。

最终要求排除了开发者统一提供模型 API 账号，也排除了让用户自己申请 API Key 的方式。MCP、Skill、插件分别承担连接工具、提供操作知识、组织分发入口等职责，不能互相替代。

## 现有 LTSD / KE 基础

本轮通过代码检索核实的可复用基础：

- [Profile 服务](../../apps/worker/src/ke/profile-service.ts)：已有按账号检查配置归属、创建/读取/更新/删除/启用方案，以及五个配置文件的管理能力。
- [局部补丁](../../apps/worker/src/ke/death/config-patch.ts)：已有期望值检查、冲突拒绝及反向补丁；当前仅覆盖 `config.txt`、`mon_control.txt`，块修改白名单为 `buyAuto`、`useSelf_item`。它不是任意配置的完整语义校验或完整版本历史。
- [前端配置定义](../../apps/web/src/ke-schema.ts)：已有字段、中文解释、解析/序列化及部分校验，可以作为整理 AI 配置知识的参考；不能直接假定这些前端规则已经构成服务端 AI 写入校验。
- [现有 KE 路由](../../apps/worker/src/ke/router.ts)及[托管说明](../ke-hosting.md)：网页会话、设备 Bearer 和托管身份各有边界；部分死亡修复流程具备补丁及通知重载机制。

若未来重启，仍需设计独立的第三方授权、角色/配置作用域、撤销与过期、服务端校验、并发修改保护和修改记录。现有设备令牌不应直接作为第三方 AI 的通用授权。保存配置、启用方案和让运行中实例重载是不同动作，不能笼统承诺保存后立即生效。

AI 建议质量还依赖实际职业、等级、装备/技能、运行状态、死亡报告及服务器规则是否足够。仅开放配置文件，不足以保证模型能正确优化。

## 讨论过但不符合最终边界的路线

| 路线 | 本轮已知内容 | 未采用原因 |
| --- | --- | --- |
| LTSD 站内聊天，统一调用模型 API | 操作最少，但通常由开发者账号承担推理额度；用户最初认为体验最佳 | 后续明确要求消耗最终用户各自 AI 平台账号额度 |
| LTSD 统一调用免费 GLM API | 官方当前把 `GLM-4.7-Flash` 输入/输出列为免费，支持工具调用；公开文档未给统一每日次数，实际并发需账号控制台确认 | 仍是开发者账号共享限流，不符合最终额度归属；未实际调用 |
| 百炼新人赠送额度 | 本轮官方资料为90天有效等条件，用完/到期后可能计费 | 不能作为持续双方免费的方案 |
| 用户自带 API Key | 可以使各用户承担自己的 API 额度 | 不符合登录即用、不申请/填写 Key 的体验 |
| 桌面 Harness、浏览器扩展、本地桥 | 确有工具调用案例 | 用户明确不接受安装 |

相关依据：[GLM 当前定价](https://docs.bigmodel.cn/cn/guide/start/pricing)、[GLM 工具能力](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash)、[GLM 限流说明](https://docs.bigmodel.cn/cn/api/rate-limit)、[百炼新人额度](https://help.aliyun.com/zh/model-studio/new-free-quota)。免费政策只代表核验时状态，不代表永久承诺；第三方检索、知识库或其他工具也可能独立收费。

## 判断

- LTSD 服务端具备配置读写基础，能够新增受限 MCP/API 和逐用户授权。
- 若未来重新评估，国内优先候选是 **Kimi 网页插件市场路线**：官方有网页 MCP/Skills、OAuth、公开市场审核入口及免费版插件权益。关键缺口是自建 LTSD 插件获审后能否向普通免费账号开放，以及插件详情直达链接和实际用量。当前不继续验证。
- 尚未找到将全部要求同时走通、并有免费账号和授权读写证据的国内公开案例。不能承诺目前任意国内 AI 网页都能自助一键接入。
- 豆包/千问自定义 MCP 的明确实操多依赖桌面端；正式生态接入另有审核或邀请门槛。
- 扣子支持网页 MCP 和逐用户 OAuth，但当前公开免费分发仍有缺口，不能沿用旧低代码教程直接得出结论。

## 国内平台证据

### Kimi：最强候选，需市场审核与免费权限验收

官方说明 Kimi Web 支持插件中的 MCP 与 Skills；插件详情安装可触发第三方 OAuth。公开市场接受个人插件提交审核。[插件说明](https://www.kimi.com/help/plugins-and-skills/overview)、[公开市场发布](https://www.kimi.com/help/plugins-and-skills/publish)

2026-10-27 的 K3 中文会员表列 Free ¥0、基础 Agent 额度、1 个并发任务、15+ 类精选插件；没有给出“每天多少次配置优化”。精选插件权益不能自动推导为所有第三方新插件均免费。[官方 K3 中文会员表](https://www.kimi.com/resources/kimi-k3-pricing)

真实第三方开发者 Firedrill 在 2026-10-19 的 Issue 中验证了远程 MCP 插件安装/发现，但限定 Kimi Code CLI，作者明确没有证明鉴权后的完整任务。它不能作为免费网页闭环验收。[开发者讨论 #1566](https://github.com/MoonshotAI/kimi-code/issues/1566)

第三方 EveryInfra 的 2026-11 使用指南区分 Kimi Code、自建 Work 插件和网页上已上架/企业插件，支持“网页要走市场发布”的判断；不证明免费账号一定获得任意第三方插件权限。[服务商接入说明](https://everyinfra.com/blog/kimi-k3-1-pro-sentiment-earnings-research)

活页的2026-11指南展示了连接远程 MCP、跳转第三方登录授权并读取页面的实际路线，但明确针对 Kimi Work 3.2.23，不能作为纯网页成功案例。[活页接入说明](https://space.24haowan.com/help/kimi)

剩余验收：普通免费用户能否安装获审 LTSD 插件；两个 LTSD 账号独立 OAuth 和权限隔离；修改后读回；模型额度归当前用户且无付费升级要求；外站能否直达插件详情；额度耗尽行为。

### 豆包：任意连接器路径依赖桌面；正式应用插件邀请制

滴答清单的真实 OAuth 接入教程把豆包自定义连接器限定在桌面客户端。开源 doubao-fuye 同样要求客户端及本地程序。[滴答 MCP 指南](https://help.dida365.com/articles/7438132116019216384)、[豆包项目安装说明](https://github.com/Humyang/doubao-fuye/blob/main/docs/MCP_INSTALL.md)

官方应用插件具备 MCP、登录和执行动作，但文档明确邀请制和分阶段放量。普通网页覆盖、免费用户权限、LTSD 作为开发者的费用及直达入口没有获得完整证明。[官方应用插件介绍](https://open.doubao.com/apps-plugin/docs/overview/introduction)

### 千问：普通聊天开放路线与 QwenWork 要分开

普通千问开放平台的 Skill 仍标“即将开放”；推荐的品牌 Agent 路线不等于任何个人开发者能免费自助上架。[开放平台](https://open.qianwen.com/)

QwenWork 官方添加自定义 MCP 的步骤从桌面客户端开始，与滴答教程一致；快查则有市场发现和 OAuth 的真实产品指南。这些证明协议和授权能力存在，但不足以证明免费网页用户安装 LTSD。[官方连接器说明](https://docs.qwenwork.cn/features/connectors)、[阿里云对应文档](https://www.alibabacloud.com/help/zh/qwenwork/qw-connectors)、[快查接入案例](https://open.kuaicha365.com/doc-center/platform-qianwen/)

当前定价资料存在数字与旧教程不一致，不能沿用“每天100积分/注册送2000”等旧值作为承诺。[当前会员页](https://qwenwork.cn/pricing?audience=individual&billing=monthly)

### 扣子：网页与用户授权存在，公开免费分发未验收

扣子英文名为 Coze，属于字节跳动产品体系；当前用户协议列出的服务主体为北京春田知韵科技有限公司及关联方，部分服务由火山引擎或飞书提供。运营背景本身不证明免费政策、网页插件权限和 LTSD 接入适用性。[官方产品介绍](https://developer.volcengine.com/articles/7418780067129786409)、[用户协议](https://docs.coze.cn/guides_terms-of-service)

新版插件文档明确每用户独立凭据及 MCP OAuth，公开描述的自建插件分发重点是个人、项目、企业团队商店。[新版插件](https://docs.coze.cn/create-plugin)、[网页 MCP](https://docs.coze.cn/mcp)

旧低代码智能体公开商店有使用者额度和逐用户授权，但新注册账号已不能进入旧低代码平台。因此旧教程不是当前新开发者可复现路线。[新账号限制 FAQ](https://docs.coze.cn/guides_FAQ)、[商店计费主体](https://docs.coze.cn/coze_pro_payer)

商店中使用扣子模型按当前登录使用者计算积分；接入方舟模型通常由模型接入点创建者承担，API/SDK 则按访问密钥创建者计量。不能将商店的用户额度规则直接套用到 LTSD 自己嵌入的聊天界面。

ReportGem 提供网页添加路线，同时明确其扣子 OAuth 和真实检索尚未完成联调。它是实际服务商的有限验证，而不是完整成功证明。[ReportGem 接入说明](https://www.reportgem.com/mcp.html)

官方活动有每日60积分、当日有效等条件，且条款对手机客户端参与有要求；不能把它视为纯网页任意新账号的持续保障。[活动规则](https://docs.coze.cn/guides_coze_points_activity_rules)

### DeepSeek 普通网页：发现的实现依赖用户端桥接

MCP-SuperAssistant 与 mcp-bridge 都有可检查项目，但分别依赖浏览器扩展或本地桥接，不符合无安装要求。没有找到普通 DeepSeek 网页原生公开插件安装及 LTSD OAuth 的完整成功证据。[MCP-SuperAssistant](https://github.com/srbhptl39/MCP-SuperAssistant)、[mcp-bridge](https://github.com/WongJingGitt/mcp-bridge)

### MiniMax Agent：已有市场项目，带 OAuth 接入需要平台协作

treg 的开发者文档区分了可公开发布的技能与 Agent 云端的鉴权连接器。后者要求对接平台、配置 MCP 与 OAuth，并取得应用提供方登记，不能等同自助发布一个通用 MCP 插件。[treg MiniMax 集成记录](https://github.com/superdesigndev/treg/blob/main/docs/MINIMAX-PLUGIN.md)

尚未证实当前免费账号额度、公开上架条件和普通用户网页直达闭环。

### 智谱清言：找到历史同类需求，但没有当前完整成功证据

LINUX DO 2024-03-14 的真实讨论将论坛 API 接入清言助手，公共搜索已运行并通过审核；作者仍卡在用户个人鉴权。该历史案例证明需求相似，不证明2026仍缺少此能力，也不证明今天已解决。[原讨论](https://linux.do/t/topic/32422)

## 海外对照：Mistral Vibe / Le Chat

当前官方文档描述免费账号可管理连接器、远程 OAuth 2.1 和读写工具。Vendia 提供免费计划 OAuth 接入指南，Reddit 有免费用户已添加多个连接器的报告；另一个服务商旧文档仍称需付费，表明版本资料有冲突，应以当前官方和账号验收为准。[官方 MCP](https://docs.mistral.ai/vibe/work/connectors/mcp-connectors)、[Vendia 实际服务接入](https://docs.vendia.com/platform/vendia-mcp-server/getting-started/)、[2026-02免费连接器讨论](https://www.reddit.com/r/MistralAI/comments/1rbtjdh/mistral_le_chat_allows_custom_connector_in_free/)、[2026-08免费用户故障与回避方式](https://www.reddit.com/r/MistralAI/comments/1w1lh49/cant_add_custom_mcp_connectors/)

它证明按用户 AI 网页额度接远程工具确有相似产品路径，但中国大陆访问证据不一致，本次无大陆网络实测，也未核实外站直达安装。因此不列为面向中国用户的首选。

## 未来重新评估的条件（非当前待办）

只有用户明确决定重新启动后，再重新核验平台现行政策。参考触发条件包括：平台开放普通开发者自助分发；明确允许免费网页账号使用第三方 OAuth 工具；或接入收益足以支持审核及维护投入。上架审核、免费资格和公开详情入口不能由 LTSD 单方面保证。

若未来验证，最小通过标准是：两名普通免费用户分别连接自己的 LTSD 测试账号，在网页完成读取一项配置、提出修改、确认保存并读回；双方不可访问对方配置；推理扣各自 AI 平台额度，开发者无模型调用费用；额度耗尽后停止；用户无需安装任何本地软件。

在实际验收或平台明确确认之前，结论为“存在有条件的候选路线”，不能表述为“已找到可保证免费的一键接入平台”。当前最终状态是：**调研完成并归档，功能暂不实施，无待自动执行的开发或平台接入任务。**
