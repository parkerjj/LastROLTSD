# Hyperdrive 数据库连接

Hyperdrive 是现有 MySQL 8 的连接代理，数据库和数据仍在原来的 MySQL 服务器上。无需 schema migration，也不需要搬迁数据或更换 `mysql2`。Hyperdrive 的 MySQL 协议[不支持预处理语句](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)，因此该模式使用 `mysql2.query()` 的占位符转义；二进制参数转为 `Buffer`，拒绝对象与数组参数，避免被扩展成 SQL 片段。源站需保持 MySQL 默认的反斜线转义规则，不要开启 `NO_BACKSLASH_ESCAPES`。直连保留既有 `execute()` 预处理执行。

## 连接模式

`MYSQL_CONNECTION_MODE` 支持以下值：

| 值 | 行为 |
| --- | --- |
| `hyperdrive` | 必须有 `HYPERDRIVE` 绑定；缺少绑定立即报错；连接失败不回退直连 |
| `direct` | 使用原有 `MYSQL_URL`，忽略 Hyperdrive 绑定 |
| `auto` | 有绑定时优先使用 Hyperdrive，否则使用 `MYSQL_URL`；查询失败不换通道重试 |

`wrangler.toml` 中 production、staging 默认设置为 `hyperdrive`，本地默认 `direct`。未指定模式的旧调用兼容为 `auto`。所有 HTTP 请求（含搜索、上传、账号）、Queue 和 Cron 都使用相同的连接选择。驱动连接池仍按每次调用创建并关闭，跨调用的源站连接复用由 Hyperdrive 管理。

Worker 运行时没有可直接读取的、文档化的账户 Paid 标志。本项目不在业务请求里调用账户管理 API 查询套餐。Cloudflare 当前同时向 Free 和 Paid 提供 Hyperdrive，升级后额度会自动调整，详见[官方价格说明](https://developers.cloudflare.com/hyperdrive/platform/pricing/)。连接模式不依赖套餐判断。

## 首次配置 Cloudflare 与 GitHub

1. 在 Cloudflare Dashboard 的 Hyperdrive 中创建 MySQL 配置，填入现有数据库的源站地址、端口、库名和凭据。生产与 staging 分别使用对应的数据库；不要把 staging 绑定到生产库。源站必须满足 Hyperdrive 的 [SSL/TLS](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/) 与[网络要求](https://developers.cloudflare.com/hyperdrive/configuration/firewall-and-networking-configuration/)。
2. **关闭该 Hyperdrive 配置的 Query caching**。账号、权限、付款和上传流程要求及时读取最新状态。Hyperdrive 不会因写入而自动失效读缓存；关闭查询缓存仍可获得连接池收益。依据见[官方缓存说明](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)。
3. 在 GitHub 的 `production` Environment 新增 variable `CLOUDFLARE_HYPERDRIVE_ID`，值为该配置的 32 位十六进制 ID。ID 不是数据库凭据，不需要放入 secret。
4. `MYSQL_CONNECTION_MODE` variable 可省略，workflow 默认 `hyperdrive`。切换直连时设置为 `direct`；恢复 Hyperdrive 时改回 `hyperdrive`。
5. 现有 `CLOUDFLARE_API_TOKEN` 额外需要目标账户的 **Hyperdrive Read** 权限。部署不会创建或修改远端 Hyperdrive 配置；会读取它以检查源站类型为 MySQL 且查询缓存关闭。

保留 GitHub secret `MYSQL_URL`：CI 的 Node 迁移脚本仍直连源站，人工切回直连也使用它。Hyperdrive 模式的 Worker 驱动不会使用该 URL 的凭据，也不会把源站 SSL 参数带到 Worker 与 Hyperdrive 之间。源站 TLS 由 Hyperdrive 配置管理。

workflow 在首次远端写入及数据库迁移前校验连接模式、配置 ID 和远端缓存设置，然后将 ID 写入 CI checkout 的 `wrangler.toml` 对应环境。后续 secret 写入、auth-disabled barrier 和最终发布都使用这个配置。缺少 ID、读取权限或仍开启查询缓存会中止部署。直连模式会移除目标环境的 Hyperdrive 绑定，不要求有 Hyperdrive ID 或读取权限。

## 手动部署配置

以下 PowerShell 命令生成被 Git 忽略的本地部署文件；不改动受版本控制的配置。先在 Cloudflare 创建配置并关闭查询缓存。

```powershell
$ErrorActionPreference = 'Stop'
Copy-Item wrangler.toml wrangler.production.local.toml
$env:MYSQL_CONNECTION_MODE = 'hyperdrive'
$env:CLOUDFLARE_HYPERDRIVE_ID = '<32-character-hyperdrive-id>'
try {
  node scripts/configure-hyperdrive.mjs --environment production --config wrangler.production.local.toml
  if ($LASTEXITCODE -ne 0) { throw 'Hyperdrive configuration failed' }
  pnpm exec wrangler deploy --dry-run --env production --config wrangler.production.local.toml
  # 核实远端 Query caching 已关闭，再使用同一配置执行正式 deploy。
} finally {
  Remove-Item Env:MYSQL_CONNECTION_MODE, Env:CLOUDFLARE_HYPERDRIVE_ID -ErrorAction SilentlyContinue
}
```

staging 使用独立 ID，并把 `--environment` / `--env` 改为 `staging`。手动切回直连时，从仓库配置重新复制部署文件，以 `MYSQL_CONNECTION_MODE=direct` 运行上述配置脚本；不需要提供 Hyperdrive ID。不要把运行时 `--var MYSQL_CONNECTION_MODE:direct` 当成移除远端绑定的替代方案。

## 本地开发与验证

默认本地开发无需 Hyperdrive ID；继续在被忽略的 `.dev.vars` 中配置 `MYSQL_CONNECTION_MODE=direct` 与 `MYSQL_URL`。迁移、导入和真实 MySQL 集成测试继续使用既有配置与隔离数据库保护。

如需在 `wrangler dev` 中测试 Hyperdrive 绑定形状，使用已渲染的命名环境配置，把 `.dev.vars` 中的模式改为 `hyperdrive`，并设置进程环境变量 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`。该字符串使用 Wrangler 支持的 MySQL URL（TLS 示例为 `?sslMode=REQUIRED`）；本项目直连 URL 的 `?ssl=true` 仅供既有直连解析器使用，两者不要混用。不要把真实 URL 提交到 TOML。[本地开发文档](https://developers.cloudflare.com/hyperdrive/configuration/local-development/)说明本地模拟直连数据库，并不经过远端 Hyperdrive 连接池。

`GET /api/health` 仍只有执行真实 `SELECT 1` 成功后才返回 `db: "ok"`，不会返回连接地址和凭据。上线后必须请求生产健康检查并验证账号、搜索和上传。单元测试与 Wrangler dry-run 只能证明连接选择及打包，不能代替边缘连接验证。

仅绑定 Hyperdrive、不提供 `MYSQL_URL` 的 Worker 同样可运行；此时搜索的 Cache API 缓存会旁路，避免用会变化的 Hyperdrive 虚拟主机/凭据作为数据库身份。既有 CI 保留源站 URL，因此仍可利用现有 30 秒搜索缓存。切换 Hyperdrive 的源站时，同步更新 `MYSQL_URL` 或 `BUILD_VERSION`，避免复用旧库的搜索缓存。该 Cache API 缓存与已关闭的 Hyperdrive SQL 查询缓存独立。
