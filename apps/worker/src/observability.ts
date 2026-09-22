export interface MetricEvent { requestId: string; route: string; status: number; elapsedMs: number; bodyBytes?: number; counts?: Record<string, number>; errorClass?: string; }

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

export function recordUploadError(event: UploadErrorEvent): void {
  console.error(JSON.stringify({ metric: 'lastroweb.upload_error', request_id: event.requestId, status: event.status, code: event.code, message: event.message, error_class: event.errorClass, source_id: event.sourceId, details: event.details }));
}
