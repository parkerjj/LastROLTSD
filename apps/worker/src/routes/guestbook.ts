import type { Hono } from 'hono';
import { GUESTBOOK_MAX_BODY_BYTES, GUESTBOOK_RATE_LIMIT, GUESTBOOK_RATE_WINDOW_MS, GuestbookValidationError, guestbookCursorContext, parseGuestbookFilters, parseGuestbookSubmission } from '../domain/guestbook';
import { guestbookRateKey, type GuestbookRepository } from '../db/guestbook-repository';
import { jsonError, requestId } from '../middleware/errors';
import { logError } from '../observability';

export interface GuestbookRouteConfig {
  getItemIds(): Promise<ReadonlySet<number>>;
  cursorSecret: string;
  rateSecret: string;
}

export function registerGuestbookRoutes(app: Hono<any>, repo: GuestbookRepository, config: GuestbookRouteConfig): void {
  app.get('/api/v1/guestbook', async (c) => {
    try {
      const raw = parseGuestbookFilters(new URL(c.req.url).searchParams);
      const filters = { ...raw, context: guestbookCursorContext(raw) };
      const result = await repo.search(filters, Date.now());
      return c.json(result, 200, { 'cache-control': 'public, max-age=15, s-maxage=15' });
    } catch (error) {
      if (error instanceof GuestbookValidationError) return jsonError('bad_request', error.message, 400, requestId(c.req.raw));
      throw error;
    }
  });

  app.post('/api/v1/guestbook', async (c) => {
    const id = requestId(c.req.raw);
    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > GUESTBOOK_MAX_BODY_BYTES) return jsonError('payload_too_large', 'Request body exceeds 16 KiB', 413, id);
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(c.req.raw, GUESTBOOK_MAX_BODY_BYTES);
    } catch {
      return jsonError('payload_too_large', 'Request body exceeds 16 KiB', 413, id);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return jsonError('bad_request', 'Request body must be valid JSON', 400, id);
    }
    try {
      const now = Date.now();
      const category = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).category : undefined;
      const itemIds = category === 'suggestion' ? undefined : await config.getItemIds();
      const input = parseGuestbookSubmission(raw, itemIds, now);
      const clientAddress = c.req.header('cf-connecting-ip') ?? 'unknown';
      const rateKey = guestbookRateKey(clientAddress, config.rateSecret);
      const bucketStart = Math.floor(now / GUESTBOOK_RATE_WINDOW_MS) * GUESTBOOK_RATE_WINDOW_MS;
      const result = await repo.create({ ...input, createdAt: now }, rateKey, bucketStart, GUESTBOOK_RATE_LIMIT);
      if (result === 'rate_limited') {
        return new Response(JSON.stringify({ error: { code: 'rate_limited', message: '提交过于频繁，请稍后再试', request_id: id } }), {
          status: 429, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store', 'retry-after': '60' },
        });
      }
      return c.json({ item: { ...input, createdAt: now, isExpired: false } }, 201, { 'cache-control': 'no-store' });
    } catch (error) {
      if (error instanceof GuestbookValidationError) return jsonError('bad_request', error.message, 400, id);
      if (error instanceof GuestbookValidationError) return jsonError('bad_request', error.message, 400, id);
      logError('lastroweb.guestbook_error', error, { request_id: id });
      return jsonError('internal_error', 'Internal Server Error', 500, id, { retryable: true });
    }
  });
}

async function readBounded(request: Request, maximum: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new RangeError('body too large');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
