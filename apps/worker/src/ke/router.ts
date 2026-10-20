import type { Hono } from 'hono';
import type { MysqlDatabase } from '../db/mysql-client';
import type { AppEnv } from '../env';
import { jsonError, requestId } from '../middleware/errors';
import { readAuthJson } from '../auth/body';
import { resolveAuthConfig } from '../auth/config';
import { createAuthRepository } from '../auth/repository';
import { createSessionService } from '../auth/session-service';
import { assertTrustedWriteOrigin } from '../auth/csrf';
import { trustedAuthClientIp, authRateLimitKey, consumeAuthRateLimit } from '../auth/rate-limit';
import { AuthFailure, type AuthRuntime, type EnabledAuthConfig } from '../auth/types';
import { resolveKeConfig, type KeConfig } from './config';
import { base64UrlDecode, sha256 } from './crypto';
import { createKeRepository, type KeRepository } from './repository';
import { createKeService, type Attestation, type BindInput, type StartInput } from './service';
import { createProfileRepository, type ProfileInput, type ProfileRepository } from './profile-repository';
import { createProfileService } from './profile-service';
import { createTokenRepository, type TokenRepository } from './token-repository';
import { createTokenService } from './token-service';
import { KeFailure, type CharacterReport, type KeLicenseMode } from './types';

const GENERAL_JSON_LIMIT = 8 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const encoder = new TextEncoder();

const KE_RATE_LIMITS = {
  bindPerSession: { scope: 'ke_bind_session', limit: 60, windowMs: HOUR_MS },
  startPerSession: { scope: 'ke_start_session', limit: 60, windowMs: HOUR_MS },
  deviceCodePerIp: { scope: 'ke_device_code_ip', limit: 10, windowMs: HOUR_MS },
  // 查询 + 决定共用：限制已登录账号对验证码的枚举/猜测。
  devicePerSession: { scope: 'ke_device_session', limit: 20, windowMs: 15 * 60 * 1000 },
} as const;

function jsonFailure(c: any, code: string, message: string, status: number, details?: Record<string, unknown>): Response {
  const id = typeof c.get === 'function' ? c.get('requestId') : requestId(c.req.raw);
  // jsonError 只支持 retryable/action 两个附加字段；结构化详情（如 active_instances）以 JSON 字符串放进 action，
  // KE 客户端按约定 JSON.parse(error.action) 读取。此契约需与 KE 端钉死。
  return jsonError(code, message, status, id, details === undefined ? {} : { action: JSON.stringify(details) });
}

function unavailable(c: any): Response {
  return jsonFailure(c, 'KE_UNAVAILABLE', '授权服务暂不可用', 503);
}

function routeFailure(c: any, error: unknown): Response {
  if (error instanceof KeFailure) return jsonFailure(c, error.code, error.publicMessage, error.status, error.details);
  if (error instanceof AuthFailure) {
    if (error.status === 401) return jsonFailure(c, 'KE_AUTH_UNAUTHENTICATED', error.publicMessage, 401);
    if (error.status === 403) return jsonFailure(c, 'KE_AUTH_FORBIDDEN', error.publicMessage, 403);
    return jsonFailure(c, 'KE_BAD_REQUEST', error.publicMessage, error.status);
  }
  return unavailable(c);
}

async function readKeJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  try {
    return await readAuthJson(request, maxBytes);
  } catch (error) {
    if (error instanceof AuthFailure) throw new KeFailure('KE_BAD_REQUEST', error.status, error.publicMessage);
    throw error;
  }
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 4294967295 ? value : null;
}

function parseInstanceId(value: unknown): string {
  // instance_id 是 KE 启动时生成的 128-bit 随机值，按 UUID 格式要求，避免客户端自报可预测值削弱反重放/绑定。
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    throw new KeFailure('KE_BAD_REQUEST', 400, '请求字段无效');
  }
  return value;
}

function parseCharacterReport(body: Record<string, unknown>): CharacterReport {
  const aid = positiveInt(body.aid);
  const cid = positiveInt(body.cid);
  const nid = positiveInt(body.nid);
  if (aid === null || cid === null || nid === null) throw new KeFailure('KE_BAD_REQUEST', 400, '请求字段无效');
  return {
    aid,
    cid,
    nid,
    char_name: typeof body.char_name === 'string' ? body.char_name.slice(0, 64) : '',
    base_level: positiveInt(body.base_level),
    job_level: positiveInt(body.job_level),
    job_id: positiveInt(body.job_id),
    map_name: typeof body.map_name === 'string' && body.map_name.length <= 64 ? body.map_name : null,
  };
}

/** 缺省按 auto（旧客户端不带 mode）；出现但不是 auto/manual 视为非法请求。 */
function parseLicenseMode(value: unknown): KeLicenseMode {
  if (value === undefined || value === 'auto') return 'auto';
  if (value === 'manual') return 'manual';
  throw new KeFailure('KE_BAD_REQUEST', 400, '请求字段无效');
}

function parseBuildId(body: Record<string, unknown>): string | null {
  return typeof body.build_id === 'string' && body.build_id.length > 0 && body.build_id.length <= 64 ? body.build_id : null;
}

function parseBuildHash(body: Record<string, unknown>): string | null {
  return typeof body.build_hash === 'string' && /^[0-9a-f]{64}$/iu.test(body.build_hash) ? body.build_hash.toLowerCase() : null;
}

function parsePublicKey(body: Record<string, unknown>): Uint8Array | null {
  if (typeof body.ke_pub !== 'string') return null;
  try {
    const bytes = base64UrlDecode(body.ke_pub);
    return bytes.byteLength === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function parseProfileInput(body: Record<string, unknown>): ProfileInput {
  return {
    name: typeof body.name === 'string' ? body.name : '',
    config_text: typeof body.config_text === 'string' ? body.config_text : '',
    mon_control: typeof body.mon_control === 'string' ? body.mon_control : null,
    pickupitems: typeof body.pickupitems === 'string' ? body.pickupitems : null,
    items_control: typeof body.items_control === 'string' ? body.items_control : null,
    timeouts: typeof body.timeouts === 'string' ? body.timeouts : null,
  };
}

function parseQueryPositive(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 4294967295 ? parsed : null;
}

function parseCharacterQuery(c: any): { aid: number; cid: number; nid: number } {
  const aid = parseQueryPositive(c.req.query('aid'));
  const cid = parseQueryPositive(c.req.query('cid'));
  const nid = parseQueryPositive(c.req.query('nid'));
  if (aid === null || cid === null || nid === null) throw new KeFailure('KE_BAD_REQUEST', 400, '请求字段无效');
  return { aid, cid, nid };
}

function parseRowId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new KeFailure('KE_BAD_REQUEST', 400, '请求字段无效');
  return id;
}

async function clientHashes(request: Request, env: AppEnv): Promise<{ ipHash: Uint8Array; uaHash: Uint8Array }> {
  const ip = trustedAuthClientIp(request, env.ENVIRONMENT);
  const ua = request.headers.get('user-agent') ?? '';
  const [ipHash, uaHash] = await Promise.all([sha256(encoder.encode(ip)), sha256(encoder.encode(ua))]);
  return { ipHash, uaHash };
}

async function attestation(request: Request, env: AppEnv, body: Record<string, unknown>): Promise<Attestation> {
  return {
    buildId: parseBuildId(body),
    buildHash: parseBuildHash(body),
    ...(await clientHashes(request, env)),
  };
}

/** 限流主体：会话 cookie（网页）、KE token（以 token id 区分，不把 token 本身喂进去）或来源 IP（匿名接口）。 */
type RateSubject = { kind: 'session' | 'action' | 'ip'; value: string };

async function assertKeRateLimit(
  handlers: { authConfig: EnabledAuthConfig; authRepository: ReturnType<typeof createAuthRepository> },
  subject: RateSubject,
  rule: { scope: string; limit: number; windowMs: number },
  now: () => number,
): Promise<void> {
  const keyDigest = await authRateLimitKey(handlers.authConfig.rateSecret, subject.kind, subject.value);
  const result = await consumeAuthRateLimit(handlers.authRepository, [
    { kind: 'window', scope: rule.scope, keyDigest, limit: rule.limit, windowMs: rule.windowMs },
  ], now);
  if (!result.allowed) {
    throw new KeFailure('KE_RATE_LIMITED', 429, '请求过于频繁，请稍后重试', { retry_after: result.retryAfter });
  }
}

export function registerKeRoutes(app: Hono<any>, env: AppEnv, database?: MysqlDatabase, runtime?: AuthRuntime): void {
  const authRuntime = runtime ?? { now: () => Date.now(), fetch: globalThis.fetch };
  let authRepository: ReturnType<typeof createAuthRepository> | null = null;
  let keRepository: KeRepository | null = null;
  let profileRepository: ProfileRepository | null = null;
  let tokenRepository: TokenRepository | null = null;
  let authConfig: EnabledAuthConfig | null | undefined;
  let keConfig: KeConfig | null = null;
  let keConfigResolved = false;

  const setup = (): { authConfig: EnabledAuthConfig; authRepository: ReturnType<typeof createAuthRepository>; keRepository: KeRepository; profileRepository: ProfileRepository; tokenRepository: TokenRepository } | null => {
    if (database === undefined) return null;
    if (authConfig === undefined) {
      try {
        const candidate = resolveAuthConfig(env);
        authConfig = candidate.enabled ? candidate : null;
      } catch {
        authConfig = null;
      }
    }
    if (authConfig === null) return null;
    if (authRepository === null) {
      authRepository = createAuthRepository(database, { mailDailyLimit: authConfig.mailDailyLimit, mailMonthlyLimit: authConfig.mailMonthlyLimit });
    }
    if (keRepository === null) keRepository = createKeRepository(database);
    if (profileRepository === null) profileRepository = createProfileRepository(database);
    if (tokenRepository === null) tokenRepository = createTokenRepository(database);
    return { authConfig, authRepository, keRepository, profileRepository, tokenRepository };
  };

  // 仅授权端点（bind/start/heartbeat/stop）依赖 license 私钥与 K_core；Profile/角色列表只依赖账号体系，
  // 因此 KE 密钥未配置或配置有误时，配置编辑器仍可使用。
  const licenseSetup = (): (NonNullable<ReturnType<typeof setup>> & { keConfig: KeConfig }) | null => {
    const handlers = setup();
    if (!handlers) return null;
    if (!keConfigResolved) {
      keConfigResolved = true;
      try {
        keConfig = resolveKeConfig(env, handlers.authConfig);
      } catch {
        keConfig = null;
      }
    }
    return keConfig === null ? null : { ...handlers, keConfig };
  };

  const tokenService = (handlers: NonNullable<ReturnType<typeof setup>>) =>
    createTokenService(handlers.tokenRepository, { siteUrl: handlers.authConfig.authSiteUrl }, authRuntime.now);
  const bearerIdentity = (handlers: NonNullable<ReturnType<typeof setup>>, request: Request) =>
    tokenService(handlers).authenticate(request.headers.get('authorization'));
  const tokenSubject = (identity: { tokenId: number }): RateSubject => ({ kind: 'action', value: `ke-token:${identity.tokenId}` });

  // 认证模型：
  // - KE 运行在 IWA（isolated-app://…），与站点跨站，拿不到会话 cookie，只用 `Authorization: Bearer ke1_…`。
  //   这些端点（bind / start / heartbeat / stop、profiles/active、me、token/revoke）**不接受 cookie**，因此没有 CSRF 面，
  //   也不能（不应）校验站点 Origin。CORS 的 allow-origin 是 `*`，Bearer 不属于「凭据」，不受该限制。
  // - /ke 网页编辑器与设备授权页与站点同源，用会话 cookie：带 JSON body 的接口要求 application/json，
  //   PUT/DELETE 不在 CORS 允许的方法内；无 body 的写操作以及设备授权的决定，额外校验 Origin（assertTrustedWriteOrigin），
  //   补上 SameSite=Lax 拦不住的同站其他来源（兄弟子域）。
  app.post('/api/v1/ke/instances/bind', async (c: any) => {
    const handlers = licenseSetup();
    if (!handlers) return unavailable(c);
    try {
      const identity = await bearerIdentity(handlers, c.req.raw);
      const body = await readKeJson(c.req.raw, GENERAL_JSON_LIMIT);
      await assertKeRateLimit(handlers, tokenSubject(identity), KE_RATE_LIMITS.bindPerSession, authRuntime.now);
      const input: BindInput = {
        instanceId: parseInstanceId(body.instance_id),
        report: parseCharacterReport(body),
        needWasmKey: body.need_wasm_key === true,
        kePublicKey: parsePublicKey(body),
        ...(await attestation(c.req.raw, env, body)),
      };
      const result = await createKeService(handlers.keRepository, handlers.keConfig, authRuntime.now).bind(identity.userId, input);
      return c.json(result, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/ke/instances/:id/start', async (c: any) => {
    const handlers = licenseSetup();
    if (!handlers) return unavailable(c);
    try {
      const identity = await bearerIdentity(handlers, c.req.raw);
      const body = await readKeJson(c.req.raw, GENERAL_JSON_LIMIT);
      await assertKeRateLimit(handlers, tokenSubject(identity), KE_RATE_LIMITS.startPerSession, authRuntime.now);
      const input: StartInput = {
        instanceId: parseInstanceId(c.req.param('id')),
        kickInstanceId: typeof body.kick_instance_id === 'string' && body.kick_instance_id.length > 0 && body.kick_instance_id.length <= 36 ? body.kick_instance_id : null,
        mode: parseLicenseMode(body.mode),
        report: parseCharacterReport(body),
        needWasmKey: body.need_wasm_key === true,
        kePublicKey: parsePublicKey(body),
        ...(await attestation(c.req.raw, env, body)),
      };
      const result = await createKeService(handlers.keRepository, handlers.keConfig, authRuntime.now).start(identity.userId, input);
      return c.json(result, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/ke/instances/:id/heartbeat', async (c: any) => {
    const handlers = licenseSetup();
    if (!handlers) return unavailable(c);
    try {
      const identity = await bearerIdentity(handlers, c.req.raw);
      const body = await readKeJson(c.req.raw, GENERAL_JSON_LIMIT);
      const ts = typeof body.ts === 'number' && Number.isSafeInteger(body.ts) ? body.ts : 0;
      const result = await createKeService(handlers.keRepository, handlers.keConfig, authRuntime.now).heartbeat(
        identity.userId,
        parseInstanceId(c.req.param('id')),
        parseCharacterReport(body),
        ts,
        await attestation(c.req.raw, env, body),
      );
      return c.json(result, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/ke/instances/:id/stop', async (c: any) => {
    const handlers = licenseSetup();
    if (!handlers) return unavailable(c);
    try {
      const identity = await bearerIdentity(handlers, c.req.raw);
      await createKeService(handlers.keRepository, handlers.keConfig, authRuntime.now).stop(identity.userId, parseInstanceId(c.req.param('id')));
      return c.newResponse(null, 204, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  // —— KE 自身：账号信息与退出登录（Bearer）——
  app.get('/api/v1/ke/me', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      const identity = await bearerIdentity(handlers, c.req.raw);
      const profile = await handlers.authRepository.readProfile(identity.userId);
      if (!profile) throw new KeFailure('KE_AUTH_UNAUTHENTICATED', 401, '请先登录');
      return c.json({ user: { id: profile.id, display_name: profile.display_name } }, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/ke/token/revoke', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      const identity = await bearerIdentity(handlers, c.req.raw);
      await tokenService(handlers).revoke(identity.userId, identity.tokenId);
      return c.newResponse(null, 204, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  // —— 设备授权（KE 登录 LTSD）：匿名发起 + 匿名轮询；用户在网页（cookie）核对验证码并决定 ——
  app.post('/api/v1/ke/device/code', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      const body = await readKeJson(c.req.raw, GENERAL_JSON_LIMIT);
      await assertKeRateLimit(handlers, { kind: 'ip', value: trustedAuthClientIp(c.req.raw, env.ENVIRONMENT) }, KE_RATE_LIMITS.deviceCodePerIp, authRuntime.now);
      const result = await tokenService(handlers).createDeviceCode({ label: body.label, ...(await clientHashes(c.req.raw, env)) });
      return c.json(result, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/ke/device/token', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      const body = await readKeJson(c.req.raw, GENERAL_JSON_LIMIT);
      const result = await tokenService(handlers).poll(body.device_code, await clientHashes(c.req.raw, env));
      return c.json(result, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.get('/api/v1/ke/device/lookup', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      const identity = await createSessionService(handlers.authRepository, handlers.authConfig, authRuntime).authenticate(c.req.raw);
      await assertKeRateLimit(handlers, { kind: 'session', value: identity.sessionToken }, KE_RATE_LIMITS.devicePerSession, authRuntime.now);
      const result = await tokenService(handlers).lookup(c.req.query('user_code'));
      return c.json(result, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/ke/device/decision', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      assertTrustedWriteOrigin(c.req.raw, handlers.authConfig);
      const identity = await createSessionService(handlers.authRepository, handlers.authConfig, authRuntime).authenticate(c.req.raw);
      const body = await readKeJson(c.req.raw, GENERAL_JSON_LIMIT);
      if (typeof body.approve !== 'boolean') throw new KeFailure('KE_BAD_REQUEST', 400, '请求字段无效');
      await assertKeRateLimit(handlers, { kind: 'session', value: identity.sessionToken }, KE_RATE_LIMITS.devicePerSession, authRuntime.now);
      await tokenService(handlers).decide(identity.userId, body.user_code, body.approve);
      return c.newResponse(null, 204, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  // —— 已授权设备管理（网页，cookie）——
  app.get('/api/v1/ke/tokens', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      const identity = await createSessionService(handlers.authRepository, handlers.authConfig, authRuntime).authenticate(c.req.raw);
      const tokens = await tokenService(handlers).list(identity.userId);
      return c.json({ tokens }, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.delete('/api/v1/ke/tokens/:id', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      assertTrustedWriteOrigin(c.req.raw, handlers.authConfig);
      const identity = await createSessionService(handlers.authRepository, handlers.authConfig, authRuntime).authenticate(c.req.raw);
      await tokenService(handlers).revoke(identity.userId, parseRowId(c.req.param('id')));
      return c.newResponse(null, 204, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.get('/api/v1/ke/characters', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      const identity = await createSessionService(handlers.authRepository, handlers.authConfig, authRuntime).authenticate(c.req.raw);
      const characters = await handlers.keRepository.listCharacters(Number(identity.userId));
      return c.json({ characters }, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.get('/api/v1/ke/profiles', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      const identity = await createSessionService(handlers.authRepository, handlers.authConfig, authRuntime).authenticate(c.req.raw);
      const { aid, cid, nid } = parseCharacterQuery(c);
      const profiles = await createProfileService(handlers.profileRepository, authRuntime.now).list(identity.userId, aid, cid, nid);
      return c.json({ profiles: profiles.map((profile) => ({ id: profile.id, name: profile.name, is_active: profile.is_active })) }, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.get('/api/v1/ke/profiles/active', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      const identity = await bearerIdentity(handlers, c.req.raw);
      const { aid, cid, nid } = parseCharacterQuery(c);
      const active = await createProfileService(handlers.profileRepository, authRuntime.now).fetchActive(identity.userId, aid, cid, nid);
      return c.json(active, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.get('/api/v1/ke/profiles/:id', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      const identity = await createSessionService(handlers.authRepository, handlers.authConfig, authRuntime).authenticate(c.req.raw);
      const profile = await createProfileService(handlers.profileRepository, authRuntime.now).getById(identity.userId, parseRowId(c.req.param('id')));
      return c.json(profile, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/ke/profiles', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      const body = await readKeJson(c.req.raw, env.MAX_BODY_BYTES);
      const identity = await createSessionService(handlers.authRepository, handlers.authConfig, authRuntime).authenticate(c.req.raw);
      const { aid, cid, nid } = parseCharacterReport(body);
      const input = parseProfileInput(body);
      const result = await createProfileService(handlers.profileRepository, authRuntime.now).create(identity.userId, aid, cid, nid, input);
      return c.json(result, 201, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.put('/api/v1/ke/profiles/:id', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      const body = await readKeJson(c.req.raw, env.MAX_BODY_BYTES);
      const identity = await createSessionService(handlers.authRepository, handlers.authConfig, authRuntime).authenticate(c.req.raw);
      const input = parseProfileInput(body);
      await createProfileService(handlers.profileRepository, authRuntime.now).update(identity.userId, parseRowId(c.req.param('id')), input);
      return c.newResponse(null, 204, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/ke/profiles/:id/activate', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      assertTrustedWriteOrigin(c.req.raw, handlers.authConfig);
      const identity = await createSessionService(handlers.authRepository, handlers.authConfig, authRuntime).authenticate(c.req.raw);
      await createProfileService(handlers.profileRepository, authRuntime.now).activate(identity.userId, parseRowId(c.req.param('id')));
      return c.newResponse(null, 204, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.delete('/api/v1/ke/profiles/:id', async (c: any) => {
    const handlers = setup();
    if (!handlers) return unavailable(c);
    try {
      assertTrustedWriteOrigin(c.req.raw, handlers.authConfig);
      const identity = await createSessionService(handlers.authRepository, handlers.authConfig, authRuntime).authenticate(c.req.raw);
      await createProfileService(handlers.profileRepository, authRuntime.now).remove(identity.userId, parseRowId(c.req.param('id')));
      return c.newResponse(null, 204, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });
}
