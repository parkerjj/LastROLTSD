# Deployment runbook

LastROWeb deploys as one Cloudflare Worker with static Vite assets and a D1 database. Wrangler creates and deploys the Worker; do not create a separate Cloudflare Pages project and do not enable Cloudflare's native Git integration. GitHub Actions is the only automatic production deployment path.

All command examples in this runbook use PowerShell. Run them from the repository root with Node.js 24.x and pnpm 12.4.2 available on `PATH`.

## Prerequisites and local verification

```powershell
$ErrorActionPreference = 'Stop'
Set-Location 'D:\Development\LastROWeb'
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm secrets:generate
pnpm exec wrangler d1 migrations apply lastroweb-local --local
pnpm --filter web build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:docs
pnpm exec playwright install chromium webkit
pnpm playwright test
pnpm exec wrangler dev --local
```

The Node version must be 24.x and pnpm must be 12.4.2. The Wrangler command is the production-shaped local server; `pnpm dev` runs only Vite and is useful for UI work. The build intentionally runs before `pnpm test` because `apps/web/test/build.test.ts` verifies the generated SPA document.

`pnpm secrets:generate` creates `.dev.vars` and `.deployment-secrets.local`. Both are ignored by Git. It refuses to overwrite them unless `--force` is explicitly supplied; forcing rotation invalidates every previously distributed source key. Never paste either file into an issue, log, commit, or chat.

To exercise authenticated uploads locally, load the generated local values without printing them:

```powershell
$ErrorActionPreference = 'Stop'
$localVars = Get-Content '.dev.vars' | ConvertFrom-StringData
$env:MARKET_SOURCE_ID = 'local-primary'
$env:MARKET_SOURCE_NAME = 'Local primary source'
$env:MARKET_SOURCE_API_KEY_SHA256 = $localVars.UPLOAD_API_KEY_SHA256
pnpm cf:source-seed -- --output source-seed.local.sql
pnpm exec wrangler d1 execute lastroweb-local --local --file source-seed.local.sql
Remove-Item Env:MARKET_SOURCE_ID, Env:MARKET_SOURCE_NAME, Env:MARKET_SOURCE_API_KEY_SHA256
```

Use `UPLOAD_API_KEY` from `.dev.vars` as the local Bearer token. The SQL file contains only its SHA-256 hash.

## One-time Cloudflare setup

Authenticate interactively from PowerShell for initial setup:

```powershell
$ErrorActionPreference = 'Stop'
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler d1 create lastroweb-production
```

Record the returned D1 UUID outside the repository. Render a temporary production config without committing it:

```powershell
$ErrorActionPreference = 'Stop'
$env:CLOUDFLARE_D1_DATABASE_ID = '<D1 UUID>'
pnpm cf:config -- --input wrangler.toml --output wrangler.production.local.toml --environment production
Remove-Item Env:CLOUDFLARE_D1_DATABASE_ID
```

Apply migrations before seeding the source:

```powershell
$ErrorActionPreference = 'Stop'
pnpm exec wrangler d1 migrations apply lastroweb-production --remote --env production --config wrangler.production.local.toml
```

Load the generated deployment values without printing them, render an idempotent SQL seed containing only the hash, and apply it:

```powershell
$ErrorActionPreference = 'Stop'
$deploymentSecrets = Get-Content '.deployment-secrets.local' | ConvertFrom-StringData
$env:MARKET_SOURCE_ID = 'primary'
$env:MARKET_SOURCE_NAME = 'Primary market source'
$env:MARKET_SOURCE_API_KEY_SHA256 = $deploymentSecrets.PRODUCTION_SOURCE_API_KEY_SHA256
pnpm cf:source-seed -- --output source-seed.production.local.sql
pnpm exec wrangler d1 execute lastroweb-production --remote --env production --config wrangler.production.local.toml --file source-seed.production.local.sql
Remove-Item Env:MARKET_SOURCE_ID, Env:MARKET_SOURCE_NAME, Env:MARKET_SOURCE_API_KEY_SHA256
```

Only `PRODUCTION_SOURCE_API_KEY` is given to the external uploader. The Worker authenticates it by comparing its SHA-256 hash with `market_sources.api_key_hash`; `UPLOAD_API_KEY` is not a Worker runtime binding.

Configure the two Worker secrets. These persist across normal deployments:

```powershell
$ErrorActionPreference = 'Stop'
$deploymentSecrets = Get-Content '.deployment-secrets.local' | ConvertFrom-StringData
$deploymentSecrets.PRODUCTION_CURSOR_SECRET | pnpm exec wrangler secret put CURSOR_SECRET --env production --config wrangler.production.local.toml
$deploymentSecrets.PRODUCTION_ADMIN_SECRET | pnpm exec wrangler secret put ADMIN_SECRET --env production --config wrangler.production.local.toml
```

The cursor secret is mandatory in production. The admin secret enables the retention preview endpoint and should remain private.

## First manual deployment

```powershell
$ErrorActionPreference = 'Stop'
pnpm --filter web build
pnpm exec wrangler deploy --env production --config wrangler.production.local.toml
```

Use the deployed URL returned by Wrangler:

```powershell
Invoke-RestMethod -Uri 'https://<worker-host>/api/health' -Method Get
Invoke-RestMethod -Uri 'https://<worker-host>/api/v1/market/search?limit=1' -Method Get
```

Perform a redacted smoke upload using the documented fixture and the production source key only from a secure local shell. Never put the key on a command line that will be saved to shell history; prefer an environment variable and an `Authorization` header assembled by the shell.

## Catalog Release

Catalog data is generated offline from an explicitly supplied file or directory. The importer does not access the network, does not modify source files, writes production SQL only below the Git-ignored `.generated\` directory, and never deletes or rewrites listings.

Validate first, then generate the reviewed release:

```powershell
$ErrorActionPreference = 'Stop'
$inputFile = 'C:\path\to\catalog-items.txt'
$version = 'catalog-2026-09-19'
$outputDir = Join-Path '.generated' ('catalog\' + $version)
pnpm catalog:import -- --input-file $inputFile --kind items --version $version --encoding auto --output-dir $outputDir --dry-run
pnpm catalog:import -- --input-file $inputFile --kind items --version $version --encoding auto --output-dir $outputDir
$manifest = Get-Content (Join-Path $outputDir ('catalog-items-' + $version + '.manifest.json')) -Raw | ConvertFrom-Json
$manifest | Format-List dataVersion,inputChecksum,dataChecksum,outputChecksum,itemCount,aliasCount,errorCount
Get-FileHash (Join-Path $outputDir ('catalog-items-' + $version + '.sql')) -Algorithm SHA256
```

Review the manifest and SQL before applying them. The output is stable by item ID and normalized alias. The SQL uses bounded statements, updates only submitted item IDs and derived rows, and can be applied repeatedly without clearing existing listings.

Apply a reviewed release locally or remotely only after the catalog migrations are present:

```powershell
$ErrorActionPreference = 'Stop'
$sqlFile = '.generated\catalog\catalog-2026-09-19\catalog-items-catalog-2026-09-19.sql'
pnpm exec wrangler d1 execute lastroweb-local --local --file $sqlFile
```

For production, use the reviewed production config and an explicit maintenance approval:

```powershell
$ErrorActionPreference = 'Stop'
$sqlFile = '.generated\catalog\catalog-2026-09-19\catalog-items-catalog-2026-09-19.sql'
pnpm exec wrangler d1 execute lastroweb-production --remote --env production --config wrangler.production.local.toml --file $sqlFile
```

Verify the active version and a sample of names after the apply:

```powershell
$ErrorActionPreference = 'Stop'
pnpm exec wrangler d1 execute lastroweb-production --remote --env production --config wrangler.production.local.toml --command "SELECT current_version FROM catalog_state WHERE id = 1; SELECT item_id,canonical_name_zh,data_version FROM item_catalog ORDER BY item_id LIMIT 20;"
```

## GitHub Actions automatic deployment

The repository workflow `.github/workflows/ci.yml` verifies pull requests and pushes to `main`. On a push to `main`, the `deploy-production` job runs only after lint, typecheck, unit/integration tests, documentation checks, web build, and Playwright pass. It then applies D1 migrations and deploys the Worker and assets.

Create a GitHub environment named `production`. Add these environment secrets:

- `CLOUDFLARE_API_TOKEN`: a scoped token with Account / Workers Scripts / Edit and Account / D1 / Edit for the selected account.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.
- `CLOUDFLARE_D1_DATABASE_ID`: the UUID returned by `wrangler d1 create`.

No application key or Worker runtime secret is required in GitHub after the one-time Wrangler secret setup. Optionally add required reviewers to the GitHub `production` environment; this pauses the deploy job after verification until approved.

Pushes are intentionally not performed by setup scripts. Review and merge the deployment branch into `main`; the resulting `main` push triggers production deployment. Do not separately configure Cloudflare to watch the repository, because that would create a second competing deploy path.

## Staging

Repeat the same flow using `lastroweb-staging`, `--environment staging`, `--env staging`, and the `STAGING_*` generated values. Keep a separate D1 database and source API key. A staging deployment must pass the health, upload, search, history, retention-preview, and catalog-release smoke checks before production changes.

## Rollback and migration safety

Use Cloudflare Workers Deployments in the dashboard or Wrangler's version/deployment commands to promote a previously known-good Worker version. Record the deployed commit SHA and Cloudflare version for every release. A Worker rollback does not roll back D1 schema or catalog data; use reviewed forward migrations for database correction.

To roll back catalog data, stop new catalog imports, select the previously reviewed SQL and manifest pair kept outside Git, apply that SQL in a controlled maintenance window, and verify `catalog_state`, item names, aliases, and listing counts:

```powershell
$ErrorActionPreference = 'Stop'
$knownGoodSql = 'C:\secure\catalog-releases\catalog-items-catalog-2026-09-18.sql'
pnpm exec wrangler d1 execute lastroweb-production --remote --env production --config wrangler.production.local.toml --file $knownGoodSql
pnpm exec wrangler d1 execute lastroweb-production --remote --env production --config wrangler.production.local.toml --command "SELECT current_version FROM catalog_state WHERE id = 1; SELECT COUNT(*) AS listings FROM listings;"
```

Do not delete or rewrite a production migration, reset the database, or roll back catalog rows by deleting listings. Before schema changes or retention-policy changes, create and verify a D1 export. Retention defaults to 90 days for history and sold events and never deletes current listings. Longer retention or substantially higher upload volume requires a D1 quota and cost review.

## Custom domain

The initial `workers.dev` URL is sufficient. Add a custom domain later in the Cloudflare Worker settings after the first healthy deployment. A custom domain is routing configuration, not a separate Pages project.
