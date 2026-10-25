# KE 构建自动登记与发布顺序

## 登记流程

`POST /api/v1/ke/builds/register` 只接受指定 KE GitHub Actions 生产 job 的 OIDC 凭证，不接受玩家 token、cookie 或普通账号登录。服务端验证 GitHub 签名、短期有效期、不可变仓库/所有者 ID、main、production、指定 workflow、commit/run/attempt；audience 还绑定完整登记 JSON 的 SHA-256，凭证不能替换成另一组指纹使用。

登记内容包含 buildId、core 密文 SHA-256、源码 SHA、packageId、engineVersion、Release tag 和 CoreKey 版本，不包含任何解密密钥。服务端要求 CoreKey 版本与线上配置一致。

脱机版（standalone）构建额外携带 `network_sha256`、`network_key_version`、`standalone_package_id` 三个字段，服务端要求 `network_key_version` 与线上 `KE_NETWORK_KEY_VERSION` 一致。三个字段必须同时出现；旧 web 构建一个都不带，登记内容与 audience 完全不变。`ke_builds.kind` 记录 `web` / `standalone`，同一次 GitHub run 可以同时登记这两个构建（唯一键包含 kind）。

KE 必须先完成生产包校验，登记并核对服务端成功回执，才可正式发布 GitHub Release。登记超时、认证失败、数据库失败、返回内容不符或冲突，一律终止发布。

## 数据库与首次启用

迁移 `020_ke_build_registry.sql` 新增：

- `ke_builds`：构建指纹与来源、ACTIVE/REVOKED 状态、登记与撤销时间。
- `ke_build_policy`：单行持久化 enforced 标志。

迁移 `021_ke_standalone_modules.sql` 追加脱机版字段：

- `kind`（`web` / `standalone`，旧行默认 `web`）；
- `network_sha256`、`network_key_version`、`standalone_package_id`；
- 唯一键改为 `(publisher_run_id, publisher_run_attempt, kind)` 与 `(release_tag, kind)`，
  允许同一发布 run 同时登记 web 与 standalone。

首次部署时 enforced=0，保持之前的静态清单/未配置行为。第一次可信登记在同一事务内写入构建并设置 enforced=1，之后数据库成为唯一白名单来源，旧 `KE_BUILD_MANIFEST` 不再参与解析和判定。

**首次成功登记后，未登记的旧包和 local-debug 将在下一次 bind/start/heartbeat 被拒绝。** 如有仍需保留的正式构建，应在切换前准备其可信登记；不要把任意本地调试包登记为生产构建。

enforced=1 后缺失构建、hash不符或REVOKED返回 `403 KE_BUILD_REJECTED`；数据库/策略表异常返回503，不会自动退回放行。清空 `ke_builds` 也不会关闭策略。

## 幂等与撤销

同一 buildId 的相同内容允许重复登记；同一 buildId 内容不同、同一个 run/attempt 登记另一构建、已撤销构建重试，全部返回409。普通登记永远不能将 REVOKED 改回 ACTIVE。

本次不新增管理UI。维护者可在生产数据库对指定 buildId 执行受控撤销：将 status 设为 REVOKED，同时记录 revoked_at 毫秒时间。不要删除 policy 行或通过清空表试图关闭策略。撤销在该构建下次授权/心跳检查时生效，已有 lease 的行为仍遵守现有授权机制。

## 部署与配置

首次上线需要先执行迁移，再部署 LTSD。后续每次 KE 发布只登记一条数据库记录，不需要重编译/部署 LTSD，也不需要更新 GitHub/Worker 的 KE_BUILD_MANIFEST secret。

现有 license 私钥和 CoreKey 不变；OIDC 不需要新增长期登记密码或把 Cloudflare 管理凭证交给 KE。生产登记接口仅对可信 GitHub job 开放；真实正向 OIDC 联调需要在 KE main Actions 中进行，不能在本机伪造 GitHub 签名。
