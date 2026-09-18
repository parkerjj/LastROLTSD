import { describe, expect, it } from 'vitest';
import { jsonError } from '../src/middleware/errors';
import { enforceUploadLimits, LimitError } from '../src/middleware/limits';

describe('errors and limits', () => {
  it('returns a standard error without secrets', async () => {
    const response = jsonError('bad_request', 'Invalid payload', 400, 'request-1');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'bad_request', message: 'Invalid payload', request_id: 'request-1' } });
  });
  it('enforces body and part limits', () => {
    const request = new Request('https://example.test', { headers: { 'content-length': String(512 * 1024 + 1) } });
    const parsed = { part_count: 1, part_index: 0, shops: [] } as never;
    expect(() => enforceUploadLimits(request, parsed)).toThrow(LimitError);
    expect(() => enforceUploadLimits(new Request('https://example.test'), { part_count: 17, part_index: 0, shops: [] } as never)).toThrow(/parts/);
  });
});
