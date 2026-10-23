import type { AppEnv } from '../env';
import { createMysqlDatabase, type MysqlConfig, type MysqlDatabase } from './mysql-client';

type MysqlBindings = Pick<AppEnv, 'MYSQL_URL' | 'MYSQL_CONNECTION_MODE' | 'HYPERDRIVE'>;

function connectionSource(env: MysqlBindings): string | MysqlConfig | undefined {
  const mode = env.MYSQL_CONNECTION_MODE ?? 'auto';
  if (!['auto', 'direct', 'hyperdrive'].includes(mode)) {
    throw new Error('MYSQL_CONNECTION_MODE must be auto, direct, or hyperdrive');
  }
  if (mode === 'hyperdrive' && !env.HYPERDRIVE) throw new Error('HYPERDRIVE binding is required in hyperdrive mode');
  if (mode !== 'direct' && env.HYPERDRIVE) {
    const { host, port, user, password, database } = env.HYPERDRIVE;
    if (!host || !user || !database || typeof password !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('HYPERDRIVE binding has invalid MySQL connection parameters');
    }
    // The Worker-to-Hyperdrive transport is internal. Origin TLS is managed by
    // Hyperdrive, independently of MYSQL_URL's direct-connection SSL options.
    return { host, port, user, password, database, ssl: false };
  }
  return env.MYSQL_URL?.trim() ? env.MYSQL_URL : undefined;
}

export function hasMysqlConnection(env: MysqlBindings): boolean {
  return connectionSource(env) !== undefined;
}

export function createWorkerDatabase(env: MysqlBindings): MysqlDatabase | undefined {
  const source = connectionSource(env);
  return source === undefined ? undefined : createMysqlDatabase(source, typeof source === 'string' ? 'prepared' : 'text');
}
