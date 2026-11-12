import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerAdminRoutes } from '../src/routes/admin';

afterEach(() => vi.restoreAllMocks());

describe('admin retention preview', () => {
  it('reports bounded lower limits instead of exact unbounded counts', async () => {
    const app = new Hono();
    vi.spyOn(Date, 'now').mockReturnValue(100 * 86_400_000);
    registerAdminRoutes(app, { ADMIN_SECRET: 'secret' } as never, {
      countExpiredHistory: async (_before: number, limit: number) => {
        expect(_before).toBe(70 * 86_400_000);
        expect(limit).toBe(1001);
        return 1001;
      },
      countExpiredSoldEvents: async (_before: number, limit: number) => {
        expect(_before).toBe(70 * 86_400_000);
        expect(limit).toBe(1001);
        return 7;
      },
    } as never);

    const response = await app.request('/api/admin/retention-preview', { headers: { 'x-admin-secret': 'secret' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      history: 1000,
      historyTruncated: true,
      soldEvents: 7,
      soldEventsTruncated: false,
      retentionDays: 30,
    });
  });
});
