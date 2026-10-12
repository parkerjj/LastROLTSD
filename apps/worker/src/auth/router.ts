import type { Hono } from 'hono';
import type { MysqlDatabase } from '../db/mysql-client';
import type { AppEnv } from '../env';
import { jsonError, requestId } from '../middleware/errors';
import { readAuthJson } from './body';
import { issueCsrf } from './csrf';
import { resolveAuthConfig } from './config';
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

  for (const route of PLACEHOLDER_ROUTES) {
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
