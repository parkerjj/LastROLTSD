import type { Hono } from 'hono';
import { readAuthJson } from '../auth/body';
import { AuthFailure, type AuthIdentity } from '../auth/types';
import { jsonError, requestId } from '../middleware/errors';
import { logError } from '../observability';
import type { AdminService } from './service';
import type { TransferRequest, TransferService } from './transfer-service';
import { AdminFailure } from './types';

const BODY_LIMIT_BYTES = 16 * 1024;
const NO_STORE = { 'cache-control': 'no-store' } as const;

export interface AdminAuthServices {
  /** 校验会话 Cookie，未登录抛 AuthFailure(401)。 */
  authenticate(request: Request): Promise<AuthIdentity & { userId: string }>;
  /** 校验会话 CSRF（含 Origin），失败抛 AuthFailure(403)。 */
  assertSession(request: Request, identity: AuthIdentity): Promise<void>;
  /** 强制改密（见 auth/action-service 的 adminSetPassword）。 */
  setPassword(actorId: string, targetUserId: string, newPassword: string, requestId: string): Promise<void>;
}

interface Actor {
  id: number;
  userId: string;
}

function badRequest(message = '请求字段无效'): AdminFailure {
  return new AdminFailure('ADMIN_BAD_REQUEST', 400, message);
}

function idParam(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d{0,15}$/u.test(value)) throw badRequest();
  return Number(value);
}

const UINT32_MAX = 4_294_967_295;

function uint32(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > UINT32_MAX) throw badRequest();
  return value;
}

// 查询串里的 aid/cid/nid：纯数字字符串，范围同 uint32。
function queryUint32(value: string | undefined): number {
  if (value === undefined || !/^\d{1,10}$/u.test(value)) throw badRequest();
  return uint32(Number(value));
}

function accountText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 254) throw badRequest();
  return value;
}

/**
 * 管理员后台接口（/api/v1/admin/*）。顺序固定：先确认登录，再确认是管理员（不是 → 404，不暴露后台的存在），
 * 最后才对写操作校验 CSRF——这样普通用户永远只会看到 404。
 */
export function registerAdminAccountRoutes(app: Hono<any>, service: AdminService, auth: AdminAuthServices | null, transfer: TransferService | null = null): void {
  async function guarded(request: Request, write: boolean, work: (actor: Actor, id: string) => Promise<Response>): Promise<Response> {
    const id = requestId(request);
    if (!auth) return jsonError('auth_unavailable', '账号服务暂不可用', 503, id);
    try {
      const identity = await auth.authenticate(request);
      const actor = { id: Number(identity.userId), userId: identity.userId };
      await service.assertAdmin(actor.id);
      if (write) await auth.assertSession(request, identity);
      return await work(actor, id);
    } catch (error) {
      if (error instanceof AuthFailure) return jsonError(error.code, error.publicMessage, error.status, id);
      if (error instanceof AdminFailure) return jsonError(error.code, error.publicMessage, error.status, id);
      logError('lastroweb.admin_error', error, { request_id: id });
      return jsonError('internal_error', 'Internal Server Error', 500, id);
    }
  }

  const reply = (data: unknown, status: 200 | 201 = 200): Response => new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE },
  });

  app.get('/api/v1/admin/users', (c) => guarded(c.req.raw, false, async () => (
    reply({ users: await service.searchUsers(c.req.query('q') ?? '') })
  )));

  app.get('/api/v1/admin/users/:id', (c) => guarded(c.req.raw, false, async () => (
    reply(await service.getUser(idParam(c.req.param('id'))))
  )));

  app.post('/api/v1/admin/users/:id/entitlements', (c) => guarded(c.req.raw, true, async (actor, id) => {
    const target = idParam(c.req.param('id'));
    const body = await readAuthJson(c.req.raw, BODY_LIMIT_BYTES);
    return reply(await service.adjustEntitlement(actor.id, target, body, id), 201);
  }));

  app.patch('/api/v1/admin/entitlements/:id', (c) => guarded(c.req.raw, true, async (actor, id) => {
    const entitlementId = idParam(c.req.param('id'));
    const body = await readAuthJson(c.req.raw, BODY_LIMIT_BYTES);
    await service.editEntitlement(actor.id, entitlementId, body, id);
    return reply({ ok: true });
  }));

  app.post('/api/v1/admin/users/:id/password', (c) => guarded(c.req.raw, true, async (actor, id) => {
    const target = idParam(c.req.param('id'));
    const body = await readAuthJson(c.req.raw, BODY_LIMIT_BYTES);
    if (Object.keys(body).some((key) => key !== 'new_password') || typeof body.new_password !== 'string') throw badRequest();
    await auth!.setPassword(actor.userId, String(target), body.new_password, id);
    return reply({ ok: true });
  }));

  app.delete('/api/v1/admin/guestbook/entries/:id', (c) => guarded(c.req.raw, true, async (actor, id) => (
    reply(await service.deleteGuestbookEntry(actor.id, idParam(c.req.param('id')), id))
  )));

  app.delete('/api/v1/admin/guestbook/replies/:id', (c) => guarded(c.req.raw, true, async (actor, id) => {
    await service.deleteGuestbookReply(actor.id, idParam(c.req.param('id')), id);
    return reply({ ok: true });
  }));

  // 角色转移：路由始终注册；服务缺失时在确认是管理员之后才返回 503。
  const unavailable = (id: string): Response => jsonError('auth_unavailable', '账号服务暂不可用', 503, id);

  app.get('/api/v1/admin/transfer/characters', (c) => guarded(c.req.raw, false, async (_actor, id) => {
    if (!transfer) return unavailable(id);
    return reply(await transfer.listCharacters(accountText(c.req.query('account'))));
  }));

  app.get('/api/v1/admin/transfer/preview', (c) => guarded(c.req.raw, false, async (_actor, id) => {
    if (!transfer) return unavailable(id);
    const request: TransferRequest = {
      source: accountText(c.req.query('source')), target: accountText(c.req.query('target')),
      aid: queryUint32(c.req.query('aid')), cid: queryUint32(c.req.query('cid')), nid: queryUint32(c.req.query('nid')),
    };
    return reply(await transfer.preview(request));
  }));

  app.post('/api/v1/admin/transfer', (c) => guarded(c.req.raw, true, async (actor, id) => {
    if (!transfer) return unavailable(id);
    const body = await readAuthJson(c.req.raw, BODY_LIMIT_BYTES);
    const keys = ['source', 'target', 'aid', 'cid', 'nid', 'note'];
    if (Object.keys(body).some((key) => !keys.includes(key)) || typeof body.note !== 'string') throw badRequest();
    const request = {
      source: accountText(body.source), target: accountText(body.target),
      aid: uint32(body.aid), cid: uint32(body.cid), nid: uint32(body.nid), note: body.note,
    };
    return reply(await transfer.confirm(actor.id, request, id));
  }));

  app.get('/api/v1/admin/audit', (c) => guarded(c.req.raw, false, async () => {
    const before = c.req.query('before');
    return reply({ entries: await service.listAudit(before === undefined ? null : idParam(before)) });
  }));
}
