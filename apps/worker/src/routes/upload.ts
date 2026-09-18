import type { Hono } from 'hono';
import { parseUploadRequest, UploadValidationError } from '@lastroweb/protocol';
import { AuthError, requireSource } from '../middleware/auth';
import { enforceUploadLimits, LimitError } from '../middleware/limits';
import { jsonError, requestId } from '../middleware/errors';
import { canonicalBatchId, ingestUpload, IngestionError, isValidIdempotencyKey, type ListingStateService } from '../services/ingestion';
import type { AppEnv } from '../env';
import type { MarketRepository } from '../db/repository';

export function registerUploadRoute(app: Hono<any>, env: AppEnv, repo: MarketRepository, state: ListingStateService): void {
  app.post('/api/v1/market/upload', async (c) => {
    const id = requestId(c.req.raw);
    try {
      const source = await requireSource(c.req.raw, repo);
      if (env.UPLOAD_LIMITER) {
        const limiterResponse = await env.UPLOAD_LIMITER.fetch('https://lastroweb.invalid/upload-limit', { method: 'POST', headers: { 'x-source-id': source.id } });
        if (limiterResponse.status === 429) return jsonError('rate_limited', 'Upload rate limit exceeded', 429, id);
        if (!limiterResponse.ok) return jsonError('service_unavailable', 'Upload limiter unavailable', 503, id);
      }
      const idempotencyKey = c.req.header('idempotency-key');
      if (!isValidIdempotencyKey(idempotencyKey)) return jsonError('bad_request', 'Idempotency-Key header is required', 400, id);
      const raw = await c.req.raw.text();
      if (new TextEncoder().encode(raw).byteLength > env.MAX_BODY_BYTES) return jsonError('payload_too_large', 'Upload body exceeds configured limit', 413, id);
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return jsonError('bad_request', 'Malformed JSON', 400, id); }
      const request = parseUploadRequest(parsed);
      if (idempotencyKey !== canonicalBatchId(request)) return jsonError('bad_request', 'Idempotency-Key must match the canonical snapshot part', 400, id);
      enforceUploadLimits(c.req.raw, request, new TextEncoder().encode(raw).byteLength);
      const result = await ingestUpload(source, request, idempotencyKey, repo, state);
      return c.json(result, 202, { 'cache-control': 'no-store' });
    } catch (error) {
      if (error instanceof UploadValidationError) return jsonError('bad_request', 'Invalid upload request', 400, id);
      if (error instanceof AuthError) return jsonError(error.status === 401 ? 'unauthorized' : 'forbidden', error.message, error.status, id);
      if (error instanceof LimitError) return jsonError(error.status === 413 ? 'payload_too_large' : 'rate_limited', error.message, error.status, id);
      if (error instanceof IngestionError) return jsonError(error.status === 400 ? 'bad_request' : error.status === 409 ? 'conflict' : 'service_unavailable', error.message, error.status, id);
      const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 500;
      const code = status === 409 ? 'conflict' : status === 413 ? 'payload_too_large' : status === 429 ? 'rate_limited' : status === 503 ? 'service_unavailable' : 'internal_error';
      console.error(JSON.stringify({ metric: 'lastroweb.upload_error', request_id: id, error_class: error instanceof Error ? error.name : 'UnknownError' }));
      return jsonError(code, 'Unexpected internal error', status, id);
    }
  });
}
