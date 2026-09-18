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

  app.get('*', (c) => c.notFound());

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
