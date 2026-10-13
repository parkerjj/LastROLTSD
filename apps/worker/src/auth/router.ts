import type { Hono } from 'hono';
import type { MysqlDatabase } from '../db/mysql-client';
import type { AppEnv } from '../env';
import { jsonError, requestId } from '../middleware/errors';
import { readAuthJson } from './body';
import { assertCsrf, assertTrustedWriteOrigin, issueCsrf } from './csrf';
import { resolveAuthConfig } from './config';
import { createAccountService } from './account-service';
import { normalizeEmail, parseDisplayName, validatePasswordConfirmation } from './input';
import { createAuthRepository } from './repository';
import { AUTH_RATE_LIMITS, authRateLimitKey, consumeAuthRateLimit, trustedAuthClientIp } from './rate-limit';
import { clearSessionCookie, createSessionService } from './session-service';
import { AuthFailure, type AuthBindings, type AuthFailureStatus, type AuthRuntime } from './types';

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

function tooManyRequests(c: any, retryAfter: number): Response {
  const response = jsonFailure(c, 'AUTH_RATE_LIMITED', '请求过于频繁，请稍后重试', 429);
  response.headers.set('retry-after', String(retryAfter));
  return response;
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
      if (Object.prototype.hasOwnProperty.call(body, 'avatar_base64')) {
        throw new AuthFailure('AUTH_AVATAR_UNSUPPORTED', 415, '注册暂不支持上传头像，请稍后在账号设置中添加');
      }

      const emailInput = body.email;
      const passwordInput = body.password;
      const confirmationInput = body.password_confirmation;
      const displayNameInput = body.display_name;
      if (typeof emailInput !== 'string' || typeof passwordInput !== 'string'
        || typeof confirmationInput !== 'string' || typeof displayNameInput !== 'string') {
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

  app.get('/api/v1/users/:id/avatar', (c) => {
    if (!/^[1-9]\d{0,19}$/u.test(c.req.param('id'))) return notFound(c);
    return unavailable(c);
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
