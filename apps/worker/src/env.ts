import type { D1Database, Fetcher } from '@cloudflare/workers-types';
import { DEFAULT_CURSOR_SECRET } from './domain/search';

export interface AppEnv {
  DB?: D1Database | undefined;
  ASSETS?: Fetcher | undefined;
  ENVIRONMENT: string;
  BUILD_VERSION: string;
  MAX_BODY_BYTES: number;
  CURSOR_SECRET?: string | undefined;
  UPLOAD_LIMITER?: Fetcher | undefined;
  ADMIN_SECRET?: string | undefined;
}

export function resolveAppEnv(bindings: Record<string, unknown>): AppEnv {
  const maxBody = Number(bindings.MAX_BODY_BYTES ?? 512 * 1024);
  const environment = String(bindings.ENVIRONMENT ?? 'local');
  const configuredCursorSecret = typeof bindings.CURSOR_SECRET === 'string' ? bindings.CURSOR_SECRET : '';
  if ((environment === 'staging' || environment === 'production') && configuredCursorSecret.length < 16) throw new Error('CURSOR_SECRET must be configured with at least 16 characters');
  return {
    DB: bindings.DB as D1Database | undefined,
    ASSETS: bindings.ASSETS as Fetcher | undefined,
    ENVIRONMENT: environment,
    BUILD_VERSION: String(bindings.BUILD_VERSION ?? 'dev'),
    MAX_BODY_BYTES: Number.isFinite(maxBody) && maxBody > 0 ? maxBody : 512 * 1024,
    CURSOR_SECRET: configuredCursorSecret.length >= 16 ? configuredCursorSecret : DEFAULT_CURSOR_SECRET,
    UPLOAD_LIMITER: bindings.UPLOAD_LIMITER as Fetcher | undefined,
    ADMIN_SECRET: bindings.ADMIN_SECRET as string | undefined,
  };
}
