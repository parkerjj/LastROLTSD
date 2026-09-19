import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createD1Repository } from '../src/db/d1-repository';
import { computeShopIdentity } from '../src/domain/shop-identity';

class SqlitePrepared {
  public values: unknown[] = [];

  constructor(private readonly database: DatabaseSync, public readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.values) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes ?? 0) } };
  }
}

class SqliteD1 {
  constructor(public readonly database: DatabaseSync, private readonly failOnSql?: RegExp) {}

  prepare(sql: string): SqlitePrepared {
    return new SqlitePrepared(this.database, sql);
  }

  async batch(statements: SqlitePrepared[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec('BEGIN');
    try {
      const results: Array<{ meta: { changes: number } }> = [];
      for (const statement of statements) {
        if (this.failOnSql?.test(statement.sql)) throw new Error('synthetic D1 batch failure');
        const result = this.database.prepare(statement.sql).run(...statement.values);
        results.push({ meta: { changes: Number(result.changes ?? 0) } });
      }
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function applyMigrations(database: DatabaseSync): void {
  for (const name of readdirSync(resolve(process.cwd(), 'migrations')).filter((value) => /^\d{4}_.+\.sql$/u.test(value)).sort()) {
    database.exec(readFileSync(resolve(process.cwd(), 'migrations', name), 'utf8'));
  }
}

function createDatabase(failOnSql?: RegExp): SqliteD1 {
  const database = new DatabaseSync(':memory:');
  applyMigrations(database);
  database.exec("INSERT INTO market_sources(id,name,api_key_hash,created_at) VALUES ('source-a','A','hash-a',0),('source-b','B','hash-b',0)");
  return new SqliteD1(database, failOnSql);
}

async function input(sourceId: string, batchId: string, observedAt: number, shopStatus: 'opening' | 'dismissed' = 'opening') {
  const identity = await computeShopIdentity({ sourceId, vendorAccountId: 'account-1', shopType: 'sell', mapName: 'prontera', x: 100, y: 120, title: 'Synthetic shop' });
  return {
    sourceId,
    identityHash: identity.identityHash,
    shopId: identity.shopId,
    shopStatus,
    batchId,
    vendorAccountId: 'account-1',
    clientRunId: 'run-1',
    observedAt,
    vendorName: 'Synthetic vendor',
    title: 'Synthetic shop',
    shopType: 'sell' as const,
    mapName: 'prontera',
    x: 100,
    y: 120,
  };
}

describe('D1 shop lifecycle', () => {
  it('records the upload batch, closes session/listings atomically, and writes no sold event', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      const opening = await repository.resolveShopObservation!(await input('source-a', 'open-1', 100));
      d1.database.prepare("INSERT INTO listings(shop_session_id,item_fingerprint,item_id,price,quantity,last_quantity,first_seen_at,last_seen_at,last_changed_at) VALUES (?, 'fp', 1234, 100, 2, 2, 100, 100, 100)").run(opening.session!.id);

      const dismissed = await repository.resolveShopObservation!(await input('source-a', 'dismiss-1', 200, 'dismissed'));

      expect(dismissed.resolution).toBe('dismissed');
      expect(d1.database.prepare('SELECT status,last_status_batch_id FROM shops WHERE id=?').get(opening.internalShopId)).toEqual({ status: 'closed', last_status_batch_id: 'dismiss-1' });
      expect(d1.database.prepare('SELECT ended_at FROM shop_sessions WHERE id=?').get(opening.session!.id)).toEqual({ ended_at: 200 });
      expect(d1.database.prepare('SELECT status FROM listings WHERE shop_session_id=?').get(opening.session!.id)).toEqual({ status: 'expired' });
      expect(d1.database.prepare('SELECT COUNT(*) AS count FROM sold_events').get()).toEqual({ count: 0 });
    } finally {
      d1.database.close();
    }
  });

  it('rolls back the shop close when session/listing expiry fails in the same batch', async () => {
    const d1 = createDatabase(/UPDATE listings SET status='expired'/u);
    try {
      const repository = createD1Repository(d1 as never);
      const opening = await repository.resolveShopObservation!(await input('source-a', 'open-1', 100));
      d1.database.prepare("INSERT INTO listings(shop_session_id,item_fingerprint,item_id,price,quantity,last_quantity,first_seen_at,last_seen_at,last_changed_at) VALUES (?, 'fp', 1234, 100, 2, 2, 100, 100, 100)").run(opening.session!.id);

      await expect(repository.resolveShopObservation!(await input('source-a', 'dismiss-1', 200, 'dismissed'))).rejects.toThrow('synthetic D1 batch failure');
      expect(d1.database.prepare('SELECT status,last_status_batch_id FROM shops WHERE id=?').get(opening.internalShopId)).toEqual({ status: 'active', last_status_batch_id: 'open-1' });
      expect(d1.database.prepare('SELECT ended_at FROM shop_sessions WHERE id=?').get(opening.session!.id)).toEqual({ ended_at: null });
      expect(d1.database.prepare('SELECT status FROM listings WHERE shop_session_id=?').get(opening.session!.id)).toEqual({ status: 'active' });
    } finally {
      d1.database.close();
    }
  });

  it('ignores stale openings, creates a new session for newer openings, and isolates sources', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      const first = await repository.resolveShopObservation!(await input('source-a', 'open-1', 100));
      await repository.resolveShopObservation!(await input('source-a', 'dismiss-1', 200, 'dismissed'));

      const stale = await repository.resolveShopObservation!(await input('source-a', 'open-old', 150));
      expect(stale.resolution).toBe('stale_event_ignored');
      expect(stale.session).toBeNull();

      const reopened = await repository.resolveShopObservation!(await input('source-a', 'open-2', 300));
      expect(reopened.resolution).toBe('created');
      expect(reopened.session?.id).not.toBe(first.session?.id);
      expect(d1.database.prepare('SELECT COUNT(*) AS count FROM shop_sessions').get()).toEqual({ count: 2 });

      const otherSource = await repository.resolveShopObservation!(await input('source-b', 'open-b', 300));
      expect(otherSource.resolution).toBe('created');
      expect(otherSource.internalShopId).not.toBe(reopened.internalShopId);
      expect(otherSource.shopId).not.toBe(reopened.shopId);
    } finally {
      d1.database.close();
    }
  });
});
