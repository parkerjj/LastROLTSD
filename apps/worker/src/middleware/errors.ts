export interface ErrorEnvelope { error: { code: string; message: string; request_id: string; retryable?: boolean; action?: string } }
export interface ErrorResponseMetadata { retryable?: boolean; action?: string; }
export function jsonError(code: string, message: string, status: number, requestId: string, metadata: ErrorResponseMetadata = {}): Response {
  const error = { code, message, request_id: requestId, ...(metadata.retryable === undefined ? {} : { retryable: metadata.retryable }), ...(metadata.action === undefined ? {} : { action: metadata.action }) };
  return new Response(JSON.stringify({ error } satisfies ErrorEnvelope), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
export function requestId(request: Request): string { return request.headers.get('cf-ray') ?? crypto.randomUUID(); }
export function statusForError(error: unknown): number { return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 500; }
