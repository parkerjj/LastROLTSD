import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import type { MarketRepository } from '../db/repository';
import type { SnapshotRepository } from '../db/snapshot-repository';

const RETENTION_PREVIEW_LIMIT = 1000;

export function registerAdminRoutes(app: Hono<any>, env: AppEnv, repo: MarketRepository, snapshots?: SnapshotRepository): void {
  if (snapshots) {
    const allowed = (secret: string | undefined): boolean => Boolean(env.ADMIN_SECRET && secret === env.ADMIN_SECRET);
    app.get('/api/admin/snapshots/:sourceId/:snapshotId', async (c) => {
      if (!allowed(c.req.header('x-admin-secret'))) return c.notFound();
      const status = await snapshots.status(c.req.param('sourceId'), c.req.param('snapshotId'));
      return status ? c.json(status, 200, { 'cache-control': 'no-store' }) : c.notFound();
    });
    app.post('/api/admin/snapshots/:sourceId/:snapshotId/requeue', async (c) => {
      if (!allowed(c.req.header('x-admin-secret'))) return c.notFound();
      const requeued = await snapshots.requeue(c.req.param('sourceId'), c.req.param('snapshotId'));
      return c.json({ requeued }, requeued ? 202 : 409, { 'cache-control': 'no-store' });
    });
  }
  app.get('/api/admin/retention-preview', async (c) => {
    const secret = c.req.header('x-admin-secret');
    if (!env.ADMIN_SECRET || !secret || secret !== env.ADMIN_SECRET) return c.json({ error: { code: 'not_found', message: 'Not found', request_id: crypto.randomUUID() } }, 404);
    const before = Date.now() - 180 * 24 * 60 * 60 * 1000;
    const scanLimit = RETENTION_PREVIEW_LIMIT + 1;
    const historyCount = repo.countExpiredHistory ? await repo.countExpiredHistory(before, scanLimit) : 0;
    const soldEventCount = repo.countExpiredSoldEvents ? await repo.countExpiredSoldEvents(before, scanLimit) : 0;
    return c.json({
      history: Math.min(historyCount, RETENTION_PREVIEW_LIMIT),
      historyTruncated: historyCount > RETENTION_PREVIEW_LIMIT,
      soldEvents: Math.min(soldEventCount, RETENTION_PREVIEW_LIMIT),
      soldEventsTruncated: soldEventCount > RETENTION_PREVIEW_LIMIT,
      retentionDays: 180,
    }, 200, { 'cache-control': 'no-store' });
  });
}
