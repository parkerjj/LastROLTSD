import { describe, expect, it } from 'vitest';
import { ingestUpload } from '../src/services/ingestion';
import type { MarketRepository } from '../src/db/repository';
import type { AuthenticatedSource } from '../src/middleware/auth';

const source: AuthenticatedSource = { id: 's1', name: 'Source', apiKeyHash: 'hash', status: 'active', tokenHash: 'hash' };
const request = { protocol_version: 1, client_run_id: 'run', snapshot_id: 'snap', snapshot_mode: 'full' as const, part_index: 0, part_count: 1, observed_at: '2026-09-18T12:00:00Z', shops_seen: ['shop'], shops: [{ shop_key: 'shop', vendor_key: 'vendor', vendor_name: 'Vendor', title: 'Shop', shop_type: 'sell' as const, map_name: 'map', x: 1, y: 2, items: [{ item_id: 1, name: 'Item', upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] }] }] } as any;

function fakeRepo(): MarketRepository {
  let batch: any = null;
  return {
    findSourceByApiKeyHash: async () => source,
    getOrCreateVendor: async (_source, input) => ({ id: 1, sourceId: 's1', ...input }),
    getOrCreateShop: async (_source, input) => ({ id: 1, sourceId: 's1', ...input, status: 'active', closedAt: null }),
    getOrCreateSession: async (input) => ({ id: 1, shopId: input.shopId, clientRunId: 'run', startedAt: input.observedAt, lastSeenAt: input.observedAt, endedAt: null, initialSyncComplete: false, lastCompleteSnapshotId: null }),
    getBatch: async () => batch,
    getSnapshotParts: async () => [],
    insertBatch: async (input) => { batch = { id: 1, ...input, status: 'processing' }; return batch; },
    completeBatch: async (_source, _id, response) => { batch = { ...batch, status: 'accepted', responseJson: JSON.stringify(response) }; },
    loadListingsByFingerprint: async () => [], applyListingChanges: async () => ({ updated: 0, conflicts: 0 }), markShopHeartbeats: async () => 1, finalizeSnapshot: async () => {}, searchListings: async () => ({ items: [], nextCursor: null }), getListingHistory: async () => ({ items: [], nextCursor: null }), getOptionDictionary: async () => [],
  };
}

describe('upload ingestion', () => {
  it('accepts a baseline and returns the same result for a duplicate batch', async () => {
    const repo = fakeRepo(); const state = { applyBatchObservations: async (_s: any, _session: any, observations: any[]) => ({ processedListings: observations.length, changedListings: observations.length, soldEvents: 0 }) };
    const first = await ingestUpload(source, request, repo, state);
    const second = await ingestUpload(source, request, repo, state);
    expect(first.duplicate).toBe(false); expect(second.duplicate).toBe(true); expect(second.batchId).toBe(first.batchId); expect(second.processedListings).toBe(1);
  });
  it('rejects a duplicate batch with a changed payload', async () => {
    const repo = fakeRepo(); const state = { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) };
    await ingestUpload(source, request, repo, state);
    await expect(ingestUpload(source, { ...request, shops_seen: ['other'] }, repo, state)).rejects.toMatchObject({ status: 409 });
  });
});
