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

## Async full upload rollout

This change was implemented with static verification only, as requested. No local
MySQL installation, database migration, Queue creation, or deployment was performed.
Runtime SQL, end-to-end recovery, and edge CPU measurements remain deployment checks.

Apply forward migrations `004_upload_part_limit.sql` and `005_async_snapshots.sql`
before deploying the new Worker. Do not edit the checksums of earlier migrations.
The new tables store accepted snapshots, per-shop staging, exact listing presence,
and Queue budget reservations. Only MySQL is used; historical D1 migration/export
tools are retained but the D1 TypeScript runtime has been removed.

Production pushes to `main` automatically check for the snapshot Queue and create
it if absent, then apply pending MySQL migrations before deploying the Worker.
The GitHub production `CLOUDFLARE_API_TOKEN` must include account-level
`Queues: Edit` permission. Queue lookup or creation failures stop the workflow
before schema migrations. No manual SQL or Queue creation is needed for this path.

For deployments outside GitHub Actions, create the Queue matching the deployment
environment before deploying a consumer:

```powershell
pnpm exec wrangler queues create lastroweb-production-snapshot-jobs
```

The default environment uses `lastroweb-snapshot-jobs`; staging uses
`lastroweb-staging-snapshot-jobs`. Consumer settings must retain
`max_batch_size = 1`. Set `SNAPSHOT_QUEUE_DAILY_BUDGET` (default 9000 reserved
operations/day) and `SNAPSHOT_RECONCILE_BATCH_SIZE` (default 200 rows) in the target
environment's vars. Client upload part size independently controls materialization.
With no Queue binding, jobs remain durable and the recovery Cron processes them.

Three Cron expressions are configured: `* * * * *` runs one recovery chunk,
`*/5 * * * *` runs one staging cleanup chunk, and `0 3 * * *` retains the existing
history cleanup. Workers Free allows five Cron triggers per account, so enabling
all three in multiple deployed environments can exceed the account limit. Staging
and production should not both inherit these schedules on the same free account.
Cron recovery has a maximum throughput of 1440 chunks/day and is not an unlimited
substitute for Queue capacity.

Use `GET /api/admin/snapshots/:sourceId/:snapshotId` with `x-admin-secret` to inspect
status, stage, cursor, generation, attempts, lease and failure code. Use
`POST /api/admin/snapshots/:sourceId/:snapshotId/requeue` for a failed snapshot whose
parts are complete. Requeue retains its committed cursor and invalidates previous
messages; the next recovery Cron picks it up. Incomplete snapshots require a new
snapshot after their 24-hour receive timeout. Do not manually reset a cursor on
partially applied data.

Completed and permanently incomplete staging payloads are reclaimed incrementally after seven days; accepted
part hashes and responses remain as idempotency tombstones. Review failed jobs
before deciding to discard their debugging data. Search changes progressively as
parts are materialized; source `last_full_snapshot_at` is a completion marker.

Check the OpenKore adapter accepts `resolution: pending` and caches the stable
`uuid -> shop_id` mapping with `applied: false`. This repository does not contain
that adapter. See [API contract](api.md) and [CPU and Queue estimates](upload-performance.md).

## Rollback Considerations

Worker deployment rollback changes Worker code only. It does not roll back MySQL schema or imported data. Preserve the D1 dump and the converter output, take a VPS MySQL backup before importing, and use reviewed forward MySQL migrations to repair schema. Do not reset a production database, delete a migration record, or run `DROP DATABASE`.
