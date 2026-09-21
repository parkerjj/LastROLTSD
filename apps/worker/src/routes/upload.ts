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

interface UploadErrorMetadata {
  retryable: boolean;
  action?: string;
  retryAfter?: string;
}

function receivedBodyLog(raw: string): Pick<Parameters<typeof recordUploadReceived>[0], 'payload' | 'bodyPreview' | 'bodyTruncated'> {
  const bytes = new TextEncoder().encode(raw);
  if (bytes.byteLength > MAX_LOG_BODY_BYTES) return { bodyPreview: new TextDecoder().decode(bytes.slice(0, MAX_LOG_BODY_BYTES)), bodyTruncated: true };
  try { return { payload: JSON.parse(raw) }; } catch { return { bodyPreview: raw, bodyTruncated: false }; }
}

function isUploadLimitValidationError(error: UploadValidationError): boolean {
  const limitedFields = new Set<PropertyKey>(['part_count', 'part_index', 'shops', 'items', 'options']);
  return error.issues.some((issue) => issue.code === 'too_big' && limitedFields.has(issue.path[issue.path.length - 1]!));
}

export function registerUploadRoute(app: Hono<any>, env: AppEnv, repo: MarketRepository, state: ListingStateService): void {
  app.post('/api/v1/market/upload', async (c) => {
    const id = requestId(c.req.raw);
    let source: AuthenticatedSource | undefined;
    let raw = '';
    const logError = (code: string, message: string, status: number, errorClass: string, metadata: UploadErrorMetadata, details?: Record<string, unknown>): Response => {
      recordUploadError({ requestId: id, status, code, message, errorClass, ...(source ? { sourceId: source.id } : {}), ...(details ? { details } : {}) });
      const response = jsonError(code, message, status, id, { retryable: metadata.retryable, ...(metadata.action === undefined ? {} : { action: metadata.action }) });
      if (metadata.retryAfter !== undefined) response.headers.set('retry-after', metadata.retryAfter);
      return response;
    };
    try {
      raw = await c.req.raw.text();
      const bodyBytes = new TextEncoder().encode(raw).byteLength;
      const declaredBodyBytes = Number(c.req.header('content-length') ?? 0);
      recordUploadReceived({ requestId: id, method: c.req.raw.method, path: new URL(c.req.raw.url).pathname, bodyBytes, ...(Number.isFinite(declaredBodyBytes) && declaredBodyBytes > 0 ? { declaredBodyBytes } : {}), ...(c.req.header('content-type') ? { contentType: c.req.header('content-type')! } : {}), ...(c.req.header('idempotency-key') ? { idempotencyKey: c.req.header('idempotency-key')! } : {}), ...receivedBodyLog(raw) });
      source = await requireSource(c.req.raw, repo);
      if (env.UPLOAD_LIMITER) {
        let limiterResponse: Response;
        try {
          limiterResponse = await env.UPLOAD_LIMITER.fetch('https://lastroweb.invalid/upload-limit', { method: 'POST', headers: { 'x-source-id': source.id } });
        } catch (error) {
          return logError('limiter_unavailable', 'Upload limiter unavailable', 503, 'LimiterError', { retryable: true }, { errorMessage: error instanceof Error ? error.message : String(error) });
        }
        if (limiterResponse.status === 429) return logError('rate_limited', 'Upload rate limit exceeded', 429, 'LimitError', { retryable: true, retryAfter: limiterResponse.headers.get('retry-after') ?? '60' }, { expected: 'upload limiter allows request', actual: 429 });
        if (!limiterResponse.ok) return logError('limiter_unavailable', 'Upload limiter unavailable', 503, 'LimiterError', { retryable: true }, { expected: 'upload limiter 2xx response', actual: limiterResponse.status });
      }
      const idempotencyKey = c.req.header('idempotency-key');
      if (!isValidIdempotencyKey(idempotencyKey)) return logError('invalid_idempotency_key', 'Idempotency-Key header is required and must be printable ASCII', 400, 'UploadRequestError', { retryable: false }, { expected: 'a printable Idempotency-Key header', actual: idempotencyKey === undefined ? 'missing' : idempotencyKey });
      const uploadBodyBytes = new TextEncoder().encode(raw).byteLength;
      if (uploadBodyBytes > env.MAX_BODY_BYTES) return logError('payload_too_large', 'Upload body exceeds configured limit', 413, 'LimitError', { retryable: false, action: 'reshard_upload' }, { expected: env.MAX_BODY_BYTES, actual: uploadBodyBytes });
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch (error) { return logError('malformed_json', 'Malformed JSON', 400, 'UploadValidationError', { retryable: false }, { expected: 'valid JSON', actual: error instanceof Error ? error.message : 'JSON parse failed' }); }
      const request = parseUploadRequest(parsed);
      if (idempotencyKey !== canonicalBatchId(request)) return logError('idempotency_key_mismatch', 'Idempotency-Key must match the canonical snapshot part', 400, 'UploadValidationError', { retryable: false }, { expected: canonicalBatchId(request), actual: idempotencyKey });
      enforceUploadLimits(c.req.raw, request, new TextEncoder().encode(raw).byteLength);
      const result = await ingestUpload(source, request, idempotencyKey, repo, state);
      return c.json(result, 202, { 'cache-control': 'no-store' });
    } catch (error) {
      if (error instanceof UploadValidationError) {
        const limitExceeded = isUploadLimitValidationError(error);
        return logError(
          limitExceeded ? 'upload_limit_exceeded' : 'invalid_upload',
          limitExceeded ? 'Upload exceeds configured structural limits' : 'Invalid upload request',
          limitExceeded ? 413 : 422,
          error.name,
          limitExceeded ? { retryable: false, action: 'reshard_upload' } : { retryable: false },
          { issues: error.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })) },
        );
      }
      if (error instanceof AuthError) return logError(error.status === 401 ? 'unauthorized' : 'source_disabled', error.message, error.status, error.name, { retryable: false }, error.details);
      if (error instanceof LimitError) return logError(error.code, error.message, error.status, error.name, { retryable: error.status === 429, ...(error.action === undefined ? {} : { action: error.action }) }, { expected: 'configured upload limits', actual: error.message });
      if (error instanceof IngestionError) return logError(error.code, error.message, error.status, error.name, { retryable: error.retryable, ...(error.action === undefined ? {} : { action: error.action }), ...(error.retryAfterSeconds === undefined ? {} : { retryAfter: String(error.retryAfterSeconds) }) }, { expected: 'upload can be ingested', actual: error.message });
      return logError('internal_error', 'Unexpected internal error', 500, error instanceof Error ? error.name : 'UnknownError', { retryable: true }, { errorMessage: error instanceof Error ? error.message : String(error) });
    }
  });
}
