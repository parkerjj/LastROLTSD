# Operations

All operator command examples use PowerShell.

## Health and monitoring

Monitor Worker request metrics and MySQL failures through Workers Logs. Metrics include request ID, route, status, elapsed time, and declared request size. Do not log bearer tokens, complete upload bodies, player identifiers, coordinates, or `MYSQL_URL`.

`GET /api/health` always returns Worker metadata. It reports `db: "unconfigured"` locally when `MYSQL_URL` is absent, `db: "ok"` only after MySQL `SELECT 1`, and `db: "error"` on a sanitized connection failure. It never returns host, username, password, or socket details.

The daily retention trigger removes bounded old listing history and sold events; it does not delete current listings. Monitor MySQL disk, connection, query-latency, backup, and TLS-certificate health before expanding retention or upload volume. The Worker pool is intentionally bounded to two connections per isolate; account for Worker concurrency and VPS `max_connections` together.

## MySQL change control

Back up MySQL before every production import or schema migration. Apply `pnpm db:mysql:migrate` before Worker deployment, then run `pnpm db:mysql:migrate -- --dry-run` and `pnpm db:mysql:verify` with `MYSQL_URL` in the process environment. The migration tracker is checksum-protected and should only move forward.

Keep a read-only D1 export and the converted SQL outside Git throughout the cutover window. A database rollback is a separate, approved operation; reverting Worker code does not revert MySQL data. Never reset a production schema or use `DROP DATABASE`.

## Catalog operations

Catalog imports generate versioned static JSON assets under `apps/web/public/catalog`. They do not query either MySQL or D1 and do not alter listings. Review the generated JSON/checksum, rebuild the web app, and deploy it with the Worker. See [catalog import](catalog-import.md).
