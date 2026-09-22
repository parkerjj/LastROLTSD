import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerUploadRoute } from '../src/routes/upload';
import { hashApiKey } from '../src/middleware/auth';
import type { MarketRepository } from '../src/db/repository';
import { MysqlDatabaseError } from '../src/db/mysql-client';

const heartbeatPayload = {
  protocol_version: 2,
  client_run_id: 'run',
  snapshot_id: 'snap',
  snapshot_mode: 'heartbeat',
  part_index: 0,
  part_count: 1,
  observed_at: '2026-09-18T12:00:00Z',
  shops: [{
    uuid: '5f2e7d65-0b98-4ff4-a6c3-3b0b92e7d2f1',
    shop_status: 'opening',
    vendor_account_id: 'vendor-account',
    vendor_name: 'Vendor',
    title: 'Shop',
    shop_type: 'sell',
    map_name: 'map',
    x: 1,
    y: 2,
    items: [],
  }],
};

function repo(hash: string, status: 'active' | 'disabled' = 'active'): MarketRepository {
  let batch: any = null;
  return {
    findSourceByApiKeyHash: async (value) => value === hash ? { id: 's1', name: 'S', apiKeyHash: hash, status } : null,
    getOrCreateVendor: async (_s, input) => ({ id: 1, sourceId: 's1', ...input }), getOrCreateShop: async (_s, input) => ({ id: 1, sourceId: 's1', ...input, status: 'active', closedAt: null }), getOrCreateSession: async (input) => ({ id: 1, shopId: input.shopId, clientRunId: 'run', startedAt: input.observedAt, lastSeenAt: input.observedAt, endedAt: null, initialSyncComplete: false, lastCompleteSnapshotId: null }), getBatch: async () => batch, getSnapshotParts: async () => [], insertBatch: async (input) => { batch = { id: 1, ...input, status: 'processing' }; return batch; }, completeBatch: async (_s, _b, result) => { batch.responseJson = JSON.stringify(result); }, loadListingsByFingerprint: async () => [], applyListingChanges: async () => ({ updated: 0, conflicts: 0 }), markShopHeartbeats: async () => 1, finalizeSnapshot: async () => {}, searchListings: async () => ({ items: [], nextCursor: null }), getListingHistory: async () => ({ items: [], nextCursor: null }), getOptionDefinitions: async () => ({ version: 'unpublished', items: [] }), getCatalogVersion: async () => 'unpublished',
    resolveShopObservation: async (input) => ({ internalShopId: 1, shopId: 'shop_v1_synthetic', identityHash: 'identity-a', resolution: 'matched', status: input.shopStatus, applied: true, session: input.shopStatus === 'dismissed' ? null : { id: 1, shopId: 1, clientRunId: input.clientRunId, startedAt: input.observedAt, lastSeenAt: input.observedAt, endedAt: null, initialSyncComplete: true, lastCompleteSnapshotId: 'baseline' } }),
    searchItems: async () => [],
  };
}

describe('upload route', () => {
  it('authenticates before accepting a valid upload', async () => {
    const key = 'route-secret'; const app = new Hono(); const repository = repo(await hashApiKey(key));
    registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repository, { applyBatchObservations: async (_source, _session, observations) => ({ processedListings: observations.length, changedListings: observations.length, soldEvents: 0 }) });
    const response = await app.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': 'snap/0' }, body: JSON.stringify(heartbeatPayload) });
    expect(response.status).toBe(202); expect((await response.json() as { accepted: boolean }).accepted).toBe(true);
  });
  it('returns a request id for malformed JSON', async () => {
    const key = 'route-secret'; const app = new Hono(); const repository = repo(await hashApiKey(key));
    registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repository, { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
    const response = await app.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'snap/0' }, body: '{' });
    expect(response.status).toBe(400); expect((await response.json() as { error: { code: string; request_id: string; retryable: boolean } }).error).toMatchObject({ code: 'malformed_json', retryable: false });
  });
  it('requires an idempotency key and rejects a non-canonical key', async () => {
    const key = 'route-secret'; const repository = repo(await hashApiKey(key));
    for (const [idempotencyKey, code] of [[undefined, 'invalid_idempotency_key'], ['other/0', 'idempotency_key_mismatch'], ['x'.repeat(257), 'invalid_idempotency_key']] as const) {
      const app = new Hono();
      registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repository, { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
      const headers = new Headers({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
      if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
      const response = await app.request('/api/v1/market/upload', { method: 'POST', headers, body: JSON.stringify(heartbeatPayload) });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code).toBe(code);
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
    expect((await forbidden.json() as { error: { code: string } }).error.code).toBe('source_disabled');

    const limitedApp = new Hono();
    registerUploadRoute(limitedApp, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 16 }, repo(hash), { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
    const limited = await limitedApp.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': 'snap/0' }, body: JSON.stringify(heartbeatPayload) });
    expect(limited.status).toBe(413);
    expect((await limited.json() as { error: { code: string } }).error.code).toBe('payload_too_large');
  });

  it('logs the received payload and the expected source state for a 403', async () => {
    const key = 'route-secret';
    const app = new Hono();
    const repository = repo(await hashApiKey(key), 'disabled');
    registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repository, { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await app.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': 'snap/0' }, body: JSON.stringify(heartbeatPayload) });
      expect(response.status).toBe(403);
      const received = JSON.parse(String(output.mock.calls[0]?.[0])) as { metric: string; payload: typeof heartbeatPayload };
      const failure = JSON.parse(String(errors.mock.calls[0]?.[0])) as { metric: string; status: number; details: { expected: string; actual: string; tokenHashPrefix: string; storedHashPrefix: string } };
      expect(received.metric).toBe('lastroweb.upload_received');
      expect(received.payload.snapshot_id).toBe('snap');
      expect(failure).toMatchObject({ metric: 'lastroweb.upload_error', status: 403, details: { expected: 'active', actual: 'disabled' } });
      expect(failure.details.tokenHashPrefix).toBe(failure.details.storedHashPrefix);
    } finally {
      output.mockRestore();
      errors.mockRestore();
    }
  });

  it('does not expose unexpected internal error messages', async () => {
    const key = 'route-secret';
    const app = new Hono();
    const repository = repo(await hashApiKey(key));
    repository.getBatch = async () => { throw new Error('SQLITE_CONSTRAINT_PRIVATE_DETAIL'); };
    registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repository, { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
    const response = await app.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': 'snap/0' }, body: JSON.stringify(heartbeatPayload) });
    expect(response.status).toBe(500);
    const body = await response.json() as { error: { message: string; retryable: boolean } };
    expect(body.error.message).toBe('Unexpected internal error');
    expect(body.error.message).not.toContain('SQLITE');
    expect(body.error.retryable).toBe(true);
  });

  it('logs MySQL error codes without exposing database diagnostics to the client', async () => {
    const key = 'route-secret';
    const app = new Hono();
    const repository = repo(await hashApiKey(key));
    repository.getBatch = async () => {
      throw new MysqlDatabaseError(Object.assign(new Error('private SQL and credentials'), {
        code: 'ER_CANT_AGGREGATE_2COLLATIONS', errno: 1267, sqlState: 'HY000',
      }));
    };
    registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repository, { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await app.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': 'snap/0' }, body: JSON.stringify(heartbeatPayload) });
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).not.toContain('ER_CANT_AGGREGATE');
      expect(body).not.toContain('private SQL');
      expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toMatchObject({
        metric: 'lastroweb.upload_error', source_id: 's1',
        details: { mysql_code: 'ER_CANT_AGGREGATE_2COLLATIONS', mysql_errno: 1267, mysql_sql_state: 'HY000' },
      });
      expect(JSON.stringify(errors.mock.calls)).not.toContain('private SQL');
    } finally {
      errors.mockRestore();
    }
  });

  it('maps an optional source limiter rejection to 429', async () => {
    const key = 'route-secret';
    const app = new Hono();
    const repository = repo(await hashApiKey(key));
    const limiter = { fetch: async () => new Response(null, { status: 429, headers: { 'retry-after': '17' } }) };
    registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024, UPLOAD_LIMITER: limiter as never }, repository, { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
    const response = await app.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': 'snap/0' }, body: '{}' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
    expect((await response.json() as { error: { code: string; retryable: boolean } }).error).toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('distinguishes schema, upload-limit, and batch-state failures without requiring a baseline', async () => {
    const key = 'route-secret'; const hash = await hashApiKey(key);
    const request = async (repository: MarketRepository, payload: unknown, idempotencyKey = 'snap/0') => {
      const app = new Hono();
      registerUploadRoute(app, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, repository, { applyBatchObservations: async () => ({ processedListings: 0, changedListings: 0, soldEvents: 0 }) });
      return app.request('/api/v1/market/upload', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify(payload) });
    };

    const invalid = await request(repo(hash), { ...heartbeatPayload, protocol_version: 1 });
    expect(invalid.status).toBe(422);
    expect((await invalid.json() as { error: { code: string } }).error.code).toBe('invalid_upload');

    const tooManyParts = await request(repo(hash), { ...heartbeatPayload, part_count: 17 });
    expect(tooManyParts.status).toBe(413);
    expect((await tooManyParts.json() as { error: { code: string; action: string } }).error).toMatchObject({ code: 'upload_limit_exceeded', action: 'reshard_upload' });

    const heartbeat = await request(repo(hash), heartbeatPayload);
    expect(heartbeat.status).toBe(202);
    expect((await heartbeat.json() as { accepted: boolean }).accepted).toBe(true);

    const processingRepo = repo(hash);
    processingRepo.completeBatch = async () => { throw new Error('synthetic interruption'); };
    expect((await request(processingRepo, heartbeatPayload)).status).toBe(500);
    processingRepo.completeBatch = async () => {};
    const processing = await request(processingRepo, heartbeatPayload);
    expect(processing.status).toBe(423);
    expect(processing.headers.get('retry-after')).toBe('5');
    expect((await processing.json() as { error: { code: string; retryable: boolean } }).error).toMatchObject({ code: 'batch_in_progress', retryable: true });
  });
});
