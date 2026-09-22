import type { AppEnv } from '../env';
import { MysqlDatabaseError, type MysqlDatabase } from '../db/mysql-client';

export async function healthPayload(env: AppEnv, database?: Pick<MysqlDatabase, 'healthcheck'>): Promise<{ ok: true; version: string; environment: string; db: 'unconfigured' | 'ok' | 'error' }> {
  let db: 'unconfigured' | 'ok' | 'error' = 'unconfigured';
  if (env.MYSQL_URL) {
    try {
      if (!database) throw new Error('database is unavailable');
      await database.healthcheck();
      db = 'ok';
    } catch (error) {
      if (error instanceof MysqlDatabaseError) console.error(JSON.stringify({ metric: 'lastroweb.mysql_health_error', code: error.code, errno: error.errno, sql_state: error.sqlState }));
      db = 'error';
    }
  }
  return { ok: true, version: env.BUILD_VERSION, environment: env.ENVIRONMENT, db };
}
