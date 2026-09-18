import { describe, expect, it } from 'vitest';
import { createD1Repository } from '../src/db/d1-repository';

class Prepared {
  public bound: unknown[] = [];
  constructor(public readonly sql: string, private readonly row: Record<string, unknown> | null = null) {}
  bind(...values: unknown[]) { this.bound = values; return this; }
  async first<T>() { return this.row as T | null; }
  async all<T>() { return { results: this.row ? [this.row as T] : [] }; }
  async run() { return { meta: { changes: 1 } }; }
}

class FakeDb {
  statements: Prepared[] = [];
  prepare(sql: string) { const statement = new Prepared(sql, sql.includes('market_sources') ? { id: 's1', name: 'Source', api_key_hash: 'hash', status: 'active' } : null); this.statements.push(statement); return statement as never; }
  async batch(statements: Prepared[]) { return statements.map(() => ({ meta: { changes: 1 } })); }
}

describe('D1 repository', () => {
  it('binds source hash and maps source rows', async () => {
    const db = new FakeDb();
    const source = await createD1Repository(db as never).findSourceByApiKeyHash('secret-hash');
    expect(source?.id).toBe('s1');
    expect(db.statements[0]?.sql).not.toContain('secret-hash');
    expect(db.statements[0]?.bound).toEqual(['secret-hash']);
  });

  it('rejects oversized generated batches', async () => {
    const db = new FakeDb();
    const repo = createD1Repository(db as never);
    await expect(repo.applyListingChanges(Array.from({ length: 46 }, (_, id) => ({ listingId: id, expectedVersion: 0, price: 1, quantity: 1, status: 'active', observedAt: 1, batchId: 'b' })))).rejects.toThrow(/batch statement/);
  });
});
