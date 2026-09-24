import type { Fetcher } from '@cloudflare/workers-types';
import { DEFAULT_CURSOR_SECRET } from './domain/search';
import type { SnapshotMessage } from './services/full-upload';

export interface AppEnv {
  MYSQL_URL?: string | undefined;
  ASSETS?: Fetcher | undefined;
  ENVIRONMENT: string;
  BUILD_VERSION: string;
  MAX_BODY_BYTES: number;
  CURSOR_SECRET?: string | undefined;
  GUESTBOOK_RATE_SECRET?: string | undefined;
  UPLOAD_LIMITER?: Fetcher | undefined;
  ADMIN_SECRET?: string | undefined;
  SNAPSHOT_QUEUE?: { send(message: SnapshotMessage): Promise<void> } | undefined;
  SNAPSHOT_QUEUE_DAILY_BUDGET?: number | undefined;
  SNAPSHOT_RECONCILE_BATCH_SIZE?: number | undefined;
}

export function resolveAppEnv(bindings: Record<string, unknown>): AppEnv {
  const maxBody = Number(bindings.MAX_BODY_BYTES ?? 512 * 1024);
  const environment = String(bindings.ENVIRONMENT ?? 'local');
  const configuredCursorSecret = typeof bindings.CURSOR_SECRET === 'string' ? bindings.CURSOR_SECRET : '';
  const guestbookRateSecret = typeof bindings.GUESTBOOK_RATE_SECRET === 'string' ? bindings.GUESTBOOK_RATE_SECRET : '';
  const mysqlUrl = typeof bindings.MYSQL_URL === 'string' && bindings.MYSQL_URL.trim() !== '' ? bindings.MYSQL_URL : undefined;
  if ((environment === 'staging' || environment === 'production') && !mysqlUrl) throw new Error('MYSQL_URL must be configured outside local environments');
  if ((environment === 'staging' || environment === 'production') && configuredCursorSecret.length < 16) throw new Error('CURSOR_SECRET must be configured with at least 16 characters');
  if ((environment === 'staging' || environment === 'production') && guestbookRateSecret.length < 32) throw new Error('GUESTBOOK_RATE_SECRET must be configured with at least 32 characters');
  return {
    MYSQL_URL: mysqlUrl,
    ASSETS: bindings.ASSETS as Fetcher | undefined,
    ENVIRONMENT: environment,
    BUILD_VERSION: String(bindings.BUILD_VERSION ?? 'dev'),
    MAX_BODY_BYTES: Number.isFinite(maxBody) && maxBody > 0 ? maxBody : 512 * 1024,
    CURSOR_SECRET: configuredCursorSecret.length >= 16 ? configuredCursorSecret : DEFAULT_CURSOR_SECRET,
    GUESTBOOK_RATE_SECRET: guestbookRateSecret.length >= 32 ? guestbookRateSecret : 'lastroweb-local-guestbook-rate-secret-v1',
    UPLOAD_LIMITER: bindings.UPLOAD_LIMITER as Fetcher | undefined,
    ADMIN_SECRET: bindings.ADMIN_SECRET as string | undefined,
    SNAPSHOT_QUEUE: bindings.SNAPSHOT_QUEUE as AppEnv['SNAPSHOT_QUEUE'],
    SNAPSHOT_QUEUE_DAILY_BUDGET: nonnegativeInteger(bindings.SNAPSHOT_QUEUE_DAILY_BUDGET, 9000),
    SNAPSHOT_RECONCILE_BATCH_SIZE: positiveInteger(bindings.SNAPSHOT_RECONCILE_BATCH_SIZE, 200),
  };
}

function nonnegativeInteger(value: unknown, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Snapshot configuration must be a nonnegative integer');
  return parsed;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = nonnegativeInteger(value, fallback);
  if (parsed === 0) throw new Error('Snapshot batch size must be positive');
  return parsed;
}
