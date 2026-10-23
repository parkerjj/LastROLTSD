import type { Hono } from 'hono';
import type { AuthRepository } from '../auth/repository';
import { createSessionService } from '../auth/session-service';
import { assertTrustedWriteOrigin } from '../auth/csrf';
import type { AuthRuntime, EnabledAuthConfig } from '../auth/types';
import type { SharedProfileService } from './shared-profile-service';
import type { SharedProfileQuery } from './shared-profile-types';
import { KeFailure } from './types';

const HOUR_MS = 60 * 60 * 1000;
export const HALL_RATE_LIMITS = {
  like: { scope: 'hall_like_account', limit: 300, windowMs: HOUR_MS },
  copy: { scope: 'hall_copy_account', limit: 60, windowMs: HOUR_MS },
  share: { scope: 'hall_share_account', limit: 300, windowMs: HOUR_MS },
} as const;

interface SharedRouteContext {
  authConfig: EnabledAuthConfig;
  authRepository: AuthRepository;
  sharedProfileService: SharedProfileService;
}
interface SharedRouteOptions {
  setup(): SharedRouteContext | null;
  runtime: AuthRuntime;
  readJson(request: Request, maxBytes: number): Promise<Record<string, unknown>>;
  rateLimit(
    context: SharedRouteContext,
    subject: { kind: 'action'; value: string },
    rule: { scope: string; limit: number; windowMs: number },
    now: () => number,
  ): Promise<void>;
  failure(context: any, error: unknown): Response;
  unavailable(context: any): Response;
}

function badQuery(): never { throw new KeFailure('KE_BAD_REQUEST', 400, '大厅查询参数无效'); }
function rowId(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) badQuery();
  return Number(value);
}
function queryInput(query: Record<string, string>): SharedProfileQuery {
  const sort = query.sort ?? 'newest';
  if (sort !== 'newest' && sort !== 'uses' && sort !== 'likes') badQuery();
  const page = query.page === undefined ? 1 : rowId(query.page);
  if (!Number.isSafeInteger((page - 1) * 20)) badQuery();
  if (query.job_id === undefined) return { sort, page };
  if (!/^[0-9]+$/u.test(query.job_id)) badQuery();
  const jobId = Number(query.job_id);
  if (!Number.isSafeInteger(jobId) || jobId > 4294967295) badQuery();
  return { sort, page, job_id: jobId };
}
function copyInput(body: Record<string, unknown>) {
  const values = [body.aid, body.cid, body.nid];
  if (values.some((value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 4294967295)
    || typeof body.request_id !== 'string') throw new KeFailure('KE_BAD_REQUEST', 400, '复制请求参数无效');
  return { aid: body.aid as number, cid: body.cid as number, nid: body.nid as number, request_id: body.request_id };
}

export function registerSharedProfileRoutes(app: Hono<any>, options: SharedRouteOptions): void {
  // These routes share the account setup with the editor, without KE license or email-verification gates.
  const handle = (write: boolean, work: (c: any, handlers: SharedRouteContext, userId: string) => Promise<Response>) => async (c: any) => {
    const handlers = options.setup();
    if (!handlers) return options.unavailable(c);
    try {
      if (write) assertTrustedWriteOrigin(c.req.raw, handlers.authConfig);
      const identity = await createSessionService(handlers.authRepository, handlers.authConfig, options.runtime).authenticate(c.req.raw);
      return await work(c, handlers, identity.userId);
    } catch (error) {
      return options.failure(c, error);
    }
  };
  const limit = (handlers: SharedRouteContext, userId: string, rule: typeof HALL_RATE_LIMITS[keyof typeof HALL_RATE_LIMITS]) =>
    options.rateLimit(handlers, { kind: 'action', value: `user:${userId}` }, rule, options.runtime.now);

  app.get('/api/v1/ke/shared-profiles', handle(false, async (c, handlers, userId) =>
    c.json(await handlers.sharedProfileService.list(userId, queryInput(c.req.query())), 200, { 'cache-control': 'no-store' })));
  app.get('/api/v1/ke/shared-profiles/code/:code', handle(false, async (c, handlers, userId) =>
    c.json(await handlers.sharedProfileService.getByCode(userId, c.req.param('code')), 200, { 'cache-control': 'no-store' })));
  app.get('/api/v1/ke/shared-profiles/:id', handle(false, async (c, handlers, userId) =>
    c.json(await handlers.sharedProfileService.getById(userId, rowId(c.req.param('id'))), 200, { 'cache-control': 'no-store' })));
  app.delete('/api/v1/ke/shared-profiles/:id/withdraw', handle(true, async (c, handlers, userId) => {
    const id = rowId(c.req.param('id'));
    await limit(handlers, userId, HALL_RATE_LIMITS.share);
    await handlers.sharedProfileService.withdrawById(userId, id);
    return c.newResponse(null, 204, { 'cache-control': 'no-store' });
  }));

  for (const [method, liked] of [['put', true], ['delete', false]] as const) {
    app[method]('/api/v1/ke/shared-profiles/:id/like', handle(true, async (c, handlers, userId) => {
      const id = rowId(c.req.param('id'));
      await limit(handlers, userId, HALL_RATE_LIMITS.like);
      return c.json(await handlers.sharedProfileService.setLike(userId, id, liked), 200, { 'cache-control': 'no-store' });
    }));
  }
  app.post('/api/v1/ke/shared-profiles/:id/copy', handle(true, async (c, handlers, userId) => {
    const id = rowId(c.req.param('id'));
    const input = copyInput(await options.readJson(c.req.raw, 8 * 1024));
    await limit(handlers, userId, HALL_RATE_LIMITS.copy);
    const result = await handlers.sharedProfileService.copy(userId, id, input);
    return c.json(result, result.duplicate ? 200 : 201, { 'cache-control': 'no-store' });
  }));
  app.delete('/api/v1/ke/profiles/:id/sharing', handle(true, async (c, handlers, userId) => {
    const id = rowId(c.req.param('id'));
    await limit(handlers, userId, HALL_RATE_LIMITS.share);
    await handlers.sharedProfileService.withdraw(userId, id);
    return c.newResponse(null, 204, { 'cache-control': 'no-store' });
  }));
}
