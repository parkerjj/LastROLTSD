import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index';
import type { AppEnv } from '../src/env';

const ACCOUNT_ROUTES: readonly [string, string][] = [
  ['GET', '/api/v1/auth/csrf'],
  ['POST', '/api/v1/auth/register'],
  ['POST', '/api/v1/auth/login'],
  ['GET', '/api/v1/auth/me'],
  ['POST', '/api/v1/auth/session/refresh'],
  ['POST', '/api/v1/auth/logout'],
  ['POST', '/api/v1/auth/logout-all'],
  ['POST', '/api/v1/auth/email-verification/request'],
  ['POST', '/api/v1/auth/email-verification/confirm'],
  ['POST', '/api/v1/auth/password/change'],
  ['POST', '/api/v1/auth/password-reset/request'],
  ['POST', '/api/v1/auth/password-reset/confirm'],
  ['PATCH', '/api/v1/account/profile'],
  ['PUT', '/api/v1/account/avatar'],
  ['DELETE', '/api/v1/account/avatar'],
  ['GET', '/api/v1/users/10000/avatar?v=0'],
];

describe('Worker account route wiring', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('keeps every account route out of ASSETS and returns JSON 404 for unknown account paths', async () => {
    const assetsFetch = vi.fn(async () => new Response('asset'));
    const app = createApp({
      ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024,
      AUTH_ENABLED: 'false', ASSETS: { fetch: assetsFetch } as unknown as Fetcher,
    } as unknown as AppEnv);

    for (const [method, path] of ACCOUNT_ROUTES) {
      const response = await app.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(503);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    }

    const unknown = await app.request('/api/v1/auth/not-a-route');
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: 'AUTH_NOT_FOUND' } });
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it('keeps account OPTIONS private while public API fallback retains wildcard CORS', async () => {
    const assetsFetch = vi.fn(async () => new Response('asset'));
    const app = createApp({
      ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024,
      AUTH_ENABLED: 'false', ASSETS: { fetch: assetsFetch } as unknown as Fetcher,
    } as unknown as AppEnv);

    const accountOptions = await app.request('/api/v1/auth/csrf', { method: 'OPTIONS' });
    expect(accountOptions.status).toBe(204);
    expect(accountOptions.headers.get('access-control-allow-origin')).toBeNull();
    expect(accountOptions.headers.get('access-control-allow-credentials')).toBeNull();

    const publicFallback = await app.request('/api/v1/authentic');
    expect(publicFallback.status).toBe(200);
    expect(publicFallback.headers.get('access-control-allow-origin')).toBe('*');
    expect(assetsFetch).toHaveBeenCalledTimes(1);
  });
});
