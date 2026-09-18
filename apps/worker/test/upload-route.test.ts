import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerUploadRoute } from '../src/routes/upload';
import { hashApiKey } from '../src/middleware/auth';
import type { MarketRepository } from '../src/db/repository';

function repo(hash: string, status: 'active' | 'disabled' = 'active'): MarketRepository {
  let batch: any = null;
  return {
    findSourceByApiKeyHash: async (value) => value === hash ? { id: 's1', name: 'S', apiKeyHash: hash, status } : null,
    getOrCreateVendor: async (_s, input) => ({ id: 1, sourceId: 's1', ...input }), getOrCreateShop: async (_s, input) => ({ id: 1, sourceId: 's1', ...input, status: 'active', closedAt: null }), getOrCreateSession: async (input) => ({ id: 1, shopId: input.shopId, clientRunId: 'run', startedAt: input.observedAt, lastSeenAt: input.observedAt, endedAt: null, initialSyncComplete: false, lastCompleteSnapshotId: null }), getBatch: async () => batch, getSnapshotParts: async () => [], insertBatch: async (input) => { batch = { id: 1, ...input, status: 'processing' }; return batch; }, completeBatch: async (_s, _b, result) => { batch.responseJson = JSON.stringify(result); }, loadListingsByFingerprint: async () => [], applyListingChanges: async () => ({ updated: 0, conflicts: 0 }), markShopHeartbeats: async () => 1, finalizeSnapshot: async () => {}, searchListings: async () => ({ items: [], nextCursor: null }), getListingHistory: async () => ({ items: [], nextCursor: null }), getOptionDictionary: async () => [],
  };
}

describe('upload route', () => {
  it('authenticates before accepting a valid upload', async () => {
    const key = 'route-secret'; const app = new Hono(); const repository = repo(await hashApiKey(key));
    registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repository, { applyBatchObservations: async (_source, _session, observations) => ({ processedListings: observations.length, changedListings: observations.length, soldEvents: 0 }) });
    const response = await app.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': 'snap/0' }, body: JSON.stringify({ protocol_version: 1, client_run_id: 'run', snapshot_id: 'snap', snapshot_mode: 'heartbeat', part_index: 0, part_count: 1, observed_at: '2026-09-18T12:00:00Z', shops_seen: ['shop'], shops: [] }) });
    expect(response.status).toBe(202); expect((await response.json() as { accepted: boolean }).accepted).toBe(true);
  });
  it('returns a request id for malformed JSON', async () => {
    const key = 'route-secret'; const app = new Hono(); const repository = repo(await hashApiKey(key));
    registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repository, { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
    const response = await app.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'snap/0' }, body: '{' });
    expect(response.status).toBe(400); expect((await response.json() as { error: { request_id: string } }).error.request_id).toBeTruthy();
  });
  it('requires an idempotency key and rejects a non-canonical key', async () => {
    const key = 'route-secret'; const repository = repo(await hashApiKey(key));
    for (const idempotencyKey of [undefined, 'other/0', 'x'.repeat(257)]) {
      const app = new Hono();
      registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repository, { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
      const headers = new Headers({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
      if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
      const response = await app.request('/api/v1/market/upload', { method: 'POST', headers, body: JSON.stringify({ protocol_version: 1, client_run_id: 'run', snapshot_id: 'snap', snapshot_mode: 'heartbeat', part_index: 0, part_count: 1, observed_at: '2026-09-18T12:00:00Z', shops_seen: ['shop'], shops: [] }) });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code).toBe('bad_request');
    }
  });
  it('maps authentication and upload-limit failures to standard error codes', async () => {
    const key = 'route-secret'; const hash = await hashApiKey(key);
    const unauthorizedApp = new Hono();
    registerUploadRoute(unauthorizedApp, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repo(hash), { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
    const unauthorized = await unauthorizedApp.request('/api/v1/market/upload', { method: 'POST', headers: { 'idempotency-key': 'snap/0' }, body: '{}' });
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json() as { error: { code: string } }).error.code).toBe('unauthorized');

    const forbiddenApp = new Hono();
    registerUploadRoute(forbiddenApp, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repo(hash, 'disabled'), { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
    const forbidden = await forbiddenApp.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'snap/0' }, body: '{}' });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json() as { error: { code: string } }).error.code).toBe('forbidden');

    const limitedApp = new Hono();
    registerUploadRoute(limitedApp, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 16 }, repo(hash), { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
    const limited = await limitedApp.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': 'snap/0' }, body: JSON.stringify({ protocol_version: 1, client_run_id: 'run', snapshot_id: 'snap', snapshot_mode: 'heartbeat', part_index: 0, part_count: 1, observed_at: '2026-09-18T12:00:00Z', shops_seen: [], shops: [] }) });
    expect(limited.status).toBe(413);
    expect((await limited.json() as { error: { code: string } }).error.code).toBe('payload_too_large');
  });
});
