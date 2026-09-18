import type { AppEnv } from '../env';
export async function healthPayload(env: AppEnv): Promise<{ ok: true; version: string; environment: string; db: string }> {
  let db = 'unconfigured';
  if (env.DB) {
    try { await env.DB.prepare('SELECT 1').first(); db = 'ok'; } catch { db = 'error'; }
  }
  return { ok: true, version: env.BUILD_VERSION, environment: env.ENVIRONMENT, db };
}
