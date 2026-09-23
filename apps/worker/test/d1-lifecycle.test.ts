import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createD1Repository } from '../src/db/d1-repository';
import { computeShopIdentity } from '../src/domain/shop-identity';

class SqlitePrepared {
  private values: SQLInputValue[] = [];
  constructor(private readonly database: DatabaseSync, public readonly sql: string, private readonly recordRequest: () => void) {}
  bind(...values: SQLInputValue[]): this { this.values = values; return this; }
  async all<T>(): Promise<{ results: T[] }> { this.recordRequest(); return { results: this.database.prepare(this.sql).all(...this.values) as T[] }; }
  async run(): Promise<{ meta: { changes: number } }> { this.recordRequest(); const result = this.database.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes ?? 0) } }; }
  async executeForBatch(): Promise<{ meta: { changes: number }; results: unknown[] }> {
    if (/\breturning\b/iu.test(this.sql)) {
      const results = this.database.prepare(this.sql).all(...this.values) as unknown[];
      const changes = this.database.prepare('SELECT changes() AS changes').get() as { changes: number };
      return { results, meta: { changes: Number(changes.changes ?? 0) } };
    }
    const result = await this.run();
    return { results: [], meta: result.meta };
  }
}

class SqliteD1 {
  requests = 0;
  private batching = false;
  constructor(public readonly database: DatabaseSync) {}
  prepare(sql: string): SqlitePrepared { return new SqlitePrepared(this.database, sql, () => { if (!this.batching) this.requests += 1; }); }
  async batch(statements: SqlitePrepared[]): Promise<Array<{ meta: { changes: number }; results: unknown[] }>> {
    this.requests += 1;
    this.batching = true;
    this.database.exec('BEGIN');
    try {
      const results: Array<{ meta: { changes: number }; results: unknown[] }> = [];
      for (const statement of statements) results.push(await statement.executeForBatch());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    } finally {
      this.batching = false;
    }
  }
  resetRequests(): void { this.requests = 0; }
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

  it('finalizes a full snapshot and preserves source-scoped shop state', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      const first = await observation('source-a', 100);
      const resolved = await repository.resolveShopObservation!(first);
      await addBatch(repository, 'source-a', 'full-1/0', 'full-1', 100);
      await repository.recordSnapshotSessions!('source-a', 'full-1', [resolved.internalShopId], 100);
      await repository.finalizeSnapshot('source-a', 'full-1', 100);
      const matched = await repository.resolveShopObservation!({ ...first, observedAt: 200, batchId: 'full-2/0' });
      expect(matched).toMatchObject({ resolution: 'matched', session: { initialSyncComplete: true, lastCompleteSnapshotId: 'full-1' } });
      const other = await repository.resolveShopObservation!(await observation('source-b', 200, 'opening', 'account-b'));
      expect(other.internalShopId).not.toBe(matched.internalShopId);
      expect(d1.database.prepare('SELECT full_state_hash FROM shops WHERE id=?').get(matched.internalShopId)).toEqual({ full_state_hash: 'full-1' });
    } finally { d1.database.close(); }
  });

  it('resolves opening shops with two D1 requests regardless of batch size', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      const inputs = await Promise.all(Array.from({ length: 12 }, (_, index) => observation('source-a', 100, 'opening', `account-${index}`)));

      const resolved = await repository.resolveShopObservations!(inputs);

      expect(resolved).toHaveLength(inputs.length);
      expect(resolved.every((entry) => entry.resolution === 'created' && entry.session !== null)).toBe(true);
      expect(d1.requests).toBe(2);
    } finally { d1.database.close(); }
  });

  it('applies existing listing transitions in one D1 batch', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      const shop = await repository.resolveShopObservation!(await observation('source-a', 100));
      const listings = await Promise.all(Array.from({ length: 12 }, (_, index) => repository.createListing!({ sessionId: shop.internalShopId, fingerprint: `transition-${index}`, itemId: 4000 + index, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 100, quantity: 3, observedAt: 100, batchId: 'setup' })));
      d1.resetRequests();

      const result = await repository.applyListingTransitionsBulk!(listings.map((listing) => ({ listingId: listing.id, shopSessionId: listing.shopSessionId, expectedVersion: listing.stateVersion, price: 90, quantity: 3, status: 'active', observedAt: 200, batchId: 'transitions', history: { eventType: 'price_changed' } })));

      expect(result).toMatchObject({ updated: listings.length, conflicts: 0, soldEvents: 0 });
      expect(d1.requests).toBe(1);
      expect(d1.database.prepare("SELECT COUNT(*) AS count FROM listing_events WHERE snapshot_id='transitions'").get()).toEqual({ count: listings.length });
    } finally { d1.database.close(); }
  });

  it('writes new listings and their options in one D1 batch', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      const shop = await repository.resolveShopObservation!(await observation('source-a', 100));
      d1.resetRequests();

      await repository.insertNewListingsBulk!(Array.from({ length: 12 }, (_, index) => ({ sessionId: shop.internalShopId, fingerprint: `new-${index}`, itemId: 5000 + index, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 100, quantity: 3, observedAt: 100, batchId: 'new-listings', options: [{ type: 1, value: index, param: 0 }, { type: 2, value: index + 1, param: 0 }] })));

      expect(d1.requests).toBe(1);
      expect(d1.database.prepare("SELECT COUNT(*) AS count FROM listings WHERE last_changed_snapshot_id='new-listings'").get()).toEqual({ count: 12 });
      expect(d1.database.prepare('SELECT COUNT(*) AS count FROM listing_options').get()).toEqual({ count: 24 });
    } finally { d1.database.close(); }
  });

  it('records unchanged listings against their latest observation batch', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      const shop = await repository.resolveShopObservation!(await observation('source-a', 100));
      const listing = await repository.createListing!({ sessionId: shop.internalShopId, fingerprint: 'observed-only', itemId: 4001, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 10, quantity: 1, observedAt: 100, batchId: 'changed-1' });

      await repository.markListingsObservedBulk!([{ sessionId: shop.internalShopId, fingerprint: 'observed-only' }], 'observed-2', 200);

      expect(d1.database.prepare('SELECT last_changed_at,last_changed_snapshot_id FROM listings WHERE id=?').get(listing.id)).toEqual({ last_changed_at: 200, last_changed_snapshot_id: 'observed-2' });
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

  it('records a dismissed shop that has no prior opening observation', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      const dismissedInput = await observation('source-a', 100, 'dismissed', 'account-new');
      const dismissed = await repository.resolveShopObservation!(dismissedInput);
      expect(dismissed).toMatchObject({ resolution: 'dismissed', status: 'dismissed', applied: true, session: null });
      expect(d1.database.prepare('SELECT status,closed_at,close_reason FROM shops WHERE id=?').get(dismissed.internalShopId)).toEqual({ status: 'closed', closed_at: 100, close_reason: 'explicit_dismissed' });
      expect(d1.database.prepare('SELECT COUNT(*) AS count FROM listings WHERE shop_id=?').get(dismissed.internalShopId)).toEqual({ count: 0 });
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

  it('closes shops omitted from a complete full snapshot and expires their listings', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      const firstA = await observation('source-a', 100, 'opening', 'account-a');
      const firstB = await observation('source-a', 100, 'opening', 'account-b');
      const shopA = await repository.resolveShopObservation!(firstA);
      const shopB = await repository.resolveShopObservation!(firstB);
      const otherSourceShop = await repository.resolveShopObservation!(await observation('source-b', 100, 'opening', 'account-c'));
      const equallyRecentShop = await repository.resolveShopObservation!(await observation('source-a', 200, 'opening', 'account-d'));
      const listing = await repository.createListing!({ sessionId: shopB.internalShopId, fingerprint: 'fp-omitted-shop', itemId: 4001, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 10, quantity: 1, observedAt: 100, batchId: 'full-1/0' });
      await repository.insertBatch({ sourceId: 'source-a', batchId: 'full-1/0', snapshotId: 'full-1', partIndex: 0, partCount: 1, snapshotMode: 'full', payloadHash: 'full-1', responseJson: null, receivedAt: 100 });
      await repository.recordSnapshotSessions!('source-a', 'full-1', [shopA.internalShopId, shopB.internalShopId], 100);
      await repository.finalizeSnapshot('source-a', 'full-1', 100);

      const secondA = await repository.resolveShopObservation!({ ...firstA, observedAt: 200, batchId: 'full-2/0' });
      await repository.insertBatch({ sourceId: 'source-a', batchId: 'full-2/0', snapshotId: 'full-2', partIndex: 0, partCount: 1, snapshotMode: 'full', payloadHash: 'full-2', responseJson: null, receivedAt: 200 });
      await repository.recordSnapshotSessions!('source-a', 'full-2', [secondA.internalShopId], 200);
      await repository.reconcileSnapshot!({ sourceId: 'source-a', snapshotId: 'full-2', observedAt: 200, batchIds: ['full-2/0'], sessionIds: [secondA.internalShopId] });

      expect(d1.database.prepare('SELECT status,close_reason,closed_at FROM shops WHERE id=?').get(shopB.internalShopId)).toEqual({ status: 'closed', close_reason: 'missing_full', closed_at: 200 });
      expect(d1.database.prepare('SELECT status FROM listings WHERE id=?').get(listing.id)).toEqual({ status: 'expired' });
      expect(d1.database.prepare('SELECT status FROM shops WHERE id=?').get(otherSourceShop.internalShopId)).toEqual({ status: 'active' });
      expect(d1.database.prepare('SELECT status FROM shops WHERE id=?').get(equallyRecentShop.internalShopId)).toEqual({ status: 'active' });
      expect((await repository.searchListings({ limit: 20, sort: 'price_asc' })).items).toEqual([]);
    } finally { d1.database.close(); }
  });

  it('merges shop IDs when recording multiple parts of one full snapshot', async () => {
    const d1 = createDatabase();
    try {
      const repository = createD1Repository(d1 as never);
      await repository.insertBatch({ sourceId: 'source-a', batchId: 'multi/0', snapshotId: 'multi', partIndex: 0, partCount: 2, snapshotMode: 'full', payloadHash: 'multi-0', responseJson: null, receivedAt: 100 });
      await repository.insertBatch({ sourceId: 'source-a', batchId: 'multi/1', snapshotId: 'multi', partIndex: 1, partCount: 2, snapshotMode: 'full', payloadHash: 'multi-1', responseJson: null, receivedAt: 100 });
      await repository.recordSnapshotSessions!('source-a', 'multi', [11], 100);
      await repository.recordSnapshotSessions!('source-a', 'multi', [22], 100);

      expect(await repository.getSnapshotSessionIds!('source-a', 'multi')).toEqual([11, 22]);
    } finally { d1.database.close(); }
  });
});
