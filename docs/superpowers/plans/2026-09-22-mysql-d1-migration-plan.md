# MySQL D1 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the production D1/SQLite market-state path with a verified, batched, transaction-safe MySQL 8 implementation and provide safe D1 export, conversion, import, verification, deployment, and rollback operations.

**Architecture:** A D1-free `MysqlDatabase` adapter owns parsed configuration, a small isolate-cached `mysql2/promise` pool, parameterized execution, transactions, and health checks. `createMysqlRepository()` implements the existing `MarketRepository` contract using bounded set-based reads/writes and MySQL transactions. MySQL schema and data-migration tools are independent of the Worker so a direct-Worker compatibility failure blocks only the production runtime switch, never gets hidden with Hyperdrive or D1 fallback.

**Tech Stack:** TypeScript, Vitest, mysql2/promise, MySQL 8/InnoDB, Cloudflare Workers/Wrangler, Node.js 24, pnpm 12, PowerShell runbooks.

**Spec:** `docs/superpowers/specs/2026-09-22-mysql-d1-migration-design.md`

## Global Constraints

- Use `mysql2/promise` and `MYSQL_URL`; do not use Hyperdrive, an HTTP proxy, a D1 fallback, or a dual-write path.
- Do not print, commit, interpolate into command lines, or document a real database URL, password, token, or API key.
- Preserve the `MarketRepository` interface, protocol-v2 idempotency, optimistic locking, source-scoped identity, reconciliation, sold-event, cursor, and static-catalog semantics.
- Preserve bounded set-based upload work: no N+1 database reads/writes for hundreds or thousands of observations.
- All dynamic SQL values, including every `IN` member, use placeholders. Only repository-owned, allowlisted SQL structure may be composed.
- Write every new production behaviour test first, observe its expected failure, implement the smallest change, and rerun the focused test before proceeding.
- A successful TypeScript build is insufficient. The production switch requires fresh Wrangler dry-run and local runtime evidence; `MYSQL_TEST_URL` integration evidence is required when available.
- If direct Worker `mysql2` TCP/TLS execution fails, do not change to Hyperdrive; report the exact failure and leave production D1 removal uncompleted.

## Review Focus

- Percent-encoded user/password and `ssl=true` must parse correctly without appearing in thrown errors or logs; Task 2 owns tests.
- A 1,000-observation upload must use a bounded number of set-based statements and one transaction, not one connection/query per observation; Tasks 6–8 own tests.
- A duplicate upload key with a different payload must still return the existing idempotency conflict rather than a generic duplicate-key error; Task 6 owns tests.
- A failed write after a successful batch claim must rollback the claim and dependent rows; Tasks 2 and 6 own tests.
- Workers runtime Node/TCP/TLS incompatibility must stop deployment configuration changes and be reported with exact Wrangler/local evidence; Tasks 1 and 10 own tests/checks.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `apps/worker/src/db/mysql-client.ts` | URL validation, mysql2 pool lifecycle, parameterized executor, transactions, health probe, safe error classification. |
| `apps/worker/src/db/mysql-repository.ts` | Complete `MarketRepository` implementation using MySQL-only SQL and bounded chunks. |
| `apps/worker/test/mysql-client.test.ts` | URL, transaction, placeholder, batch-bound, and sanitization tests. |
| `apps/worker/test/mysql-repository*.test.ts` | SQL-shape and repository-contract tests through a fake MySQL executor. |
| `apps/worker/test/mysql-integration.test.ts` | Optional MySQL 8 integration contract tests gated by `MYSQL_TEST_URL`. |
| `migrations/mysql/001_initial.sql` | MySQL 8/InnoDB market schema and indexes. |
| `scripts/mysql-migrate.mjs` | Checked, idempotent MySQL schema-migration runner. |
| `scripts/export-d1.mjs` | Safe wrapper for remote D1 SQL export. |
| `scripts/convert-sqlite-to-mysql.mjs` | Streaming, fail-closed SQLite dump converter. |
| `scripts/import-mysql.mjs` | Non-destructive MySQL SQL importer. |
| `scripts/verify-mysql-migration.mjs` | Source/target migration consistency checks. |
| `apps/worker/src/env.ts`, `index.ts`, `routes/health.ts` | MySQL-only production environment, cached dependency assembly, and real DB health. |
| `wrangler.toml`, `wrangler.production.local.toml`, `.dev.vars.example` | No D1 binding; secret-only MySQL configuration. |
| `.github/workflows/ci.yml` | Migrate, connectivity-check, secret-through-stdin, then deploy. |
| `README.md`, `docs/deployment.md`, `docs/operations.md`, `docs/api.md`, `docs/mysql-migration.md` | MySQL operations, credential safety, conversion, validation, rollback, and compatibility outcome. |

### Task 1: Stabilize dependency state and prove the Worker compatibility gate

**Files:**
- Modify: `apps/worker/package.json`, `pnpm-lock.yaml`
- Create: `scripts/verify-worker-mysql.mjs`, `tests/deployment/worker-mysql-runtime.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `node scripts/verify-worker-mysql.mjs [--local] [--mysql-test]`, returning non-zero with a redacted stage-specific error.
- Consumes: `MYSQL_TEST_URL` only when `--mysql-test` is supplied; it must never print that environment variable.

- [ ] **Step 1: Write the failing stage-classification test**

```ts
it('reports a bundle failure without echoing MYSQL_URL', () => {
  const result = runScript('verify-worker-mysql.mjs', [], {
    MYSQL_URL: 'mysql://user:top-secret@example.test/app',
    WORKER_MYSQL_TEST_RUNNER: 'node -e "process.stderr.write(\'Could not resolve long\'); process.exit(1)"',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('bundle');
  expect(result.stderr).not.toContain('top-secret');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run tests/deployment/worker-mysql-runtime.test.ts`

Expected: FAIL because `verify-worker-mysql.mjs` does not exist.

- [ ] **Step 3: Lock the declared `mysql2` dependency without changing user source files**

Run a single package-manager process: `pnpm install --lockfile-only` followed by `pnpm install --frozen-lockfile`. Verify that `pnpm-lock.yaml` contains the selected `mysql2` version and every transitive dependency, including `long`. Do not run package-manager commands concurrently. Add ignored rules for caller-generated `*.sqlite.sql`, `*.mysql.sql`, and migration report artifacts under `.generated\mysql-migration\`; do not add a broad rule that hides committed migrations.

- [ ] **Step 4: Implement the redacted compatibility runner**

```js
const stage = process.argv.includes('--local') ? 'local-runtime' : 'bundle';
const command = process.env.WORKER_MYSQL_TEST_RUNNER
  ?? (stage === 'bundle'
    ? 'pnpm exec wrangler deploy --dry-run --env production --config wrangler.production.local.toml'
    : 'pnpm exec wrangler dev --local --port 8791');
// Spawn with shell:false where possible; report only stage and a normalized error class.
// Never include process.env.MYSQL_URL in output.
```

The runner must use its injected runner only in tests. The real path runs Wrangler directly, captures output, labels failures `bundle`, `local-runtime`, or `mysql-select-1`, and exits non-zero without attempting deploy.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `pnpm vitest run tests/deployment/worker-mysql-runtime.test.ts`

Expected: PASS; output contains no test password.

- [ ] **Step 6: Gather real compatibility evidence before any configuration switch**

Run, sequentially:

```powershell
node scripts/verify-worker-mysql.mjs
node scripts/verify-worker-mysql.mjs --local
if ($env:MYSQL_TEST_URL) { node scripts/verify-worker-mysql.mjs --mysql-test }
```

Record the exact failing stage and sanitized output. If any direct-runtime check fails, continue only with offline schema/tooling/repository tasks and mark Tasks 10–11's production switch branch blocked.

- [ ] **Step 7: Commit**

```powershell
git add apps/worker/package.json pnpm-lock.yaml .gitignore scripts/verify-worker-mysql.mjs tests/deployment/worker-mysql-runtime.test.ts
git commit -m "test: add Worker MySQL compatibility gate"
```

### Task 2: Build a testable MySQL executor and bounded transaction primitive

**Files:**
- Modify: `apps/worker/src/db/mysql-client.ts`
- Modify: `apps/worker/test/mysql-client.test.ts`
- Create: `apps/worker/test/mysql-client-transaction.test.ts`

**Interfaces:**
- Produces: `parseMysqlUrl(value): MysqlConfig`, `createMysqlDatabase(url): MysqlDatabase`, and `MysqlDatabase.all/first/run/transaction/healthcheck/close`.
- Consumes: SQL plus `readonly unknown[]`; returns `{ affectedRows: number; insertId: number }` for writes.

- [ ] **Step 1: Write failing URL, error-sanitization, and transaction tests**

```ts
it('rejects invalid ports without including encoded credentials', () => {
  expect(() => parseMysqlUrl('mysql://alice:p%40ss@db.test:70000/app'))
    .toThrow('MYSQL_URL port must be between 1 and 65535');
});

it('rolls back a batch when its second execute fails', async () => {
  const fake = new FakePool({ failAtExecute: 2 });
  await expect(createMysqlDatabaseForPool(fake).transaction(async (db) => {
    await db.run('INSERT INTO t(v) VALUES (?)', [1]);
    await db.run('INSERT INTO t(v) VALUES (?)', [2]);
  })).rejects.toThrow('database operation failed');
  expect(fake.calls).toEqual(['begin', 'execute', 'execute', 'rollback', 'release']);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter worker test -- mysql-client mysql-client-transaction`

Expected: FAIL because the current client accepts invalid ports and lacks injectable transaction/health APIs.

- [ ] **Step 3: Implement the narrow executor boundary**

```ts
export interface MysqlDatabase {
  all<T extends MysqlRow>(sql: string, values?: readonly unknown[]): Promise<T[]>;
  first<T extends MysqlRow>(sql: string, values?: readonly unknown[]): Promise<T | null>;
  run(sql: string, values?: readonly unknown[]): Promise<MysqlWriteResult>;
  transaction<T>(work: (db: MysqlDatabase) => Promise<T>): Promise<T>;
  healthcheck(): Promise<void>;
  close(): Promise<void>;
}
```

Use `pool.execute`, not `query`, for all application SQL. Validate scheme, host, user, database, numeric port, supported SSL flag values, and forbid URL options that alter pooling. Pool construction is private; `createMysqlDatabaseForPool` is test-only and receives a `MysqlPoolLike`. On errors, throw a new classified error without the original message unless it is a safe validation error. Limit pool connections to a named constant of `2`; do not create the pool until first use.

- [ ] **Step 4: Add bounded helper tests and implementation**

```ts
expect(chunkRows(Array.from({ length: 1000 }), 3, 600)).toHaveLength(5);
expect(makePlaceholders(3, 2)).toBe('(?, ?), (?, ?), (?, ?)');
```

Expose only `chunkRows` and `makePlaceholders` needed by the repository. Reject an empty row width or chunk size. These helpers create SQL structure from trusted counts only, never values.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm --filter worker test -- mysql-client mysql-client-transaction`

Expected: PASS, with explicit `commit` on success and `rollback` on failure.

- [ ] **Step 6: Commit**

```powershell
git add apps/worker/src/db/mysql-client.ts apps/worker/test/mysql-client.test.ts apps/worker/test/mysql-client-transaction.test.ts
git commit -m "feat: add bounded MySQL database adapter"
```

### Task 3: Add a repeatable MySQL 8 schema migration path

**Files:**
- Create: `migrations/mysql/001_initial.sql`, `scripts/mysql-migrate.mjs`, `apps/worker/test/mysql-schema.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `pnpm db:mysql:migrate`, which reads `MYSQL_URL` and applies checked migration filenames in lexical order.
- Consumes: `migrations/mysql/*.sql`; creates `schema_migrations(name VARCHAR(255) PRIMARY KEY, checksum CHAR(64), applied_at BIGINT UNSIGNED)`.

- [ ] **Step 1: Write failing schema tests**

```ts
const sql = readFileSync(resolve(repoRoot, 'migrations/mysql/001_initial.sql'), 'utf8');
expect(sql).toMatch(/CREATE TABLE market_sources/u);
expect(sql).toMatch(/ENGINE=InnoDB/u);
expect(sql).not.toMatch(/WITHOUT ROWID|PRAGMA|AUTOINCREMENT|json_each|\?\d+/iu);
expect(sql).toMatch(/UNIQUE KEY .*transition_key/u);
expect(sql).toMatch(/INDEX idx_listings_active_item_price \(status, item_id, price, id\)/u);
```

- [ ] **Step 2: Run the schema test and verify RED**

Run: `pnpm vitest run apps/worker/test/mysql-schema.test.ts`

Expected: FAIL because the MySQL schema does not exist.

- [ ] **Step 3: Write `001_initial.sql` and the runner**

Define all six existing dynamic-market tables with MySQL 8 checks, `BIGINT UNSIGNED` IDs/timestamps, matching foreign keys/cascades, unique keys, source-scoped shop identity, event transition key, and upload idempotency/part uniqueness. Replace each partial index with the equivalent status-leading composite index. The runner must calculate SHA-256 over each SQL file, run migration statements with a single MySQL connection, insert the migration record only after successful execution, and reject an existing name with a different checksum.

```js
const applied = await db.first('SELECT checksum FROM schema_migrations WHERE name=?', [name]);
if (applied && applied.checksum !== checksum) throw new Error(`migration checksum mismatch: ${name}`);
if (!applied) { await executeStatements(connection, sql); await db.run('INSERT INTO schema_migrations ...', [name, checksum, Date.now()]); }
```

- [ ] **Step 4: Run schema test and a migration dry connection check**

Run: `pnpm vitest run apps/worker/test/mysql-schema.test.ts`

Run: `node scripts/mysql-migrate.mjs --dry-run`

Expected: schema test PASS; dry run validates file order and requires but never prints `MYSQL_URL`.

- [ ] **Step 5: Commit**

```powershell
git add migrations/mysql/001_initial.sql scripts/mysql-migrate.mjs apps/worker/test/mysql-schema.test.ts package.json
git commit -m "feat: add MySQL 8 market schema"
```

### Task 4: Build the fail-closed streaming SQLite-to-MySQL converter

**Files:**
- Create: `scripts/convert-sqlite-to-mysql.mjs`, `tests/scripts/convert-sqlite-to-mysql.test.ts`

**Interfaces:**
- Produces: `node scripts/convert-sqlite-to-mysql.mjs --input .generated/mysql-migration/source.sql --output .generated/mysql-migration/converted.sql`.
- Consumes: UTF-8 SQLite dump stream; returns non-zero for unsupported statements with source line number.

- [ ] **Step 1: Write failing converter fixtures/tests**

```ts
const source = "PRAGMA foreign_keys=ON;\nCREATE TABLE x(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT) WITHOUT ROWID;\nINSERT OR IGNORE INTO x VALUES(1,'中文 O''Brien');\n";
const output = convert(source);
expect(output).toContain('BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY');
expect(output).toContain("INSERT INTO x VALUES(1,'中文 O''Brien') ON DUPLICATE KEY UPDATE id=id;");
expect(output).not.toMatch(/PRAGMA|WITHOUT ROWID|AUTOINCREMENT/u);
expect(() => convert('CREATE VIRTUAL TABLE f USING fts5(v);')).toThrow('unsupported SQLite statement at line 1');
```

- [ ] **Step 2: Run converter tests and verify RED**

Run: `pnpm vitest run tests/scripts/convert-sqlite-to-mysql.test.ts`

Expected: FAIL because the converter is absent.

- [ ] **Step 3: Implement a streaming statement lexer and explicit transformers**

The lexer must recognize semicolons outside single/double/backtick quoted strings and SQL line/block comments; it must preserve UTF-8 input incrementally. Implement only explicit transformations for `PRAGMA`, transaction wrappers, `WITHOUT ROWID`, supported AUTOINCREMENT tables, `INSERT OR IGNORE`, `INSERT OR REPLACE`, `sqlite_sequence`, SQLite quoting, and known migration index forms. Reject JSON1/FTS/trigger/attach/detach/unknown DDL and any unsupported `ON CONFLICT` form with line number. Do not silently remove a data statement.

- [ ] **Step 4: Run converter tests and a file round-trip**

Run: `pnpm vitest run tests/scripts/convert-sqlite-to-mysql.test.ts`

Run: `node scripts/convert-sqlite-to-mysql.mjs --input migrations/0001_initial.sql --output .generated/mysql-migration/schema-preview.sql`

Expected: tests PASS; generated preview is outside Git and no unsupported construct is silently omitted.

- [ ] **Step 5: Commit**

```powershell
git add scripts/convert-sqlite-to-mysql.mjs tests/scripts/convert-sqlite-to-mysql.test.ts
git commit -m "feat: add streaming SQLite to MySQL converter"
```

### Task 5: Add D1 export, safe import, and migration verification tools

**Files:**
- Create: `scripts/export-d1.mjs`, `scripts/import-mysql.mjs`, `scripts/verify-mysql-migration.mjs`, `tests/scripts/mysql-migration-tools.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `pnpm db:d1:export`, `pnpm db:mysql:import`, and `pnpm db:mysql:verify`.
- Consumes: selected output/input paths, `MYSQL_URL`, and Cloudflare credentials in environment only.

- [ ] **Step 1: Write failing safe-operation tests**

```ts
expect(runScript('import-mysql.mjs', ['--input', fixture])).toMatchObject({ status: 1, stderr: expect.stringContaining('MYSQL_URL') });
expect(runScript('import-mysql.mjs', ['--input', fixture, '--replace-existing'])).toMatchObject({ status: 1, stderr: expect.stringContaining('--confirm-replace-existing') });
expect(runScript('export-d1.mjs', ['--output', output], { CLOUDFLARE_API_TOKEN: 'do-not-print' }).stdout).not.toContain('do-not-print');
```

- [ ] **Step 2: Run migration-tool tests and verify RED**

Run: `pnpm vitest run tests/scripts/mysql-migration-tools.test.ts`

Expected: FAIL because the scripts are absent.

- [ ] **Step 3: Implement the scripts with injectable process/database boundaries**

`export-d1.mjs` validates the output is not tracked, checks `wrangler whoami` without forwarding credentials, then runs Wrangler `d1 export` with the caller-supplied `--database` name and `--output` file. `import-mysql.mjs` lexes input statements safely, checks `SELECT DATABASE()`, refuses `DROP DATABASE`, and commits bounded import groups. `verify-mysql-migration.mjs` compares counts and maxima for all six tables, source count, foreign/unique metadata, transition keys, batch keys, randomized primary-key samples, UTF-8 Chinese samples, and NULL counts. Print counts and checksums only, never connection details.

- [ ] **Step 4: Run tests and safe dry runs**

Run: `pnpm vitest run tests/scripts/mysql-migration-tools.test.ts`

Run: `node scripts/import-mysql.mjs --input .generated/mysql-migration/schema-preview.sql --dry-run`

Expected: PASS; dry run validates input and target connection requirements without writes.

- [ ] **Step 5: Commit**

```powershell
git add scripts/export-d1.mjs scripts/import-mysql.mjs scripts/verify-mysql-migration.mjs tests/scripts/mysql-migration-tools.test.ts package.json
git commit -m "feat: add MySQL migration operations tools"
```

### Task 6: Port source, shop/session, and upload-batch repository operations

**Files:**
- Modify: `apps/worker/src/db/mysql-repository.ts`
- Create: `apps/worker/test/mysql-repository-core.test.ts`

**Interfaces:**
- Produces: MySQL implementations of `findSourceByApiKeyHash`, `getOrCreateVendor`, `getOrCreateShop`, `getOrCreateSession`, `resolveShopObservations`, `getBatch`, `getSnapshotParts`, `insertBatch`, `retryBatch`, `failBatch`, and `completeBatch`.
- Consumes: `MysqlDatabase` from Task 2 and exact existing input/output types from `db/types.ts` and `db/repository.ts`.

- [ ] **Step 1: Write failing contract and bounded-query tests**

```ts
it('resolves 1000 shops with bounded tuple reads and one transaction', async () => {
  const db = new RecordingMysqlDatabase();
  await createMysqlRepository(db).resolveShopObservations!(observations(1000));
  expect(db.transactions).toBe(1);
  expect(db.sql.filter((s) => s.includes('FROM shops'))).toHaveLength(5);
  expect(db.values.every((v) => !String(v).includes('shop-0'))).toBe(false);
  expect(db.sql.join('\n')).not.toContain("'shop-0'");
});

it('returns an idempotency conflict when an existing batch hash differs', async () => {
  await expect(repository.insertBatch(changedPayloadFor('same/0'))).rejects.toMatchObject({ code: 'idempotency_key_reused' });
});
```

- [ ] **Step 2: Run the core test and verify RED**

Run: `pnpm --filter worker test -- mysql-repository-core`

Expected: FAIL because the current MySQL repository throws an incomplete-migration error.

- [ ] **Step 3: Implement set-based source/shop/batch operations**

Use `SELECT ... WHERE (source_id, identity_hash) IN (...)` in chunks of the Task 2 limit. Insert new rows with multi-value `INSERT`; resolve duplicate races by re-reading the exact unique key. Use `INSERT ... ON DUPLICATE KEY UPDATE` only for the columns that D1's conflict clause changed. Batch claiming and all shop/session writes run inside `db.transaction`; distinguish duplicate keys from connection failures and preserve `inserted`, retry, processing, rejected, and accepted behavior.

- [ ] **Step 4: Run focused core tests and verify GREEN**

Run: `pnpm --filter worker test -- mysql-repository-core`

Expected: PASS; assertions show no per-row SQL and every user string is in a value array.

- [ ] **Step 5: Commit**

```powershell
git add apps/worker/src/db/mysql-repository.ts apps/worker/test/mysql-repository-core.test.ts
git commit -m "feat: port MySQL upload batch repository core"
```

### Task 7: Port listing/options/history and optimistic-transition writes

**Files:**
- Modify: `apps/worker/src/db/mysql-repository.ts`
- Create: `apps/worker/test/mysql-repository-listings.test.ts`

**Interfaces:**
- Produces: MySQL `loadListingsByObservations`, `createListingsBundleBatch`, `insertNewListingsBulk`, `insertListingOptionsBatch`, `insertHistoriesBatch`, `insertSoldEvent`, `applyListingTransitionsBulk`, and `markListingsObservedBulk`.

- [ ] **Step 1: Write failing transition and rollback tests**

```ts
it('updates only rows with the expected state version and emits events only for winners', async () => {
  const result = await repository.applyListingTransitionsBulk!(twoChangesWithOneConflict());
  expect(result).toEqual({ updated: 1, conflicts: 1, soldEvents: 1, conflictIds: [secondListingId] });
  expect(db.sql.join('\n')).toMatch(/JOIN \(SELECT \? AS listing_id, \? AS expected_version/u);
});

it('rolls back listings and options when option insertion fails', async () => {
  await expect(repository.insertNewListingsBulk!(listingsWithOptions())).rejects.toThrow('database operation failed');
  expect(db.rolledBack).toBe(true);
});
```

- [ ] **Step 2: Run the listing test and verify RED**

Run: `pnpm --filter worker test -- mysql-repository-listings`

Expected: FAIL because these methods are not implemented.

- [ ] **Step 3: Implement bounded multi-row writes**

Use tuple prefetches for existing listings. Create listing rows and options in chunks in one transaction. For each transition chunk, join a parameterized `SELECT ? AS ... UNION ALL SELECT ...` derived table to `listings`, include `state_version = expected_version`, reload affected listing IDs, then write only their immutable history/sold events with the unique transition key. Avoid `RETURNING`, `json_each`, `json_extract`, `INSERT OR REPLACE`, and `INSERT OR IGNORE`.

- [ ] **Step 4: Run focused listing tests and verify GREEN**

Run: `pnpm --filter worker test -- mysql-repository-listings`

Expected: PASS; 1,000 rows are chunked and no event is created for the conflict.

- [ ] **Step 5: Commit**

```powershell
git add apps/worker/src/db/mysql-repository.ts apps/worker/test/mysql-repository-listings.test.ts
git commit -m "feat: port MySQL listing transition writes"
```

### Task 8: Port snapshot, reconciliation, retention, search, and history reads

**Files:**
- Modify: `apps/worker/src/db/mysql-repository.ts`
- Create: `apps/worker/test/mysql-repository-read-model.test.ts`

**Interfaces:**
- Produces: MySQL `markShopHeartbeats`, `recordSnapshotSessions`, `finalizeSnapshot`, `reconcileSnapshot`, `deleteExpiredHistory`, `deleteExpiredSoldEvents`, `countExpiredHistory`, `countExpiredSoldEvents`, `searchListings`, `getListingHistory`, and `getItemMarketHistory`.

- [ ] **Step 1: Write failing query-shape/contract tests**

```ts
it('keeps cursor search parameterized and returns hydrated options in bounded queries', async () => {
  const page = await repository.searchListings(searchFiltersWithChineseText());
  expect(page.nextCursor).toBeTypeOf('string');
  expect(db.sql.join('\n')).toContain('CONCAT');
  expect(db.sql.join('\n')).not.toMatch(/json_each|\?1|\|\|/u);
  expect(db.statementCount).toBeLessThanOrEqual(3);
});

it('deletes retention rows in a bounded MySQL statement', async () => {
  await repository.deleteExpiredHistory!(123, 50);
  expect(db.sql.at(-1)).toMatch(/DELETE FROM listing_events .* ORDER BY id LIMIT \?/su);
});
```

- [ ] **Step 2: Run the read-model test and verify RED**

Run: `pnpm --filter worker test -- mysql-repository-read-model`

Expected: FAIL because MySQL read/snapshot methods are absent.

- [ ] **Step 3: Implement the remaining repository contract**

Preserve source filters, active/stale/closed semantics, signed cursor context, ordering, option predicates, history pagination, and static option definitions. Use MySQL `CONCAT` for composed text, normal `?` placeholders, and status-leading indexes. Reconciliation must update missing streaks and insert inferred sold events only after complete full snapshots. Retention performs a bounded ordered delete and returns the affected row count.

- [ ] **Step 4: Run focused read-model tests and verify GREEN**

Run: `pnpm --filter worker test -- mysql-repository-read-model`

Expected: PASS; no SQLite-only syntax occurs in captured SQL.

- [ ] **Step 5: Commit**

```powershell
git add apps/worker/src/db/mysql-repository.ts apps/worker/test/mysql-repository-read-model.test.ts
git commit -m "feat: port MySQL market read model"
```

### Task 9: Replace D1 contract coverage with MySQL contract and optional real integration coverage

**Files:**
- Create: `apps/worker/test/mysql-integration.test.ts`
- Modify: `apps/worker/test/d1-repository.test.ts`, `d1-lifecycle.test.ts`, `d1-search.test.ts`, `migrations.test.ts`, `query-indexes.test.ts`, `resource-budgets.test.ts`, `options-bundle.test.ts`
- Modify: `tests/integration/catalog-upload-search-flow.test.ts`

**Interfaces:**
- Produces: default fake-adapter contract coverage and `MYSQL_TEST_URL`-gated MySQL 8 integration coverage.

- [ ] **Step 1: Write the failing skip/real-integration boundary test**

```ts
const testIfMysql = process.env.MYSQL_TEST_URL ? it : it.skip;
testIfMysql('runs source, upload replay, transition, reconciliation, search, and retention against MySQL 8', async () => {
  await withFreshMysqlSchema(process.env.MYSQL_TEST_URL!, async (repository) => {
    await runCatalogUploadSearchFlow(repository);
  });
});
```

- [ ] **Step 2: Run without `MYSQL_TEST_URL` and verify RED/explicit skip setup**

Run: `pnpm --filter worker test -- mysql-integration`

Expected: the initial test setup fails until it explicitly reports one skipped integration test; it must not report it as passed.

- [ ] **Step 3: Move D1-only assertions to MySQL equivalents**

Replace D1 statement-count/meter/JSON1/index assertions with executor-recording assertions against MySQL SQL and the MySQL schema. Keep D1-specific code only in export/conversion comparison tests. Remove production-test imports of `createD1Repository` and `D1Meter`; update catalog tests to assert static catalog behaviour without a database engine.

- [ ] **Step 4: Run focused worker tests and optional real integration test**

Run: `pnpm --filter worker test`

Run when `MYSQL_TEST_URL` has already been supplied in the shell: `pnpm --filter worker test -- mysql-integration`

Expected: fake contract suite PASS; integration suite either PASS against the dedicated schema or is clearly reported skipped because the variable is absent.

- [ ] **Step 5: Commit**

```powershell
git add apps/worker/test tests/integration/catalog-upload-search-flow.test.ts
git commit -m "test: move market repository contract to MySQL"
```

### Task 10: Switch Worker wiring, health, Wrangler, and CI only after the runtime gate passes

**Files:**
- Modify: `apps/worker/src/env.ts`, `apps/worker/src/index.ts`, `apps/worker/src/routes/health.ts`, `apps/worker/test/health.test.ts`
- Modify: `wrangler.toml`, `wrangler.production.local.toml`, `.dev.vars.example`, `.github/workflows/ci.yml`
- Modify: `tests/deployment/deployment-tools.test.ts`, `scripts/render-wrangler-config.mjs`, `scripts/render-source-seed.mjs`

**Interfaces:**
- Produces: local `db: 'unconfigured' | 'ok' | 'error'`; production/staging `resolveAppEnv` refuses missing `MYSQL_URL`; Worker fetch and scheduled jobs obtain one cached MySQL database.

- [ ] **Step 1: Write failing environment, health, and no-D1-binding tests**

```ts
expect(() => resolveAppEnv({ ENVIRONMENT: 'production', CURSOR_SECRET: 'x'.repeat(16) }))
  .toThrow('MYSQL_URL must be configured');
await expect(healthPayload(localEnvWithoutMysql, undefined)).resolves.toMatchObject({ db: 'unconfigured' });
await expect(healthPayload(localEnvWithMysql, failingDatabase)).resolves.toMatchObject({ db: 'error' });
expect(readFileSync('wrangler.toml', 'utf8')).not.toContain('d1_databases');
expect(readFileSync('apps/worker/src/index.ts', 'utf8')).not.toMatch(/createD1Repository|env\.DB|d1-meter/u);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run apps/worker/test/health.test.ts tests/deployment/deployment-tools.test.ts`

Expected: FAIL because current health only says configured and both Wrangler files still bind D1.

- [ ] **Step 3: Implement runtime wiring and deployment order**

Pass the cached `MysqlDatabase` explicitly into health instead of reconstructing it. Delete every `[[d1_databases]]` section/binding and D1 config rendering; update source seed SQL to MySQL `ON DUPLICATE KEY UPDATE`. Add `MYSQL_URL=` placeholder comments to `.dev.vars.example`, never a value. In CI, run `pnpm db:mysql:migrate`, a redacted connectivity check, and health check before this stdin-only secret operation and deploy:

```yaml
- name: Set Worker MySQL secret
  shell: bash
  env:
    MYSQL_URL: ${{ secrets.MYSQL_URL }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  run: node -e "process.stdout.write(process.env.MYSQL_URL)" | pnpm exec wrangler secret put MYSQL_URL --env production --config wrangler.production.local.toml
```

Do not remove D1 configuration or deploy in a real environment if Task 1's actual compatibility gate failed.

- [ ] **Step 4: Run focused tests and runtime evidence**

Run: `pnpm vitest run apps/worker/test/health.test.ts tests/deployment/deployment-tools.test.ts`

Run: `node scripts/verify-worker-mysql.mjs`

Run: `node scripts/verify-worker-mysql.mjs --local`

Expected: tests PASS. Only if both real checks pass may the production-Wrangler/CI edits be considered enabled; otherwise retain the disabled, documented switch branch and report the block.

- [ ] **Step 5: Commit**

```powershell
git add apps/worker/src/env.ts apps/worker/src/index.ts apps/worker/src/routes/health.ts apps/worker/test/health.test.ts wrangler.toml wrangler.production.local.toml .dev.vars.example .github/workflows/ci.yml tests/deployment/deployment-tools.test.ts scripts/render-wrangler-config.mjs scripts/render-source-seed.mjs
git commit -m "feat: wire verified MySQL Worker runtime"
```

### Task 11: Publish operations documentation and execute full verification

**Files:**
- Modify: `README.md`, `docs/deployment.md`, `docs/operations.md`, `docs/api.md`
- Create: `docs/mysql-migration.md`

**Interfaces:**
- Produces: PowerShell-only, redacted runbooks for VPS preparation, D1 export, conversion, import, verification, secret setup, health check, rollback, and compatibility failure.

- [ ] **Step 1: Write failing documentation assertions**

```js
expect(readFileSync('docs/mysql-migration.md', 'utf8')).toContain('pnpm db:d1:export');
expect(readFileSync('docs/mysql-migration.md', 'utf8')).toContain('pnpm db:mysql:verify');
expect(allDocs).not.toMatch(/CLOUDFLARE_D1_DATABASE_ID|D1-backed market upload API/u);
expect(allDocs).toContain('Do not commit MYSQL_URL');
```

- [ ] **Step 2: Run documentation test and verify RED**

Run: `pnpm test:docs`

Expected: FAIL because the MySQL migration runbook and updated database terminology do not exist.

- [ ] **Step 3: Document exact safe PowerShell sequence**

Document a dedicated VPS MySQL user, least-privilege database grants, public-IP/port firewall allowance, TLS verification, GitHub `production` secrets (`MYSQL_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`), Worker secret setup through a pipeline, dump retention outside Git, and rollback as Worker deployment rollback plus no destructive database rollback. Include export, conversion, import, migration, verification, and health commands. State the actual Task 1 compatibility result verbatim and say the production switch is incomplete if it failed.

- [ ] **Step 4: Run the complete verification matrix**

Run, sequentially:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:docs
pnpm --filter web build
node scripts/convert-sqlite-to-mysql.mjs --input migrations/0001_initial.sql --output .generated/mysql-migration/schema-preview.sql
node scripts/mysql-migrate.mjs --dry-run
node scripts/import-mysql.mjs --input .generated/mysql-migration/schema-preview.sql --dry-run
node scripts/verify-worker-mysql.mjs
node scripts/verify-worker-mysql.mjs --local
if ($env:MYSQL_TEST_URL) { pnpm --filter worker test -- mysql-integration; node scripts/verify-worker-mysql.mjs --mysql-test }
```

Read each exit code and report every failure/skip by command. Do not describe unavailable MySQL integration tests as passed.

- [ ] **Step 5: Commit**

```powershell
git add README.md docs/deployment.md docs/operations.md docs/api.md docs/mysql-migration.md
git commit -m "docs: add MySQL migration operations runbook"
```

## Plan self-review

- Spec coverage: Tasks 1–2 cover direct mysql2 feasibility, pooling, URL safety, and transaction primitives; Task 3 schema; Tasks 4–5 export/convert/import/verify; Tasks 6–9 every repository contract and batch behaviour; Task 10 Worker/CI/configuration; Task 11 documentation and the required final evidence matrix.
- Placeholder scan: the plan contains no deferred implementation markers; every task names exact files, interfaces, red/green commands, and a commit scope.
- Type consistency: repository tasks use `MysqlDatabase`, `MysqlWriteResult`, and the established `MarketRepository` signatures throughout; runtime health consumes the Task 2 database interface.
- Review focus coverage: URL secrecy and transaction rollback are tested in Task 2; 1,000-row batch bounds in Tasks 6–8; payload idempotency in Task 6; and Workers compatibility stop conditions in Tasks 1 and 10.
