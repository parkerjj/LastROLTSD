import type { Hono } from 'hono';
import { Buffer } from 'node:buffer';
import { parseUploadRequest, UploadValidationError, type UploadRequest } from '@lastroweb/protocol';
import { AuthError, requireSource } from '../middleware/auth';
import { enforceUploadLimits, LimitError } from '../middleware/limits';
import { jsonError, requestId } from '../middleware/errors';
import { canonicalBatchId, ingestUpload, IngestionError, isValidIdempotencyKey, type ListingStateService } from '../services/ingestion';
import type { AppEnv } from '../env';
import type { MarketRepository, UploadResultLike } from '../db/repository';
import { recordUploadError } from '../observability';
import type { AuthenticatedSource } from '../middleware/auth';
import { MysqlDatabaseError } from '../db/mysql-client';

interface UploadErrorMetadata {
  retryable: boolean;
  action?: string;
  retryAfter?: string;
}

function isUploadLimitValidationError(error: UploadValidationError): boolean {
  const limitedFields = new Set<PropertyKey>(['part_count', 'part_index', 'shops', 'items', 'options']);
  return error.issues.some((issue) => issue.code === 'too_big' && limitedFields.has(issue.path[issue.path.length - 1]!));
}

export type UploadHandler = (source: AuthenticatedSource, request: UploadRequest, key: string) => Promise<UploadResultLike>;
export function registerUploadRoute(app: Hono<any>, env: AppEnv, repo: MarketRepository, state: ListingStateService, handler?: UploadHandler): void {
  app.post('/api/v1/market/upload', async (c) => {
    const id = requestId(c.req.raw);
    let source: AuthenticatedSource | undefined;
    let bodyBytes = 0;
    let stage = 'read_body';
    const logError = (code: string, message: string, status: number, errorClass: string, metadata: UploadErrorMetadata, details?: Record<string, unknown>): Response => {
      recordUploadError({ requestId: id, status, code, message, errorClass, ...(source ? { sourceId: source.id } : {}), details: { stage, body_bytes: bodyBytes, retryable: metadata.retryable, ...details } });
      const response = jsonError(code, message, status, id, { retryable: metadata.retryable, ...(metadata.action === undefined ? {} : { action: metadata.action }) });
      if (metadata.retryAfter !== undefined) response.headers.set('retry-after', metadata.retryAfter);
      return response;
    };
    try {
      const raw = await c.req.raw.text();
      bodyBytes = Buffer.byteLength(raw, 'utf8');
      stage = 'authenticate';
      source = await requireSource(c.req.raw, repo);
      if (env.UPLOAD_LIMITER) {
        stage = 'rate_limit';
        try {
          const limiterResponse = await env.UPLOAD_LIMITER.fetch('https://lastroweb.invalid/upload-limit', { method: 'POST', headers: { 'x-source-id': source.id } });
          if (limiterResponse.status === 429) return logError('rate_limited', 'Upload rate limit exceeded', 429, 'LimitError', { retryable: true, retryAfter: limiterResponse.headers.get('retry-after') ?? '60' }, { expected: 'upload limiter allows request', actual: 429 });
          if (!limiterResponse.ok) return logError('limiter_unavailable', 'Upload limiter unavailable', 503, 'LimiterError', { retryable: true }, { expected: 'upload limiter 2xx response', actual: limiterResponse.status });
        } catch {
          return logError('limiter_unavailable', 'Upload limiter unavailable', 503, 'LimiterError', { retryable: true });
        }
      }
      stage = 'validate';
      const idempotencyKey = c.req.header('idempotency-key');
      if (!isValidIdempotencyKey(idempotencyKey)) return logError('invalid_idempotency_key', 'Idempotency-Key header is required and must be printable ASCII', 400, 'UploadRequestError', { retryable: false }, { expected: 'a printable Idempotency-Key header', actual: idempotencyKey === undefined ? 'missing' : 'invalid' });
      if (bodyBytes > env.MAX_BODY_BYTES) return logError('payload_too_large', 'Upload body exceeds configured limit', 413, 'LimitError', { retryable: false, action: 'reshard_upload' }, { expected: env.MAX_BODY_BYTES, actual: bodyBytes });
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return logError('malformed_json', 'Malformed JSON', 400, 'UploadValidationError', { retryable: false }, { expected: 'valid JSON', actual: 'JSON parse failed' }); }
      const request = parseUploadRequest(parsed);
      if (idempotencyKey !== canonicalBatchId(request)) return logError('idempotency_key_mismatch', 'Idempotency-Key must match the canonical snapshot part', 400, 'UploadValidationError', { retryable: false }, { expected: 'canonical snapshot part', actual: 'mismatch' });
      enforceUploadLimits(c.req.raw, request, bodyBytes);
      stage = request.snapshot_mode === 'full' ? 'receive_full_part' : 'ingest';
      const result = handler ? await handler(source, request, idempotencyKey)
        : await ingestUpload(source, request, idempotencyKey, repo, state, (nextStage) => { stage = nextStage; });
      stage = 'respond';
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
          { issue_count: error.issues.length, issues: error.issues.slice(0, 10).map((issue) => ({ path: issue.path, code: issue.code })) },
        );
      }
      if (error instanceof AuthError) return logError(error.status === 401 ? 'unauthorized' : 'source_disabled', error.message, error.status, error.name, { retryable: false }, { expected: error.details.expected, actual: error.details.actual });
      if (error instanceof LimitError) return logError(error.code, error.message, error.status, error.name, { retryable: error.status === 429, ...(error.action === undefined ? {} : { action: error.action }) }, { expected: 'configured upload limits', actual: error.message });
      if (error instanceof IngestionError) return logError(error.code, error.message, error.status, error.name, { retryable: error.retryable, ...(error.action === undefined ? {} : { action: error.action }), ...(error.retryAfterSeconds === undefined ? {} : { retryAfter: String(error.retryAfterSeconds) }) }, { expected: 'upload can be ingested', actual: error.message });
      return logError('internal_error', 'Unexpected internal error', 500, error instanceof Error ? error.name : 'UnknownError', { retryable: true }, {
        ...(error instanceof MysqlDatabaseError ? { mysql_code: error.code, mysql_errno: error.errno, mysql_sql_state: error.sqlState,
          mysql_operation: error.operation, mysql_cause_type: error.causeType,
          mysql_client_reason: error.clientReason, mysql_cause_frames: error.causeFrames } : {}),
      });
    }
  });
}
