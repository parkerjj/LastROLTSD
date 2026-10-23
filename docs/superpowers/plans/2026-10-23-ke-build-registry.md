# KE 自动构建登记实施设计与计划

用户已明确批准：先实现并部署 LTSD，再修改 KE 发布脚本；登记失败不得发布正式 Release。复用 MySQL，使用 GitHub OIDC，不新增长期登记密码，不向 KE 提供 Cloudflare 管理权限。不提交或 push KE/RoBrowser。

## 接口与安全约束

- `POST /api/v1/ke/builds/register`，JSON 上限 8 KiB。仅接受 GitHub OIDC Bearer；不使用玩家 token/cookie，也不走玩家 CSRF。
- Payload 固定字段：`build_id`、`core_sha256`、`commit_sha`、`package_id`、`engine_version`、`release_tag`、`core_key_version`。build_id 最长64、hash为小写hex64、commit为hex40、版本正整数。
- Audience 为 `ltsd-ke-build-registration:` 加上述 payload 按键排序的 JSON SHA-256，将短期凭证绑定本次完整登记内容。
- 仅接受 GitHub issuer、RS256、有效期内的 token，且 repo_id=`1421979322`、owner_id=`1243976`、repository=`parkerjj/KoreEngine`、main、production、指定 `ci-release.yml@refs/heads/main`、push/workflow_dispatch、github-hosted runner。
- 校验 payload.commit_sha 与 claims.sha/workflow_sha 一致；release_tag 为 `ke-<sha>-<run_id>-<run_attempt>`，build_id 为 `<shortsha>-<12位UTC时间>-<run_id>-<run_attempt>`。支持 GitHub 普通与 immutable subject，但不能仅信任可改名的 repo 名。
- JWKS 只从 GitHub 固定 HTTPS URL 获取，限体积、超时、密钥类型；验证失败不访问登记写入。不得日志记录 token。
- 同 build_id 的同一登记幂等成功，内容不同返回409；revoked 不可恢复；同run/attempt唯一，防止复用凭证登记第二个构建。
- 登记响应必须明确 registered=true、registry_enforced=true，并回显已落库的身份/指纹；KE 必须逐字段核对。

## 数据库与首次上线

新增 migration `020_ke_build_registry.sql`，仅新增 `ke_builds` 和单行 `ke_build_policy`。初始 enforced=0 保留当前静态/未配置行为；首次可信登记在同一事务内写记录并将 enforced=1。不能因构建表清空、SQL失败或请求缺字段而恢复放行。

登记事务锁 policy 单行，验证既有记录，再插入/确认构建并启用 policy。授权检查用一个 SELECT 左连接 policy/build，在 enforced=1 时必须匹配 ACTIVE/hash；数据库异常503。原静态清单只在 bootstrap 使用；enforced=1 后不再读取或解析旧 secret，数据库为唯一权威，异常不得回退。

部署前核对生产 MySQL target、已应用 migration checksum、Cloudflare 当前 bindings/config；只新增本次 migration，不擅自执行无关待执行 migration。部署保留现有 vars、secrets、Hyperdrive/queue/资产配置；不运行既有 auth-disabled barrier，不修改账号/密钥。

## 分工与步骤

### 1. OIDC 模块

- [x] `apps/worker/src/ke/build-publisher.ts`：导出 BuildRegistration、validateBuildRegistration、buildRegistrationAudience、verifyGithubBuildPublisher。
- [x] `apps/worker/test/ke-build-publisher.test.ts`：真实RSA签名测试，错误签名、时间、aud、repo/ref/workflow/env/run/body绑定、JWKS失败都拒绝。

### 2. 登记与授权

- [x] migration、build-registry repository、独立 register router；在玩家 KE middleware 前注册。
- [x] createKeService 加可选异步 fingerprint guard，生产 router 传 DB guard；原静态校验保留，stop 不因版本撤销被阻止。
- [x] 事务幂等/冲突/撤销、首次启用、未知build、DB失败、API无效凭证测试；真实隔离MySQL验证迁移与并发。

### 3. 先部署 LTSD

- [x] 定向验证和独立安全 review，构建+deploy dry-run。
- [x] 执行新增 migration，部署保留线上配置的 Worker；验证健康、未认证登记拒绝、policy bootstrap 状态。
- [x] 正向真实 GitHub OIDC 登记需要后续 main Actions，不伪造线上成功测试。

### 4. 后改 KE

- [x] LTSD部署确认后新增登记 helper+测试；workflow release job 赋 id-token:write，在 draft→正式之前取得绑定payload的OIDC，调用登记并逐字段确认。
- [x] 任何超时、非成功、格式/回显不符都失败；不执行正式publish。重试只复用同一登记内容。
- [x] 更新操作文档、记录线上部署版本与未运行真实KE发布的限制。

## 实施与部署记录

- 生产执行020，schema checksum已匹配；只新增2表，policy=0/builds=0，未登记伪造生产构建。
- 2026-10-23 部署 Worker 版本 `c0657a8d-6a4b-4a41-bfb2-d6801d9a78cd`；回滚前版本 `250e0cb3-3569-4cde-a6c4-f03c0f4167f3`。
- 线上 health200/dbok；无凭证/伪造凭证401、非法JSON400、超限413；vars/secret绑定/Hyperdrive保持一致。
- LTSD973测试通过/38跳过；含OIDC52与真实隔离MySQL4，typecheck/lint/docs通过；两项review P2已修复并复审。
- LTSD部署确认后才修改KE：helper5定向测试、CLI失败exit1、跨仓真实RSA+路由+隔离MySQL联调、发布相关Node25通过及actionlint通过。
- 正向真实GitHub OIDC登记留待main Actions，未运行真实KE发布。没有push，源码变更仍需提交合入以免后续旧代码部署覆盖本次线上功能。
