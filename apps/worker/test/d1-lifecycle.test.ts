import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createD1Repository } from '../src/db/d1-repository';
import { computeShopIdentity } from '../src/domain/shop-identity';

class SqlitePrepared {
  private values: SQLInputValue[] = [];
  constructor(private readonly database: DatabaseSync, public readonly sql: string) {}
  bind(...values: SQLInputValue[]): this { this.values = values; return this; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.database.prepare(this.sql).all(...this.values) as T[] }; }
  async run(): Promise<{ meta: { changes: number } }> { const result = this.database.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes ?? 0) } }; }
}

class SqliteD1 {
  constructor(public readonly database: DatabaseSync) {}
  prepare(sql: string): SqlitePrepared { return new SqlitePrepared(this.database, sql); }
  async batch(statements: SqlitePrepared[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec('BEGIN');
    try {
      const results: Array<{ meta: { changes: number } }> = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function createDatabase(): SqliteD1 {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(resolve(process.cwd(), 'migrations/0001_initial.sql'), 'utf8'));
  database.exec("INSERT INTO market_sources(id,name,api_key_hash,created_at,updated_at) VALUES ('source-a','A','hash-a',0,0),('source-b','B','hash-b',0,0)");
  return new SqliteD1(database);
}

async function observation(sourceId: string, observedAt: number, status: 'opening' | 'dismissed' = 'opening', account = 'account-1') {
  const identity = await computeShopIdentity({ sourceId, vendorAccountId: account, shopType: 'sell', mapName: 'prontera', x: 100, y: 120, title: 'Synthetic shop' });
  return {
    sourceId, identityHash: identity.identityHash, shopId: identity.shopId, shopStatus: status,
    batchId: `batch-${observedAt}`, vendorAccountId: account, clientRunId: 'run-1', observedAt,
    vendorName: 'Synthetic vendor', title: 'Synthetic shop', shopType: 'sell' as const,
    mapName: 'prontera', x: 100, y: 120,
  };
}

async function addBatch(repository: ReturnType<typeof createD1Repository>, sourceId: string, batchId: string, snapshotId: string, observedAt: number) {
  return repository.insertBatch({ sourceId, batchId, snapshotId, partIndex: 0, partCount: 1, snapshotMode: 'full', payloadHash: `${batchId}-hash`, responseJson: null, receivedAt: observedAt });
}

describe('D1 clean-break lifecycle', () => {
  it('upserts sources/shops, inserts listings and records listing transitions in final tables', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      expect(await repository.findSourceByApiKeyHash('hash-a')).toMatchObject({ id: 'source-a' });
      const resolved = await repository.resolveShopObservation!(await observation('source-a', 100));
      expect(resolved).toMatchObject({ resolution: 'created', status: 'opening', applied: true });
      const session = resolved.session!;
      const listing = await repository.createListing!({ sessionId: session.id, fingerprint: 'fp-1', itemKey: 'slot-1', itemId: 4001, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 100, quantity: 3, observedAt: 100, batchId: 'batch-100' });
      await repository.insertListingOptions!({ listingId: listing.id, options: [{ type: 12, value: 60, param: 0 }] });
      const transition = await repository.applyListingTransitions!([{ listingId: listing.id, shopSessionId: session.id, expectedVersion: listing.stateVersion, price: 90, quantity: 1, status: 'active', observedAt: 110, batchId: 'batch-110', history: { eventType: 'quantity_changed' }, soldEvent: { soldQuantity: 2, fromQuantity: 3, toQuantity: 1, reason: 'quantity_decrease', transitionKey: 'transition-1' } }]);
      expect(transition).toMatchObject({ updated: 1, conflicts: 0, soldEvents: 1 });
      const history = await repository.getListingHistory(listing.id, 50);
      expect(history?.items[0]).toMatchObject({ price: 90, quantity: 1, batchId: 'batch-110' });
      expect(history?.inferredSales?.[0]).toMatchObject({ soldQuantity: 2, fromQuantity: 3, toQuantity: 1 });
      expect(d1.database.prepare("SELECT COUNT(*) AS count FROM listing_events WHERE listing_id=?").get(listing.id)).toEqual({ count: 2 });
      expect(d1.database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('vendors','shop_sessions','sold_events','item_catalog','search_short_tokens')").get()).toEqual({ count: 0 });
    } finally { d1.database.close(); }
  });

  it('requires a full snapshot until finalized and preserves source-scoped shop state', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      const first = await observation('source-a', 100);
      expect(await repository.requiresFullSnapshot!([first])).toBe(true);
      const resolved = await repository.resolveShopObservation!(first);
      await addBatch(repository, 'source-a', 'full-1/0', 'full-1', 100);
      await repository.recordSnapshotSessions!('source-a', 'full-1', [resolved.internalShopId], 100);
      await repository.finalizeSnapshot('source-a', 'full-1', 100);
      expect(await repository.requiresFullSnapshot!([{ ...first, observedAt: 200, batchId: 'full-2/0' }])).toBe(false);
      const matched = await repository.resolveShopObservation!({ ...first, observedAt: 200, batchId: 'full-2/0' });
      expect(matched).toMatchObject({ resolution: 'matched', session: { initialSyncComplete: true, lastCompleteSnapshotId: 'full-1' } });
      const other = await repository.resolveShopObservation!(await observation('source-b', 200, 'opening', 'account-b'));
      expect(other.internalShopId).not.toBe(matched.internalShopId);
      expect(d1.database.prepare('SELECT full_state_hash FROM shops WHERE id=?').get(matched.internalShopId)).toEqual({ full_state_hash: 'full-1' });
    } finally { d1.database.close(); }
  });

  it('dismisses atomically, expires active listings, ignores stale events, and resets baseline on reopen', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      const openingInput = await observation('source-a', 100);
      const opening = await repository.resolveShopObservation!(openingInput);
      const listing = await repository.createListing!({ sessionId: opening.internalShopId, fingerprint: 'fp-dismiss', itemId: 4001, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 10, quantity: 1, observedAt: 100, batchId: 'open-1' });
      const dismissed = await repository.resolveShopObservation!({ ...openingInput, observedAt: 200, batchId: 'dismiss-1', shopStatus: 'dismissed' });
      expect(dismissed).toMatchObject({ resolution: 'dismissed', status: 'dismissed', applied: true, session: null });
      expect(d1.database.prepare('SELECT status,closed_at FROM shops WHERE id=?').get(opening.internalShopId)).toEqual({ status: 'closed', closed_at: 200 });
      expect(d1.database.prepare('SELECT status FROM listings WHERE id=?').get(listing.id)).toEqual({ status: 'expired' });
      const stale = await repository.resolveShopObservation!({ ...openingInput, observedAt: 150, batchId: 'open-old' });
      expect(stale).toMatchObject({ resolution: 'stale_event_ignored', applied: false, session: null });
      const reopened = await repository.resolveShopObservation!({ ...openingInput, observedAt: 300, batchId: 'open-2' });
      expect(reopened).toMatchObject({ resolution: 'created', status: 'opening', applied: true, session: { initialSyncComplete: false } });
      expect(d1.database.prepare('SELECT status,full_state_hash FROM shops WHERE id=?').get(opening.internalShopId)).toEqual({ status: 'active', full_state_hash: null });
    } finally { d1.database.close(); }
  });

  it('marks missing full-snapshot listings and writes inferred sold events without legacy tables', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      const resolved = await repository.resolveShopObservation!(await observation('source-a', 100));
      const listing = await repository.createListing!({ sessionId: resolved.internalShopId, fingerprint: 'fp-stale', itemId: 4001, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 10, quantity: 2, observedAt: 100, batchId: 'old-full' });
      d1.database.prepare('UPDATE shops SET full_state_hash=?,last_changed_at=? WHERE id=?').run('old-full', 100, resolved.internalShopId);
      const first = await repository.reconcileSnapshot!({ sourceId: 'source-a', snapshotId: 'new-full', observedAt: 200, batchIds: ['new-full/0'], sessionIds: [resolved.internalShopId] });
      expect(first.markedMissing).toBe(1);
      const second = await repository.reconcileSnapshot!({ sourceId: 'source-a', snapshotId: 'newer-full', observedAt: 300, batchIds: ['newer-full/0'], sessionIds: [resolved.internalShopId] });
      expect(second.inferredSold).toBe(1);
      expect(d1.database.prepare('SELECT status,missing_full_count FROM listings WHERE id=?').get(listing.id)).toEqual({ status: 'missing', missing_full_count: 2 });
      expect(d1.database.prepare("SELECT event_type,sold_quantity,reason FROM listing_events WHERE listing_id=?").get(listing.id)).toEqual({ event_type: 'missing', sold_quantity: 2, reason: 'missing_full' });
    } finally { d1.database.close(); }
  });
});
