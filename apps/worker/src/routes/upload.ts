import type { Hono } from 'hono';
import { parseUploadRequest, UploadValidationError } from '@lastroweb/protocol';
import { AuthError, requireSource } from '../middleware/auth';
import { enforceUploadLimits, LimitError } from '../middleware/limits';
import { jsonError, requestId } from '../middleware/errors';
import { canonicalBatchId, ingestUpload, IngestionError, isValidIdempotencyKey, type ListingStateService } from '../services/ingestion';
import type { AppEnv } from '../env';
import type { MarketRepository } from '../db/repository';
import { recordUploadError, recordUploadReceived } from '../observability';
import type { AuthenticatedSource } from '../middleware/auth';

const MAX_LOG_BODY_BYTES = 64 * 1024;

function receivedBodyLog(raw: string): Pick<Parameters<typeof recordUploadReceived>[0], 'payload' | 'bodyPreview' | 'bodyTruncated'> {
  const bytes = new TextEncoder().encode(raw);
  if (bytes.byteLength > MAX_LOG_BODY_BYTES) return { bodyPreview: new TextDecoder().decode(bytes.slice(0, MAX_LOG_BODY_BYTES)), bodyTruncated: true };
  try { return { payload: JSON.parse(raw) }; } catch { return { bodyPreview: raw, bodyTruncated: false }; }
}

export function registerUploadRoute(app: Hono<any>, env: AppEnv, repo: MarketRepository, state: ListingStateService): void {
  app.post('/api/v1/market/upload', async (c) => {
    const id = requestId(c.req.raw);
    let source: AuthenticatedSource | undefined;
    let raw = '';
    const logError = (code: string, message: string, status: number, errorClass: string, details?: Record<string, unknown>): Response => {
      recordUploadError({ requestId: id, status, code, message, errorClass, ...(source ? { sourceId: source.id } : {}), ...(details ? { details } : {}) });
      return jsonError(code, message, status, id);
    };
    try {
      raw = await c.req.raw.text();
      const bodyBytes = new TextEncoder().encode(raw).byteLength;
      const declaredBodyBytes = Number(c.req.header('content-length') ?? 0);
      recordUploadReceived({ requestId: id, method: c.req.raw.method, path: new URL(c.req.raw.url).pathname, bodyBytes, ...(Number.isFinite(declaredBodyBytes) && declaredBodyBytes > 0 ? { declaredBodyBytes } : {}), ...(c.req.header('content-type') ? { contentType: c.req.header('content-type')! } : {}), ...(c.req.header('idempotency-key') ? { idempotencyKey: c.req.header('idempotency-key')! } : {}), ...receivedBodyLog(raw) });
      source = await requireSource(c.req.raw, repo);
      if (env.UPLOAD_LIMITER) {
        const limiterResponse = await env.UPLOAD_LIMITER.fetch('https://lastroweb.invalid/upload-limit', { method: 'POST', headers: { 'x-source-id': source.id } });
        if (limiterResponse.status === 429) { const response = logError('rate_limited', 'Upload rate limit exceeded', 429, 'LimitError', { expected: 'upload limiter allows request', actual: 429 }); response.headers.set('retry-after', limiterResponse.headers.get('retry-after') ?? '60'); return response; }
        if (!limiterResponse.ok) return logError('service_unavailable', 'Upload limiter unavailable', 503, 'LimiterError', { expected: 'upload limiter 2xx response', actual: limiterResponse.status });
      }
      const idempotencyKey = c.req.header('idempotency-key');
      if (!isValidIdempotencyKey(idempotencyKey)) return logError('bad_request', 'Idempotency-Key header is required', 400, 'UploadRequestError', { expected: 'a printable Idempotency-Key header', actual: idempotencyKey === undefined ? 'missing' : idempotencyKey });
      const uploadBodyBytes = new TextEncoder().encode(raw).byteLength;
      if (uploadBodyBytes > env.MAX_BODY_BYTES) return logError('payload_too_large', 'Upload body exceeds configured limit', 413, 'LimitError', { expected: env.MAX_BODY_BYTES, actual: uploadBodyBytes });
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch (error) { return logError('bad_request', 'Malformed JSON', 400, 'UploadValidationError', { expected: 'valid JSON', actual: error instanceof Error ? error.message : 'JSON parse failed' }); }
      const request = parseUploadRequest(parsed);
      if (idempotencyKey !== canonicalBatchId(request)) return logError('bad_request', 'Idempotency-Key must match the canonical snapshot part', 400, 'UploadValidationError', { expected: canonicalBatchId(request), actual: idempotencyKey });
      enforceUploadLimits(c.req.raw, request, new TextEncoder().encode(raw).byteLength);
      const result = await ingestUpload(source, request, idempotencyKey, repo, state);
      return c.json(result, 202, { 'cache-control': 'no-store' });
    } catch (error) {
      if (error instanceof UploadValidationError) return logError('bad_request', 'Invalid upload request', 400, error.name, { issues: error.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })) });
      if (error instanceof AuthError) return logError(error.status === 401 ? 'unauthorized' : 'forbidden', error.message, error.status, error.name, error.details);
      if (error instanceof LimitError) return logError(error.status === 413 ? 'payload_too_large' : 'rate_limited', error.message, error.status, error.name, { expected: 'configured upload limits', actual: error.message });
      if (error instanceof IngestionError) return logError(error.status === 400 ? 'bad_request' : error.status === 409 ? 'conflict' : 'service_unavailable', error.message, error.status, error.name, { expected: 'upload can be ingested', actual: error.message });
      const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 500;
      const code = status === 409 ? 'conflict' : status === 413 ? 'payload_too_large' : status === 429 ? 'rate_limited' : status === 503 ? 'service_unavailable' : 'internal_error';
      return logError(code, 'Unexpected internal error', status, error instanceof Error ? error.name : 'UnknownError', { errorMessage: error instanceof Error ? error.message : String(error) });
    }
  });
}
