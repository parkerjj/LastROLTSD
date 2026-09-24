import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logError, logInfo, logWarn, recordMetric, recordUploadError, isErrorResponse } from '../src/observability';
import { createApp } from '../src/index';

describe('observability logging', () => {
  // Capture every console channel so we can assert that the success path
  // writes nothing to any of them.
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('isErrorResponse', () => {
    it('treats 4xx and 5xx as error responses', () => {
      expect(isErrorResponse(399)).toBe(false);
      expect(isErrorResponse(400)).toBe(true);
      expect(isErrorResponse(404)).toBe(true);
      expect(isErrorResponse(500)).toBe(true);
      expect(isErrorResponse(503)).toBe(true);
    });

    it('treats 2xx and 3xx as success responses', () => {
      expect(isErrorResponse(200)).toBe(false);
      expect(isErrorResponse(201)).toBe(false);
      expect(isErrorResponse(204)).toBe(false);
      expect(isErrorResponse(301)).toBe(false);
      expect(isErrorResponse(304)).toBe(false);
    });
  });

  describe('recordMetric — success path is silent', () => {
    it('emits nothing for a 200 response', () => {
      recordMetric({ requestId: 'req-200', route: '/api/v1/health', status: 200, elapsedMs: 12 });
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('emits nothing for a 3xx redirect', () => {
      recordMetric({ requestId: 'req-304', route: '/api/v1/health', status: 304, elapsedMs: 4 });
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('recordMetric — error path emits structured error', () => {
    it('writes a single error line for a 500 with timestamp, level, metric, and context', () => {
      recordMetric({ requestId: 'req-500', route: '/api/v1/market/upload', status: 500, elapsedMs: 87, bodyBytes: 4096 });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();

      const line = errorSpy.mock.calls[0]![0] as string;
      const payload = JSON.parse(line);
      expect(payload).toMatchObject({
        metric: 'lastroweb.request',
        level: 'error',
        request_id: 'req-500',
        route: '/api/v1/market/upload',
        status: 500,
        elapsed_ms: 87,
        body_bytes: 4096,
        error_class: 'Error',
        message: 'HTTP 500 on /api/v1/market/upload',
      });
      expect(typeof payload.timestamp).toBe('string');
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(typeof payload.stack).toBe('string');
      expect(payload.stack.length).toBeGreaterThan(0);
    });

    it('emits a 4xx client error through the same error channel', () => {
      recordMetric({ requestId: 'req-422', route: '/api/v1/market/upload', status: 422, elapsedMs: 3 });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(payload.status).toBe(422);
      expect(payload.level).toBe('error');
    });

    it('omits body_bytes when not provided', () => {
      recordMetric({ requestId: 'req', route: '/api/v1/health', status: 500, elapsedMs: 1 });
      const payload = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(payload.body_bytes).toBeUndefined();
    });
  });

  describe('logError — error event shape', () => {
    it('captures the error class, message, stack, and arbitrary context', () => {
      const error = new Error('database connection refused');
      error.name = 'MysqlDatabaseError';
      logError('lastroweb.test_error', error, { request_id: 'req-ctx', route: '/api/v1/market/search', stage: 'query' });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(payload).toMatchObject({
        metric: 'lastroweb.test_error',
        level: 'error',
        message: 'database connection refused',
        error_class: 'MysqlDatabaseError',
        request_id: 'req-ctx',
        route: '/api/v1/market/search',
        stage: 'query',
      });
      expect(payload.stack).toContain('MysqlDatabaseError');
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('accepts a non-Error value without crashing', () => {
      logError('lastroweb.test_string', 'a plain string failure');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(payload.message).toBe('a plain string failure');
      expect(payload.error_class).toBe('StringError');
      expect(payload.stack).toBeUndefined();
    });
  });

  describe('logWarn and logInfo are silenced at the ERROR threshold', () => {
    it('does not emit WARN events', () => {
      logWarn('lastroweb.snapshot_dispatch_fallback', { source_id: 'src-1', snapshot_id: 'snap-1' });
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('does not emit INFO events', () => {
      logInfo('lastroweb.snapshot_chunk', { source_id: 'src-1', processed: 42 });
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('recordUploadError — keeps ERROR severity and gains timestamp/stack', () => {
    it('routes through logError with full context', () => {
      recordUploadError({
        requestId: 'req-up',
        status: 413,
        code: 'payload_too_large',
        message: 'Upload body exceeds configured limit',
        errorClass: 'LimitError',
        sourceId: 'src-upload',
        details: { stage: 'rate_limit', body_bytes: 524288, retryable: false },
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(payload).toMatchObject({
        metric: 'lastroweb.upload_error',
        level: 'error',
        request_id: 'req-up',
        status: 413,
        code: 'payload_too_large',
        message: 'Upload body exceeds configured limit',
        error_class: 'LimitError',
        source_id: 'src-upload',
        details: { stage: 'rate_limit', body_bytes: 524288, retryable: false },
      });
      expect(typeof payload.stack).toBe('string');
      expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('end-to-end: a successful Worker request writes nothing to the console', () => {
    it('serves /api/health with 200 and produces zero log lines', async () => {
      const app = createApp({ ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 });
      const response = await app.request('/api/health');
      expect(response.status).toBe(200);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('serves /api/health through the raw Worker fetch entrypoint with 200 and zero log lines', async () => {
      const worker = (await import('../src/index')).default;
      const response = await worker.fetch(new Request('https://example.test/api/health'), { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 });
      expect(response.status).toBe(200);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
