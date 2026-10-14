# LastROWeb

LastROWeb is a Cloudflare Worker + Hono market API with a Vite query UI. Production market state uses MySQL 8 through `mysql2`; the Worker has no D1 binding or SQLite runtime fallback. The Kore adapter remains outside this repository.

## Local development

All commands below are PowerShell commands run from the repository root.

```powershell
$ErrorActionPreference = 'Stop'
corepack enable
pnpm install --frozen-lockfile
pnpm secrets:generate
# Edit the ignored .dev.vars and replace MYSQL_URL with the authorized VPS MySQL 8 URL.
pnpm db:mysql:migrate
pnpm --filter web build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:docs
pnpm exec wrangler dev --local
```

`.dev.vars.example` contains safe placeholders for `MYSQL_URL` and the optional `MYSQL_TEST_URL`; do not commit the generated `.dev.vars`. `GET /api/health` reports `db: "ok"` only after a real `SELECT 1`; an unconfigured local URL reports `db: "unconfigured"`.

## Entrypoints

- `POST /api/v1/market/upload` — authenticated, idempotent market upload
- `GET /api/v1/market/search` — current listing search
- `GET /api/v1/market/listings/:id/history` — bounded price/quantity history
- `GET /api/v1/options` — static option dictionary
- `GET /api/health` — Worker and MySQL health
- `/account`, `/register`, `/login` — player account pages; authentication is disabled by default
- `/api/v1/auth/*`, `/api/v1/account/*` — player account API; authentication is disabled by default

See [deployment](docs/deployment.md), [MySQL migration](docs/mysql-migration.md), [operations](docs/operations.md), and the [API contract](docs/api.md).

The player account pages and API are implemented, but authentication remains disabled by default. See the [account operations](docs/operations.md#account-mail-and-cleanup) for enablement and CPU-verification conditions, along with the [account system specification](docs/superpowers/specs/2026-10-12-ltsd-account-system-design.md), reviewed [implementation plan](docs/superpowers/plans/2026-10-12-ltsd-account-system-plan.md), [review record](docs/superpowers/plans/2026-10-12-ltsd-account-system-plan-review.md), and [development handoff prompt](docs/superpowers/plans/2026-10-12-ltsd-account-system-development-prompt.md).

***

# LastROWeb（中文）

LastROWeb 是一个基于 Cloudflare Worker + Hono 的市场 API，配合 Vite 查询界面使用。生产环境的市场数据使用 MySQL 8（通过 `mysql2` 连接）；Worker 没有 D1 绑定，也没有 SQLite 运行时回退。Kore 适配器不在本仓库中维护。

## 本地开发

以下命令均为在仓库根目录执行的 PowerShell 命令。

```powershell
$ErrorActionPreference = 'Stop'
corepack enable
pnpm install --frozen-lockfile
pnpm secrets:generate
# 编辑被忽略的 .dev.vars，将 MYSQL_URL 替换为已授权的 VPS MySQL 8 连接地址。
pnpm db:mysql:migrate
pnpm --filter web build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:docs
pnpm exec wrangler dev --local
```

`.dev.vars.example` 中包含 `MYSQL_URL` 和可选的 `MYSQL_TEST_URL` 的安全占位符；请勿提交生成的 `.dev.vars`。`GET /api/health` 只有在真实执行 `SELECT 1` 成功后才会返回 `db: "ok"`；本地未配置连接地址时返回 `db: "unconfigured"`。

## 入口端点

- `POST /api/v1/market/upload` — 需要鉴权、幂等的市场数据上传
- `GET /api/v1/market/search` — 当前在售列表搜索
- `GET /api/v1/market/listings/:id/history` — 有上限的价格/数量历史
- `GET /api/v1/options` — 静态词条字典
- `GET /api/health` — Worker 与 MySQL 健康检查
- `/account`、`/register`、`/login` — 玩家账号页面；认证默认关闭
- `/api/v1/auth/*`、`/api/v1/account/*` — 玩家账号接口；认证默认关闭

详见[部署文档](docs/deployment.md)、[MySQL 迁移](docs/mysql-migration.md)、[运维手册](docs/operations.md)与 [API 契约](docs/api.md)。

玩家账号页面与API已实现，但认证默认关闭。启用与CPU验证条件见[账号运维说明](docs/operations.md#account-mail-and-cleanup)，设计见[账号系统规格](docs/superpowers/specs/2026-10-12-ltsd-account-system-design.md)，详细步骤见已审阅的[实施计划](docs/superpowers/plans/2026-10-12-ltsd-account-system-plan.md)、[Review记录](docs/superpowers/plans/2026-10-12-ltsd-account-system-plan-review.md)及[开发交接Prompt](docs/superpowers/plans/2026-10-12-ltsd-account-system-development-prompt.md)。
