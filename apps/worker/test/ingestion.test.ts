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
    const first = await ingestUpload(source, request, 'snap/0', repo, state);
    const second = await ingestUpload(source, request, 'snap/0', repo, state);
    expect(first.duplicate).toBe(false); expect(second.duplicate).toBe(true); expect(second.batchId).toBe(first.batchId); expect(second.processedListings).toBe(1);
  });
  it('rejects a duplicate batch with a changed payload', async () => {
    const repo = fakeRepo(); const state = { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) };
    await ingestUpload(source, request, 'snap/0', repo, state);
    await expect(ingestUpload(source, { ...request, shops_seen: ['other'] }, 'snap/0', repo, state)).rejects.toMatchObject({ status: 409 });
  });
  it('rejects an idempotency key that does not match the canonical snapshot part', async () => {
    await expect(ingestUpload(source, request, 'other/0', fakeRepo(), { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) })).rejects.toMatchObject({ status: 400 });
  });

  it('treats equivalent option ordering as the same normalized payload', async () => {
    const repo = fakeRepo();
    const state = { applyBatchObservations: async (_s: any, _session: any, observations: any[]) => ({ processedListings: observations.length, changedListings: 0, soldEvents: 0 }) };
    const firstRequest = {
      ...request,
      shops: [{ ...request.shops[0], items: [{ ...request.shops[0].items[0], options: [{ type: 2, value: 4, param: 1 }, { type: 1, value: 8, param: 0 }] }] }],
    } as any;
    const reorderedRequest = {
      ...firstRequest,
      shops: [{ ...firstRequest.shops[0], items: [{ ...firstRequest.shops[0].items[0], options: [{ type: 1, value: 8, param: 0 }, { type: 2, value: 4, param: 1 }] }] }],
    } as any;
    await ingestUpload(source, firstRequest, 'snap/0', repo, state);
    const duplicate = await ingestUpload(source, reorderedRequest, 'snap/0', repo, state);
    expect(duplicate.duplicate).toBe(true);
  });

  it('does not process a batch returned from a concurrent insert race', async () => {
    const repo = fakeRepo();
    let inserts = 0;
    repo.getBatch = async () => null;
    const originalInsert = repo.insertBatch;
    repo.insertBatch = async (input: any) => {
      inserts += 1;
      if (inserts === 1) return originalInsert(input);
      return { id: 1, ...input, status: 'accepted', responseJson: JSON.stringify({ accepted: true, batchId: 'snap/0', duplicate: false, processedShops: 1, processedListings: 1, changedListings: 0, soldEvents: 0, next: null }), inserted: false } as any;
    };
    const state = { applyBatchObservations: async () => ({ processedListings: 99, changedListings: 99, soldEvents: 99 }) };
    await ingestUpload(source, request, 'snap/0', repo, state);
    const duplicate = await ingestUpload(source, request, 'snap/0', repo, state);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.processedListings).toBe(1);
  });

  it('chunks heartbeat shop updates into bounded calls', async () => {
    const repo = fakeRepo();
    const heartbeatCalls: number[] = [];
    repo.markShopHeartbeats = async (_source, shops) => { heartbeatCalls.push(shops.length); return shops.length; };
    const heartbeatRequest = { ...request, snapshot_mode: 'heartbeat', shops_seen: Array.from({ length: 81 }, (_, index) => `shop-${index}`), shops: [] } as any;
    await ingestUpload(source, heartbeatRequest, 'snap/0', repo, { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
    expect(heartbeatCalls).toEqual([40, 40, 1]);
  });

  it('marks a failed batch rejected so retries do not remain stuck processing', async () => {
    const repo = fakeRepo();
    let failed = false;
    repo.failBatch = async () => { failed = true; };
    const state = { applyBatchObservations: async () => { throw new Error('temporary write failure'); } };
    await expect(ingestUpload(source, request, 'snap/0', repo, state)).rejects.toThrow('temporary write failure');
    expect(failed).toBe(true);
    const failedBatch = await repo.getBatch('s1', 'snap/0');
    repo.getBatch = async () => failedBatch ? { ...failedBatch, status: 'rejected' } : null;
    await expect(ingestUpload(source, request, 'snap/0', repo, state)).rejects.toMatchObject({ status: 503 });
  });
});
