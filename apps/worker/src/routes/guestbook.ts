import type { Hono } from 'hono';
import {
  GUESTBOOK_MAX_BODY_BYTES,
  GUESTBOOK_RATE_LIMIT,
  GUESTBOOK_RATE_WINDOW_MS,
  GuestbookValidationError,
  guestbookCursorContext,
  parseGuestbookContentEdit,
  parseGuestbookFilters,
  parseGuestbookIdParam,
  parseGuestbookReplySubmission,
  parseGuestbookSubmission,
} from '../domain/guestbook';
import { guestbookRateKey, type GuestbookRepository } from '../db/guestbook-repository';
import { jsonError, requestId } from '../middleware/errors';
import { logError } from '../observability';
import { NOOP_ACTIVITY_RECORDER, type ActivityRecorder } from '../activity/recorder';
import { AuthFailure, type AuthIdentity } from '../auth/types';

export interface GuestbookAuthServices {
  /** 校验会话 Cookie，未登录抛 AuthFailure(401) */
  authenticate(request: Request): Promise<AuthIdentity & { userId: string }>;
  /** 校验会话 CSRF（含 Origin），失败抛 AuthFailure(403) */
  assertSession(request: Request, identity: AuthIdentity): Promise<void>;
}

export interface GuestbookRouteConfig {
  getItemIds(): Promise<ReadonlySet<number>>;
  cursorSecret: string;
  rateSecret: string;
  auth: GuestbookAuthServices | null;
  activity?: ActivityRecorder;
}

type JsonBody = { ok: true; value: unknown } | { ok: false; response: Response };

async function readJsonBody(request: Request, id: string): Promise<JsonBody> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > GUESTBOOK_MAX_BODY_BYTES) {
    return { ok: false, response: jsonError('payload_too_large', 'Request body exceeds 16 KiB', 413, id) };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBounded(request, GUESTBOOK_MAX_BODY_BYTES);
  } catch {
    return { ok: false, response: jsonError('payload_too_large', 'Request body exceeds 16 KiB', 413, id) };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: jsonError('bad_request', 'Request body must be valid JSON', 400, id) };
  }
}

function rateLimitedResponse(id: string): Response {
  return new Response(JSON.stringify({ error: { code: 'rate_limited', message: '提交过于频繁，请稍后再试', request_id: id } }), {
    status: 429, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store', 'retry-after': '60' },
  });
}

export function registerGuestbookRoutes(app: Hono<any>, repo: GuestbookRepository, config: GuestbookRouteConfig): void {
  const activity = config.activity ?? NOOP_ACTIVITY_RECORDER;
  /** 校验登录态 + 会话 CSRF；失败时返回可直接落地的 Response */
  async function requireIdentity(request: Request, id: string): Promise<{ userId: string } | { response: Response }> {
    if (!config.auth) return { response: jsonError('auth_unavailable', '账号服务暂不可用', 503, id) };
    try {
      const identity = await config.auth.authenticate(request);
      await config.auth.assertSession(request, identity);
      return { userId: identity.userId };
    } catch (error) {
      if (error instanceof AuthFailure) return { response: jsonError(error.code, error.publicMessage, error.status, id) };
      throw error;
    }
  }

  app.get('/api/v1/guestbook', async (c) => {
    try {
      const raw = parseGuestbookFilters(new URL(c.req.url).searchParams);
      const filters = { ...raw, context: guestbookCursorContext(raw) };
      // 列表接口带 public max-age 缓存，不注入 hasReplied（避免污染边缘缓存）；
      // 需要用户级态的 hasReplied 时由单条详情接口返回
      const result = await repo.search(filters, Date.now());
      return c.json(result, 200, { 'cache-control': 'public, max-age=15, s-maxage=15' });
    } catch (error) {
      if (error instanceof GuestbookValidationError) return jsonError('bad_request', error.message, 400, requestId(c.req.raw));
      throw error;
    }
  });

  app.post('/api/v1/guestbook', async (c) => {
    const id = requestId(c.req.raw);
    const identity = await requireIdentity(c.req.raw, id);
    if ('response' in identity) return identity.response;
    const body = await readJsonBody(c.req.raw, id);
    if (!body.ok) return body.response;
    try {
      const now = Date.now();
      const category = body.value && typeof body.value === 'object' && !Array.isArray(body.value)
        ? (body.value as Record<string, unknown>).category
        : undefined;
      const itemIds = category === 'suggestion' ? undefined : await config.getItemIds();
      const input = parseGuestbookSubmission(body.value, itemIds, now);
      const rateKey = guestbookRateKey('entry', identity.userId, config.rateSecret);
      const bucketStart = Math.floor(now / GUESTBOOK_RATE_WINDOW_MS) * GUESTBOOK_RATE_WINDOW_MS;
      const result = await repo.create({ ...input, createdAt: now }, identity.userId, rateKey, bucketStart, GUESTBOOK_RATE_LIMIT);
      if (result.status === 'rate_limited') return rateLimitedResponse(id);
      const item = await repo.readById(result.id, now, identity.userId);
      await activity.record(c.req.raw, { userId: identity.userId, event: 'GUESTBOOK_POST', requestId: id });
      return c.json({ item }, 201, { 'cache-control': 'no-store' });
    } catch (error) {
      if (error instanceof GuestbookValidationError) return jsonError('bad_request', error.message, 400, id);
      logError('lastroweb.guestbook_error', error, { request_id: id });
      return jsonError('internal_error', 'Internal Server Error', 500, id, { retryable: true });
    }
  });

  app.patch('/api/v1/guestbook/:id', async (c) => {
    const id = requestId(c.req.raw);
    const identity = await requireIdentity(c.req.raw, id);
    if ('response' in identity) return identity.response;
    const body = await readJsonBody(c.req.raw, id);
    if (!body.ok) return body.response;
    try {
      const entryId = parseGuestbookIdParam(c.req.param('id'), 'id');
      const content = parseGuestbookContentEdit(body.value);
      const now = Date.now();
      const updated = await repo.updateEntryContent(entryId, identity.userId, content, now);
      if (!updated) {
        const existing = await repo.readById(entryId, now, identity.userId);
        return existing
          ? jsonError('forbidden', '只能修改自己的留言', 403, id)
          : jsonError('not_found', '留言不存在', 404, id);
      }
      const item = await repo.readById(entryId, now, identity.userId);
      return c.json({ item }, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      if (error instanceof GuestbookValidationError) return jsonError('bad_request', error.message, 400, id);
      logError('lastroweb.guestbook_error', error, { request_id: id });
      return jsonError('internal_error', 'Internal Server Error', 500, id, { retryable: true });
    }
  });

  app.post('/api/v1/guestbook/:id/replies', async (c) => {
    const id = requestId(c.req.raw);
    const identity = await requireIdentity(c.req.raw, id);
    if ('response' in identity) return identity.response;
    const body = await readJsonBody(c.req.raw, id);
    if (!body.ok) return body.response;
    try {
      const entryId = parseGuestbookIdParam(c.req.param('id'), 'id');
      const content = parseGuestbookReplySubmission(body.value);
      const now = Date.now();
      const rateKey = guestbookRateKey('reply', identity.userId, config.rateSecret);
      const bucketStart = Math.floor(now / GUESTBOOK_RATE_WINDOW_MS) * GUESTBOOK_RATE_WINDOW_MS;
      const result = await repo.createReply(entryId, identity.userId, content, now, rateKey, bucketStart, GUESTBOOK_RATE_LIMIT);
      if (result.status === 'rate_limited') return rateLimitedResponse(id);
      if (result.status === 'duplicate') return jsonError('reply_exists', '你已经回复过这条留言，可直接编辑原回复', 409, id);
      if (result.status === 'entry_not_found') return jsonError('not_found', '留言不存在', 404, id);
      const entry = await repo.readById(entryId, now, identity.userId);
      const item = entry?.replies.find((reply) => reply.id === result.id) ?? null;
      await activity.record(c.req.raw, { userId: identity.userId, event: 'GUESTBOOK_REPLY', requestId: id });
      return c.json({ item }, 201, { 'cache-control': 'no-store' });
    } catch (error) {
      if (error instanceof GuestbookValidationError) return jsonError('bad_request', error.message, 400, id);
      logError('lastroweb.guestbook_error', error, { request_id: id });
      return jsonError('internal_error', 'Internal Server Error', 500, id, { retryable: true });
    }
  });

  app.patch('/api/v1/guestbook/replies/:id', async (c) => {
    const id = requestId(c.req.raw);
    const identity = await requireIdentity(c.req.raw, id);
    if ('response' in identity) return identity.response;
    const body = await readJsonBody(c.req.raw, id);
    if (!body.ok) return body.response;
    try {
      const replyId = parseGuestbookIdParam(c.req.param('id'), 'id');
      const content = parseGuestbookReplySubmission(body.value);
      const now = Date.now();
      const updated = await repo.updateReplyContent(replyId, identity.userId, content, now);
      if (!updated) return jsonError('not_found', '回复不存在或无权修改', 404, id);
      return c.json({ item: { id: replyId, content, editedAt: now } }, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      if (error instanceof GuestbookValidationError) return jsonError('bad_request', error.message, 400, id);
      logError('lastroweb.guestbook_error', error, { request_id: id });
      return jsonError('internal_error', 'Internal Server Error', 500, id, { retryable: true });
    }
  });

  /** 单条详情：返回完整回复历史 + hasReplied；带 private 缓存避免边缘污染 */
  app.get('/api/v1/guestbook/:id', async (c) => {
    try {
      const entryId = parseGuestbookIdParam(c.req.param('id'), 'id');
      let currentUserId: string | undefined;
      if (config.auth) {
        try {
          const identity = await config.auth.authenticate(c.req.raw);
          currentUserId = identity.userId;
        } catch {
          // 未登录 → 匿名访问，hasReplied 为 null
        }
      }
      const item = await repo.readById(entryId, Date.now(), currentUserId);
      if (!item) return jsonError('not_found', '留言不存在', 404, requestId(c.req.raw));
      return c.json({ item }, 200, { 'cache-control': 'private, no-cache' });
    } catch (error) {
      if (error instanceof GuestbookValidationError) return jsonError('bad_request', error.message, 400, requestId(c.req.raw));
      throw error;
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
