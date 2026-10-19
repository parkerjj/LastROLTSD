import type { Hono } from 'hono';

// 公开 API 全部匿名（跨域调用从不携带 Cookie 等隐式凭证），因此用常量 `*` 作为
// allow-origin；这也是对边缘缓存唯一安全的策略——缓存 key 不含 Origin 头，命中时
// Worker 不执行，按来源 echo 会把带错误 CORS 头的缓存响应串给其它来源。`*` 天然
// 覆盖以下四个来源：
// - https://ltsd.ro（同域，实际不触发 CORS 校验）
// - https://game.lastro.cn
// - isolated-app://nuqzolbnqymznffqhrx7ylosbqvbzekt4eybubmopsmsbjz5z2uqaaic
// - isolated-app://o5kpgmrpqz25nc2dnneb2ltf5lga7zkchc6xenxhu6l766pmyquaaaac
const CORS_ORIGIN = { 'access-control-allow-origin': '*' } as const;
const PREFLIGHT_HEADERS = {
  ...CORS_ORIGIN,
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  // authorization：KE（IWA）用 Bearer token 调 /api/v1/ke/*。通配符 `*` 不覆盖 Authorization，必须显式列出；
  // Bearer 不是 cookie 类「凭据」，allow-origin 仍可用 `*`。
  'access-control-allow-headers': 'content-type, authorization, x-admin-secret',
  'access-control-max-age': '86400',
} as const;

function isAccountPath(path: string): boolean {
  return path === '/api/v1/auth' || path.startsWith('/api/v1/auth/')
    || path === '/api/v1/account' || path.startsWith('/api/v1/account/')
    || /^\/api\/v1\/users\/[^/]+\/avatar$/u.test(path);
}

// fetch 拿到的响应（如 ASSETS 兜底）headers 不可变；此时重建响应，避免 CORS 标注变成 500。
export function withCorsHeaders(response: Response): Response {
  try {
    response.headers.set('access-control-allow-origin', '*');
    return response;
  } catch {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers([...response.headers, ...Object.entries(CORS_ORIGIN)]) });
  }
}

// 只挂 /api/*：/making-cookie 与 /lastro/presence 已自带 CORS 头，静态资源不需要。
// 注意搜索热路径 fetchSearch 与 fetchUpload 绕过 Hono 路由，需单独调用 withCorsHeaders。
export function registerCorsMiddleware(app: Hono<any>): void {
  app.use('/api/*', async (c, next) => {
    if (isAccountPath(c.req.path)) {
      await next();
      return;
    }
    if (c.req.method === 'OPTIONS') return c.newResponse(null, 204, PREFLIGHT_HEADERS);
    await next();
    c.res = withCorsHeaders(c.res);
  });
}
