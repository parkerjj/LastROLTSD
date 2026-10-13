import type { AppEnv } from '../env';
import { AuthFailure, type AuthBindings, type AuthConfig, type DisabledAuthConfig, type EnabledAuthConfig, type MailDeliveryConfig } from './types';

const UNAVAILABLE_MESSAGE = '账号服务暂不可用';

function unavailable(): AuthFailure {
  return new AuthFailure('AUTH_UNAVAILABLE', 503, UNAVAILABLE_MESSAGE);
}

function emptyKeyVersions(): ReadonlyMap<string, Uint8Array> {
  return new Map<string, Uint8Array>();
}

function disabledConfig(): DisabledAuthConfig {
  return {
    enabled: false,
    mysqlUrl: null,
    authSiteUrl: null,
    csrfSecret: null,
    rateSecret: null,
    passwordKeys: emptyKeyVersions(),
    mailPayloadKeys: emptyKeyVersions(),
    currentPasswordKeyVersion: '1',
    currentMailPayloadKeyVersion: '1',
  };
}

function isEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === '' || normalized === 'false') return false;
  if (normalized === 'true') return true;
  throw unavailable();
}

function requiredValue(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0) throw unavailable();
  return value;
}

function optionalMailApiKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length <= 512 && !/\s/u.test(normalized) ? normalized : null;
}

function optionalMailbox(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 320 || /[\r\n]/u.test(normalized)) return null;
  const address = /^(?:[^<>\r\n]{1,120}\s+)?<[^<>\s@]+@[^<>\s@]+>$|^[^<>\s@]+@[^<>\s@]+$/u;
  return address.test(normalized) ? normalized : null;
}

function mailDeliveryConfig(env: AppEnv & AuthBindings): MailDeliveryConfig {
  return {
    apiKey: optionalMailApiKey(env.RESEND_API_KEY),
    from: optionalMailbox(env.MAIL_FROM),
    replyTo: optionalMailbox(env.MAIL_REPLY_TO),
  };
}

function decodeSecret(value: string | undefined): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) throw unavailable();
  try {
    const binary = atob(value);
    if (binary.length !== 32 || btoa(binary) !== value) throw unavailable();
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw unavailable();
  }
}

function keyVersion(value: string | undefined, fallback: string): string {
  const version = value ?? fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/u.test(version)) throw unavailable();
  return version;
}

function optionalPreviousKey(versionValue: string | undefined, secretValue: string | undefined, currentVersion: string): [string, Uint8Array] | null {
  const hasVersion = typeof versionValue === 'string' && versionValue.trim().length > 0;
  const hasSecret = typeof secretValue === 'string' && secretValue.length > 0;
  if (hasVersion !== hasSecret) throw unavailable();
  if (!hasVersion || !hasSecret) return null;

  const version = keyVersion(versionValue, '');
  if (version === currentVersion) throw unavailable();
  return [version, decodeSecret(secretValue)];
}

function keyMap(currentVersion: string, currentSecret: string | undefined, previous: [string, Uint8Array] | null): ReadonlyMap<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>([[currentVersion, decodeSecret(currentSecret)]]);
  if (previous) keys.set(previous[0], previous[1]);
  return keys;
}

function trustedSiteOrigin(value: string | undefined, environment: string): string {
  try {
    const url = new URL(requiredValue(value));
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw unavailable();
    const secure = url.protocol === 'https:';
    const loopbackHttp = url.protocol === 'http:' && environment === 'local'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
    if (!secure && !loopbackHttp) throw unavailable();
    return url.origin;
  } catch {
    throw unavailable();
  }
}

function assertIndependentSecrets(secrets: readonly Uint8Array[]): void {
  const encodings = secrets.map((secret) => {
    let binary = '';
    for (const byte of secret) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  if (new Set(encodings).size !== encodings.length) throw unavailable();
}

export function resolveAuthConfig(env: AppEnv & AuthBindings): AuthConfig {
  if (!isEnabled(env.AUTH_ENABLED)) return disabledConfig();

  const mysqlUrl = requiredValue(env.MYSQL_URL).trim();
  if (!mysqlUrl) throw unavailable();
  const authSiteUrl = trustedSiteOrigin(env.AUTH_SITE_URL, env.ENVIRONMENT);
  const currentPasswordKeyVersion = keyVersion(env.AUTH_PASSWORD_KEY_VERSION, '1');
  const currentMailPayloadKeyVersion = keyVersion(env.AUTH_MAIL_PAYLOAD_KEY_VERSION, '1');
  const previousPassword = optionalPreviousKey(env.AUTH_PASSWORD_PREVIOUS_KEY_VERSION, env.AUTH_PASSWORD_PREVIOUS_SECRET, currentPasswordKeyVersion);
  const previousMailPayload = optionalPreviousKey(env.AUTH_MAIL_PAYLOAD_PREVIOUS_KEY_VERSION, env.AUTH_MAIL_PAYLOAD_PREVIOUS_SECRET, currentMailPayloadKeyVersion);
  const passwordKeys = keyMap(currentPasswordKeyVersion, env.AUTH_PASSWORD_SECRET, previousPassword);
  const mailPayloadKeys = keyMap(currentMailPayloadKeyVersion, env.AUTH_MAIL_PAYLOAD_SECRET, previousMailPayload);
  const csrfSecret = decodeSecret(env.AUTH_CSRF_SECRET);
  const rateSecret = decodeSecret(env.AUTH_RATE_SECRET);
  assertIndependentSecrets([
    ...passwordKeys.values(),
    ...mailPayloadKeys.values(),
    csrfSecret,
    rateSecret,
  ]);

  const config: EnabledAuthConfig = {
    enabled: true,
    mysqlUrl,
    authSiteUrl,
    csrfSecret,
    rateSecret,
    passwordKeys,
    mailPayloadKeys,
    currentPasswordKeyVersion,
    currentMailPayloadKeyVersion,
    mailDelivery: mailDeliveryConfig(env),
  };
  return config;
}

export function requireAuthConfig(config: AuthConfig): asserts config is EnabledAuthConfig {
  if (!config.enabled) throw unavailable();
}
