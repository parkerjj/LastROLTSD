import { requireAuthConfig } from './config';
import { validatePassword } from './input';
import { AuthFailure, type AuthConfig, type CredentialSnapshot, type EnabledAuthConfig, type MailPayloadContext, type PasswordMaterial, type SealedMailPayload } from './types';

const PASSWORD_SCHEME = 'hmac-sha256-v1' as const;
const PASSWORD_MESSAGE_PREFIX = new TextEncoder().encode('ltsd-password-v1\0');
const MAIL_PAYLOAD_MAX_BYTES = 8192;
const MAIL_PAYLOAD_TAG_BYTES = 16;
const MAIL_PAYLOAD_MAX_CIPHERTEXT_BYTES = MAIL_PAYLOAD_MAX_BYTES + MAIL_PAYLOAD_TAG_BYTES;
const MAIL_PAYLOAD_PURPOSES = new Set(['VERIFY_EMAIL', 'RESET_PASSWORD', 'PASSWORD_CHANGED']);

function unavailable(): AuthFailure {
  return new AuthFailure('AUTH_UNAVAILABLE', 503, '账号服务暂不可用');
}

function invalidToken(): AuthFailure {
  return new AuthFailure('INVALID_TOKEN', 400, '令牌无效');
}

function unreadableMailPayload(): AuthFailure {
  return new AuthFailure('MAIL_PAYLOAD_UNREADABLE', 503, '邮件任务暂不可用');
}

function unavailableMailPayloadKey(): AuthFailure {
  return new AuthFailure('MAIL_PAYLOAD_KEY_UNAVAILABLE', 503, '邮件任务暂不可用');
}

function oversizedMailPayload(): AuthFailure {
  return new AuthFailure('MAIL_PAYLOAD_TOO_LARGE', 413, '邮件内容超出限制');
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxEncodedLength || value.length % 4 !== 0
    || !/^[A-Za-z0-9+\x2f]*={0,2}$/u.test(value)) {
    throw unreadableMailPayload();
  }
  try {
    const binary = atob(value);
    if (binary.length > maxBytes || btoa(binary) !== value) throw unreadableMailPayload();
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw unreadableMailPayload();
  }
}

function decodeOpaqueToken(token: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw invalidToken();
  try {
    const base64 = token.replace(/-/gu, '+').replace(/_/gu, '/') + '=';
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length !== 32 || encodeBase64Url(bytes) !== token) throw invalidToken();
    return bytes;
  } catch {
    throw invalidToken();
  }
}

function passwordMessage(password: string, salt: Uint8Array): Uint8Array {
  const passwordBytes = new TextEncoder().encode(password);
  const message = new Uint8Array(PASSWORD_MESSAGE_PREFIX.length + salt.length + passwordBytes.length);
  message.set(PASSWORD_MESSAGE_PREFIX, 0);
  message.set(salt, PASSWORD_MESSAGE_PREFIX.length);
  message.set(passwordBytes, PASSWORD_MESSAGE_PREFIX.length + salt.length);
  return message;
}

function mailAdditionalData(context: MailPayloadContext): Uint8Array {
  if (typeof context.mailId !== 'string' || context.mailId.length === 0 || !MAIL_PAYLOAD_PURPOSES.has(context.purpose)) {
    throw unreadableMailPayload();
  }
  return new TextEncoder().encode(JSON.stringify([context.mailId, context.purpose]));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function warnVerificationFailure(reason: 'unknown_scheme' | 'unknown_key_version' | 'invalid_material' | 'crypto_failure'): void {
  console.warn('auth_password_verification_unavailable', reason);
}

function passwordKey(config: EnabledAuthConfig, version: string): Uint8Array | undefined {
  return config.passwordKeys.get(version);
}

function mailPayloadKey(config: EnabledAuthConfig, version: string): Uint8Array | undefined {
  return config.mailPayloadKeys.get(version);
}

export async function createPasswordMaterial(password: string, config: AuthConfig): Promise<PasswordMaterial> {
  requireAuthConfig(config);
  validatePassword(password);
  const keyVersion = config.currentPasswordKeyVersion;
  const keyBytes = passwordKey(config, keyVersion);
  if (!keyBytes) throw unavailable();

  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, toArrayBuffer(passwordMessage(password, salt))));
    return { scheme: PASSWORD_SCHEME, salt, digest, keyVersion };
  } catch {
    throw unavailable();
  }
}

export async function verifyPassword(password: string, snapshot: CredentialSnapshot, config: AuthConfig): Promise<boolean> {
  requireAuthConfig(config);
  validatePassword(password);
  if (snapshot.scheme !== PASSWORD_SCHEME) {
    warnVerificationFailure('unknown_scheme');
    return false;
  }
  if (typeof snapshot.keyVersion !== 'string' || !snapshot.keyVersion || !passwordKey(config, snapshot.keyVersion)) {
    warnVerificationFailure('unknown_key_version');
    return false;
  }
  if (!(snapshot.salt instanceof Uint8Array) || snapshot.salt.length !== 16
    || !(snapshot.digest instanceof Uint8Array) || snapshot.digest.length !== 32) {
    warnVerificationFailure('invalid_material');
    return false;
  }

  try {
    const key = await crypto.subtle.importKey('raw', toArrayBuffer(passwordKey(config, snapshot.keyVersion)!), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, toArrayBuffer(snapshot.digest), toArrayBuffer(passwordMessage(password, snapshot.salt)));
  } catch {
    warnVerificationFailure('crypto_failure');
    throw unavailable();
  }
}

export function createOpaqueToken(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function digestToken(token: string): Promise<Uint8Array> {
  if (typeof token !== 'string') throw invalidToken();
  const tokenBytes = decodeOpaqueToken(token);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(tokenBytes)));
}

export async function sealMailPayload(
  plaintext: string,
  context: MailPayloadContext,
  config: AuthConfig,
): Promise<SealedMailPayload> {
  requireAuthConfig(config);
  if (typeof plaintext !== 'string') throw unreadableMailPayload();
  if (plaintext.length > MAIL_PAYLOAD_MAX_BYTES) throw oversizedMailPayload();
  const plaintextBytes = new TextEncoder().encode(plaintext);
  if (plaintextBytes.length > MAIL_PAYLOAD_MAX_BYTES) throw oversizedMailPayload();

  const keyVersion = config.currentMailPayloadKeyVersion;
  const keyBytes = mailPayloadKey(config, keyVersion);
  if (!keyBytes) throw unavailable();
  const additionalData = mailAdditionalData(context);

  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), { name: 'AES-GCM' }, false, ['encrypt']);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(additionalData),
      tagLength: 128,
    }, key, toArrayBuffer(plaintextBytes)));
    return { payloadCiphertext: encodeBase64(ciphertext), payloadIv: encodeBase64(iv), payloadKeyVersion: keyVersion };
  } catch {
    throw unavailable();
  }
}

export async function openMailPayload(
  sealed: SealedMailPayload,
  context: MailPayloadContext,
  config: AuthConfig,
): Promise<string> {
  requireAuthConfig(config);
  if (!sealed || typeof sealed !== 'object' || typeof sealed.payloadKeyVersion !== 'string' || !sealed.payloadKeyVersion) {
    console.warn('auth_mail_payload_key_unavailable');
    throw unavailableMailPayloadKey();
  }
  const keyBytes = mailPayloadKey(config, sealed.payloadKeyVersion);
  if (!keyBytes) {
    console.warn('auth_mail_payload_key_unavailable');
    throw unavailableMailPayloadKey();
  }

  const iv = decodeBase64(sealed.payloadIv, 12);
  const ciphertext = decodeBase64(sealed.payloadCiphertext, MAIL_PAYLOAD_MAX_CIPHERTEXT_BYTES);
  if (iv.length !== 12 || ciphertext.length < MAIL_PAYLOAD_TAG_BYTES) throw unreadableMailPayload();
  const additionalData = mailAdditionalData(context);

  try {
    const key = await crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(additionalData),
      tagLength: 128,
    }, key, toArrayBuffer(ciphertext));
    if (plaintext.byteLength > MAIL_PAYLOAD_MAX_BYTES) throw unreadableMailPayload();
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    throw unreadableMailPayload();
  }
}
