import type { Hono } from 'hono';
import type { MysqlDatabase } from '../db/mysql-client';
import type { AppEnv } from '../env';
import { jsonError, requestId } from '../middleware/errors';
import { readAuthJson } from './body';
import { avatarResponse } from './avatar';
import { assertCsrf, assertTrustedWriteOrigin, issueCsrf } from './csrf';
import { resolveAuthConfig } from './config';
import { createAccountService } from './account-service';
import { createActionService } from './action-service';
import { normalizeEmail, parseDisplayName, validatePasswordConfirmation } from './input';
import { createAuthRepository } from './repository';
import { AUTH_RATE_LIMITS, authRateLimitKey, consumeAuthRateLimit, trustedAuthClientIp } from './rate-limit';
import { clearSessionCookie, createSessionService } from './session-service';
import { AuthFailure, type AuthBindings, type AuthFailureStatus, type AuthRateLimitRule, type AuthRuntime, type EnabledAuthConfig } from './types';

type AuthRouteMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface PlaceholderRoute {
  method: AuthRouteMethod;
  path: string;
  fields?: readonly string[];
  maxBytes?: number;
}

const GENERAL_JSON_LIMIT = 8 * 1024;
const AVATAR_JSON_LIMIT = 64 * 1024;

const PLACEHOLDER_ROUTES: readonly PlaceholderRoute[] = [
  { method: 'POST', path: '/api/v1/auth/register', fields: ['email', 'password', 'password_confirmation', 'display_name', 'avatar_base64'], maxBytes: AVATAR_JSON_LIMIT },
  { method: 'POST', path: '/api/v1/auth/login', fields: ['email', 'password'], maxBytes: GENERAL_JSON_LIMIT },
  { method: 'GET', path: '/api/v1/auth/me' },
  { method: 'POST', path: '/api/v1/auth/session/refresh', fields: [], maxBytes: GENERAL_JSON_LIMIT },
  { method: 'POST', path: '/api/v1/auth/logout', fields: [], maxBytes: GENERAL_JSON_LIMIT },
  { method: 'POST', path: '/api/v1/auth/logout-all', fields: [], maxBytes: GENERAL_JSON_LIMIT },
  { method: 'POST', path: '/api/v1/auth/email-verification/request', fields: [], maxBytes: GENERAL_JSON_LIMIT },
  { method: 'POST', path: '/api/v1/auth/email-verification/confirm', fields: ['token'], maxBytes: GENERAL_JSON_LIMIT },
  { method: 'POST', path: '/api/v1/auth/password/change', fields: ['current_password', 'new_password', 'new_password_confirmation'], maxBytes: GENERAL_JSON_LIMIT },
  { method: 'POST', path: '/api/v1/auth/password-reset/request', fields: ['email'], maxBytes: GENERAL_JSON_LIMIT },
  { method: 'POST', path: '/api/v1/auth/password-reset/confirm', fields: ['token', 'new_password', 'new_password_confirmation'], maxBytes: GENERAL_JSON_LIMIT },
  { method: 'PATCH', path: '/api/v1/account/profile', fields: ['display_name'], maxBytes: GENERAL_JSON_LIMIT },
  { method: 'PUT', path: '/api/v1/account/avatar', fields: ['avatar_base64'], maxBytes: AVATAR_JSON_LIMIT },
  { method: 'DELETE', path: '/api/v1/account/avatar' },
];

const KNOWN_PATHS = new Map<string, string>([
  ['/api/v1/auth/csrf', 'GET, OPTIONS'],
  ...PLACEHOLDER_ROUTES.map((route) => [route.path, `${route.method}, OPTIONS`] as [string, string]),
  ['/api/v1/users/:id/avatar', 'GET, OPTIONS'],
]);

function jsonFailure(c: any, code: string, message: string, status: AuthFailureStatus): Response {
  const contextRequestId = c.get('requestId');
  const id = typeof contextRequestId === 'string' && contextRequestId.length > 0
    ? contextRequestId
    : requestId(c.req.raw);
  return jsonError(code, message, status, id);
}

function notFound(c: any): Response {
  return jsonFailure(c, 'AUTH_NOT_FOUND', '请求路径不存在', 404);
}

function unavailable(c: any): Response {
  return jsonFailure(c, 'AUTH_UNAVAILABLE', '账号服务暂不可用', 503);
}

function routeFailure(c: any, error: unknown): Response {
  return error instanceof AuthFailure
    ? jsonFailure(c, error.code, error.publicMessage, error.status)
    : unavailable(c);
}

async function readEmptyAuthBody(request: Request): Promise<void> {
  const body = await readAuthJson(request, GENERAL_JSON_LIMIT);
  if (Object.keys(body).length !== 0) throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求字段无效');
}

async function requireBodylessAuthRequest(request: Request): Promise<void> {
  if (!request.body) return;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.byteLength > 0) {
        await reader.cancel();
        throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求不应包含正文');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function tooManyRequests(c: any, retryAfter: number): Response {
  const response = jsonFailure(c, 'AUTH_RATE_LIMITED', '请求过于频繁，请稍后重试', 429);
  response.headers.set('retry-after', String(retryAfter));
  return response;
}

interface SensitiveRateIdentity {
  kind: 'session' | 'action';
  value: string;
}

async function sensitiveRateRules(
  config: EnabledAuthConfig,
  clientIp: string,
  identities: readonly SensitiveRateIdentity[],
): Promise<AuthRateLimitRule[]> {
  const ipDigest = await authRateLimitKey(config.rateSecret, 'ip', clientIp);
  const identityDigests = await Promise.all(identities.map(({ kind, value }) => authRateLimitKey(config.rateSecret, kind, value)));
  const identityLimit = AUTH_RATE_LIMITS.sensitivePerSessionOrAction;
  const ipLimit = AUTH_RATE_LIMITS.sensitivePerIp;
  return [
    ...identityDigests.map((keyDigest) => ({
      kind: 'window' as const,
      scope: identityLimit.scope,
      keyDigest,
      limit: identityLimit.limit,
      windowMs: identityLimit.windowMs,
    })),
    { kind: 'window', scope: ipLimit.scope, keyDigest: ipDigest, limit: ipLimit.limit, windowMs: ipLimit.windowMs },
  ];
}

async function profileRateRules(config: EnabledAuthConfig, sessionToken: string): Promise<AuthRateLimitRule[]> {
  const keyDigest = await authRateLimitKey(config.rateSecret, 'session', sessionToken);
  const limit = AUTH_RATE_LIMITS.profilePerSession;
  return [{
    kind: 'window', scope: limit.scope, keyDigest, limit: limit.limit, windowMs: limit.windowMs,
  }];
}

async function mailRequestRateRules(
  config: EnabledAuthConfig,
  emailNormalized: string,
  clientIp: string,
): Promise<AuthRateLimitRule[]> {
  const [emailDigest, ipDigest] = await Promise.all([
    authRateLimitKey(config.rateSecret, 'email', emailNormalized),
    authRateLimitKey(config.rateSecret, 'ip', clientIp),
  ]);
  const emailLimit = AUTH_RATE_LIMITS.mailPerEmail;
  const ipLimit = AUTH_RATE_LIMITS.mailPerIp;
  const cooldown = AUTH_RATE_LIMITS.mailCooldown;
  return [
    { kind: 'window', scope: emailLimit.scope, keyDigest: emailDigest, limit: emailLimit.limit, windowMs: emailLimit.windowMs },
    { kind: 'window', scope: ipLimit.scope, keyDigest: ipDigest, limit: ipLimit.limit, windowMs: ipLimit.windowMs },
    { kind: 'cooldown', scope: cooldown.scope, keyDigest: emailDigest, cooldownMs: cooldown.cooldownMs },
  ];
}

function requireActionToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new AuthFailure('AUTH_ACTION_INVALID', 400, '链接已失效，请登录后重新申请');
  }
  return value;
}

function knownPath(path: string): boolean {
  return KNOWN_PATHS.has(path) || /^\/api\/v1\/users\/[1-9]\d{0,19}\/avatar$/u.test(path);
}

function allowHeader(path: string): string {
  if (path === '/api/v1/users/:id/avatar' || /^\/api\/v1\/users\/[1-9]\d{0,19}\/avatar$/u.test(path)) return 'GET, OPTIONS';
  return KNOWN_PATHS.get(path) ?? 'OPTIONS';
}

function enabledConfig(env: AppEnv & AuthBindings) {
  try {
    const config = resolveAuthConfig(env);
    return config.enabled ? config : null;
  } catch {
    return null;
  }
}

export function registerAuthRoutes(
  app: Hono<any>,
  env: AppEnv & AuthBindings,
  database?: MysqlDatabase,
  runtime?: AuthRuntime,
): void {
  const repository = database ? createAuthRepository(database) : null;
  const authRuntime = runtime ?? { now: () => Date.now(), fetch: globalThis.fetch };
  const implementedRoutePaths = new Set([
    '/api/v1/auth/register',
    '/api/v1/auth/login',
    '/api/v1/auth/me',
    '/api/v1/auth/session/refresh',
    '/api/v1/auth/logout',
    '/api/v1/auth/logout-all',
    '/api/v1/auth/email-verification/request',
    '/api/v1/auth/email-verification/confirm',
    '/api/v1/auth/password/change',
    '/api/v1/auth/password-reset/request',
    '/api/v1/auth/password-reset/confirm',
    '/api/v1/account/profile',
    '/api/v1/account/avatar',
  ]);

  app.get('/api/v1/auth/csrf', async (c) => {
    const config = enabledConfig(env);
    if (!config) return unavailable(c);
    try {
      const result = await issueCsrf(c.req.raw, config, 'anonymous', undefined, runtime ? () => runtime.now() : undefined);
      return c.json({ csrf_token: result.token }, 200, {
        'cache-control': 'no-store',
        ...(result.cookie ? { 'set-cookie': result.cookie } : {}),
      });
    } catch (error) {
      if (error instanceof AuthFailure) return jsonFailure(c, error.code, error.publicMessage, error.status);
      return unavailable(c);
    }
  });

  app.post('/api/v1/auth/register', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      const body = await readAuthJson(c.req.raw, AVATAR_JSON_LIMIT);
      if (Object.keys(body).some((field) => !['email', 'password', 'password_confirmation', 'display_name', 'avatar_base64'].includes(field))) {
        throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求字段无效');
      }

      const emailInput = body.email;
      const passwordInput = body.password;
      const confirmationInput = body.password_confirmation;
      const displayNameInput = body.display_name;
      const avatarBase64Input = body.avatar_base64;
      if (typeof emailInput !== 'string' || typeof passwordInput !== 'string'
        || typeof confirmationInput !== 'string' || typeof displayNameInput !== 'string'
        || (avatarBase64Input !== undefined && typeof avatarBase64Input !== 'string')) {
        throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求格式无效');
      }

      const emailNormalized = normalizeEmail(emailInput).normalized;
      const password = validatePasswordConfirmation(passwordInput, confirmationInput);
      const displayName = parseDisplayName(displayNameInput);
      await assertCsrf(c.req.raw, config, 'anonymous', undefined, () => authRuntime.now());

      const clientIp = trustedAuthClientIp(c.req.raw, env.ENVIRONMENT);
      const [emailDigest, ipDigest] = await Promise.all([
        authRateLimitKey(config.rateSecret, 'email', emailNormalized),
        authRateLimitKey(config.rateSecret, 'ip', clientIp),
      ]);
      const registrationLimit = AUTH_RATE_LIMITS.registrationPerIp;
      const mailEmailLimit = AUTH_RATE_LIMITS.mailPerEmail;
      const mailIpLimit = AUTH_RATE_LIMITS.mailPerIp;
      const mailCooldown = AUTH_RATE_LIMITS.mailCooldown;
      const rateLimit = await consumeAuthRateLimit(repository, [
        { kind: 'window', scope: registrationLimit.scope, keyDigest: ipDigest, limit: registrationLimit.limit, windowMs: registrationLimit.windowMs },
        { kind: 'window', scope: mailEmailLimit.scope, keyDigest: emailDigest, limit: mailEmailLimit.limit, windowMs: mailEmailLimit.windowMs },
        { kind: 'window', scope: mailIpLimit.scope, keyDigest: ipDigest, limit: mailIpLimit.limit, windowMs: mailIpLimit.windowMs },
        { kind: 'cooldown', scope: mailCooldown.scope, keyDigest: emailDigest, cooldownMs: mailCooldown.cooldownMs },
      ], () => authRuntime.now());
      if (!rateLimit.allowed) return tooManyRequests(c, rateLimit.retryAfter);

      const response = await createAccountService(repository, config, authRuntime).register({
        email: emailInput,
        password,
        password_confirmation: password,
        display_name: displayName,
        ...(typeof avatarBase64Input === 'string' ? { avatar_base64: avatarBase64Input } : {}),
        requestId: requestId(c.req.raw),
      });
      return c.json(response, 202, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/auth/login', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      const body = await readAuthJson(c.req.raw, GENERAL_JSON_LIMIT);
      if (Object.keys(body).some((field) => field !== 'email' && field !== 'password')) {
        throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求字段无效');
      }
      if (typeof body.email !== 'string' || typeof body.password !== 'string') {
        throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求格式无效');
      }

      await assertCsrf(c.req.raw, config, 'anonymous', undefined, () => authRuntime.now());
      const emailNormalized = normalizeEmail(body.email).normalized;
      const [emailDigest, ipDigest] = await Promise.all([
        authRateLimitKey(config.rateSecret, 'email', emailNormalized),
        authRateLimitKey(config.rateSecret, 'ip', trustedAuthClientIp(c.req.raw, env.ENVIRONMENT)),
      ]);
      const emailLimit = AUTH_RATE_LIMITS.loginPerEmail;
      const ipLimit = AUTH_RATE_LIMITS.loginPerIp;
      const rateLimit = await consumeAuthRateLimit(repository, [
        { kind: 'window', scope: emailLimit.scope, keyDigest: emailDigest, limit: emailLimit.limit, windowMs: emailLimit.windowMs },
        { kind: 'window', scope: ipLimit.scope, keyDigest: ipDigest, limit: ipLimit.limit, windowMs: ipLimit.windowMs },
      ], () => authRuntime.now());
      if (!rateLimit.allowed) return tooManyRequests(c, rateLimit.retryAfter);

      const result = await createSessionService(repository, config, authRuntime).login(body.email, body.password);
      return c.json(result.response, 200, { 'cache-control': 'no-store', 'set-cookie': result.cookie });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.get('/api/v1/auth/me', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      const service = createSessionService(repository, config, authRuntime);
      const identity = await service.authenticate(c.req.raw);
      return c.json(await service.me(identity), 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/auth/session/refresh', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      await readEmptyAuthBody(c.req.raw);
      const service = createSessionService(repository, config, authRuntime);
      const identity = await service.authenticate(c.req.raw);
      await assertCsrf(c.req.raw, config, 'session', identity, () => authRuntime.now());
      const refreshed = await service.refresh(identity);
      return c.json({ expires_at: refreshed.expires_at, csrf_token: refreshed.csrf_token }, 200, {
        'cache-control': 'no-store', 'set-cookie': refreshed.cookie,
      });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/auth/logout', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      await readEmptyAuthBody(c.req.raw);
      assertTrustedWriteOrigin(c.req.raw, config);
      const service = createSessionService(repository, config, authRuntime);
      let identity = null;
      try {
        identity = await service.authenticate(c.req.raw);
      } catch (error) {
        if (!(error instanceof AuthFailure) || error.status !== 401) throw error;
      }
      if (identity) await assertCsrf(c.req.raw, config, 'session', identity, () => authRuntime.now());
      await service.logout(identity);
      return c.newResponse(null, 204, { 'cache-control': 'no-store', 'set-cookie': clearSessionCookie(config) });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/auth/logout-all', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      await readEmptyAuthBody(c.req.raw);
      const service = createSessionService(repository, config, authRuntime);
      const identity = await service.authenticate(c.req.raw);
      await assertCsrf(c.req.raw, config, 'session', identity, () => authRuntime.now());
      await service.logoutAll(identity);
      return c.newResponse(null, 204, { 'cache-control': 'no-store', 'set-cookie': clearSessionCookie(config) });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/auth/email-verification/request', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      await readEmptyAuthBody(c.req.raw);
      const sessions = createSessionService(repository, config, authRuntime);
      const identity = await sessions.authenticate(c.req.raw);
      await assertCsrf(c.req.raw, config, 'session', identity, () => authRuntime.now());

      const profile = await repository.readProfile(identity.userId);
      if (!profile) throw new AuthFailure('AUTH_UNAUTHENTICATED', 401, '请先登录');
      const clientIp = trustedAuthClientIp(c.req.raw, env.ENVIRONMENT);
      const rules = await sensitiveRateRules(config, clientIp, [{ kind: 'session', value: identity.sessionToken }]);
      if (profile.status === 'PENDING_EMAIL') {
        rules.push(...await mailRequestRateRules(config, normalizeEmail(profile.email).normalized, clientIp));
      }
      const rateLimit = await consumeAuthRateLimit(repository, rules, () => authRuntime.now());
      if (!rateLimit.allowed) return tooManyRequests(c, rateLimit.retryAfter);

      const result = await createActionService(repository, config, authRuntime).requestVerification(identity);
      const status = 'verified' in result ? 200 : 202;
      return c.json(result, status, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/auth/email-verification/confirm', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      const body = await readAuthJson(c.req.raw, GENERAL_JSON_LIMIT);
      if (Object.keys(body).some((field) => field !== 'token')) throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求字段无效');
      const token = requireActionToken(body.token);
      const sessions = createSessionService(repository, config, authRuntime);
      const identity = await sessions.authenticate(c.req.raw);
      await assertCsrf(c.req.raw, config, 'session', identity, () => authRuntime.now());

      const rules = await sensitiveRateRules(config, trustedAuthClientIp(c.req.raw, env.ENVIRONMENT), [
        { kind: 'session', value: identity.sessionToken },
        { kind: 'action', value: token },
      ]);
      const rateLimit = await consumeAuthRateLimit(repository, rules, () => authRuntime.now());
      if (!rateLimit.allowed) return tooManyRequests(c, rateLimit.retryAfter);

      const result = await createActionService(repository, config, authRuntime).confirmVerification(identity, token);
      return c.json(result.response, 200, { 'cache-control': 'no-store', 'set-cookie': result.cookie });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/auth/password/change', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      const body = await readAuthJson(c.req.raw, GENERAL_JSON_LIMIT);
      if (Object.keys(body).some((field) => !['current_password', 'new_password', 'new_password_confirmation'].includes(field))) {
        throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求字段无效');
      }
      if (typeof body.current_password !== 'string' || typeof body.new_password !== 'string'
        || typeof body.new_password_confirmation !== 'string') throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求格式无效');

      const sessions = createSessionService(repository, config, authRuntime);
      const identity = await sessions.authenticate(c.req.raw);
      await assertCsrf(c.req.raw, config, 'session', identity, () => authRuntime.now());
      const rules = await sensitiveRateRules(config, trustedAuthClientIp(c.req.raw, env.ENVIRONMENT), [
        { kind: 'session', value: identity.sessionToken },
      ]);
      const rateLimit = await consumeAuthRateLimit(repository, rules, () => authRuntime.now());
      if (!rateLimit.allowed) return tooManyRequests(c, rateLimit.retryAfter);

      await createActionService(repository, config, authRuntime).changePassword(
        identity,
        body.current_password,
        body.new_password,
        body.new_password_confirmation,
      );
      return c.newResponse(null, 204, { 'cache-control': 'no-store', 'set-cookie': clearSessionCookie(config) });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/auth/password-reset/request', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      const body = await readAuthJson(c.req.raw, GENERAL_JSON_LIMIT);
      if (Object.keys(body).some((field) => field !== 'email')) throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求字段无效');
      if (typeof body.email !== 'string') throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求格式无效');
      await assertCsrf(c.req.raw, config, 'anonymous', undefined, () => authRuntime.now());

      const email = normalizeEmail(body.email);
      const rules = await mailRequestRateRules(
        config,
        email.normalized,
        trustedAuthClientIp(c.req.raw, env.ENVIRONMENT),
      );
      const rateLimit = await consumeAuthRateLimit(repository, rules, () => authRuntime.now());
      if (!rateLimit.allowed) return tooManyRequests(c, rateLimit.retryAfter);

      const response = await createActionService(repository, config, authRuntime).requestReset(body.email);
      return c.json(response, 202, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.post('/api/v1/auth/password-reset/confirm', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      const body = await readAuthJson(c.req.raw, GENERAL_JSON_LIMIT);
      if (Object.keys(body).some((field) => !['token', 'new_password', 'new_password_confirmation'].includes(field))) {
        throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求字段无效');
      }
      const token = requireActionToken(body.token);
      if (typeof body.new_password !== 'string' || typeof body.new_password_confirmation !== 'string') {
        throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求格式无效');
      }
      await assertCsrf(c.req.raw, config, 'anonymous', undefined, () => authRuntime.now());

      const rules = await sensitiveRateRules(config, trustedAuthClientIp(c.req.raw, env.ENVIRONMENT), [
        { kind: 'action', value: token },
      ]);
      const rateLimit = await consumeAuthRateLimit(repository, rules, () => authRuntime.now());
      if (!rateLimit.allowed) return tooManyRequests(c, rateLimit.retryAfter);

      const sessions = createSessionService(repository, config, authRuntime);
      let currentIdentity: Awaited<ReturnType<typeof sessions.authenticate>> | null = null;
      try {
        currentIdentity = await sessions.authenticate(c.req.raw);
      } catch (error) {
        if (!(error instanceof AuthFailure) || error.status !== 401) throw error;
      }
      const result = await createActionService(repository, config, authRuntime).confirmReset(
        token,
        body.new_password,
        body.new_password_confirmation,
      );
      const headers: Record<string, string> = { 'cache-control': 'no-store' };
      if (currentIdentity?.userId === result.changedUserId) headers['set-cookie'] = clearSessionCookie(config);
      return c.newResponse(null, 204, headers);
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.patch('/api/v1/account/profile', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      const body = await readAuthJson(c.req.raw, GENERAL_JSON_LIMIT);
      if (Object.keys(body).some((field) => field !== 'display_name')) {
        throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求字段无效');
      }
      if (typeof body.display_name !== 'string') throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求格式无效');

      const sessions = createSessionService(repository, config, authRuntime);
      const identity = await sessions.authenticate(c.req.raw);
      await assertCsrf(c.req.raw, config, 'session', identity, () => authRuntime.now());
      const rules = await profileRateRules(config, identity.sessionToken);
      const rateLimit = await consumeAuthRateLimit(repository, rules, () => authRuntime.now());
      if (!rateLimit.allowed) return tooManyRequests(c, rateLimit.retryAfter);

      const user = await createAccountService(repository, config, authRuntime)
        .updateDisplayName(identity, body.display_name, requestId(c.req.raw));
      return c.json({ user }, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.put('/api/v1/account/avatar', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      const body = await readAuthJson(c.req.raw, AVATAR_JSON_LIMIT);
      if (Object.keys(body).some((field) => field !== 'avatar_base64')) {
        throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求字段无效');
      }
      if (typeof body.avatar_base64 !== 'string') throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求格式无效');

      const sessions = createSessionService(repository, config, authRuntime);
      const identity = await sessions.authenticate(c.req.raw);
      await assertCsrf(c.req.raw, config, 'session', identity, () => authRuntime.now());
      const rules = await profileRateRules(config, identity.sessionToken);
      const rateLimit = await consumeAuthRateLimit(repository, rules, () => authRuntime.now());
      if (!rateLimit.allowed) return tooManyRequests(c, rateLimit.retryAfter);

      const user = await createAccountService(repository, config, authRuntime)
        .setAvatar(identity, body.avatar_base64, requestId(c.req.raw));
      return c.json({ user }, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  app.delete('/api/v1/account/avatar', async (c) => {
    const config = enabledConfig(env);
    if (!config || !repository) return unavailable(c);
    try {
      await requireBodylessAuthRequest(c.req.raw);
      const sessions = createSessionService(repository, config, authRuntime);
      const identity = await sessions.authenticate(c.req.raw);
      await assertCsrf(c.req.raw, config, 'session', identity, () => authRuntime.now());
      const rules = await profileRateRules(config, identity.sessionToken);
      const rateLimit = await consumeAuthRateLimit(repository, rules, () => authRuntime.now());
      if (!rateLimit.allowed) return tooManyRequests(c, rateLimit.retryAfter);

      const user = await createAccountService(repository, config, authRuntime)
        .setAvatar(identity, null, requestId(c.req.raw));
      return c.json({ user }, 200, { 'cache-control': 'no-store' });
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  for (const route of PLACEHOLDER_ROUTES) {
    if (implementedRoutePaths.has(route.path)) continue;
    app.on([route.method], route.path, async (c) => {
      if (!database || !enabledConfig(env)) return unavailable(c);
      if (route.fields) {
        try {
          const body = await readAuthJson(c.req.raw, route.maxBytes ?? GENERAL_JSON_LIMIT);
          if (Object.keys(body).some((field) => !route.fields!.includes(field))) {
            throw new AuthFailure('AUTH_BAD_REQUEST', 400, '请求字段无效');
          }
        } catch (error) {
          if (error instanceof AuthFailure) return jsonFailure(c, error.code, error.publicMessage, error.status);
          return unavailable(c);
        }
      }
      return unavailable(c);
    });
  }

  app.get('/api/v1/users/:id/avatar', async (c) => {
    if (!/^[1-9]\d{0,19}$/u.test(c.req.param('id'))) return notFound(c);
    if (!database || !repository || !enabledConfig(env)) return unavailable(c);
    try {
      return await avatarResponse(c.req.param('id'), c.req.query('v') ?? null, repository);
    } catch (error) {
      return routeFailure(c, error);
    }
  });

  const options = (c: any) => knownPath(c.req.path)
    ? c.newResponse(null, 204, { 'cache-control': 'no-store', allow: allowHeader(c.req.path) })
    : notFound(c);
  app.options('/api/v1/auth', options);
  app.options('/api/v1/auth/*', options);
  app.options('/api/v1/account', options);
  app.options('/api/v1/account/*', options);
  app.options('/api/v1/users/:id/avatar', options);

  app.all('/api/v1/auth', notFound);
  app.all('/api/v1/auth/*', notFound);
  app.all('/api/v1/account', notFound);
  app.all('/api/v1/account/*', notFound);
  app.all('/api/v1/users/:id/avatar', notFound);
}
