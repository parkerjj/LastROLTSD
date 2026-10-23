import type { AppEnv } from '../env';
import { hasMysqlConnection } from '../db/mysql-connection';
import { MysqlDatabaseError, type MysqlDatabase } from '../db/mysql-client';
import { logError } from '../observability';

export async function healthPayload(env: AppEnv, database?: Pick<MysqlDatabase, 'healthcheck'>): Promise<{ ok: true; version: string; environment: string; db: 'unconfigured' | 'ok' | 'error' }> {
  let db: 'unconfigured' | 'ok' | 'error' = 'unconfigured';
  if (hasMysqlConnection(env)) {
    try {
      if (!database) throw new Error('database is unavailable');
      await database.healthcheck();
      db = 'ok';
    } catch (error) {
      if (error instanceof MysqlDatabaseError) logError('lastroweb.mysql_health_error', error, { code: error.code, errno: error.errno, sql_state: error.sqlState });
      db = 'error';
    }
  }
  return { ok: true, version: env.BUILD_VERSION, environment: env.ENVIRONMENT, db };
}
