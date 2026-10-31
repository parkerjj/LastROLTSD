import { describe, expect, it } from 'vitest';
import { createCommerceRepository } from '../src/commerce/repository';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';

class FakeDatabase implements MysqlDatabase {
  readonly calls: Array<{ method: 'all' | 'first' | 'run'; sql: string; values: readonly unknown[] }> = [];
  commitCount = 0;
  rollbackCount = 0;
  userExists = true;

  async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    this.calls.push({ method: 'all', sql, values });
    return [];
  }

  async first<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T | null> {
    this.calls.push({ method: 'first', sql, values });
    if (sql.includes('FROM auth_users')) return this.userExists ? { id: values[0] } as unknown as T : null;
    return null;
  }

  async run(sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> {
    this.calls.push({ method: 'run', sql, values });
    return { affectedRows: 1, insertId: 1 };
  }

  async transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> {
    try {
      const result = await work(this);
      this.commitCount += 1;
      return result;
    } catch (error) {
      this.rollbackCount += 1;
      throw error;
    }
  }

  async healthcheck(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('commerce repository transaction boundary', () => {
  it('locks the string user ID before any account-owned commerce row read', async () => {
    const db = new FakeDatabase();
    const repository = createCommerceRepository(db);
    const userId = '9007199254740993';

    await repository.transaction(async (tx) => {
      await expect(tx.lockUser(userId)).resolves.toBe(true);
      await tx.first('SELECT id FROM commerce_orders WHERE user_id = ? FOR UPDATE', [userId]);
    });

    expect(db.calls.map(({ sql }) => sql)).toEqual([
      'SELECT id FROM auth_users WHERE id = ? FOR UPDATE',
      'SELECT id FROM commerce_orders WHERE user_id = ? FOR UPDATE',
    ]);
    expect(db.calls[0]?.values).toEqual([userId]);
    expect(db.commitCount).toBe(1);
  });

  it('returns false for a missing user without reading commerce rows', async () => {
    const db = new FakeDatabase();
    db.userExists = false;

    await expect(createCommerceRepository(db).transaction((tx) => tx.lockUser('42'))).resolves.toBe(false);
    expect(db.calls).toHaveLength(1);
    expect(db.commitCount).toBe(1);
  });

  it('rejects IDs that are not canonical unsigned BIGINT decimal strings', async () => {
    const db = new FakeDatabase();
    const repository = createCommerceRepository(db);

    for (const invalidId of ['', '0', '01', '-1', '1e3', '18446744073709551616']) {
      await expect(repository.transaction((tx) => tx.lockUser(invalidId))).rejects.toThrow('invalid commerce ID');
    }
    await expect(repository.transaction((tx) => tx.lockUser(42 as unknown as string))).rejects.toThrow('invalid commerce ID');
    expect(db.calls).toHaveLength(0);
  });

  it('propagates transaction failures so MysqlDatabase rolls back all writes', async () => {
    const db = new FakeDatabase();
    const repository = createCommerceRepository(db);

    await expect(repository.transaction(async (tx) => {
      await tx.lockUser('42');
      await tx.run('INSERT INTO commerce_quotes (user_id) VALUES (?)', ['42']);
      throw new Error('abort transaction');
    })).rejects.toThrow('abort transaction');

    expect(db.commitCount).toBe(0);
    expect(db.rollbackCount).toBe(1);
  });
});
