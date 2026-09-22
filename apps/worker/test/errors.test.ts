import { describe, expect, it } from 'vitest';
import { jsonError } from '../src/middleware/errors';
import { enforceUploadLimits } from '../src/middleware/limits';

describe('errors and limits', () => {
  it('returns a standard error without secrets', async () => {
    const response = jsonError('idempotency_key_reused', 'A new snapshot is required', 422, 'request-1', { retryable: false, action: 'new_snapshot' });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: 'idempotency_key_reused', message: 'A new snapshot is required', request_id: 'request-1', retryable: false, action: 'new_snapshot' } });
  });
  it('enforces body and part limits', () => {
    const request = new Request('https://example.test', { headers: { 'content-length': String(512 * 1024 + 1) } });
    const parsed = { part_count: 1, part_index: 0, shops: [] } as never;
    try { enforceUploadLimits(request, parsed); } catch (error) { expect(error).toMatchObject({ status: 413, code: 'payload_too_large' }); }
    try { enforceUploadLimits(new Request('https://example.test'), { part_count: 17, part_index: 0, shops: [] } as never); } catch (error) { expect(error).toMatchObject({ status: 413, code: 'upload_limit_exceeded' }); }
  });
});
