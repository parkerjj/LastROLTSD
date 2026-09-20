import { describe, expect, it } from 'vitest';
import { ingestUpload } from '../src/services/ingestion';
import type { MarketRepository } from '../src/db/repository';
import type { AuthenticatedSource } from '../src/middleware/auth';

const source: AuthenticatedSource = { id: 'source-a', name: 'Synthetic source', apiKeyHash: 'hash', status: 'active', tokenHash: 'hash' };
const session = { id: 7, shopId: 11, clientRunId: 'run', startedAt: 1, lastSeenAt: 1, endedAt: null, initialSyncComplete: true, lastCompleteSnapshotId: 'baseline' };
const shop = {
  uuid: '5f2e7d65-0b98-4ff4-a6c3-3b0b92e7d2f1',
  shop_status: 'opening' as const,
  vendor_account_id: 'account-a',
  vendor_name: 'Synthetic vendor',
  title: 'Synthetic shop',
  shop_type: 'sell' as const,
  map_name: 'synthetic-map',
  x: 10,
  y: 20,
  items: [{ item_id: 1234, item_key: 'slot-0', price: 100, quantity: 2, upgrade: 0, slots: 0, cards: [], options: [] }],
};
const request = {
  protocol_version: 2 as const,
  client_run_id: 'run',
  snapshot_id: 'snapshot',
  snapshot_mode: 'full' as const,
  part_index: 0,
  part_count: 1,
  observed_at: '2026-09-19T12:00:00Z',
  shops: [shop],
};

function fakeRepo(): MarketRepository {
  let batch: any = null;
  const repository = {
    findSourceByApiKeyHash: async () => source,
    getOrCreateVendor: async (_source: string, input: any) => ({ id: 1, sourceId: source.id, ...input }),
    getOrCreateShop: async (_source: string, input: any) => ({ id: 11, sourceId: source.id, ...input, status: 'active', closedAt: null }),
    getOrCreateSession: async (input: any) => ({ ...session, shopId: input.shopId, clientRunId: input.clientRunId, startedAt: input.observedAt, lastSeenAt: input.observedAt }),
    resolveShopObservation: async () => ({ internalShopId: 11, shopId: 'shop_v1_synthetic', identityHash: 'identity-a', resolution: 'matched', status: 'opening', applied: true, session }),
    getBatch: async () => batch,
    getSnapshotParts: async () => [],
    insertBatch: async (input: any) => { batch = { id: 1, ...input, status: 'processing' }; return batch; },
    completeBatch: async (_source: string, _batchId: string, response: any) => { batch = { ...batch, status: 'accepted', responseJson: JSON.stringify(response) }; },
    loadListingsByFingerprint: async () => [],
    applyListingChanges: async () => ({ updated: 0, conflicts: 0 }),
    markListingsObservedBulk: async () => 1,
    recordSnapshotSessions: async () => {},
    finalizeSnapshot: async () => {},
    searchListings: async () => ({ items: [], nextCursor: null }),
    getListingHistory: async () => ({ items: [], nextCursor: null }),
    getOptionDefinitions: async () => ({ version: 'unpublished', items: [] }),
    getCatalogVersion: async () => 'unpublished',
    searchItems: async () => [],
  };
  return repository as MarketRepository;
}

describe('protocol 2 upload migration', () => {
  it('accepts observation-only items and returns ordered snake_case shop resolution', async () => {
    const state = { applyBatchObservations: async (_source: any, _session: any, observations: any[]) => ({ processedListings: observations.length, changedListings: observations.length, soldEvents: 0 }) };
    const result = await ingestUpload(source, request, 'snapshot/0', fakeRepo(), state);

    expect(result).toMatchObject({ accepted: true, batch_id: 'snapshot/0', processed_shops: 1, processed_listings: 1, duplicate: false });
    expect(result.shops).toEqual([{ uuid: shop.uuid, shop_id: 'shop_v1_synthetic', shop_status: 'opening', applied: true, resolution: 'matched' }]);
  });

  it('uses shop objects for heartbeat and never requires shops_seen', async () => {
    const heartbeat = { ...request, snapshot_id: 'heartbeat', snapshot_mode: 'heartbeat' as const, shops: [{ ...shop, items: [] }] };
    const result = await ingestUpload(source, heartbeat, 'heartbeat/0', fakeRepo(), { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });

    expect(result.processed_listings).toBe(0);
    expect(result.shops[0]?.uuid).toBe(shop.uuid);
  });

  it('applies dismissed without creating a sold event', async () => {
    const dismissed = { ...request, snapshot_id: 'dismissed', shops: [{ ...shop, shop_status: 'dismissed' as const, items: [] }] };
    const repository = fakeRepo() as any;
    repository.resolveShopObservation = async () => ({ internalShopId: 11, shopId: 'shop_v1_synthetic', identityHash: 'identity-a', resolution: 'dismissed', status: 'dismissed', applied: true, session: null });
    const result = await ingestUpload(source, dismissed, 'dismissed/0', repository, { applyBatchObservations: async () => ({ processedListings: 99, changedListings: 99, soldEvents: 99 }) });

    expect(result).toMatchObject({ processed_listings: 0, sold_events: 0 });
    expect(result.shops[0]).toMatchObject({ uuid: shop.uuid, shop_status: 'dismissed', resolution: 'dismissed', applied: true });
  });

  it('returns the stored response for an identical replay', async () => {
    const repository = fakeRepo();
    const state = { applyBatchObservations: async (_source: any, _session: any, observations: any[]) => ({ processedListings: observations.length, changedListings: 0, soldEvents: 0 }) };
    const first = await ingestUpload(source, request, 'snapshot/0', repository, state);
    const duplicate = await ingestUpload(source, request, 'snapshot/0', repository, state);

    expect(duplicate).toEqual({ ...first, duplicate: true });
  });
});
