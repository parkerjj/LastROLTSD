import mysql, { type ResultSetHeader } from 'mysql2/promise';

export const MYSQL_POOL_CONNECTION_LIMIT = 2;

export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
}

export interface MysqlRow {
  [column: string]: unknown;
}

export interface MysqlWriteResult {
  affectedRows: number;
  insertId: number;
}

type MysqlQueryResult = MysqlRow[] | ResultSetHeader;

interface MysqlExecutorLike {
  execute<T extends MysqlQueryResult>(sql: string, values?: readonly unknown[]): Promise<[T, unknown]>;
}

interface MysqlConnectionLike extends MysqlExecutorLike {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface MysqlPoolLike extends MysqlExecutorLike {
  getConnection(): Promise<MysqlConnectionLike>;
  end(): Promise<void>;
}

export interface MysqlDatabase {
  all<T extends MysqlRow = MysqlRow>(sql: string, values?: readonly unknown[]): Promise<T[]>;
  first<T extends MysqlRow = MysqlRow>(sql: string, values?: readonly unknown[]): Promise<T | null>;
  run(sql: string, values?: readonly unknown[]): Promise<MysqlWriteResult>;
  transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T>;
  healthcheck(): Promise<void>;
  close(): Promise<void>;
}

export class MysqlDatabaseError extends Error {
  public readonly code: string = 'MYSQL_CLIENT_ERROR';
  public readonly errno?: number;
  public readonly sqlState?: string;
  constructor(cause?: unknown) {
    super('database operation failed');
    this.name = 'MysqlDatabaseError';
    if (cause instanceof Error && cause.message.includes('Code generation from strings disallowed')) {
      this.code = 'MYSQL_EVAL_DISABLED';
      this.message = 'database operation failed: mysql2 requires disableEval: true in Workers';
    }
    if (cause && typeof cause === 'object') {
      const value = cause as { code?: unknown; errno?: unknown; sqlState?: unknown };
      if (typeof value.code === 'string') this.code = value.code;
      if (typeof value.errno === 'number') this.errno = value.errno;
      if (typeof value.sqlState === 'string') this.sqlState = value.sqlState;
    }
  }
}

export function parseMysqlUrl(value: string): MysqlConfig {
  const rawPort = extractRawPort(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    if (rawPort !== undefined && (!Number.isSafeInteger(rawPort) || rawPort < 1 || rawPort > 65_535)) {
      throw new Error('MYSQL_URL port must be between 1 and 65535');
    }
    throw new Error('MYSQL_URL must be a valid mysql URL');
  }

  if (url.protocol !== 'mysql:') throw new Error('MYSQL_URL must use the mysql:// scheme');
  const port = url.port === '' ? 3306 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('MYSQL_URL port must be between 1 and 65535');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!url.hostname || !url.username || !database || database.includes('/')) {
    throw new Error('MYSQL_URL must include host, user, and database');
  }

  const parameters = Array.from(url.searchParams.entries());
  if (parameters.some(([key]) => key !== 'ssl') || parameters.length > 1) {
    throw new Error('MYSQL_URL contains unsupported options');
  }
  const sslValue = url.searchParams.get('ssl');
  if (sslValue !== null && !['true', 'false', '1', '0'].includes(sslValue)) {
    throw new Error('MYSQL_URL ssl must be true, false, 1, or 0');
  }

  return {
    host: url.hostname,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: sslValue === 'true' || sslValue === '1',
  };
}

export function makePlaceholders(rowCount: number, rowWidth: number): string {
  assertPositiveInteger(rowCount, 'row count');
  assertPositiveInteger(rowWidth, 'row width');
  return Array.from({ length: rowCount }, () => `(${Array.from({ length: rowWidth }, () => '?').join(', ')})`).join(', ');
}

export function chunkRows<T>(rows: readonly T[], rowWidth: number, maximumBoundValues: number): T[][] {
  assertPositiveInteger(rowWidth, 'row width');
  assertPositiveInteger(maximumBoundValues, 'maximum bound values');
  if (maximumBoundValues < rowWidth) throw new Error('maximum bound values must be at least the row width');
  const chunkSize = Math.floor(maximumBoundValues / rowWidth);
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) chunks.push(rows.slice(index, index + chunkSize));
  return chunks;
}

export function createMysqlDatabase(mysqlUrl: string): MysqlDatabase {
  const config = parseMysqlUrl(mysqlUrl);
  let pool: MysqlPoolLike | undefined;
  return createMysqlDatabaseForPoolFactory(() => {
    pool ??= mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      // JSON_TABLE text columns inherit the connection collation; match the schema.
      charset: 'utf8mb4_0900_ai_ci',
      // Workers disallow the dynamic Function constructor used by mysql2 parsers.
      disableEval: true,
      waitForConnections: true,
      connectionLimit: MYSQL_POOL_CONNECTION_LIMIT,
      maxIdle: MYSQL_POOL_CONNECTION_LIMIT,
      idleTimeout: 10_000,
      enableKeepAlive: true,
      ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    }) as unknown as MysqlPoolLike;
    return pool;
  }, async () => {
    const poolToClose = pool;
    if (poolToClose) await protect(() => poolToClose.end());
  });
}

export function createMysqlDatabaseForPool(pool: MysqlPoolLike): MysqlDatabase {
  return createMysqlDatabaseForPoolFactory(() => pool, async () => {
    await protect(() => pool.end());
  });
}

function createMysqlDatabaseForPoolFactory(poolFor: () => MysqlPoolLike, closePool: () => Promise<void>): MysqlDatabase {
  const databaseFor = (executor: MysqlExecutorLike, close: () => Promise<void>): MysqlDatabase => ({
    all: async <T extends MysqlRow = MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> => {
      const result = await execute<MysqlRow[]>(executor, sql, values);
      if (!Array.isArray(result)) throw new MysqlDatabaseError();
      return result as T[];
    },
    first: async <T extends MysqlRow = MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T | null> => {
      const rows = await databaseFor(executor, close).all<T>(sql, values);
      return rows[0] ?? null;
    },
    run: async (sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> => {
      const result = await execute<ResultSetHeader>(executor, sql, values);
      if (Array.isArray(result)) throw new MysqlDatabaseError();
      return { affectedRows: Number(result.affectedRows), insertId: Number(result.insertId) };
    },
    transaction: async <T>(work: (transactionDatabase: MysqlDatabase) => Promise<T>): Promise<T> => {
      let connection: MysqlConnectionLike | undefined;
      let began = false;
      try {
        const transactionConnection = await protect(() => poolFor().getConnection());
        connection = transactionConnection;
        await protect(() => transactionConnection.beginTransaction());
        began = true;
        const value = await work(databaseFor(transactionConnection, async () => undefined));
        await protect(() => transactionConnection.commit());
        return value;
      } catch (error) {
        if (connection && began) {
          try {
            await connection.rollback();
          } catch {
            // The original operation error remains the safe application error.
          }
        }
        throw error;
      } finally {
        if (connection) connection.release();
      }
    },
    healthcheck: async (): Promise<void> => {
      await execute<MysqlRow[]>(executor, 'SELECT 1 AS healthy', []);
    },
    close,
  });

  return databaseFor({
    execute: (sql, values) => poolFor().execute(sql, values),
  }, closePool);
}

async function execute<T extends MysqlQueryResult>(executor: MysqlExecutorLike, sql: string, values: readonly unknown[]): Promise<T> {
  return protect(async () => (await executor.execute<T>(sql, values))[0]);
}

async function protect<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof MysqlDatabaseError) throw error;
    throw new MysqlDatabaseError(error);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function extractRawPort(value: string): number | undefined {
  const schemeIndex = value.indexOf('://');
  if (schemeIndex === -1) return undefined;
  const authority = value.slice(schemeIndex + 3).split(/[/?#]/u, 1)[0] ?? '';
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const match = /:(\d+)$/u.exec(hostPort);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}
