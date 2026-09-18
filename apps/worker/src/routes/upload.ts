import type { Hono } from 'hono';
import { parseUploadRequest, UploadValidationError } from '@lastroweb/protocol';
import { requireSource } from '../middleware/auth';
import { enforceUploadLimits } from '../middleware/limits';
import { jsonError, requestId } from '../middleware/errors';
import { ingestUpload, type ListingStateService } from '../services/ingestion';
import type { AppEnv } from '../env';
import type { MarketRepository } from '../db/repository';

export function registerUploadRoute(app: Hono<any>, env: AppEnv, repo: MarketRepository, state: ListingStateService): void {
  app.post('/api/v1/market/upload', async (c) => {
    const id = requestId(c.req.raw);
    try {
      const source = await requireSource(c.req.raw, repo);
      const raw = await c.req.raw.text();
      if (new TextEncoder().encode(raw).byteLength > env.MAX_BODY_BYTES) return jsonError('payload_too_large', 'Upload body exceeds configured limit', 413, id);
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return jsonError('bad_request', 'Malformed JSON', 400, id); }
      const request = parseUploadRequest(parsed);
      enforceUploadLimits(c.req.raw, request, new TextEncoder().encode(raw).byteLength);
      const result = await ingestUpload(source, request, repo, state);
      return c.json(result, 202, { 'cache-control': 'no-store' });
    } catch (error) {
      if (error instanceof UploadValidationError) return jsonError('bad_request', 'Invalid upload request', 400, id);
      const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 500;
      return jsonError(status === 409 ? 'conflict' : 'internal_error', error instanceof Error ? error.message : 'Unexpected error', status, id);
    }
  });
}
