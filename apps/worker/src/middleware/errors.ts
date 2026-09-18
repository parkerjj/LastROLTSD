export interface ErrorEnvelope { error: { code: string; message: string; request_id: string } }
export function jsonError(code: string, message: string, status: number, requestId: string): Response {
  return new Response(JSON.stringify({ error: { code, message, request_id: requestId } } satisfies ErrorEnvelope), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
export function requestId(request: Request): string { return request.headers.get('cf-ray') ?? crypto.randomUUID(); }
export function statusForError(error: unknown): number { return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 500; }
