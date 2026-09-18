import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerUploadRoute } from '../src/routes/upload';
import { hashApiKey } from '../src/middleware/auth';
import type { MarketRepository } from '../src/db/repository';

function repo(hash: string): MarketRepository {
  let batch: any = null;
  return {
    findSourceByApiKeyHash: async (value) => value === hash ? { id: 's1', name: 'S', apiKeyHash: hash, status: 'active' } : null,
    getOrCreateVendor: async (_s, input) => ({ id: 1, sourceId: 's1', ...input }), getOrCreateShop: async (_s, input) => ({ id: 1, sourceId: 's1', ...input, status: 'active', closedAt: null }), getOrCreateSession: async (input) => ({ id: 1, shopId: input.shopId, clientRunId: 'run', startedAt: input.observedAt, lastSeenAt: input.observedAt, endedAt: null, initialSyncComplete: false, lastCompleteSnapshotId: null }), getBatch: async () => batch, getSnapshotParts: async () => [], insertBatch: async (input) => { batch = { id: 1, ...input, status: 'processing' }; return batch; }, completeBatch: async (_s, _b, result) => { batch.responseJson = JSON.stringify(result); }, loadListingsByFingerprint: async () => [], applyListingChanges: async () => ({ updated: 0, conflicts: 0 }), markShopHeartbeats: async () => 1, finalizeSnapshot: async () => {}, searchListings: async () => ({ items: [], nextCursor: null }), getListingHistory: async () => ({ items: [], nextCursor: null }), getOptionDictionary: async () => [],
  };
}

describe('upload route', () => {
  it('authenticates before accepting a valid upload', async () => {
    const key = 'route-secret'; const app = new Hono(); const repository = repo(await hashApiKey(key));
    registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repository, { applyBatchObservations: async (_source, _session, observations) => ({ processedListings: observations.length, changedListings: observations.length, soldEvents: 0 }) });
    const response = await app.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocol_version: 1, client_run_id: 'run', snapshot_id: 'snap', snapshot_mode: 'heartbeat', part_index: 0, part_count: 1, observed_at: '2026-09-18T12:00:00Z', shops_seen: ['shop'], shops: [] }) });
    expect(response.status).toBe(202); expect((await response.json() as { accepted: boolean }).accepted).toBe(true);
  });
  it('returns a request id for malformed JSON', async () => {
    const key = 'route-secret'; const app = new Hono(); const repository = repo(await hashApiKey(key));
    registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repository, { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
    const response = await app.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{' });
    expect(response.status).toBe(400); expect((await response.json() as { error: { request_id: string } }).error.request_id).toBeTruthy();
  });
});
