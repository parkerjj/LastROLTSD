import { isProxyOriginRequest, trustedProxyClient } from '../network/trusted-proxy';
import type { AuthRepository } from './repository';
import type { AuthRateLimitRule } from './types';

const HOUR = 60 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const MINUTE = 60 * 1000;

export const AUTH_RATE_LIMITS = {
  registrationPerIp: { scope: 'registration_ip', limit: 10, windowMs: HOUR },
  mailPerEmail: { scope: 'mail_email', limit: 5, windowMs: HOUR },
  mailPerIp: { scope: 'mail_ip', limit: 20, windowMs: HOUR },
  loginPerEmail: { scope: 'login_email', limit: 10, windowMs: FIFTEEN_MINUTES },
  loginPerIp: { scope: 'login_ip', limit: 60, windowMs: FIFTEEN_MINUTES },
  sensitivePerSessionOrAction: { scope: 'sensitive_identity', limit: 10, windowMs: FIFTEEN_MINUTES },
  sensitivePerIp: { scope: 'sensitive_ip', limit: 60, windowMs: FIFTEEN_MINUTES },
  profilePerSession: { scope: 'profile_session', limit: 10, windowMs: MINUTE },
  mailCooldown: { scope: 'mail_cooldown', cooldownMs: MINUTE },
} as const;

export type AuthRateLimitKeyKind = 'email' | 'ip' | 'session' | 'action';

export async function authRateLimitKey(secret: Uint8Array, kind: AuthRateLimitKeyKind, value: string): Promise<Uint8Array> {
  if (secret.byteLength !== 32 || value.length < 1 || value.length > 512) throw new Error('invalid auth rate key input');
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = new TextEncoder().encode(`ltsd-auth-rate-${kind}-v1\0${value}`);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, toArrayBuffer(message)));
}

export function trustedAuthClientIp(request: Request, environment: string, proxySecret?: string): string {
  if (environment === 'production' && isProxyOriginRequest(request)) {
    return trustedProxyClient(request, environment, proxySecret)?.ip ?? 'unknown';
  }
  if (environment === 'production') {
    const cloudflareIp = request.headers.get('cf-connecting-ip')?.trim();
    if (cloudflareIp && cloudflareIp.length <= 64) return cloudflareIp;
  }

  if (environment === 'local') {
    try {
      const hostname = new URL(request.url).hostname;
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return hostname;
    } catch {
      return 'unknown';
    }
  }

  return 'unknown';
}

export async function consumeAuthRateLimit(
  repository: AuthRepository,
  rules: readonly AuthRateLimitRule[],
  now: () => number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  return repository.consumeAuthRateLimits(rules, now);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
