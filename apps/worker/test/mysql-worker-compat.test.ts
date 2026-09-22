import mysql from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMysqlDatabase, MysqlDatabaseError } from '../src/db/mysql-client';

afterEach(() => vi.restoreAllMocks());

describe('MySQL Worker compatibility', () => {
  it('disables dynamic parser compilation on the pool used for queries', async () => {
    const originalCreatePool = mysql.createPool;
    const createPool = vi.spyOn(mysql, 'createPool').mockImplementation((config) => {
      const pool = originalCreatePool(config);
      vi.spyOn(pool, 'execute').mockResolvedValue([[], []] as never);
      return pool;
    });
    const database = createMysqlDatabase('mysql://test:secret@localhost/test');
    // Keep the real driver configuration, but avoid opening an external socket.
    try {
      await database.healthcheck();
      expect(createPool.mock.results[0]?.value.pool.config.connectionConfig.disableEval).toBe(true);
    } finally {
      await database.close();
    }
  });

  it('identifies the Workers eval restriction without a MySQL server error code', () => {
    const error = new MysqlDatabaseError(new EvalError('Code generation from strings disallowed for this context'));
    expect(error.code).toBe('MYSQL_EVAL_DISABLED');
    expect(error.message).toContain('disableEval');
  });

  it('preserves server error codes while keeping SQL and credentials out of diagnostics', () => {
    const error = new MysqlDatabaseError(Object.assign(new Error('secret SQL and password'), {
      code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000',
    }));
    expect(error).toMatchObject({ code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' });
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain('secret SQL and password');
    expect(new MysqlDatabaseError(new Error('secret')).code).toBe('MYSQL_CLIENT_ERROR');
  });
});
