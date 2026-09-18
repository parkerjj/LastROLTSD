import { Hono } from 'hono';
import type { AppEnv } from './env';

export type WorkerBindings = AppEnv;
export type WorkerVariables = { requestId: string };

export function createApp(env: AppEnv): Hono<{ Bindings: WorkerBindings; Variables: WorkerVariables }> {
  const app = new Hono<{ Bindings: WorkerBindings; Variables: WorkerVariables }>();

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      version: env.BUILD_VERSION,
      db: env.DB ? 'configured' : 'unconfigured',
    }),
  );

  app.get('*', async (c) => {
    if (env.ASSETS) return env.ASSETS.fetch(c.req.raw);
    return c.text('Not found', 404);
  });

  return app;
}

const defaultApp = createApp({
  ENVIRONMENT: 'production',
  BUILD_VERSION: 'unknown',
  MAX_BODY_BYTES: 512 * 1024,
});

export default {
  fetch(request: Request, env: AppEnv): Promise<Response> {
    return createApp(env).fetch(request);
  },
};

void defaultApp;
