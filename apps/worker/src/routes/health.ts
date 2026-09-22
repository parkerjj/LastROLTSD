import type { AppEnv } from '../env';
import type { MysqlDatabase } from '../db/mysql-client';

export async function healthPayload(env: AppEnv, database?: Pick<MysqlDatabase, 'healthcheck'>): Promise<{ ok: true; version: string; environment: string; db: 'unconfigured' | 'ok' | 'error' }> {
  let db: 'unconfigured' | 'ok' | 'error' = 'unconfigured';
  if (env.MYSQL_URL) {
    try {
      if (!database) throw new Error('database is unavailable');
      await database.healthcheck();
      db = 'ok';
    } catch {
      db = 'error';
    }
  }
  return { ok: true, version: env.BUILD_VERSION, environment: env.ENVIRONMENT, db };
}
