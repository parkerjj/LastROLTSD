# D1/SQLite to MySQL 8 migration

Use this runbook once, during an approved maintenance window. It is deliberately conservative: it exports D1 first, never writes secrets to disk, refuses destructive database commands by default, and leaves the original dump available for audit and rollback.

## Preconditions

- MySQL 8 is reachable at a public, TLS-enabled VPS hostname from Cloudflare Workers.
- A dedicated database/user exists with the required application privileges.
- `.dev.vars` is ignored and contains a real `MYSQL_URL`; do not use the placeholder from `.dev.vars.example`.
- The destination MySQL database is empty or explicitly approved for import.
- Wrangler credentials can export the old D1 database.

## Export, convert, import, verify

```powershell
$ErrorActionPreference = 'Stop'
$dump = '.generated\d1\production.sqlite.sql'
$mysqlData = '.generated\mysql\production.data.sql'
pnpm db:d1:export -- --database '<old-d1-database-name>' --output $dump
node scripts/convert-sqlite-to-mysql.mjs --input $dump --output $mysqlData --data-only
$localVars = Get-Content '.dev.vars' | ConvertFrom-StringData
$env:MYSQL_URL = $localVars.MYSQL_URL
try {
  pnpm db:mysql:migrate
  pnpm db:mysql:import -- --input $mysqlData --dry-run
  pnpm db:mysql:import -- --input $mysqlData
  pnpm db:mysql:verify
} finally {
  Remove-Item Env:MYSQL_URL -ErrorAction SilentlyContinue
}
```

`migrations/mysql/001_initial.sql` supplies the target InnoDB schema for `market_sources`, `shops`, `listings`, `listing_options`, `listing_events`, and `upload_batches`. It uses MySQL foreign keys and unique keys, with `BIGINT UNSIGNED` IDs/timestamps and UTF-8 (`utf8mb4`). SQLite-only syntax such as `AUTOINCREMENT`, `WITHOUT ROWID`, `PRAGMA`, numbered placeholders, partial indexes, and `ON CONFLICT` is not used in the target runtime schema.

## What to verify

`pnpm db:mysql:verify` reports row counts for all six tables, maximum IDs where applicable, foreign-key count, `listing_events.transition_key` uniqueness, the `upload_batches` source/batch idempotency key, nullable fields, and sample Chinese text. Supply `--expected-counts <json-file>` when an independently recorded source count is available. Do not run destructive cleanup merely to make numbers match.

## Cutover and rollback boundary

Only after a successful MySQL validation should the GitHub production deployment set the Worker `MYSQL_URL` secret and deploy. Verify `/api/health` returns `db: "ok"`, then perform a controlled upload/search/history smoke test.

If a failure occurs before cutover, retain the D1 dump and stop. If it occurs after code deployment, roll back the Worker version separately; MySQL schema/data require reviewed forward repair or restoration from the VPS backup. Never run `DROP DATABASE` or delete the migration tracker to force a retry.

## Cloudflare Worker compatibility evidence

`node scripts/verify-worker-mysql.mjs` has passed the Wrangler bundle gate, and `node scripts/verify-worker-mysql.mjs --local` has passed local module loading. Cloudflare's current Node compatibility documentation lists `node:net` as supported and TCP sockets as suitable for MySQL wire protocols. Those facts do not substitute for a real deployed edge connection to this VPS. Until the authorized `MYSQL_TEST_URL` integration and deployed `SELECT 1` checks run, the production cutover remains operationally unverified; no Hyperdrive or D1 fallback is configured.
