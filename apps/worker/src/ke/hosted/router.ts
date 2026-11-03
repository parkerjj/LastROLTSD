/**
 * 托管（离线挂机）的 HTTP 层。
 *
 * - 面板（网页，会话 cookie）：/api/v1/ke/hosted…，写操作校验 Origin；创建需要重新输入账号密码（I2）。
 * - agent（请求签名，不走 cookie/Bearer）：/api/v1/ke/agent…，直连 origin.ltsd.ro，没有反代层防护，所以自己鉴权。
 */
import type { Hono } from 'hono';
import { readAuthJson } from '../../auth/body';
import { assertTrustedWriteOrigin } from '../../auth/csrf';
import { verifyPassword } from '../../auth/crypto';
import { normalizeEmail } from '../../auth/input';
import { createSessionService } from '../../auth/session-service';
import type { AuthRuntime, EnabledAuthConfig } from '../../auth/types';
import { AuthFailure } from '../../auth/types';
import type { createAuthRepository } from '../../auth/repository';
import type { KeConfig } from '../config';
import { base64UrlDecode } from '../crypto';
import { KeFailure } from '../types';
import type { HostedRepository } from './repository';
import { createHostedService, type CreateHostedInput, type HostedService, type LeaseInput, type ReportInput } from './service';

const JSON_LIMIT = 8 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const AGENT_BODY_LIMIT = 16 * 1024;

const HOSTED_RATE_LIMITS = {
  create: { scope: 'ke_hosted_create', limit: 20, windowMs: HOUR_MS },
  // 启停对游戏服等于“登录”：无粘性分配会换 VPS/换出口 IP，限制频率防止制造登录风暴（6A 的 I17）。
  control: { scope: 'ke_hosted_control', limit: 30, windowMs: HOUR_MS },
} as const;

export interface HostedRouterDeps {
  setup(): { authConfig: EnabledAuthConfig; authRepository: ReturnType<typeof createAuthRepository> } | null;
  licenseSetup(): Promise<{ authConfig: EnabledAuthConfig; authRepository: ReturnType<typeof createAuthRepository>; keConfig: KeConfig } | null>;
  repository(): HostedRepository | null;
  runtime: AuthRuntime;
  rateLimit(
    handlers: { authConfig: EnabledAuthConfig; authRepository: ReturnType<typeof createAuthRepository> },
    subject: { kind: 'session' | 'action' | 'ip'; value: string },
    rule: { scope: string; limit: number; windowMs: number },
    now: () => number,
  ): Promise<void>;
  failure(c: unknown, error: unknown): Response;
  unavailable(c: unknown): Response;
  /** 即时推送：通知这些 agent 立刻对账（失败不影响主流程；DO 未启用时为空实现）。 */
  notify?(agentIds: readonly string[]): Promise<void>;
  log?(event: string, detail: Record<string, unknown>): void;
}

function badRequest(): KeFailure {
  return new KeFailure('KE_BAD_REQUEST', 400, '请求字段无效');
}

function intField(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw badRequest();
  return value;
}

function textField(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) throw badRequest();
  if (new TextEncoder().encode(value).byteLength > maxBytes) throw badRequest();
  return value;
}

export function parseCreateInput(body: Record<string, unknown>): CreateHostedInput {
  return {
    nid: intField(body.nid, 0, 4294967295),
    aid: intField(body.aid, 1, 4294967295),
    cid: intField(body.cid, 1, 4294967295),
    charName: textField(body.char_name, 64),
    gameAccount: textField(body.game_account, 128),
    gamePassword: textField(body.game_password, 128),
  };
}

export function parseLeaseInput(body: Record<string, unknown>): LeaseInput {
  const instances: LeaseInput['instances'] = [];
  if (body.instances !== undefined) {
    if (!Array.isArray(body.instances) || body.instances.length > 128) throw badRequest();
    for (const item of body.instances) {
      if (typeof item !== 'object' || item === null) throw badRequest();
      const entry = item as Record<string, unknown>;
      instances.push({
        id: textField(entry.id, 36),
        epoch: intField(entry.epoch, 0, Number.MAX_SAFE_INTEGER),
        phase: textField(entry.phase, 16),
        retryAt: entry.retry_at === undefined || entry.retry_at === null ? null : intField(entry.retry_at, 0, Number.MAX_SAFE_INTEGER),
      });
    }
  }
  const capacity = (typeof body.capacity === 'object' && body.capacity !== null ? body.capacity : {}) as Record<string, unknown>;
  return {
    version: typeof body.agent_version === 'string' && body.agent_version.length <= 32 ? body.agent_version : null,
    packageId: typeof body.package_id === 'string' && body.package_id.length <= 80 ? body.package_id : null,
    memAvailableMb: capacity.mem_available_mb === undefined ? null : intField(capacity.mem_available_mb, 0, 10_000_000),
    cleanSlate: body.clean_slate === true,
    instances,
  };
}

const REPORT_PHASES = ['starting', 'running', 'backoff', 'stopping', 'stopped', 'error'] as const;

export function parseReportInput(body: Record<string, unknown>): ReportInput {
  const phase = REPORT_PHASES.find((candidate) => candidate === body.phase);
  if (phase === undefined) throw badRequest();
  return {
    epoch: intField(body.epoch, 0, Number.MAX_SAFE_INTEGER),
    phase,
    retryAt: body.retry_at === undefined || body.retry_at === null ? null : intField(body.retry_at, 0, Number.MAX_SAFE_INTEGER),
  };
}

function parseInstanceParam(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) throw badRequest();
  return value.toLowerCase();
}

async function readBodyBytes(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > AGENT_BODY_LIMIT) throw new KeFailure('KE_BAD_REQUEST', 413, '请求体过大');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > AGENT_BODY_LIMIT) throw new KeFailure('KE_BAD_REQUEST', 413, '请求体过大');
  return bytes;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength === 0) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw badRequest();
}

export function registerHostedRoutes(app: Hono<any>, deps: HostedRouterDeps): void {
  const notify = async (agentIds: readonly string[]): Promise<void> => {
    if (!deps.notify || agentIds.length === 0) return;
    try {
      await deps.notify(agentIds);
    } catch (error) {
      deps.log?.('hosted.notify_failed', { error: String(error) });
    }
  };

  const serviceFor = async (): Promise<{ service: HostedService; handlers: NonNullable<Awaited<ReturnType<HostedRouterDeps['licenseSetup']>>> } | null> => {
    const handlers = await deps.licenseSetup();
    const repository = deps.repository();
    if (!handlers || !repository) return null;
    return { service: createHostedService(repository, handlers.keConfig, deps.runtime.now, deps.log), handlers };
  };

  const sessionUser = async (handlers: NonNullable<ReturnType<HostedRouterDeps['setup']>>, request: Request) =>
    createSessionService(handlers.authRepository, handlers.authConfig, deps.runtime).authenticate(request);

  // —— 面板（cookie）——
  app.get('/api/v1/ke/hosted', async (c: any) => {
    const ctx = await serviceFor();
    if (!ctx) return deps.unavailable(c);
    try {
      const identity = await sessionUser(ctx.handlers, c.req.raw);
      const [eligibility, items] = await Promise.all([ctx.service.eligibility(identity.userId), ctx.service.list(identity.userId)]);
      return c.json({ eligibility, items }, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return deps.failure(c, error);
    }
  });

  app.post('/api/v1/ke/hosted', async (c: any) => {
    const ctx = await serviceFor();
    if (!ctx) return deps.unavailable(c);
    try {
      assertTrustedWriteOrigin(c.req.raw, ctx.handlers.authConfig);
      const identity = await sessionUser(ctx.handlers, c.req.raw);
      const body = await readAuthJson(c.req.raw, JSON_LIMIT).catch((error: unknown) => {
        if (error instanceof AuthFailure) throw new KeFailure('KE_BAD_REQUEST', error.status, error.publicMessage);
        throw error;
      });
      await deps.rateLimit(ctx.handlers, { kind: 'session', value: identity.sessionToken }, HOSTED_RATE_LIMITS.create, deps.runtime.now);
      // I2：创建/修改凭据要重新输入账号密码——被盗会话不能批量登记别人的游戏账号。
      const profile = await ctx.handlers.authRepository.readProfile(identity.userId);
      const snapshot = profile ? await ctx.handlers.authRepository.readCredentialByEmail(normalizeEmail(profile.email).normalized) : null;
      const password = typeof body.current_password === 'string' ? body.current_password : '';
      if (!snapshot || snapshot.userId !== identity.userId || password === '' || !await verifyPassword(password, snapshot, ctx.handlers.authConfig)) {
        throw new KeFailure('KE_AUTH_FORBIDDEN', 403, '账号密码不正确');
      }
      const result = await ctx.service.create(identity.userId, parseCreateInput(body));
      return c.json(result, 201, { 'cache-control': 'no-store' });
    } catch (error) {
      return deps.failure(c, error);
    }
  });

  for (const action of ['start', 'stop'] as const) {
    app.post(`/api/v1/ke/hosted/:id/${action}`, async (c: any) => {
      const ctx = await serviceFor();
      if (!ctx) return deps.unavailable(c);
      try {
        assertTrustedWriteOrigin(c.req.raw, ctx.handlers.authConfig);
        const identity = await sessionUser(ctx.handlers, c.req.raw);
        await deps.rateLimit(ctx.handlers, { kind: 'session', value: identity.sessionToken }, HOSTED_RATE_LIMITS.control, deps.runtime.now);
        const result = await ctx.service[action](identity.userId, parseInstanceParam(c.req.param('id')));
        await notify(result.notify);
        return c.newResponse(null, 204, { 'cache-control': 'no-store' });
      } catch (error) {
        return deps.failure(c, error);
      }
    });
  }

  app.delete('/api/v1/ke/hosted/:id', async (c: any) => {
    const ctx = await serviceFor();
    if (!ctx) return deps.unavailable(c);
    try {
      assertTrustedWriteOrigin(c.req.raw, ctx.handlers.authConfig);
      const identity = await sessionUser(ctx.handlers, c.req.raw);
      await ctx.service.remove(identity.userId, parseInstanceParam(c.req.param('id')));
      return c.newResponse(null, 204, { 'cache-control': 'no-store' });
    } catch (error) {
      return deps.failure(c, error);
    }
  });

  // —— agent（请求签名）——
  const agentRoute = (
    method: 'post',
    path: string,
    handler: (service: HostedService, agent: Awaited<ReturnType<HostedService['authenticateAgent']>>, c: any, body: Record<string, unknown>) => Promise<Response>,
  ): void => {
    app[method](path, async (c: any) => {
      const ctx = await serviceFor();
      if (!ctx) return deps.unavailable(c);
      try {
        const bytes = await readBodyBytes(c.req.raw);
        const url = new URL(c.req.url);
        const agent = await ctx.service.authenticateAgent({
          headers: c.req.raw.headers,
          method: c.req.method,
          pathAndQuery: `${url.pathname}${url.search}`,
          body: bytes,
        });
        return await handler(ctx.service, agent, c, parseJsonObject(bytes));
      } catch (error) {
        return deps.failure(c, error);
      }
    });
  };

  agentRoute('post', '/api/v1/ke/agent/lease', async (service, agent, c, body) =>
    c.json(await service.lease(agent, parseLeaseInput(body)), 200, { 'cache-control': 'no-store' }));

  agentRoute('post', '/api/v1/ke/agent/instances/:id/launch', async (service, agent, c, body) =>
    c.json(await service.launch(agent, parseInstanceParam(c.req.param('id')), intField(body.epoch, 0, Number.MAX_SAFE_INTEGER)), 200, { 'cache-control': 'no-store' }));

  agentRoute('post', '/api/v1/ke/agent/instances/:id/token', async (service, agent, c, body) =>
    c.json(await service.refreshToken(agent, parseInstanceParam(c.req.param('id')), intField(body.epoch, 0, Number.MAX_SAFE_INTEGER)), 200, { 'cache-control': 'no-store' }));

  agentRoute('post', '/api/v1/ke/agent/instances/:id/report', async (service, agent, c, body) => {
    const result = await service.report(agent, parseInstanceParam(c.req.param('id')), parseReportInput(body));
    await notify(result.notify);
    return c.newResponse(null, 204, { 'cache-control': 'no-store' });
  });

  agentRoute('post', '/api/v1/ke/agent/modules/keys', async (service, agent, c, body) => {
    if (!Array.isArray(body.modules) || body.modules.length < 1 || body.modules.length > 2 || typeof body.ke_pub !== 'string') throw badRequest();
    let kePublicKey: Uint8Array;
    try {
      kePublicKey = base64UrlDecode(body.ke_pub);
    } catch {
      throw badRequest();
    }
    return c.json(await service.moduleKeys(agent, { modules: body.modules.map(String), kePublicKey }), 200, { 'cache-control': 'no-store' });
  });
}
