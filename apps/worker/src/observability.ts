export interface MetricEvent { requestId: string; route: string; status: number; elapsedMs: number; bodyBytes?: number; counts?: Record<string, number>; errorClass?: string; }
export function recordMetric(event: MetricEvent): void {
  console.log(JSON.stringify({ metric: 'lastroweb.request', request_id: event.requestId, route: event.route, status: event.status, elapsed_ms: Math.round(event.elapsedMs), body_bytes: event.bodyBytes, counts: event.counts, error_class: event.errorClass }));
}
