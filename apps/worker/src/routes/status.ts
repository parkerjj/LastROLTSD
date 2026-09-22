import type { Hono } from 'hono';
import type { MarketRepository } from '../db/repository';

export function registerStatusRoute(app: Hono<any>, repo: MarketRepository): void {
  app.get('/api/v1/status', async (c) => {
    const latestUpdatedAt = await repo.getLatestMarketUpdateAt?.();
    return c.json({ latestUpdatedAt: latestUpdatedAt ?? null }, 200, { 'cache-control': 'no-store' });
  });
}
