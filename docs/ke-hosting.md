# KE 离线挂机（服务器托管）— LTSD 侧

设计与不变量的权威版本在 KoreEngine 仓库的 `docs/linux-hosting-design.md`（第 5–11 节与 6A）。本文只记录 LTSD 侧的接口、数据与运维。

## 数据（迁移 028）

`ke_agents`（VPS）、`ke_agent_nonces`（请求防重放）、`ke_hosted_credentials`（游戏账号明文 + 密码 AES-GCM 密文）、
`ke_hosted_instances`（托管记录、归属、epoch）、`ke_hosted_tokens`（托管 token）、`ke_instance_status`（最新状态快照）；
`ke_instances.kick_reason`。迁移同时把既有 `mode='manual'` 的实例改成 `auto`。

## 规则摘要

- **托管资格**：非 `signup` 来源的有效 `slots` 之和 ≥ 1 且拥有 `module:core`（管理员赠送也算）。**全有或全无**：失去资格后所有托管实例停止，一个都不保留，重新购买后不自动恢复。
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

## 接口

面板（会话 cookie，写操作校验 Origin）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/ke/hosted` | 资格与托管列表（含最新状态快照） |
| POST | `/api/v1/ke/hosted` | 登记托管角色；需 `current_password` 重新验证账号密码 |
| POST | `/api/v1/ke/hosted/:id/start` · `/stop` | 启动/停止（每会话每小时 30 次） |
| DELETE | `/api/v1/ke/hosted/:id` | 删除（须先停止） |

agent（请求签名，直连 `origin.ltsd.ro`）：头 `x-ke-agent` / `x-ke-ts` / `x-ke-nonce` / `x-ke-sig`，
签名内容 `KE-AGENT-V1\nMETHOD\nPATH?QUERY\nts\nnonce\nsha256hex(body)`（Ed25519），时间窗 ±60 秒，nonce 一次性。

| 路径 | 说明 |
| --- | --- |
| `POST /api/v1/ke/agent/lease` | 租约与对账（每 60 秒）；返回属于该 agent 的实例与期望状态；被围栏时 `fenced:true` |
| `POST /api/v1/ke/agent/instances/:id/launch` | 预占额度并下发启动包（游戏凭据 + 托管 token） |
| `POST /api/v1/ke/agent/instances/:id/token` | 刷新托管 token |
| `POST /api/v1/ke/agent/instances/:id/report` | 上报阶段：`starting/running/backoff/stopping/stopped/error` |
| `POST /api/v1/ke/agent/modules/keys` | agent 级模块密钥（以 `agent_id` 为盐封装，只含 core/network） |

新增错误码：`KE_HOSTING_ENTITLEMENT_REQUIRED`、`KE_EPOCH_STALE`、`KE_CHARACTER_IN_USE`、`KE_CHARACTER_MISMATCH`、`KE_AGENT_FENCED`、
`KE_HOSTED_CAP_REACHED`、`KE_HOSTED_CHARACTER_BUSY`、`KE_HOSTED_EXISTS`、`KE_HOSTED_LIMIT`、`KE_HOSTED_NOT_STOPPED`、`KE_HOSTED_CHARACTER_UNAVAILABLE`。

## Cron（`*/5 * * * *`）

`runHostedTick`：agent 故障转移（租约 30 分钟 + 3 分钟余量，带熔断：无健康证据或严格过半 agent 过期时冻结）、
资格扫描、queued 兜底调度、清理。所有步骤幂等（Cron 可能重复或延迟）。

## 已知局限

- MySQL 集成测试（`tests/integration/*-mysql.test.ts`）需要 `MYSQL_TEST_URL`；托管的 SQL 目前只有内存假仓库的单元测试覆盖，上线前必须在真实 MySQL 上跑一遍。
- 30 天独占不续期、占槽窗口 10 分钟 < license 30 分钟：产品决定保持现状（见 KoreEngine 设计稿 6A.1）。
