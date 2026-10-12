import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { registerCorsMiddleware, withCorsHeaders } from '../src/middleware/cors';

describe('CORS middleware', () => {
  it('answers API preflight for isolated-app origins', async () => {
    const app = createApp({ ENVIRONMENT: 'test', BUILD_VERSION: 'test-build', MAX_BODY_BYTES: 512 * 1024 });
    const response = await app.request('/api/v1/market/search', {
      method: 'OPTIONS',
      headers: { origin: 'isolated-app://nuqzolbnqymznffqhrx7ylosbqvbzekt4eybubmopsmsbjz5z2uqaaic', 'access-control-request-method': 'GET', 'access-control-request-headers': 'content-type' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toContain('x-admin-secret');
    expect(response.headers.get('access-control-max-age')).toBe('86400');
  });

  it('annotates successful and failing API responses with a constant allow-origin', async () => {
    const app = createApp({ ENVIRONMENT: 'test', BUILD_VERSION: 'test-build', MAX_BODY_BYTES: 512 * 1024 });
    const health = await app.request('/api/health');
    expect(health.headers.get('access-control-allow-origin')).toBe('*');
    // 未配置数据库时搜索路由不存在，落到 404 兜底——错误响应同样要跨域可读。
    const missing = await app.request('/api/v1/market/search');
    expect(missing.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('annotates a plain response in place', () => {
    const response = new Response('{}', { headers: { 'content-type': 'application/json' } });
    expect(withCorsHeaders(response)).toBe(response);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('keeps public wildcard CORS and leaves account responses without wildcard headers', async () => {
    const app = new Hono();
    registerCorsMiddleware(app);
    app.get('/api/v1/search', (c) => c.json({ items: [] }));
    app.get('/api/v1/auth/csrf', (c) => c.json({ csrf_token: 'token' }));
    app.get('/api/v1/account/profile', (c) => c.json({ user: {} }));
    app.get('/api/v1/users/:id/avatar', (c) => c.body('image'));
    app.get('/api/v1/authentic', (c) => c.json({ public: true }));
    app.options('/api/v1/auth/csrf', (c) => c.newResponse(null, 204, { 'cache-control': 'no-store' }));

    const publicResponse = await app.request('/api/v1/search');
    expect(publicResponse.headers.get('access-control-allow-origin')).toBe('*');
    const neighborResponse = await app.request('/api/v1/authentic');
    expect(neighborResponse.headers.get('access-control-allow-origin')).toBe('*');

    for (const path of ['/api/v1/auth/csrf', '/api/v1/account/profile', '/api/v1/users/10000/avatar']) {
      const response = await app.request(path);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    }

    const publicPreflight = await app.request('/api/v1/search', { method: 'OPTIONS' });
    expect(publicPreflight.status).toBe(204);
    expect(publicPreflight.headers.get('access-control-allow-origin')).toBe('*');
    const accountOptions = await app.request('/api/v1/auth/csrf', { method: 'OPTIONS' });
    expect(accountOptions.status).toBe(204);
    expect(accountOptions.headers.get('access-control-allow-origin')).toBeNull();
    expect(accountOptions.headers.get('access-control-allow-methods')).toBeNull();
  });
});
