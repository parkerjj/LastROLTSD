# D1 to VPS MySQL migration design

## Status and intent

Replace the production Cloudflare D1/SQLite market-state database with a user-operated MySQL 8 database on a VPS. The Worker must use `mysql2/promise` with `MYSQL_URL`; Hyperdrive, an HTTP database proxy, and a D1 fallback are out of scope. Routes, services, protocol-v2 semantics, static catalog behaviour, cursor pagination, and source isolation remain unchanged.

This is a gated migration. A MySQL repository and data-migration toolchain may be completed even if Workers cannot execute `mysql2` directly, but the production Worker must not be switched until the direct runtime proof succeeds. A failed proof is reported as an incomplete production switch, not hidden by a fallback.

## Current-state findings

The primary D1 implementation is `apps/worker/src/db/d1-repository.ts`; services access it through `MarketRepository`. It uses D1 `prepare`, `bind`, `all`, `run`, and `batch`, SQLite JSON1, numbered placeholders, `RETURNING`, partial indexes, and D1-metering. `migrations/0001_initial.sql` owns exactly six dynamic-market tables: `market_sources`, `shops`, `listings`, `listing_options`, `listing_events`, and `upload_batches`.

The working tree already contains uncommitted, incomplete MySQL work. It changes the Worker entrypoint and adds a basic client, but `mysql-repository.ts` throws an incomplete-migration error. D1 bindings remain in both Wrangler configurations, CI still applies D1 migrations, the MySQL dependency is not locked in `pnpm-lock.yaml`, and the test/documentation suite remains D1-oriented. This work is treated as user-owned input: it will be inspected, replaced only through TDD, and never discarded wholesale.

The first direct `wrangler deploy --dry-run --env production --config wrangler.production.local.toml` was executed. It failed before runtime validation because the locally present `mysql2` package required unresolved transitive dependency `long`; therefore it is not evidence either for or against `mysql2` TCP support. Cloudflare's current Node-compatibility pages list `node:net` as supported and TLS as partial, while its MySQL tutorial still says direct MySQL drivers can fail on unsupported secure-connection APIs. The compatibility question consequently remains an explicit implementation gate.

## Runtime architecture

`mysql-client.ts` will expose a D1-free adapter with URL parsing, parameterized `all`, `first`, `run`, transaction-scoped work, safe batch execution, health probing, and close support. It will use `mysql2/promise` prepared execution rather than converting or reusing D1 SQL. `MYSQL_URL` accepts the form `mysql://user:password@host:3306/database?ssl=true`; parsing supports percent-encoded credentials, validates the host/user/database/port, and does not expose the raw URL in errors.

The adapter is isolate-cached by sanitized connection configuration and has an intentionally small bounded connection pool. It is lazily used and shared by fetch and scheduled retention work, avoiding a new pool for every `createApp()` call. Connection/authentication/timeout failures become classified application errors without connection strings, passwords, or bound values in logs. SSL is opt-in from the URL and has documented verification behaviour.

`mysql-repository.ts` implements `MarketRepository` with no D1 type in its public or production dependency path. `index.ts` constructs only the MySQL database and repository. Production Wrangler configuration declares no `[[d1_databases]]` binding; D1 repository/meter code may remain only for historical tests and migration comparison, never as a production fallback.

In production and staging, missing `MYSQL_URL` is a configuration failure. In local development, it is allowed so the health endpoint returns `db: "unconfigured"`. With a configured database, health runs a real `SELECT 1` and returns `db: "ok"` or a sanitized `db: "error"`.

## Batching and transaction design

The existing upload path deliberately uses D1 batches to avoid hundreds or thousands of single-row calls. The migration preserves that property rather than merely translating connection setup.

Bounded chunks are derived from a named repository limit, per-row parameter count, and a conservative SQL-byte/packet budget. Every chunk is fully parameterized. Multi-key reads use row constructors such as `(source_id, identity_hash) IN ((?, ?), ...)` and `(shop_id, item_fingerprint) IN ((?, ?), ...)`; values are never rendered into SQL. New listings, options, events, and batch claims use multi-value inserts. Conflicts use narrowly scoped `ON DUPLICATE KEY UPDATE` or explicitly handled duplicate-key errors, never broad `INSERT IGNORE` that could conceal invalid data.

For state changes, the repository uses a bounded parameterized derived input table joined to target rows, or equivalent chunked set-based DML where that is clearer. Conditional updates include the expected state version. The affected rows are reloaded before history and sold-event rows are written, so only successful optimistic transitions produce dependent events. Shop resolution, heartbeat, full-snapshot reconciliation, retention, options, and history hydration remain set based.

Operations that were one D1 `batch()` become one MySQL transaction. A failure rolls back the whole operation; a commit occurs only after all dependent writes succeed. Tests will assert both rollback and that a large input yields a bounded number of statements rather than N+1 queries.

## MySQL 8 schema and repository semantics

`migrations/mysql/001_initial.sql` is a distinct MySQL 8 schema, not a copied SQLite migration. Text/composite D1 primary keys become InnoDB primary/unique keys; numeric identities use consistent `BIGINT UNSIGNED AUTO_INCREMENT` types where required. Millisecond timestamps remain numeric and map to JavaScript-safe numeric values. SQLite `WITHOUT ROWID`, `PRAGMA`, numbered placeholders, JSON1, partial indexes, and SQLite-only delete/update forms are absent.

Foreign-key cascades, status checks, source-scoped shop identities, upload idempotency keys, event transition-key uniqueness, and query indexes are preserved. Partial active-listing/shop indexes are replaced by MySQL-usable composite indexes beginning with status. JSON is used only where the repository's data representation remains compatible; otherwise relational columns and explicit joins are retained. A migration tracking table records each applied schema migration and checksum so repeated deploy jobs are safe while altered historical migrations fail loudly.

Repository parity covers source lookup; shop/session resolution; batch claim, retry, failure and completion; listing reads/creation/options/history; sold events; optimistic transitions; heartbeats; snapshot sessions/finalization/reconciliation; search/history/item history; and bounded retention. Static option definitions and catalog assets remain static resources and are not reintroduced into MySQL.

## Data migration and deployment operations

Four Node scripts provide a non-destructive, credential-safe sequence:

1. `export-d1.mjs` invokes Wrangler's remote D1 export from environment-provided Cloudflare credentials and writes a caller-selected raw SQL dump without logging tokens.
2. `convert-sqlite-to-mysql.mjs` reads and writes streams, preserves UTF-8, translates supported SQLite DDL/DML, and terminates on unsupported syntax instead of silently dropping it.
3. `import-mysql.mjs` reads `MYSQL_URL`, checks connectivity and the target database, supports a dry run, executes safe statement batches, and refuses destructive replacement without an explicit confirmation flag.
4. `verify-mysql-migration.mjs` compares source and target row counts/max IDs, identities/unique keys/foreign keys, random samples, Chinese text, NULLs, transition keys, and upload idempotency keys.

The migration runner applies the MySQL schema before any Worker deployment. Original D1 dumps are retained outside Git as rollback evidence. No script drops a database, deletes an existing target by default, or stores credentials in repository files.

GitHub's `production` environment contains only `MYSQL_URL`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID` for this deployment path. CI runs install/build/lint/typecheck/tests/docs tests, MySQL schema migration, connectivity verification, and health validation before deployment. It then sends `MYSQL_URL` to `wrangler secret put` through stdin, never through command-line text or `echo`. D1 configuration rendering, database-ID secrets, and D1 migration application are removed.

## Verification strategy

TDD is mandatory for every production addition: a focused test is written and observed failing first, minimal code makes it pass, then the full relevant suite is run. Unit tests cover URL parsing, encoding, SSL, missing fields, safe placeholders/parameter counts, transaction commit/rollback, batch chunking, schema portability, converter cases including Chinese/NULL/quotes, repository contract semantics, environment resolution, and health states. A fake MySQL executor verifies exact SQL shape and values without pretending to be a database.

When `MYSQL_TEST_URL` is available, optional integration tests create only a dedicated test schema and exercise source lookup, upload idempotency, resolution, listings/options, conflicts, history/search, and retention against MySQL 8. Absence of that variable reports the integration test as skipped rather than passed.

The direct-Worker gate is separate and mandatory: after dependency locking, run Wrangler dry-run, start `wrangler dev --local`, verify that the module loads, and, when a safe test URL is available, execute `SELECT 1` through the Worker. If bundle, local runtime, or real connection reports incompatible Node/TCP/TLS behaviour, deployment configuration is not switched and the final report states that the production switch is incomplete because the platform does not support the required connection mode.

## Non-goals and acceptance boundaries

This migration does not adopt Hyperdrive, an HTTP proxy, a D1 dual-write/fallback, a database reset, a `DROP DATABASE`, or a catalog database. No real `MYSQL_URL`, token, password, or API key is committed, printed, or documented. Completion requires fresh evidence from lint, typecheck, tests, docs tests, web build, schema/converter checks, Wrangler dry-run, local runtime, and any available real-MySQL integration test. A successful TypeScript build alone is not runtime evidence.
