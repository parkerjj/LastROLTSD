import { describe, expect, it } from 'vitest';
import { createMysqlDatabaseForPool, type MysqlPoolLike } from '../src/db/mysql-client';

class FakePool implements MysqlPoolLike {
  readonly calls: string[] = [];
  private executeCount = 0;

  constructor(private readonly failAtExecute?: number) {}

  async execute<T>(_sql: string, _values: readonly unknown[] = []): Promise<[T, unknown]> {
    this.calls.push('execute');
    this.executeCount += 1;
    if (this.executeCount === this.failAtExecute) throw new Error('password must never be exposed');
    return [{ affectedRows: 1, insertId: 42 } as T, undefined];
  }

  async getConnection(): Promise<this> {
    return this;
  }

  async beginTransaction(): Promise<void> {
    this.calls.push('begin');
  }

  async commit(): Promise<void> {
    this.calls.push('commit');
  }

  async rollback(): Promise<void> {
    this.calls.push('rollback');
  }

  release(): void {
    this.calls.push('release');
  }

  async end(): Promise<void> {
    this.calls.push('end');
  }
}

describe('MysqlDatabase transactions', () => {
  it('rolls back and releases the same connection when a batch statement fails', async () => {
    const pool = new FakePool(2);
    const database = createMysqlDatabaseForPool(pool);

    await expect(database.transaction(async (tx) => {
      await tx.run('INSERT INTO t(v) VALUES (?)', [1]);
      await tx.run('INSERT INTO t(v) VALUES (?)', [2]);
    })).rejects.toThrow('database operation failed');

    expect(pool.calls).toEqual(['begin', 'execute', 'execute', 'rollback', 'release']);
  });

  it('commits a successful transaction and uses prepared execution', async () => {
    const pool = new FakePool();
    const database = createMysqlDatabaseForPool(pool);

    await database.transaction(async (tx) => {
      await tx.run('INSERT INTO t(v) VALUES (?)', [1]);
    });

    expect(pool.calls).toEqual(['begin', 'execute', 'commit', 'release']);
  });
});
