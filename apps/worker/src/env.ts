import type { Fetcher, Hyperdrive } from '@cloudflare/workers-types';
import { hasMysqlConnection } from './db/mysql-connection';
import { DEFAULT_CURSOR_SECRET } from './domain/search';
import type { SnapshotMessage } from './services/full-upload';
import type { AuthBindings } from './auth/types';
import type { MailWakeQueue } from './auth/mail-wake';
import type { KeBindings } from './ke/types';

export interface AppEnv extends AuthBindings, KeBindings {
  MYSQL_URL?: string | undefined;
  MYSQL_CONNECTION_MODE?: 'auto' | 'direct' | 'hyperdrive' | undefined;
  HYPERDRIVE?: Pick<Hyperdrive, 'host' | 'port' | 'user' | 'password' | 'database'> | undefined;
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
  /** 账号邮件唤醒队列；缺省时只靠 Cron 兜底发送。 */
  MAIL_QUEUE?: MailWakeQueue | undefined;
  /** Chrome IWA Update Manifest（updates.json）的公开 URL；用于解析最新 Release 安装包地址。 */
  IWA_UPDATES_MANIFEST_URL?: string | undefined;
  /** KoreEngine 脱机版发行清单（releases.json）的公开 URL；缺省时使用 LTSD 的固定地址。 */
  KE_STANDALONE_MANIFEST_URL?: string | undefined;
  /** 爱发电开放平台 API token（机密，仅经 wrangler secret / 本地 .dev.vars 注入，缺省时打赏接口返回 503）。 */
  AFDIAN_TOKEN?: string | undefined;
  /** 爱发电创作者 user_id（公开值，缺省时使用 LTSD_RO 内置的默认值）。 */
  AFDIAN_USER_ID?: string | undefined;
  /** Stripe Secret Key（机密，仅经 wrangler secret / 本地 .dev.vars 注入；缺省时 Stripe 渠道静默跳过，光荣榜降级为纯爱发电）。 */
  STRIPE_SECRET_KEY?: string | undefined;
  /** Stripe Payment Link 公开 donate URL（缺省时使用 LTSD_RO 内置的常量值）。 */
  STRIPE_DONATE_URL?: string | undefined;
}

export function resolveAppEnv(bindings: Record<string, unknown>): AppEnv {
  const maxBody = Number(bindings.MAX_BODY_BYTES ?? 512 * 1024);
  const environment = String(bindings.ENVIRONMENT ?? 'local');
  const configuredCursorSecret = typeof bindings.CURSOR_SECRET === 'string' ? bindings.CURSOR_SECRET : '';
  const guestbookRateSecret = typeof bindings.GUESTBOOK_RATE_SECRET === 'string' ? bindings.GUESTBOOK_RATE_SECRET : '';
  const mysqlUrl = typeof bindings.MYSQL_URL === 'string' && bindings.MYSQL_URL.trim() !== '' ? bindings.MYSQL_URL : undefined;
  const mysqlBindings = {
    MYSQL_URL: mysqlUrl,
    MYSQL_CONNECTION_MODE: (bindings.MYSQL_CONNECTION_MODE ?? 'auto') as AppEnv['MYSQL_CONNECTION_MODE'],
    HYPERDRIVE: bindings.HYPERDRIVE as AppEnv['HYPERDRIVE'],
  };
  const configuredDatabase = hasMysqlConnection(mysqlBindings);
  if ((environment === 'staging' || environment === 'production') && !configuredDatabase) throw new Error('MYSQL_URL must be configured outside local environments unless HYPERDRIVE is bound');
  if ((environment === 'staging' || environment === 'production') && configuredCursorSecret.length < 16) throw new Error('CURSOR_SECRET must be configured with at least 16 characters');
  if ((environment === 'staging' || environment === 'production') && guestbookRateSecret.length < 32) throw new Error('GUESTBOOK_RATE_SECRET must be configured with at least 32 characters');
  return {
    ...mysqlBindings,
    ASSETS: bindings.ASSETS as Fetcher | undefined,
    ENVIRONMENT: environment,
    BUILD_VERSION: String(bindings.BUILD_VERSION ?? 'dev'),
    MAX_BODY_BYTES: Number.isFinite(maxBody) && maxBody > 0 ? maxBody : 512 * 1024,
    CURSOR_SECRET: configuredCursorSecret.length >= 16 ? configuredCursorSecret : DEFAULT_CURSOR_SECRET,
    GUESTBOOK_RATE_SECRET: guestbookRateSecret.length >= 32 ? guestbookRateSecret : 'lastroweb-local-guestbook-rate-secret-v1',
    UPLOAD_LIMITER: bindings.UPLOAD_LIMITER as Fetcher | undefined,
    ADMIN_SECRET: bindings.ADMIN_SECRET as string | undefined,
    SNAPSHOT_QUEUE: bindings.SNAPSHOT_QUEUE as AppEnv['SNAPSHOT_QUEUE'],
    MAIL_QUEUE: bindings.MAIL_QUEUE as AppEnv['MAIL_QUEUE'],
    SNAPSHOT_QUEUE_DAILY_BUDGET: nonnegativeInteger(bindings.SNAPSHOT_QUEUE_DAILY_BUDGET, 9000),
    SNAPSHOT_RECONCILE_BATCH_SIZE: positiveInteger(bindings.SNAPSHOT_RECONCILE_BATCH_SIZE, 200),
    IWA_UPDATES_MANIFEST_URL: typeof bindings.IWA_UPDATES_MANIFEST_URL === 'string' && bindings.IWA_UPDATES_MANIFEST_URL.trim() !== '' ? bindings.IWA_UPDATES_MANIFEST_URL.trim() : undefined,
    KE_STANDALONE_MANIFEST_URL: typeof bindings.KE_STANDALONE_MANIFEST_URL === 'string' && bindings.KE_STANDALONE_MANIFEST_URL.trim() !== '' ? bindings.KE_STANDALONE_MANIFEST_URL.trim() : undefined,
    AFDIAN_TOKEN: typeof bindings.AFDIAN_TOKEN === 'string' && bindings.AFDIAN_TOKEN.trim() !== '' ? bindings.AFDIAN_TOKEN.trim() : undefined,
    AFDIAN_USER_ID: typeof bindings.AFDIAN_USER_ID === 'string' && bindings.AFDIAN_USER_ID.trim() !== '' ? bindings.AFDIAN_USER_ID.trim() : undefined,
    STRIPE_SECRET_KEY: typeof bindings.STRIPE_SECRET_KEY === 'string' && bindings.STRIPE_SECRET_KEY.trim() !== '' ? bindings.STRIPE_SECRET_KEY.trim() : undefined,
    STRIPE_DONATE_URL: typeof bindings.STRIPE_DONATE_URL === 'string' && bindings.STRIPE_DONATE_URL.trim() !== '' ? bindings.STRIPE_DONATE_URL.trim() : undefined,
    AUTH_ENABLED: typeof bindings.AUTH_ENABLED === 'string' ? bindings.AUTH_ENABLED : undefined,
    AUTH_SITE_URL: typeof bindings.AUTH_SITE_URL === 'string' ? bindings.AUTH_SITE_URL : undefined,
    AUTH_PASSWORD_SECRET: typeof bindings.AUTH_PASSWORD_SECRET === 'string' ? bindings.AUTH_PASSWORD_SECRET : undefined,
    AUTH_PASSWORD_KEY_VERSION: typeof bindings.AUTH_PASSWORD_KEY_VERSION === 'string' ? bindings.AUTH_PASSWORD_KEY_VERSION : undefined,
    AUTH_PASSWORD_PREVIOUS_KEY_VERSION: typeof bindings.AUTH_PASSWORD_PREVIOUS_KEY_VERSION === 'string' ? bindings.AUTH_PASSWORD_PREVIOUS_KEY_VERSION : undefined,
    AUTH_PASSWORD_PREVIOUS_SECRET: typeof bindings.AUTH_PASSWORD_PREVIOUS_SECRET === 'string' ? bindings.AUTH_PASSWORD_PREVIOUS_SECRET : undefined,
    AUTH_CSRF_SECRET: typeof bindings.AUTH_CSRF_SECRET === 'string' ? bindings.AUTH_CSRF_SECRET : undefined,
    AUTH_RATE_SECRET: typeof bindings.AUTH_RATE_SECRET === 'string' ? bindings.AUTH_RATE_SECRET : undefined,
    AUTH_MAIL_PAYLOAD_SECRET: typeof bindings.AUTH_MAIL_PAYLOAD_SECRET === 'string' ? bindings.AUTH_MAIL_PAYLOAD_SECRET : undefined,
    AUTH_MAIL_PAYLOAD_KEY_VERSION: typeof bindings.AUTH_MAIL_PAYLOAD_KEY_VERSION === 'string' ? bindings.AUTH_MAIL_PAYLOAD_KEY_VERSION : undefined,
    AUTH_MAIL_PAYLOAD_PREVIOUS_KEY_VERSION: typeof bindings.AUTH_MAIL_PAYLOAD_PREVIOUS_KEY_VERSION === 'string' ? bindings.AUTH_MAIL_PAYLOAD_PREVIOUS_KEY_VERSION : undefined,
    AUTH_MAIL_PAYLOAD_PREVIOUS_SECRET: typeof bindings.AUTH_MAIL_PAYLOAD_PREVIOUS_SECRET === 'string' ? bindings.AUTH_MAIL_PAYLOAD_PREVIOUS_SECRET : undefined,
    RESEND_API_KEY: typeof bindings.RESEND_API_KEY === 'string' ? bindings.RESEND_API_KEY : undefined,
    MAIL_FROM: typeof bindings.MAIL_FROM === 'string' ? bindings.MAIL_FROM : undefined,
    MAIL_REPLY_TO: typeof bindings.MAIL_REPLY_TO === 'string' ? bindings.MAIL_REPLY_TO : undefined,
    AUTH_MAIL_DAILY_LIMIT: typeof bindings.AUTH_MAIL_DAILY_LIMIT === 'string' ? bindings.AUTH_MAIL_DAILY_LIMIT : undefined,
    AUTH_MAIL_MONTHLY_LIMIT: typeof bindings.AUTH_MAIL_MONTHLY_LIMIT === 'string' ? bindings.AUTH_MAIL_MONTHLY_LIMIT : undefined,
    AUTH_MAIL_CF_MONTHLY_LIMIT: typeof bindings.AUTH_MAIL_CF_MONTHLY_LIMIT === 'string' ? bindings.AUTH_MAIL_CF_MONTHLY_LIMIT : undefined,
    SEND_EMAIL: bindings.SEND_EMAIL as AppEnv['SEND_EMAIL'],
    KE_LICENSE_PRIVATE_KEY_v1: typeof bindings.KE_LICENSE_PRIVATE_KEY_v1 === 'string' ? bindings.KE_LICENSE_PRIVATE_KEY_v1 : undefined,
    KE_LICENSE_KEY_VERSION: typeof bindings.KE_LICENSE_KEY_VERSION === 'string' ? bindings.KE_LICENSE_KEY_VERSION : undefined,
    KE_CORE_KEY: typeof bindings.KE_CORE_KEY === 'string' ? bindings.KE_CORE_KEY : undefined,
    KE_CORE_KEY_VERSION: typeof bindings.KE_CORE_KEY_VERSION === 'string' ? bindings.KE_CORE_KEY_VERSION : undefined,
    KE_NETWORK_KEY: typeof bindings.KE_NETWORK_KEY === 'string' ? bindings.KE_NETWORK_KEY : undefined,
    KE_NETWORK_KEY_VERSION: typeof bindings.KE_NETWORK_KEY_VERSION === 'string' ? bindings.KE_NETWORK_KEY_VERSION : undefined,
    KE_BUILD_MANIFEST: typeof bindings.KE_BUILD_MANIFEST === 'string' ? bindings.KE_BUILD_MANIFEST : undefined,
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
