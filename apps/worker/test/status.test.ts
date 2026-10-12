import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { MarketRepository } from '../src/db/repository';
import { registerStatusRoute } from '../src/routes/status';

describe('market status response', () => {
  it('caches status at the edge for 180 seconds while revalidating on page open', async () => {
    const getLatestMarketUpdateAt = vi.fn(async () => 1_700_000_000_000);
    const app = new Hono();
    registerStatusRoute(app, { getLatestMarketUpdateAt } as unknown as MarketRepository);

    const response = await app.request('/api/v1/status');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=180');
    expect(await response.json()).toEqual({ latestUpdatedAt: 1_700_000_000_000 });
    expect(getLatestMarketUpdateAt).toHaveBeenCalledTimes(1);
  });

  it('returns the unchanged null response when the database has no update', async () => {
    const app = new Hono();
    registerStatusRoute(app, { getLatestMarketUpdateAt: async () => null } as unknown as MarketRepository);

    const response = await app.request('/api/v1/status');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ latestUpdatedAt: null });
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=180');
  });
});
