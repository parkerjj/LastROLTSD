import { requireAuthConfig } from './config';
import { AuthFailure, type AuthConfig, type AuthIdentity, type CsrfMode } from './types';

const ANONYMOUS_MAX_AGE_MS = 30 * 60 * 1000;
const COOKIE_MAX_AGE_SECONDS = 30 * 60;
const LOCAL_COOKIE_NAME = 'lastroweb-csrf-local';
const HOST_COOKIE_NAME = '__Host-ltsd-csrf';
const UTF8 = new TextEncoder();

function invalidCsrf(): AuthFailure {
  return new AuthFailure('AUTH_CSRF_INVALID', 403, '请求校验失败');
}

function unavailable(): AuthFailure {
  return new AuthFailure('AUTH_UNAVAILABLE', 503, '账号服务暂不可用');
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/gu, '+').replace(/_/gu, '/') + '=');
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.byteLength === 32 && encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function cookiePolicy(config: AuthConfig): { name: string; secure: boolean } {
  requireAuthConfig(config);
  try {
    const url = new URL(config.authSiteUrl);
    if (url.protocol === 'https:') return { name: HOST_COOKIE_NAME, secure: true };
    if (url.protocol === 'http:' && isLoopback(url.hostname)) return { name: LOCAL_COOKIE_NAME, secure: false };
  } catch {
    throw unavailable();
  }
  throw unavailable();
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const values = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(name.length + 1);
  return decodeBase64Url(value) ? value : null;
}

function assertOptionalTrustedOrigin(request: Request, config: AuthConfig): void {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase();
  if (fetchSite === 'cross-site') throw invalidCsrf();
  if (origin !== null && !isTrustedOrigin(origin, config)) throw invalidCsrf();
}

function assertTrustedWriteOrigin(request: Request, config: AuthConfig): void {
  const origin = request.headers.get('origin');
  if (!origin || request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site' || !isTrustedOrigin(origin, config)) {
    throw invalidCsrf();
  }
}

function isTrustedOrigin(origin: string, config: AuthConfig): boolean {
  requireAuthConfig(config);
  if (origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.origin !== config.authSiteUrl) return false;
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback(parsed.hostname));
  } catch {
    return false;
  }
}

function anonymousMessage(origin: string, nonce: string, issuedAt: number): Uint8Array {
  return UTF8.encode(`ltsd-csrf-v1\0anonymous\0${origin}\0${nonce}\0${issuedAt}`);
}

function sessionMessage(origin: string, sessionDigest: Uint8Array): Uint8Array {
  return UTF8.encode(`ltsd-csrf-v1\0session\0${origin}\0${encodeBase64Url(sessionDigest)}`);
}

async function sign(message: Uint8Array, secret: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, toArrayBuffer(message)));
}

async function verify(message: Uint8Array, signature: Uint8Array, secret: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, toArrayBuffer(signature), toArrayBuffer(message));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function issueCsrf(
  request: Request,
  config: AuthConfig,
  mode: CsrfMode,
  identity?: AuthIdentity,
  now: () => number = Date.now,
): Promise<{ token: string; cookie?: string }> {
  requireAuthConfig(config);
  assertOptionalTrustedOrigin(request, config);
  if (mode === 'session') {
    if (!identity || identity.sessionDigest.byteLength !== 32) throw invalidCsrf();
    const signature = await sign(sessionMessage(config.authSiteUrl, identity.sessionDigest), config.csrfSecret);
    return { token: `v1.s.${encodeBase64Url(signature)}` };
  }

  const policy = cookiePolicy(config);
  const existingNonce = readCookie(request, policy.name);
  const nonce = existingNonce ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const issuedAt = now();
  const signature = await sign(anonymousMessage(config.authSiteUrl, nonce, issuedAt), config.csrfSecret);
  if (existingNonce) return { token: `v1.a.${issuedAt}.${encodeBase64Url(signature)}` };

  const cookie = `${policy.name}=${nonce}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; HttpOnly;${policy.secure ? ' Secure;' : ''} SameSite=Lax`;
  return { token: `v1.a.${issuedAt}.${encodeBase64Url(signature)}`, cookie };
}

export async function assertCsrf(
  request: Request,
  config: AuthConfig,
  mode: CsrfMode,
  identity?: AuthIdentity,
  now: () => number = Date.now,
): Promise<void> {
  requireAuthConfig(config);
  assertTrustedWriteOrigin(request, config);
  const token = request.headers.get('x-csrf-token');
  if (!token) throw invalidCsrf();

  if (mode === 'session') {
    if (!identity || identity.sessionDigest.byteLength !== 32) throw invalidCsrf();
    const match = /^v1\.s\.([A-Za-z0-9_-]{43})$/u.exec(token);
    const signature = match?.[1] ? decodeBase64Url(match[1]) : null;
    if (!signature || !(await verify(sessionMessage(config.authSiteUrl, identity.sessionDigest), signature, config.csrfSecret))) {
      throw invalidCsrf();
    }
    return;
  }

  const match = /^v1\.a\.(0|[1-9]\d*)\.([A-Za-z0-9_-]{43})$/u.exec(token);
  if (!match?.[1] || !match[2]) throw invalidCsrf();
  const issuedAt = Number(match[1]);
  const currentTime = now();
  if (!Number.isSafeInteger(issuedAt) || issuedAt > currentTime || currentTime - issuedAt > ANONYMOUS_MAX_AGE_MS) throw invalidCsrf();

  const policy = cookiePolicy(config);
  const nonce = readCookie(request, policy.name);
  const signature = decodeBase64Url(match[2]);
  if (!nonce || !signature || !(await verify(anonymousMessage(config.authSiteUrl, nonce, issuedAt), signature, config.csrfSecret))) {
    throw invalidCsrf();
  }
}
