// Centralized observability primitives for the Worker.
//
// Design goals (per project requirement):
//  - Only ERROR-level (and above) events reach the runtime console.
//  - Success responses produce zero log lines (no console.log, no JSON stringify).
//  - Error events are emitted as structured JSON containing: timestamp (ISO 8601),
//    error class, message, stack trace (when an Error instance is supplied),
//    plus arbitrary request/operation context.
//  - The filter is a single integer compare, so the success path is effectively free
//    in the Cloudflare Workers CPU budget (no allocations on the hot path).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

// Compile-time-fixed threshold. Reading a module-level constant is a single
// property load with no I/O, keeping the hot path cheap. Bumping this to
// 'warn' or 'info' would re-enable lower-severity logs without touching callers.
const CURRENT_LOG_LEVEL: LogLevel = 'error';

export interface LogContext {
  readonly [key: string]: unknown;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[CURRENT_LOG_LEVEL];
}

interface SerializedError {
  message: string;
  errorClass: string;
  stack?: string;
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    // error.stack is populated by V8/workerd at construction time; we do not
    // pay for stack capture unless an Error was already thrown.
    return {
      message: error.message,
      errorClass: error.name,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  if (typeof error === 'string') return { message: error, errorClass: 'StringError' };
  if (error === null || error === undefined) return { message: 'unknown error', errorClass: 'UnknownError' };
  // Objects that are not Error instances: surface their JSON form as the message
  // so callers passing structured payloads still get a meaningful payload.
  try {
    return { message: JSON.stringify(error), errorClass: 'ObjectError' };
  } catch {
    return { message: String(error), errorClass: 'ObjectError' };
  }
}

function emit(level: LogLevel, payload: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  // ISO 8601 UTC timestamp; toISOString() is a single native call.
  const enriched = { ...payload, level, timestamp: new Date().toISOString() };
  const line = JSON.stringify(enriched);
  // Route through the appropriate console channel so wrangler tail / CF dashboards
  // classify the severity correctly.
  if (level === 'error' || level === 'fatal') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Emit an ERROR-level event. Accepts an Error instance (preferred — preserves
 * the original stack) or any other value as the failure signal.
 * Context fields are merged into the JSON payload verbatim.
 */
export function logError(metric: string, error: unknown, context: LogContext = {}): void {
  const info = serializeError(error);
  emit('error', {
    metric,
    message: info.message,
    error_class: info.errorClass,
    ...(info.stack ? { stack: info.stack } : {}),
    ...context,
  });
}

/** WARN-level event. Silenced when CURRENT_LOG_LEVEL > 'warn' (the current default). */
export function logWarn(metric: string, context: LogContext = {}): void {
  emit('warn', { metric, ...context });
}

/** INFO-level event. Silenced at the current ERROR threshold. */
export function logInfo(metric: string, context: LogContext = {}): void {
  emit('info', { metric, ...context });
}

/** HTTP status codes >= 400 represent error responses and are eligible for logging. */
export function isErrorResponse(status: number): boolean {
  return status >= 400;
}

export interface MetricEvent {
  requestId: string;
  route: string;
  status: number;
  elapsedMs: number;
  bodyBytes?: number;
  counts?: Record<string, number>;
  errorClass?: string;
}

export interface UploadErrorEvent {
  requestId: string;
  status: number;
  code: string;
  message: string;
  errorClass: string;
  sourceId?: string;
  details?: Record<string, unknown>;
}

/**
 * Per-request metric. Successful responses (status < 400) emit nothing,
 * satisfying the "do not log OK" requirement. Error responses are forwarded
 * to logError so they gain timestamp + structured payload.
 */
export function recordMetric(event: MetricEvent): void {
  if (!isErrorResponse(event.status)) return;
  logError('lastroweb.request', new Error(`HTTP ${event.status} on ${event.route}`), {
    request_id: event.requestId,
    route: event.route,
    status: event.status,
    elapsed_ms: Math.round(event.elapsedMs),
    ...(event.bodyBytes !== undefined && Number.isFinite(event.bodyBytes) && event.bodyBytes > 0 ? { body_bytes: event.bodyBytes } : {}),
    ...(event.counts ? { counts: event.counts } : {}),
    ...(event.errorClass ? { error_class: event.errorClass } : {}),
  });
}

/** Upload-stage error event. Already ERROR severity; routed through logError for consistency. */
export function recordUploadError(event: UploadErrorEvent): void {
  logError('lastroweb.upload_error', new Error(event.message), {
    request_id: event.requestId,
    status: event.status,
    code: event.code,
    error_class: event.errorClass,
    ...(event.sourceId ? { source_id: event.sourceId } : {}),
    ...(event.details ? { details: event.details } : {}),
  });
}
