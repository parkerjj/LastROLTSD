import { describe, expect, it } from 'vitest';
import { createGuestbookRepository } from '../src/db/guestbook-repository';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';

class FakeDatabase implements MysqlDatabase {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  constructor(private readonly rows: MysqlRow[] = []) {}
  async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> { this.calls.push({ sql, values }); return this.rows as T[]; }
  async first<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T | null> { this.calls.push({ sql, values }); return ({ request_count: 1 } as unknown as T); }
  async run(sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> { this.calls.push({ sql, values }); return { affectedRows: 1, insertId: 3 }; }
  async transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> { return work(this); }
  async healthcheck(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('guestbook MySQL repository', () => {
  it('includes expired rows and computes expiration at the exact boundary', async () => {
    const db = new FakeDatabase([{ id: 3, category: 'sell', item_id: 100, is_zeny: 0, contact: 'QQ', content: 'expired', created_at: 1, expires_at: 20 }]);
    const page = await createGuestbookRepository(db, '0123456789abcdef').search({ limit: 20, context: 'all' }, 20);
    expect(page.items).toMatchObject([{ content: 'expired', isExpired: true }]);
    expect(db.calls[0]?.sql).not.toContain('expires_at >');
  });
  it('binds search values and escapes LIKE metacharacters literally', async () => {
    const db = new FakeDatabase([]);
    await createGuestbookRepository(db, '0123456789abcdef').search({ q: "%_\\' OR 1=1 --", limit: 20, context: 'q' }, 100);
    expect(db.calls[0]?.sql).toContain("ESCAPE '\\\\'");
    expect(db.calls[0]?.sql).not.toContain("OR 1=1");
    expect(db.calls[0]?.values).toContain("%\\%\\_\\\\' OR 1=1 --%");
  });
  it('inserts rate bucket and entry within one transaction', async () => {
    const db = new FakeDatabase();
    await createGuestbookRepository(db, '0123456789abcdef').create({ category: 'suggestion', itemId: null, isZeny: false, contact: null, content: 'hello', createdAt: 10, expiresAt: null }, 'a'.repeat(64), 0, 5);
    expect(db.calls[0]?.sql).toContain('ON DUPLICATE KEY UPDATE request_count = request_count + 1');
    expect(db.calls.at(-1)?.sql).toContain('INSERT INTO guestbook_entries');
  });
});
