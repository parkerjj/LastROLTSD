export interface MetricEvent { requestId: string; route: string; status: number; elapsedMs: number; bodyBytes?: number; counts?: Record<string, number>; errorClass?: string; }

export interface UploadReceivedEvent {
  requestId: string;
  method: string;
  path: string;
  bodyBytes: number;
  declaredBodyBytes?: number;
  contentType?: string;
  idempotencyKey?: string;
  payload?: unknown;
  bodyPreview?: string;
  bodyTruncated?: boolean;
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

export function recordMetric(event: MetricEvent): void {
  console.log(JSON.stringify({
    metric: 'lastroweb.request',
    request_id: event.requestId,
    route: event.route,
    status: event.status,
    elapsed_ms: Math.round(event.elapsedMs),
    body_bytes: event.bodyBytes,
    counts: event.counts,
    error_class: event.errorClass,
  }));
}

export function recordUploadReceived(event: UploadReceivedEvent): void {
  console.log(JSON.stringify({
    metric: 'lastroweb.upload_received',
    request_id: event.requestId,
    method: event.method,
    path: event.path,
    body_bytes: event.bodyBytes,
    declared_body_bytes: event.declaredBodyBytes,
    content_type: event.contentType,
    idempotency_key: event.idempotencyKey,
    payload: event.payload,
    body_preview: event.bodyPreview,
    body_truncated: event.bodyTruncated,
  }));
}

export function recordUploadError(event: UploadErrorEvent): void {
  console.error(JSON.stringify({ metric: 'lastroweb.upload_error', request_id: event.requestId, status: event.status, code: event.code, message: event.message, error_class: event.errorClass, source_id: event.sourceId, details: event.details }));
}
