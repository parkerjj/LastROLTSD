import { Hono } from 'hono';
import { resolveAppEnv, type AppEnv } from './env';
import { healthPayload } from './routes/health';
import { createMysqlDatabase, type MysqlDatabase } from './db/mysql-client';
import { createMysqlRepository } from './db/mysql-repository';
import { registerUploadRoute } from './routes/upload';
import { registerSearchRoute } from './routes/search';
import { registerOptionsRoute } from './routes/options';
import { registerHistoryRoute } from './routes/history';
import { registerStatusRoute } from './routes/status';
import { createListingStateService } from './services/state-transition';
import { registerAdminRoutes } from './routes/admin';
import { runRetention } from './services/retention';
import { recordMetric } from './observability';
import { registerAssetRoute } from './routes/assets';

export type WorkerBindings = AppEnv;
export type WorkerVariables = { requestId: string };

let cachedDatabase: { mysqlUrl: string; database: MysqlDatabase } | undefined;

function databaseFor(mysqlUrl: string): MysqlDatabase {
  if (cachedDatabase?.mysqlUrl === mysqlUrl) return cachedDatabase.database;
  if (cachedDatabase) void cachedDatabase.database.close();
  const database = createMysqlDatabase(mysqlUrl);
  cachedDatabase = { mysqlUrl, database };
  return database;
}

export function createApp(env: AppEnv, injectedDatabase?: MysqlDatabase): Hono<{ Bindings: WorkerBindings; Variables: WorkerVariables }> {
  const app = new Hono<{ Bindings: WorkerBindings; Variables: WorkerVariables }>();
  const database = injectedDatabase ?? (env.MYSQL_URL ? databaseFor(env.MYSQL_URL) : undefined);
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
  fetch(request: Request, bindings: Record<string, unknown>): Response | Promise<Response> {
    return createApp(resolveAppEnv(bindings)).fetch(request);
  },
  async scheduled(_event: ScheduledEvent, bindings: Record<string, unknown>): Promise<void> {
    const env = resolveAppEnv(bindings);
    if (env.MYSQL_URL) await runRetention(Date.now(), {}, createMysqlRepository(databaseFor(env.MYSQL_URL)));
  },
};
