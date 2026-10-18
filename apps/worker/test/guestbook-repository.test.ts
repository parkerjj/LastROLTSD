import { describe, expect, it } from 'vitest';
import { createGuestbookRepository, guestbookRateKey } from '../src/db/guestbook-repository';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';

interface FakeOptions {
  requestCount?: number;
  affectedRows?: number;
  runError?: { errno: number; on: string };
}

class FakeDatabase implements MysqlDatabase {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  private index = 0;
  constructor(private readonly responses: MysqlRow[][] = [], private readonly options: FakeOptions = {}) {}
  async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    this.calls.push({ sql, values });
    const rows = this.responses[Math.min(this.index, this.responses.length - 1)] ?? [];
    this.index += 1;
    return rows as T[];
  }
  async first<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T | null> {
    this.calls.push({ sql, values });
    if (sql.includes('FROM guestbook_entries')) return ((this.responses[0]?.[0] ?? null) as T | null);
    return ({ request_count: this.options.requestCount ?? 1 } as unknown as T);
  }
  async run(sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> {
    this.calls.push({ sql, values });
    const error = this.options.runError;
    if (error && sql.includes(error.on)) throw Object.assign(new Error('mysql error'), { errno: error.errno });
    return { affectedRows: this.options.affectedRows ?? 1, insertId: 3 };
  }
  async transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> { return work(this); }
  async healthcheck(): Promise<void> {}
  async close(): Promise<void> {}
}

const authorColumns = {
  author_user_id: '10002', author_display_name: '小明', author_avatar_version: 3, author_admin: 1, author_has_avatar: 1,
};

const entryRow = (overrides: MysqlRow = {}): MysqlRow => ({
  id: 3, category: 'sell', item_id: 100, is_zeny: 0, contact: null, content: 'hello',
  created_at: 1, expires_at: null, edited_at: null, ...authorColumns, ...overrides,
});

const submission = { category: 'suggestion' as const, itemId: null, isZeny: false, content: 'hello', createdAt: 10, expiresAt: null };

describe('guestbook MySQL repository', () => {
  it('includes expired rows and computes expiration at the exact boundary', async () => {
    const db = new FakeDatabase([[entryRow({ content: 'expired', expires_at: 20 })]]);
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

  it('maps joined author columns and falls back to a guest author for legacy rows', async () => {
    const legacy = entryRow({ id: 4, contact: 'QQ 123', author_user_id: null, author_display_name: null, author_avatar_version: null, author_admin: null, author_has_avatar: null });
    const db = new FakeDatabase([[entryRow(), legacy], []]);
    const page = await createGuestbookRepository(db, '0123456789abcdef').search({ limit: 20, context: 'all' }, 100);
    expect(page.items[0]?.author).toEqual({
      userId: '10002', displayName: '小明', hasAvatar: true, avatarVersion: 3,
      avatarUrl: '/api/v1/users/10002/avatar?v=3', admin: 1,
    });
    expect(page.items[1]?.author).toBeNull();
    expect(page.items[1]?.contact).toBe('QQ 123');
  });

  it('attaches replies to their entries in ascending order', async () => {
    const replyRow = {
      id: 11, entry_id: 3, content: '回复内容', created_at: 5, edited_at: 6, ...authorColumns,
    };
    const db = new FakeDatabase([[entryRow()], [replyRow]]);
    const page = await createGuestbookRepository(db, '0123456789abcdef').search({ limit: 20, context: 'all' }, 100);
    expect(page.items[0]?.replies).toHaveLength(1);
    expect(page.items[0]?.replies[0]).toMatchObject({
      id: 11, entryId: 3, content: '回复内容', editedAt: 6,
      author: { userId: '10002', displayName: '小明' },
    });
    expect(db.calls[1]?.sql).toContain('FROM guestbook_replies');
    expect(db.calls[1]?.values).toEqual([3]);
  });

  it('inserts rate bucket and entry within one transaction, binding the user id', async () => {
    const db = new FakeDatabase();
    const result = await createGuestbookRepository(db, '0123456789abcdef')
      .create(submission, '10002', 'a'.repeat(64), 0, 5);
    expect(result).toEqual({ status: 'created', id: 3 });
    expect(db.calls[0]?.sql).toContain('ON DUPLICATE KEY UPDATE request_count = request_count + 1');
    const insert = db.calls.at(-1)!;
    expect(insert.sql).toContain('INSERT INTO guestbook_entries');
    expect(insert.values[0]).toBe('10002');
    expect(insert.values).toContain(null);
  });

  it('reports rate limiting when the bucket exceeds the limit', async () => {
    const db = new FakeDatabase([], { requestCount: 99 });
    const result = await createGuestbookRepository(db, '0123456789abcdef')
      .create(submission, '10002', 'a'.repeat(64), 0, 5);
    expect(result).toEqual({ status: 'rate_limited' });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO guestbook_entries'))).toBe(false);
  });

  it('updates entry content only when both id and user id match', async () => {
    const db = new FakeDatabase();
    const updated = await createGuestbookRepository(db, '0123456789abcdef').updateEntryContent(3, '10002', '改后', 50);
    expect(updated).toBe(true);
    expect(db.calls[0]?.sql).toContain('UPDATE guestbook_entries SET content = ?, edited_at = ?');
    expect(db.calls[0]?.sql).toContain('AND user_id = ?');
    expect(db.calls[0]?.values).toEqual(['改后', 50, 3, '10002']);
    const denied = await createGuestbookRepository(new FakeDatabase([], { affectedRows: 0 }), '0123456789abcdef').updateEntryContent(3, '10002', '改后', 50);
    expect(denied).toBe(false);
  });

  it('creates replies and maps MySQL constraint errors to domain results', async () => {
    const repo = createGuestbookRepository(new FakeDatabase(), '0123456789abcdef');
    const created = await repo.createReply(3, '10002', '回复', 10, 'b'.repeat(64), 0, 5);
    expect(created).toEqual({ status: 'created', id: 3 });

    const duplicate = await createGuestbookRepository(new FakeDatabase([], { runError: { errno: 1062, on: 'guestbook_replies' } }), '0123456789abcdef')
      .createReply(3, '10002', '再来一条', 10, 'b'.repeat(64), 0, 5);
    expect(duplicate).toEqual({ status: 'duplicate' });

    const missing = await createGuestbookRepository(new FakeDatabase([], { runError: { errno: 1452, on: 'guestbook_replies' } }), '0123456789abcdef')
      .createReply(999, '10002', '回复', 10, 'b'.repeat(64), 0, 5);
    expect(missing).toEqual({ status: 'entry_not_found' });

    const limited = await createGuestbookRepository(new FakeDatabase([], { requestCount: 99 }), '0123456789abcdef')
      .createReply(3, '10002', '回复', 10, 'b'.repeat(64), 0, 5);
    expect(limited).toEqual({ status: 'rate_limited' });
  });

  it('updates reply content only for the reply author', async () => {
    const db = new FakeDatabase();
    const updated = await createGuestbookRepository(db, '0123456789abcdef').updateReplyContent(11, '10002', '改后', 60);
    expect(updated).toBe(true);
    expect(db.calls[0]?.sql).toContain('UPDATE guestbook_replies SET content = ?, edited_at = ?');
    expect(db.calls[0]?.values).toEqual(['改后', 60, 11, '10002']);
    const denied = await createGuestbookRepository(new FakeDatabase([], { affectedRows: 0 }), '0123456789abcdef').updateReplyContent(11, '10002', '改后', 60);
    expect(denied).toBe(false);
  });

  it('scopes rate keys by action and user', () => {
    const secret = 's'.repeat(32);
    expect(guestbookRateKey('entry', '10002', secret)).not.toBe(guestbookRateKey('reply', '10002', secret));
    expect(guestbookRateKey('entry', '10002', secret)).not.toBe(guestbookRateKey('entry', '10003', secret));
  });
});
