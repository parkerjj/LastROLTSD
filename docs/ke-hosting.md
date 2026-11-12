# KE 离线挂机（服务器托管）— LTSD 侧

设计与不变量的权威版本在 KoreEngine 仓库的 `docs/linux-hosting-design.md`（第 5–11 节与 6A）。本文只记录 LTSD 侧的接口、数据与运维。

## 数据（迁移 028）

`ke_agents`（VPS）、`ke_agent_nonces`（请求防重放）、`ke_hosted_credentials`（游戏账号明文 + 密码 AES-GCM 密文）、
`ke_hosted_instances`（托管记录、归属、epoch）、`ke_hosted_tokens`（托管 token）、`ke_instance_status`（最新状态快照）；
`ke_instances.kick_reason`。迁移同时把既有 `mode='manual'` 的实例改成 `auto`。

## 规则摘要

- **托管资格**：拥有有效的 `module:hosting`（付费功能“离线挂机”，50 元/月）且拥有 `module:core`。**全有或全无**：功能到期、退款或被撤销后所有托管实例停止，一个都不保留，重新购买后不自动恢复。实例额度（`slots`，含免费 1 个）只决定能托管几个，不决定有没有资格。
- **离线挂机包含脱机版**：拥有 `module:hosting` 期间生效模块自动包含 `standalone`（`foldEntitlements` 里补上，不写赠送流水），到期/退款同步失效；已有的脱机时长不会因此额外延长。购买页上“离线挂机”与“脱机功能”不能同单购买（前者已包含后者）。
- **存量赠送（迁移 029）**：2026-11-05 00:00（UTC+8）之前已购买过脱机功能的账号，对每条仍有效的非 signup 脱机流水复制同一有效期窗口，生成 `source='grandfather'` 的 `module:hosting` 流水；幂等，部署后可原样再执行一次（会把已赠送流水的到期时间跟上脱机的延期）。
- **上线前置**：Stripe 里新建“离线挂机”Product（`metadata.ltsd_commerce_product_key=module:hosting`），并设置 Worker 变量 `COMMERCE_STRIPE_PRODUCT_HOSTING_ID`；缺少时商业化配置视为无效（与另外两个 Product 一样）。
- **半自动也占额度**：服务端不再区分 `mode`，一律按 `auto` 持久化并计数。
- **同角色续连**：同一用户重新开启同一角色时直接接管旧会话（`reason=character_takeover`），不提示实例超额。托管永不接管非托管会话：同角色有存活的非托管会话时 launch 返回 `KE_CHARACTER_IN_USE`。
- **被踢原因**：`KE_INSTANCE_KICKED` 的 `error.action` 里带 `{"reason": "quota_kick" | "character_takeover" | "quota_shrunk"}`。
- **超额收敛**：heartbeat 先算资格再算额度，按首次进入 ACTIVE 的时间升序保留，其余被踢，结果持久化、确定。
- **托管 token**（`ke1_` 前缀，独立于设备 token）绑定 `(instance_id, epoch, launch_seq)`，24 小时 TTL（封顶资格到期时间），改派/停止/资格丢失时立即吊销；只在 bind/start/heartbeat/stop 与本实例角色的 `profiles/active` 有效。

## 密钥与登记

```sh
node scripts/generate-ke-secrets.mjs          # 现在会同时生成 KE_HOSTED_CRED_KEY / KE_HOSTED_CRED_KEY_VERSION
wrangler secret put KE_HOSTED_CRED_KEY        # 未配置时托管整体不可用（fail closed）
MYSQL_URL=... node scripts/ke-agent-register.mjs --name vps-1 --pubkey <base64url> --max-instances 40
```

公钥由 VPS 上的 `ke-agent enroll` 生成，私钥不离开 VPS。`max_instances` 以这里为准，agent 自报的容量只作参考。

## 网页：KE 监控台（`/accounts`）

原“菜农监控台”升级为 KE 监控台，两个分区：**离线挂机**（默认）与**官方账号监控**（原有功能，账号只存浏览器）。
离线挂机分区需要登录，展示开通状态与到期日、托管数量/上限、实例额度、需要处理的数量；每个托管角色一张卡片，显示阶段
（排队中/启动中/运行中/等待重连/已停止/需要处理）、最近一次心跳上报的状态快照（等级、HP/SP、负重、地图坐标、金币、AI 模式）、挂机统计（收起时一行摘要：击杀、道具、Zeny 变化和卡片/装备数量，点开看重要掉落、掉落最多、击杀排行、经验与死亡；字段见 KoreEngine `docs/linux-hosting-design.md` 13.3 的 `stats`，Worker 原样保存快照，不需要改库）、
重试倒计时与停止原因；支持启动、停止、删除（二次确认，仅已停止的可删）与添加角色（从“我的 KE”里已绑定的角色中选择，
再填游戏账号/密码并重新输入本站密码）。没有离线挂机功能时，所有可能卡住的位置都直接给出购买入口 `/ke/buy?plan=hosting`：顶部横幅（“立即开通”，到期用户显示“已到期 / 立即续费”）、工具栏（原来灰掉的“添加角色”换成“开通离线挂机”）、空状态、顶部“未开通”小方块、因到期被停止的实例提示（“去续费”）、点启动被拒绝后的提示。购买页带 `plan=hosting` 时直接勾选离线挂机，并且不额外买额度（含免费 1 个，托管数量不超过它），直接打开购买页则保持原默认。页面不自动刷新（快照本来就按 5 分钟心跳更新）。
实现见 `apps/web/src/ke-hosting-panel.ts`；`GET /api/v1/ke/hosted` 的 `eligibility` 增加了 `hosting_expires_at`。

## 接口

面板（会话 cookie，写操作校验 Origin）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/ke/hosted` | 资格与托管列表（含最新状态快照） |
| POST | `/api/v1/ke/hosted` | 登记托管角色；需 `current_password` 重新验证账号密码 |
| POST | `/api/v1/ke/hosted/:id/start` · `/stop` | 启动/停止（每会话每小时 30 次） |
| POST | `/api/v1/ke/hosted/:id/sync-config` | 同步并重载配置：`config_sync_seq` 加 1 并推送所属 agent；实例没有在运行时返回 409 `KE_HOSTED_NOT_RUNNING`。与启动/停止共用限速 |
| DELETE | `/api/v1/ke/hosted/:id` | 删除（须先停止） |

agent（请求签名，直连 `origin.ltsd.ro`）：头 `x-ke-agent` / `x-ke-ts` / `x-ke-nonce` / `x-ke-sig`，
签名内容 `KE-AGENT-V1\nMETHOD\nPATH?QUERY\nts\nnonce\nsha256hex(body)`（Ed25519），时间窗 ±60 秒，nonce 一次性。

| 路径 | 说明 |
| --- | --- |
| `POST /api/v1/ke/agent/lease` | 租约与对账（每 60 秒）；返回属于该 agent 的实例与期望状态（含 `config_sync_seq`，agent 发现它变大就让子进程重新拉取配置）；被围栏时 `fenced:true` |
| `POST /api/v1/ke/agent/instances/:id/launch` | 预占额度并下发启动包（游戏凭据 + 托管 token） |
| `POST /api/v1/ke/agent/instances/:id/token` | 刷新托管 token |
| `POST /api/v1/ke/agent/instances/:id/report` | 上报阶段：`starting/running/backoff/stopping/stopped/error` |
| `POST /api/v1/ke/agent/modules/keys` | agent 级模块密钥（以 `agent_id` 为盐封装，只含 core/network） |

新增错误码：`KE_HOSTING_ENTITLEMENT_REQUIRED`、`KE_EPOCH_STALE`、`KE_CHARACTER_IN_USE`、`KE_CHARACTER_MISMATCH`、`KE_AGENT_FENCED`、
`KE_HOSTED_CAP_REACHED`、`KE_HOSTED_CHARACTER_BUSY`、`KE_HOSTED_EXISTS`、`KE_HOSTED_LIMIT`、`KE_HOSTED_NOT_STOPPED`、`KE_HOSTED_CHARACTER_UNAVAILABLE`、`KE_HOSTED_STOPPING`。

## 即时推送（可选，默认关闭）

面板点“启动/停止”后，最坏要等一个租约周期（60 秒）agent 才会对账。要做到秒级，启用 Durable Object `AgentHub`
（Hibernation WebSocket，每个 agent 一个 DO）。代码已就绪（`apps/worker/src/ke/hosted/agent-hub.ts`，入口已导出），
**但没有改 `wrangler.toml`**：生产配置需要你在能验证部署的环境里自己加（bindings 与 migrations 不会被 `[env.*]` 继承，每个环境都要写）：

```toml
[[durable_objects.bindings]]
name = "AGENT_HUB"
class_name = "AgentHub"

[[migrations]]
tag = "v1-agent-hub"
new_sqlite_classes = ["AgentHub"]
```

启用后：`GET /api/v1/ke/agent/ws`（同样需要请求签名，空 body）升级为 WebSocket；面板启停与 agent 回执会向对应 DO 发
`{"t":"rev"}` 信号，agent 收到后立刻对账。未绑定时该路由返回 501，agent 自动退回 60 秒租约，功能不受影响。
DO 内不使用任何定时器/alarm，保活用 `setWebSocketAutoResponse`（ping→pong 不唤醒 DO，不计费）。

## Cron（`*/5 * * * *`）

`runHostedTick`：agent 故障转移（租约 30 分钟 + 3 分钟余量，带熔断：无健康证据或严格过半 agent 过期时冻结）、
资格扫描、queued 兜底调度、清理。所有步骤幂等（Cron 可能重复或延迟）。

## 已知局限

- 迁移 028 与托管全部 SQL 已在真实 MySQL 8.4 上验证（`tests/integration/ke-hosted-mysql.test.ts`，需要 `MYSQL_TEST_URL` 指向以 `_test` 结尾的库并设置 `AUTH_TEST_DB_ALLOW_RESET=1`）。生产库上线前仍应先在 staging 跑一遍迁移。
- 既有的 `auth-account-flow` / `mysql-upload-*` 集成测试把 MySQL 版本钉死在 8.4.5，换版本会失败，与托管无关。
- 30 天独占不续期、占槽窗口 10 分钟 < license 30 分钟：产品决定保持现状（见 KoreEngine 设计稿 6A.1）。

## 死亡报告（迁移 032）

托管 core 在角色死亡时上传一份结构化报告，用户在托管页「死亡记录」里看结论、HP 曲线和配置建议，并可「一键应用」。
表 `ke_death_reports`：每角色最近 100 条且不超过 90 天（`runHostedTick` 顺带清理）；列表/统计只读索引列，完整报告在 `report_json`。

- `POST /api/v1/ke/instances/:id/death-reports`：托管实例 Bearer；报告 ≤ 256 KiB，每实例每分钟 10 次，同一 `report_key` 幂等；非托管实例 403。
- `GET /api/v1/ke/hosted/:id/death-reports[/:reportKey]`：会话；只能看自己的实例。
- `POST /api/v1/ke/hosted/:id/death-reports/:reportKey/fixes/:fixId`：`{action: apply|undo}`，服务端对该角色当前启用的 profile 做行级补丁
  （期望值不符返回 409 `KE_CONFIG_CHANGED`），并把 `config_sync_seq` 加 1、通知 agent 重载。
- `POST /api/v1/ke/profiles/active/patch`：用户设备 token（不接受托管 token），给脱机 App 用。
- `GET /api/v1/admin/ke/death-stats?days=7|30`：按 地图 × 怪物 × 技能 汇总，不含角色名。

完整说明见 KoreEngine 仓库 `docs/death-report.md`。
