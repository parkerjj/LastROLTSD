import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { AuthFailure } from '../auth/types';
import { KE_STANDALONE_MODULE, type KeEntitlements } from '../ke/entitlements';
import { APP_FLAG_IOS_ENGINE, APP_FLAG_KEYS } from './repository';

export interface AppConfigDeps {
  readFlag(key: string): Promise<boolean>;
  writeFlag(key: string, enabled: boolean, now: number): Promise<void>;
  /** 账号系统未启用时为 null：所有请求都按"没有登录"处理。 */
  auth: { authenticate(request: Request): Promise<{ userId: string; status: string }> } | null;
  entitlements(userId: string, now: number): Promise<KeEntitlements>;
  now(): number;
}

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * iOS 客户端启动时访问的唯一配置接口：
 *   1. 站点总开关 ios_engine 关闭 → 直接返回，不查登录态；
 *   2. 开启 → 按会话 cookie 判断账号是否拥有 standalone 模块；没有 cookie / 会话无效 / 邮箱未验证 = 没有权限。
 * 响应随账号变化，必须 no-store。
 */
export function registerAppConfigRoutes(app: Hono<any>, env: Pick<AppEnv, 'ADMIN_SECRET'>, deps: AppConfigDeps): void {
  app.get('/api/v1/app/config', async (c) => {
    try {
      const iosEngine = await deps.readFlag(APP_FLAG_IOS_ENGINE);
      if (!iosEngine) return c.json({ iosEngine: false, standalone: false }, 200, NO_STORE);
      return c.json({ iosEngine: true, standalone: await hasStandalone(deps, c.req.raw) }, 200, NO_STORE);
    } catch {
      return c.json({ error: { code: 'unavailable', message: '服务暂时不可用' } }, 503, NO_STORE);
    }
  });

  const adminAllowed = (secret: string | undefined): boolean => Boolean(env.ADMIN_SECRET && secret && secret === env.ADMIN_SECRET);
  const notFound = (c: any) => c.json({ error: { code: 'not_found', message: 'Not found', request_id: crypto.randomUUID() } }, 404);

  app.get('/api/admin/app-flags/:key', async (c) => {
    const key = c.req.param('key');
    if (!adminAllowed(c.req.header('x-admin-secret')) || !APP_FLAG_KEYS.includes(key)) return notFound(c);
    return c.json({ key, enabled: await deps.readFlag(key) }, 200, NO_STORE);
  });

  app.put('/api/admin/app-flags/:key', async (c) => {
    const key = c.req.param('key');
    if (!adminAllowed(c.req.header('x-admin-secret')) || !APP_FLAG_KEYS.includes(key)) return notFound(c);
    let body: unknown;
    try { body = await c.req.json(); } catch { body = undefined; }
    const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
    const enabled = (body as { enabled?: unknown } | undefined)?.enabled;
    if (fields.length !== 1 || fields[0] !== 'enabled' || typeof enabled !== 'boolean') {
      return c.json({ error: { code: 'bad_request', message: '请求体必须是 {"enabled": true|false}' } }, 400, NO_STORE);
    }
    await deps.writeFlag(key, enabled, deps.now());
    return c.json({ key, enabled }, 200, NO_STORE);
  });
}

async function hasStandalone(deps: AppConfigDeps, request: Request): Promise<boolean> {
  if (!deps.auth) return false;
  let identity: { userId: string; status: string };
  try {
    identity = await deps.auth.authenticate(request);
  } catch (error) {
    // 没有 cookie / 会话过期 / 账号被禁用：都是"没有权限"。其它错误（数据库故障等）向上抛，由路由返回 503。
    if (error instanceof AuthFailure && (error.status === 401 || error.status === 403)) return false;
    throw error;
  }
  if (identity.status !== 'ACTIVE') return false;
  const effective = await deps.entitlements(identity.userId, deps.now());
  return effective.modules.has(KE_STANDALONE_MODULE);
}
