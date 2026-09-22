import { Hono } from 'hono';
import { resolveAppEnv, type AppEnv } from './env';
import { healthPayload } from './routes/health';
import { createMysqlDatabase, type MysqlDatabase } from './db/mysql-client';
import { createMysqlRepository } from './db/mysql-repository';
import { registerUploadRoute } from './routes/upload';
import { registerSearchRoute, searchResponse } from './routes/search';
import { registerOptionsRoute } from './routes/options';
import { registerHistoryRoute } from './routes/history';
import { registerStatusRoute } from './routes/status';
import { createListingStateService } from './services/state-transition';
import { registerAdminRoutes } from './routes/admin';
import { runRetention } from './services/retention';
import { recordMetric } from './observability';
import { registerAssetRoute } from './routes/assets';
import { withSearchCache } from './middleware/search-cache';

export type WorkerBindings = AppEnv;
export type WorkerVariables = { requestId: string };

export function createApp(env: AppEnv, injectedDatabase?: MysqlDatabase): Hono<{ Bindings: WorkerBindings; Variables: WorkerVariables }> {
  const app = new Hono<{ Bindings: WorkerBindings; Variables: WorkerVariables }>();
  const database = injectedDatabase ?? (env.MYSQL_URL ? createMysqlDatabase(env.MYSQL_URL) : undefined);
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

  app.get('/api/health', async (c) => c.json(await healthPayload(env, database)));
  registerAssetRoute(app);

  if (database) {
    const repository = createMysqlRepository(database, env.CURSOR_SECRET);
    registerSearchRoute(app, repository, env.CURSOR_SECRET);
    registerOptionsRoute(app, repository);
    registerHistoryRoute(app, repository, env.CURSOR_SECRET);
    registerStatusRoute(app, repository);
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
  async fetch(request: Request, bindings: Record<string, unknown>, context?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
    const env = resolveAppEnv(bindings);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/v1/market/search' && env.MYSQL_URL) {
      return fetchSearch(request, url, env, context);
    }
    // A Worker socket belongs to the invocation that opened it.
    const database = env.MYSQL_URL ? createMysqlDatabase(env.MYSQL_URL) : undefined;
    try {
      return await createApp(env, database).fetch(request);
    } finally {
      await database?.close();
    }
  },
  async scheduled(_event: ScheduledEvent, bindings: Record<string, unknown>): Promise<void> {
    const env = resolveAppEnv(bindings);
    if (!env.MYSQL_URL) return;
    const database = createMysqlDatabase(env.MYSQL_URL);
    try {
      await runRetention(Date.now(), {}, createMysqlRepository(database));
    } finally {
      await database.close();
    }
  },
};

// The hot search path reuses this handler instead of rebuilding every Hono route.
async function fetchSearch(request: Request, url: URL, env: AppEnv, context?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const started = Date.now();
  const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();
  let response: Response;
  try {
    response = await withSearchCache(request, url, env, async () => {
      const database = createMysqlDatabase(env.MYSQL_URL!);
      try {
        // MySQL validates the cursor before issuing SQL; avoid route-level revalidation.
        return await searchResponse(request, createMysqlRepository(database, env.CURSOR_SECRET), env.CURSOR_SECRET, false);
      } finally {
        await database.close();
      }
    }, context);
  } catch (error) {
    console.error(error);
    response = new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain; charset=UTF-8', 'cache-control': 'no-store' } });
  }
  response.headers.set('x-request-id', requestId);
  recordMetric({ requestId, route: url.pathname, status: response.status, elapsedMs: Date.now() - started });
  return response;
}
