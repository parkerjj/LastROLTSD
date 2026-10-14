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
- `AFDIAN_TOKEN`
- `STRIPE_SECRET_KEY`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

`AFDIAN_TOKEN` is the open API token for the Afdian (爱发电) sponsor page (`/sponsor`, endpoint `GET /api/v1/sponsors`). The workflow passes it to `wrangler secret put AFDIAN_TOKEN` through standard input; the token must never appear in source code, Wrangler TOML, or workflow YAML. If the secret is missing the workflow warns instead of failing, and the sponsor endpoint responds 503 until the secret is configured.

`STRIPE_SECRET_KEY` is the Stripe API secret key (`sk_live_...`) used by the sponsor page to pull Stripe Payment Link donations and merge them into the honor roll alongside Afdian sponsors. The workflow passes it to `wrangler secret put STRIPE_SECRET_KEY` through standard input. If the secret is missing or empty the Stripe donor list is silently skipped and the honor roll degrades to Afdian-only; the sponsor endpoint still works. Currency is CNY (RMB); Stripe and Afdian amounts are both stored in cents and can be summed directly.

The workflow installs, builds, lints, type-checks, tests, applies the idempotent MySQL migration, performs a MySQL dry-run connection check, passes `MYSQL_URL`, `GUESTBOOK_RATE_SECRET`, `AFDIAN_TOKEN`, and `STRIPE_SECRET_KEY` to `wrangler secret put` through standard input, then deploys. A migration or connection failure prevents deployment. It never prints either secret and no longer runs D1 migrations or reads a D1 database ID.

Configure the other Worker secrets (`CURSOR_SECRET`, `ADMIN_SECRET`) independently through a secure local terminal. Do not place their values in GitHub workflow YAML or Wrangler TOML. `MYSQL_URL` is intentionally absent from both Wrangler configuration files.

## Account auth and Resend rollout

Account auth is disabled by default in each Wrangler environment. The production workflow reads `AUTH_ENABLED` from the GitHub production Environment variable; only the exact value `true` requests enablement. It enables auth only when preflight accepts the configuration and writes the resulting boolean explicitly to the final deploy. Before any account secret write, an enabled preflight first publishes a Worker version with `AUTH_ENABLED=false`. This barrier is required because each `wrangler secret put` immediately publishes a Worker version with the current public vars. All secret-write versions therefore remain disabled until the final deploy applies the complete key versions, current/previous pairs, public vars, and `AUTH_ENABLED=true` together. Expect account login and mail to pause during this maintenance window on every enabled production deployment. If the barrier fails or reports an ambiguous result, the workflow stops before account-secret writes; verify the deployed state before retrying. A secret-write failure after a successful barrier stops without recovery and leaves auth disabled. A failed or ambiguous final complete-configuration deploy may already have taken effect, so do not infer the remote `AUTH_ENABLED` state from the command's exit status; verify the deployed Worker version and configuration before retrying or reporting its state. No empty secret write or automatic fallback to the prior enabled configuration occurs.

If auth was requested but any required setting is absent or malformed, the workflow emits a warning, deploys with `AUTH_ENABLED=false`, and skips the barrier and every account-secret write. Normal deployments continue while auth remains disabled.

To request production enablement, configure these GitHub production Environment variables:

- `AUTH_ENABLED=true`
- `AUTH_SITE_URL` as the trusted HTTPS origin used by the account site
- `MAIL_FROM` as a sender on a domain you control; `MAIL_REPLY_TO` is optional
- `AUTH_PASSWORD_KEY_VERSION` and `AUTH_MAIL_PAYLOAD_KEY_VERSION` (default `1`)
- `AUTH_MAIL_DAILY_LIMIT` and `AUTH_MAIL_MONTHLY_LIMIT` (defaults `100` and `3000`; the workflow accepts lower positive values)
- `AUTH_PASSWORD_PREVIOUS_KEY_VERSION` and `AUTH_MAIL_PAYLOAD_PREVIOUS_KEY_VERSION` only when rotating, paired with their secret values below

Add these GitHub production Environment secrets: `AUTH_PASSWORD_SECRET`, `AUTH_CSRF_SECRET`, `AUTH_RATE_SECRET`, `AUTH_MAIL_PAYLOAD_SECRET`, and `RESEND_API_KEY`. Each of the four core values must be a distinct canonical Base64 encoding of 32 random bytes. When a previous version is configured, also provide the matching `AUTH_PASSWORD_PREVIOUS_SECRET` or `AUTH_MAIL_PAYLOAD_PREVIOUS_SECRET`; the current and previous versions must differ. Preflight checks syntax and key independence, not real DNS ownership, Resend account status, or delivery. The workflow writes only non-empty secrets through standard input after the full gate succeeds.

For Resend, add a sending domain you control, then copy the provider's current SPF and DKIM records into its authoritative DNS. Configure DMARC after reviewing the domain's existing policy. Preserve existing MX records for inbound mail, and do not publish multiple SPF records for the same hostname. Keep `AUTH_SITE_URL`, `MAIL_FROM`, and optional `MAIL_REPLY_TO` on real, controlled domains; the preflight cannot prove the DNS records are active or that Resend has verified the domain. The Worker sends through Resend's HTTPS API. Workers Free cannot send through Cloudflare Email Sending to arbitrary player addresses; it can call the external API using HTTPS `fetch`. See [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Resend errors](https://resend.com/docs/api-reference/errors), and [Resend account quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits) and verify the current plan and account quota before opening registration.

The three existing Cron expressions plus the new `*/2 * * * *` account tick are configured on this Worker. Workers Free currently allows at most five Cron triggers per account, shared across Workers; check the account's total before enabling production schedules. Cron CPU has the Free 10 ms per-invocation limit. No account's actual trigger usage, remaining mail quota, domain verification, DNS, production secrets, or production CPU was checked as part of this local code change.

Rotate password and mail-payload keys separately. Use the disabled barrier before changing any current or previous secret or version: while auth is disabled, retain the old current key/version as the one `PREVIOUS` pair and set the new current version and secret; re-enable only in a final deployment that includes the complete matching pairs. The GitHub workflow enforces this sequence when preflight enables auth. For manual changes, explicitly deploy `AUTH_ENABLED=false` and wait for that deployment to succeed before writing any account secret, then publish the complete public vars and matching keys in a final `AUTH_ENABLED=true` deployment. The Worker reads records using their stored version; do not remove a previous key or start a third version while any old record still needs it. Before retiring a password key, use the `auth_credentials(key_version, user_id)` index to check matching users in bounded batches and complete a separately reviewed migration or user credential upgrade. Do not silently rewrite passwords. Retire an old mail-payload key only after every old-version task is terminal or expired and its ciphertext is null. The workflow does not delete remote secrets; remove an old secret only through a separately authorized operation after the check is complete.

To disable account auth, set the production `AUTH_ENABLED` variable to `false` and deploy through the existing main-only workflow. Data and secrets remain available for a later reviewed re-enable; do not drop account tables or clear keys as part of a rollback.

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
