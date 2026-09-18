import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import type { MarketRepository } from '../db/repository';

export function registerAdminRoutes(app: Hono<any>, env: AppEnv, repo: MarketRepository): void {
  app.get('/api/admin/retention-preview', async (c) => { const secret = c.req.header('x-admin-secret'); if (!env.ADMIN_SECRET || !secret || secret !== env.ADMIN_SECRET) return c.json({ error: { code: 'not_found', message: 'Not found', request_id: crypto.randomUUID() } }, 404); const now = Date.now(); const before = now - 90 * 24 * 60 * 60 * 1000; const history = repo.countExpiredHistory ? await repo.countExpiredHistory(before) : 0; const soldEvents = repo.countExpiredSoldEvents ? await repo.countExpiredSoldEvents(before) : 0; return c.json({ history, soldEvents, retentionDays: 90 }, 200, { 'cache-control': 'no-store' }); });
}
