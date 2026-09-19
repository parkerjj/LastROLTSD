import { Hono } from 'hono';
import { resolveAppEnv, type AppEnv } from './env';
import { healthPayload } from './routes/health';
import { createD1Repository } from './db/d1-repository';
import { registerUploadRoute } from './routes/upload';
import { registerSearchRoute } from './routes/search';
import { registerOptionsRoute } from './routes/options';
import { registerItemsRoute } from './routes/items';
import { registerHistoryRoute } from './routes/history';
import { createListingStateService } from './services/state-transition';
import { registerAdminRoutes } from './routes/admin';
import { runRetention } from './services/retention';
import { recordMetric } from './observability';

export type WorkerBindings = AppEnv;
export type WorkerVariables = { requestId: string };

export function createApp(env: AppEnv): Hono<{ Bindings: WorkerBindings; Variables: WorkerVariables }> {
  const app = new Hono<{ Bindings: WorkerBindings; Variables: WorkerVariables }>();

  app.use('*', async (c, next) => {
    const started = Date.now();
    const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
    c.header('x-request-id', requestId);
    try {
      await next();
    } finally {
      const declaredBytes = Number(c.req.header('content-length') ?? 0);
      recordMetric({ requestId, route: c.req.path, status: c.res.status, elapsedMs: Date.now() - started, ...(Number.isFinite(declaredBytes) && declaredBytes > 0 ? { bodyBytes: declaredBytes } : {}) });
    }
  });

  app.get('/api/health', async (c) => c.json(await healthPayload(env)));

  if (env.DB) {
    const repository = createD1Repository(env.DB, env.CURSOR_SECRET);
    registerSearchRoute(app, repository, env.CURSOR_SECRET);
    registerOptionsRoute(app, repository);
    registerItemsRoute(app, repository);
    registerHistoryRoute(app, repository, env.CURSOR_SECRET);
    registerUploadRoute(app, env, repository, createListingStateService(repository));
    registerAdminRoutes(app, env, repository);
  }

  (app as any).get('*', async (c: any) => {
    if (env.ASSETS) return (env.ASSETS as any).fetch(c.req.raw);
    return c.notFound();
  });

  return app;
}

export default {
  fetch(request: Request, bindings: Record<string, unknown>): Response | Promise<Response> {
    return createApp(resolveAppEnv(bindings)).fetch(request);
  },
  async scheduled(_event: ScheduledEvent, bindings: Record<string, unknown>): Promise<void> {
    const env = resolveAppEnv(bindings);
    if (env.DB) await runRetention(Date.now(), {}, createD1Repository(env.DB));
  },
};
