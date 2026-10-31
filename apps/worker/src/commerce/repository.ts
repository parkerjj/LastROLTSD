import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../db/mysql-client';

export type CommerceId = string;

export interface CommerceTransaction {
  all<T extends MysqlRow = MysqlRow>(sql: string, values?: readonly unknown[]): Promise<T[]>;
  first<T extends MysqlRow = MysqlRow>(sql: string, values?: readonly unknown[]): Promise<T | null>;
  run(sql: string, values?: readonly unknown[]): Promise<MysqlWriteResult>;
  lockUser(userId: CommerceId): Promise<boolean>;
}

export interface CommerceRepository {
  transaction<T>(work: (tx: CommerceTransaction) => Promise<T>): Promise<T>;
}

const MYSQL_UNSIGNED_BIGINT_MAX = 18_446_744_073_709_551_615n;

export function assertCommerceId(value: unknown): CommerceId {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/u.test(value) || BigInt(value) > MYSQL_UNSIGNED_BIGINT_MAX) {
    throw new RangeError('invalid commerce ID');
  }
  return value;
}

export async function readLastInsertId(tx: Pick<CommerceTransaction, 'first'>): Promise<CommerceId> {
  const row = await tx.first('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
  if (!row) throw new Error('commerce insert ID unavailable');
  return assertCommerceId(row.id);
}

export function commerceTransactionView(database: MysqlDatabase): CommerceTransaction {
  return {
    all: <T extends MysqlRow = MysqlRow>(sql: string, values?: readonly unknown[]) => database.all<T>(sql, values),
    first: <T extends MysqlRow = MysqlRow>(sql: string, values?: readonly unknown[]) => database.first<T>(sql, values),
    run: (sql: string, values?: readonly unknown[]) => database.run(sql, values),
    lockUser: async (userId) => {
      const id = assertCommerceId(userId);
      const row = await database.first('SELECT id FROM auth_users WHERE id = ? FOR UPDATE', [id]);
      return row !== null;
    },
  };
}

export function createCommerceRepository(db: MysqlDatabase): CommerceRepository {
  return {
    transaction: (work) => db.transaction((database) => work(commerceTransactionView(database))),
  };
}
