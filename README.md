# LastROWeb

LastROWeb is a Cloudflare Worker + Hono market API with a Vite query UI. Production market state uses MySQL 8 through `mysql2`; the Worker has no D1 binding or SQLite runtime fallback. The OpenKore adapter remains outside this repository.

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

See [deployment](docs/deployment.md), [MySQL migration](docs/mysql-migration.md), [operations](docs/operations.md), and the [API contract](docs/api.md).
