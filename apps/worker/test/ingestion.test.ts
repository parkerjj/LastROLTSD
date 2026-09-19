import { describe, expect, it } from 'vitest';
import { ingestUpload } from '../src/services/ingestion';
import type { MarketRepository } from '../src/db/repository';
import type { AuthenticatedSource } from '../src/middleware/auth';

const source: AuthenticatedSource = { id: 's1', name: 'Synthetic source', apiKeyHash: 'hash', status: 'active', tokenHash: 'hash' };
const baseSession = { id: 1, shopId: 1, clientRunId: 'run', startedAt: 1, lastSeenAt: 1, endedAt: null, initialSyncComplete: true, lastCompleteSnapshotId: 'baseline' };
const shop = {
  uuid: '5f2e7d65-0b98-4ff4-a6c3-3b0b92e7d2f1',
  shop_status: 'opening' as const,
  vendor_account_id: 'vendor-account',
  vendor_name: 'Vendor',
  title: 'Shop',
  shop_type: 'sell' as const,
  map_name: 'map',
  x: 1,
  y: 2,
  items: [{ item_key: 'item-v1:slot-0', item_id: 1, upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] }],
};
const request = {
  protocol_version: 2 as const,
  client_run_id: 'run',
  snapshot_id: 'snap',
  snapshot_mode: 'full' as const,
  part_index: 0,
  part_count: 1,
  observed_at: '2026-09-19T12:00:00Z',
  shops: [shop],
};

function fakeRepo(session = baseSession): MarketRepository {
  let batch: any = null;
  const repository: Partial<MarketRepository> = {
    findSourceByApiKeyHash: async () => source,
    getOrCreateVendor: async (_source, input) => ({ id: 1, sourceId: 's1', ...input }),
    getOrCreateShop: async (_source, input) => ({ id: 1, sourceId: 's1', ...input, status: 'active', closedAt: null }),
    getOrCreateSession: async (input) => ({ ...session, shopId: input.shopId, clientRunId: input.clientRunId, startedAt: input.observedAt, lastSeenAt: input.observedAt }),
    resolveShopObservation: async (input) => ({ internalShopId: session.shopId, shopId: 'shop_v1_synthetic', identityHash: 'identity-a', resolution: 'matched', status: input.shopStatus, applied: true, session: input.shopStatus === 'dismissed' ? null : session }),
    getBatch: async () => batch,
    getSnapshotParts: async () => [],
    insertBatch: async (input) => { batch = { id: 1, ...input, status: 'processing' }; return batch; },
    completeBatch: async (_source, _id, response) => { batch = { ...batch, status: 'accepted', responseJson: JSON.stringify(response) }; },
    loadListingsByFingerprint: async () => [],
    applyListingChanges: async () => ({ updated: 0, conflicts: 0 }),
    markListingsObservedBulk: async () => 1,
    recordSnapshotSessions: async () => {},
    finalizeSnapshot: async () => {},
    searchListings: async () => ({ items: [], nextCursor: null }),
    getListingHistory: async () => ({ items: [], nextCursor: null }),
    getOptionDictionary: async () => [],
    getCatalogVersion: async () => 'test',
    searchItems: async () => [],
  };
  return repository as MarketRepository;
}

describe('upload ingestion', () => {
  it('accepts a protocol 2 baseline without item names and replays it idempotently', async () => {
    const repo = fakeRepo();
    const state = { applyBatchObservations: async (_s: any, _session: any, observations: any[]) => ({ processedListings: observations.length, changedListings: observations.length, soldEvents: 0 }) };
    const first = await ingestUpload(source, request, 'snap/0', repo, state);
    const second = await ingestUpload(source, request, 'snap/0', repo, state);
    expect(first).toMatchObject({ accepted: true, batch_id: 'snap/0', processed_listings: 1, duplicate: false });
    expect(second).toEqual({ ...first, duplicate: true });
  });

  it('rejects a duplicate batch with a changed structured payload', async () => {
    const repo = fakeRepo();
    const state = { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) };
    await ingestUpload(source, request, 'snap/0', repo, state);
    await expect(ingestUpload(source, { ...request, shops: [{ ...shop, title: 'Changed shop' }] }, 'snap/0', repo, state)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects an idempotency key that does not match the canonical snapshot part', async () => {
    await expect(ingestUpload(source, request, 'other/0', fakeRepo(), { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) })).rejects.toMatchObject({ status: 400 });
  });

  it('treats equivalent raw option ordering as the same normalized payload', async () => {
    const repo = fakeRepo();
    const state = { applyBatchObservations: async (_s: any, _session: any, observations: any[]) => ({ processedListings: observations.length, changedListings: 0, soldEvents: 0 }) };
    const firstRequest = { ...request, shops: [{ ...shop, items: [{ ...shop.items[0], options: [{ type: 2, value: 4, param: 1 }, { type: 1, value: 8, param: 0 }] }] }] };
    const reorderedRequest = { ...firstRequest, shops: [{ ...shop, items: [{ ...shop.items[0], options: [{ type: 1, value: 8, param: 0 }, { type: 2, value: 4, param: 1 }] }] }] };
    await ingestUpload(source, firstRequest, 'snap/0', repo, state);
    const duplicate = await ingestUpload(source, reorderedRequest, 'snap/0', repo, state);
    expect(duplicate.duplicate).toBe(true);
  });

  it('returns the stored response from a concurrent insert race without processing the payload', async () => {
    const repo = fakeRepo();
    const state = { applyBatchObservations: async () => ({ processedListings: 99, changedListings: 99, soldEvents: 99 }) };
    repo.getBatch = async () => null;
    repo.insertBatch = async (input: any) => ({ id: 1, ...input, status: 'accepted', responseJson: JSON.stringify({ accepted: true, batch_id: 'snap/0', duplicate: false, processed_shops: 1, processed_listings: 1, changed_listings: 0, sold_events: 0, shops: [], next: null }), inserted: false }) as any;
    const duplicate = await ingestUpload(source, request, 'snap/0', repo, state);
    expect(duplicate).toEqual({ accepted: true, batch_id: 'snap/0', duplicate: true, processed_shops: 1, processed_listings: 1, changed_listings: 0, sold_events: 0, shops: [], next: null });
  });

  it('uses shop objects for heartbeat and does not process listings', async () => {
    const repo = fakeRepo();
    const heartbeat = { ...request, snapshot_id: 'heartbeat', snapshot_mode: 'heartbeat' as const, shops: [{ ...shop, items: [] }] };
    const state = { applyBatchObservations: async () => ({ processedListings: 99, changedListings: 99, soldEvents: 99 }) };
    const result = await ingestUpload(source, heartbeat, 'heartbeat/0', repo, state);
    expect(result).toMatchObject({ processed_shops: 1, processed_listings: 0, changed_listings: 0, sold_events: 0 });
  });

  it('marks a failed batch rejected so retries do not remain stuck processing', async () => {
    const repo = fakeRepo();
    let failed = false;
    repo.failBatch = async () => { failed = true; };
    const state = { applyBatchObservations: async () => { throw new Error('temporary write failure'); } };
    await expect(ingestUpload(source, request, 'snap/0', repo, state)).rejects.toThrow('temporary write failure');
    expect(failed).toBe(true);
  });

  it('does not process a rejected batch when another retry wins the atomic claim', async () => {
    const repo = fakeRepo();
    repo.getBatch = async () => ({ id: 1, sourceId: 's1', batchId: 'snap/0', snapshotId: 'snap', partIndex: 0, partCount: 1, snapshotMode: 'full', payloadHash: 'unused', status: 'rejected', responseJson: null } as any);
    repo.retryBatch = async () => false;
    await expect(ingestUpload(source, request, 'snap/0', repo, { applyBatchObservations: async () => ({ processedListings: 1, changedListings: 1, soldEvents: 0 }) })).rejects.toMatchObject({ status: 409 });
  });

  it('requires a full snapshot before accepting a delta for a new session', async () => {
    const repo = fakeRepo({ ...baseSession, initialSyncComplete: false, lastCompleteSnapshotId: null });
    const delta = { ...request, snapshot_mode: 'delta' as const };
    await expect(ingestUpload(source, delta, 'snap/0', repo, { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) })).rejects.toMatchObject({ status: 409 });
  });

  it('returns dismissed shops without processing or creating sold events', async () => {
    const repo = fakeRepo();
    const dismissed = { ...request, snapshot_id: 'dismissed', shops: [{ ...shop, shop_status: 'dismissed' as const, items: [] }] };
    const result = await ingestUpload(source, dismissed, 'dismissed/0', repo, { applyBatchObservations: async () => ({ processedListings: 99, changedListings: 99, soldEvents: 99 }) });
    expect(result).toMatchObject({ processed_listings: 0, sold_events: 0 });
    expect(result.shops[0]).toMatchObject({ uuid: shop.uuid, shop_status: 'dismissed', resolution: 'matched' });
  });
});
