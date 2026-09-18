import { Hono } from 'hono';
import type { AppEnv } from './env';
import { healthPayload } from './routes/health';
import { createD1Repository } from './db/d1-repository';
import { registerUploadRoute } from './routes/upload';
import { registerSearchRoute } from './routes/search';
import { registerOptionsRoute } from './routes/options';
import { registerHistoryRoute } from './routes/history';
import { createListingStateService } from './services/state-transition';

export type WorkerBindings = AppEnv;
export type WorkerVariables = { requestId: string };

export function createApp(env: AppEnv): Hono<{ Bindings: WorkerBindings; Variables: WorkerVariables }> {
  const app = new Hono<{ Bindings: WorkerBindings; Variables: WorkerVariables }>();

  app.get('/api/health', async (c) => c.json(await healthPayload(env)));

  if (env.DB) {
    const repository = createD1Repository(env.DB);
    registerSearchRoute(app, repository);
    registerOptionsRoute(app, repository);
    registerHistoryRoute(app, repository);
    registerUploadRoute(app, env, repository, createListingStateService(repository));
  }

  (app as any).get('*', async (c: any) => {
    if (env.ASSETS) return (env.ASSETS as any).fetch(c.req.raw);
    return c.notFound();
  });

  return app;
}

const defaultApp = createApp({
  ENVIRONMENT: 'production',
  BUILD_VERSION: 'unknown',
  MAX_BODY_BYTES: 512 * 1024,
});

export default {
  fetch(request: Request, env: AppEnv): Response | Promise<Response> {
    return createApp(env).fetch(request);
  },
};

void defaultApp;
