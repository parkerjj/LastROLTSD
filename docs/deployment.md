# Deployment runbook

LastROWeb deploys one Cloudflare Worker plus Vite assets. Its only production database configuration is the `MYSQL_URL` Worker secret. Do not use Hyperdrive, an HTTP database proxy, or a D1 fallback.

All examples are PowerShell and must be run from the repository root. Never put a real password, token, API key, or connection URL in the repository, a command line, a log, or a screenshot.

## Prepare MySQL 8 on the VPS

Use a dedicated MySQL 8 database and least-privilege application user. Restrict the MySQL firewall and `bind-address`/user host to the Cloudflare egress ranges or other deliberately approved network path; do not expose a broad administrative account. Require TLS if the VPS supports it, use a CA trusted by the Worker, and use a public DNS name rather than a private/loopback address.

At an interactive MySQL administrator prompt, create the database and a dedicated user with only the privileges needed for application DDL/DML. Do not paste the password into a saved script. The Worker URL format is:

`mysql://user:password@mysql.example.com:3306/lastroweb?ssl=true`

Percent-encode reserved characters in the username or password. `ssl=true` means the client requires certificate verification; it is not a substitute for a reachable public host and valid VPS firewall rules.

## Local setup and verification

Generate ignored local variables, then replace the `MYSQL_URL` placeholder in `.dev.vars` with the authorized VPS URL. Local Worker development intentionally uses that MySQL server; it does not create a local SQLite/D1 database.

```powershell
$ErrorActionPreference = 'Stop'
pnpm install --frozen-lockfile
pnpm secrets:generate
$localVars = Get-Content '.dev.vars' | ConvertFrom-StringData
$env:MYSQL_URL = $localVars.MYSQL_URL
try {
  pnpm db:mysql:migrate
  pnpm db:mysql:migrate -- --dry-run
  pnpm --filter web build
  pnpm exec wrangler dev --local
} finally {
  Remove-Item Env:MYSQL_URL -ErrorAction SilentlyContinue
}
```

The migration runner creates `schema_migrations`, applies each `migrations/mysql/*.sql` file exactly once, and rejects a changed checksum. Its `--dry-run` performs a connection check and validates migration files without changing schema.

## First source seed

Create the source row only after the schema migration. The renderer writes an idempotent MySQL `ON DUPLICATE KEY UPDATE` statement containing the SHA-256 hash, not the raw upload key.

```powershell
$ErrorActionPreference = 'Stop'
$localVars = Get-Content '.dev.vars' | ConvertFrom-StringData
$env:MYSQL_URL = $localVars.MYSQL_URL
$env:MARKET_SOURCE_ID = 'primary'
$env:MARKET_SOURCE_NAME = 'Primary market source'
$env:MARKET_SOURCE_API_KEY_SHA256 = '<64-lowercase-hex-hash>'
try {
  pnpm db:mysql:source-seed -- --output .generated\mysql\source-seed.sql
  pnpm db:mysql:import -- --input .generated\mysql\source-seed.sql
} finally {
  Remove-Item Env:MYSQL_URL, Env:MARKET_SOURCE_ID, Env:MARKET_SOURCE_NAME, Env:MARKET_SOURCE_API_KEY_SHA256 -ErrorAction SilentlyContinue
}
```

Keep the raw upload key only in the uploader's secret store. Do not set it as a Worker secret.

## Cloudflare and GitHub configuration

Create the GitHub Environment named `production` with exactly these deployment secrets:

- `MYSQL_URL`
- `GUESTBOOK_RATE_SECRET`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The workflow installs, builds, lints, type-checks, tests, applies the idempotent MySQL migration, performs a MySQL dry-run connection check, passes `MYSQL_URL` and `GUESTBOOK_RATE_SECRET` to `wrangler secret put` through standard input, then deploys. A migration or connection failure prevents deployment. It never prints either secret and no longer runs D1 migrations or reads a D1 database ID.

Configure the other Worker secrets (`CURSOR_SECRET`, `ADMIN_SECRET`) independently through a secure local terminal. Do not place their values in GitHub workflow YAML or Wrangler TOML. `MYSQL_URL` is intentionally absent from both Wrangler configuration files.

## D1 export and MySQL data migration

Keep an immutable, ignored original dump before any cutover. Wrangler credentials must already be configured; the export tool runs `wrangler whoami` first and does not print its token.

```powershell
$ErrorActionPreference = 'Stop'
pnpm db:d1:export -- --database '<old-d1-database-name>' --output .generated\d1\production.sqlite.sql
node scripts/convert-sqlite-to-mysql.mjs --input .generated\d1\production.sqlite.sql --output .generated\mysql\production.data.sql --data-only
$localVars = Get-Content '.dev.vars' | ConvertFrom-StringData
$env:MYSQL_URL = $localVars.MYSQL_URL
try {
  pnpm db:mysql:migrate
  pnpm db:mysql:import -- --input .generated\mysql\production.data.sql --dry-run
  pnpm db:mysql:import -- --input .generated\mysql\production.data.sql
  pnpm db:mysql:verify
} finally {
  Remove-Item Env:MYSQL_URL -ErrorAction SilentlyContinue
}
```

The converter is streaming and fails instead of silently dropping unsupported SQLite statements. The importer refuses `DROP DATABASE`; replacing existing data additionally requires both `--replace-existing` and `--confirm-replace-existing`. The verifier checks all six tables, maximum IDs, required unique keys, foreign keys, nullable values, and Chinese samples. Preserve the original D1 dump outside Git for rollback and auditing.

## Static catalog release

The catalog is a static JSON asset, not a database table. Generate the reviewed JSON files and rebuild the web assets; do not submit catalog SQL to MySQL or D1. See [catalog import](catalog-import.md).

## Worker raw-TCP readiness

This repository has verified that `mysql2/promise` bundles with Wrangler and that `wrangler dev --local` starts. The current Worker compatibility date retains `nodejs_compat`. Cloudflare documents native `node:net` support backed by Worker TCP sockets, but the project has not yet performed a deployed edge `SELECT 1` against the user VPS because no authorized real MySQL test URL was supplied. Therefore do not claim an actual production cutover yet: run the dedicated MySQL integration test and a deployed `/api/health` check first.

The optional integration test is deliberately isolated from the normal local URL:

```powershell
$ErrorActionPreference = 'Stop'
$localVars = Get-Content '.dev.vars' | ConvertFrom-StringData
$env:MYSQL_TEST_URL = $localVars.MYSQL_TEST_URL
$env:ALLOW_MYSQL_TEST_DESTRUCTIVE = '1'
try {
  pnpm exec vitest run tests/integration/catalog-upload-search-flow.test.ts
} finally {
  Remove-Item Env:MYSQL_TEST_URL, Env:ALLOW_MYSQL_TEST_DESTRUCTIVE -ErrorAction SilentlyContinue
}
```

Use a dedicated test database only; the test creates then removes an isolated source row. Never point `MYSQL_TEST_URL` at production.

## Rollback

Worker deployment rollback changes Worker code only. It does not roll back MySQL schema or imported data. Preserve the D1 dump and the converter output, take a VPS MySQL backup before importing, and use reviewed forward MySQL migrations to repair schema. Do not reset a production database, delete a migration record, or run `DROP DATABASE`.
