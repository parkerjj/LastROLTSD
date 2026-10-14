import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMysqlDatabase, parseMysqlUrl, type MysqlDatabase, type MysqlRow } from '../../apps/worker/src/db/mysql-client';

export interface AuthMysqlTestContext {
  database: MysqlDatabase;
  createDatabase(): MysqlDatabase;
}

export async function withAuthTestDatabase<T>(work: (context: AuthMysqlTestContext) => Promise<T>): Promise<T> {
  const mysqlTestUrl = process.env.MYSQL_TEST_URL;
  if (!mysqlTestUrl) throw new Error('MYSQL_TEST_URL is required for auth MySQL tests');
  if (process.env.AUTH_TEST_DB_ALLOW_RESET !== '1') throw new Error('auth MySQL reset is not authorized');

  const testDatabaseName = parseMysqlUrl(mysqlTestUrl).database;
  if (!testDatabaseName.toLowerCase().endsWith('_test')) throw new Error('auth MySQL tests require a database ending in _test');
  const configuredDatabaseUrl = process.env.MYSQL_URL;
  if (configuredDatabaseUrl) {
    const configuredDatabaseName = parseMysqlUrl(configuredDatabaseUrl).database;
    if (configuredDatabaseName.toLowerCase() === testDatabaseName.toLowerCase()) {
      throw new Error('auth MySQL test database must differ from MYSQL_URL');
    }
  }

  await clearDedicatedSchema(mysqlTestUrl);
  runMigrationRunner(mysqlTestUrl);
  const databases = new Set<MysqlDatabase>();
  const createDatabase = (): MysqlDatabase => {
    const database = createMysqlDatabase(mysqlTestUrl);
    databases.add(database);
    return database;
  };
  const database = createDatabase();
  try {
    return await work({ database, createDatabase });
  } finally {
    await Promise.allSettled(Array.from(databases, (openedDatabase) => openedDatabase.close()));
  }
}

async function clearDedicatedSchema(mysqlTestUrl: string): Promise<void> {
  const database = createMysqlDatabase(mysqlTestUrl);
  try {
    await database.transaction(async (transactionDatabase) => {
      await transactionDatabase.run('SET FOREIGN_KEY_CHECKS = 0');
      try {
        const rows = await transactionDatabase.all<MysqlRow>(`SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type
          FROM information_schema.tables
          WHERE table_schema = DATABASE()`);
        for (const row of rows) {
          const tableName = requiredIdentifier(row.table_name);
          const tableType = row.table_type;
          const objectType = tableType === 'VIEW' ? 'VIEW' : tableType === 'BASE TABLE' ? 'TABLE' : null;
          if (objectType) await transactionDatabase.run(`DROP ${objectType} IF EXISTS ${quoteIdentifier(tableName)}`);
        }
      } finally {
        await transactionDatabase.run('SET FOREIGN_KEY_CHECKS = 1');
      }
    });
  } finally {
    await database.close();
  }
}

function runMigrationRunner(mysqlTestUrl: string): void {
  const runnerPath = fileURLToPath(new URL('../../scripts/mysql-migrate.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: process.cwd(),
    env: { ...process.env, MYSQL_URL: mysqlTestUrl },
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) throw new Error('auth MySQL migrations did not complete');
}

function requiredIdentifier(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid MySQL test schema object name');
  return value;
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``;
}
