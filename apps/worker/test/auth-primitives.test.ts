import { describe, expect, it, vi } from 'vitest';
import { createOpaqueToken, createPasswordMaterial, digestToken, openMailPayload, sealMailPayload, verifyPassword } from '../src/auth/crypto';
import { resolveAuthConfig, requireAuthConfig } from '../src/auth/config';
import type { AppEnv } from '../src/env';
import type { AuthBindings, CredentialSnapshot, PasswordMaterial } from '../src/auth/types';
import { AuthFailure } from '../src/auth/types';

function standardBase64(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bindings(overrides: Partial<AuthBindings> = {}): AppEnv & AuthBindings {
  return {
    ENVIRONMENT: 'test',
    BUILD_VERSION: 'test',
    MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true',
    AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: standardBase64(1),
    AUTH_CSRF_SECRET: standardBase64(2),
    AUTH_RATE_SECRET: standardBase64(3),
    AUTH_MAIL_PAYLOAD_SECRET: standardBase64(4),
    ...overrides,
  };
}

function snapshot(material: PasswordMaterial, overrides: Partial<CredentialSnapshot> = {}): CredentialSnapshot {
  return {
    userId: '10000',
    status: 'PENDING_EMAIL',
    credentialVersion: 1,
    authVersion: 1,
    scheme: material.scheme,
    salt: material.salt,
    digest: material.digest,
    keyVersion: material.keyVersion,
    ...overrides,
  };
}

describe('native account crypto and auth configuration', () => {
  it('uses a fresh per-password salt and verifies only the matching password and pepper', async () => {
    const config = resolveAuthConfig(bindings());
    const first = await createPasswordMaterial('12345', config);
    const second = await createPasswordMaterial('12345', config);

    expect(first.salt).not.toEqual(second.salt);
    expect(first.digest).not.toEqual(second.digest);
    expect(first.scheme).toBe('hmac-sha256-v1');
    expect(await verifyPassword('12345', snapshot(first), config)).toBe(true);
    expect(await verifyPassword('wrong1', snapshot(first), config)).toBe(false);
    expect(await verifyPassword('12345', snapshot(first), resolveAuthConfig(bindings({ AUTH_PASSWORD_SECRET: standardBase64(9) })))).toBe(false);
  });

  it('writes with the current password key and verifies a previous-version snapshot only with its mapped key', async () => {
    const oldConfig = resolveAuthConfig(bindings());
    const oldMaterial = await createPasswordMaterial('hello1', oldConfig);
    const rotated = resolveAuthConfig(bindings({
      AUTH_PASSWORD_SECRET: standardBase64(9),
      AUTH_PASSWORD_KEY_VERSION: '2',
      AUTH_PASSWORD_PREVIOUS_SECRET: standardBase64(1),
      AUTH_PASSWORD_PREVIOUS_KEY_VERSION: '1',
      AUTH_MAIL_PAYLOAD_SECRET: standardBase64(8),
      AUTH_MAIL_PAYLOAD_KEY_VERSION: '2',
      AUTH_MAIL_PAYLOAD_PREVIOUS_SECRET: standardBase64(4),
      AUTH_MAIL_PAYLOAD_PREVIOUS_KEY_VERSION: '1',
    }));

    expect(rotated.passwordKeys.get('1')).toEqual(new Uint8Array(32).fill(1));
    expect(rotated.mailPayloadKeys.get('1')).toEqual(new Uint8Array(32).fill(4));
    expect(rotated.currentPasswordKeyVersion).toBe('2');
    expect(rotated.currentMailPayloadKeyVersion).toBe('2');
    expect(await verifyPassword('hello1', snapshot(oldMaterial), rotated)).toBe(true);

    const currentMaterial = await createPasswordMaterial('hello1', rotated);
    expect(currentMaterial.keyVersion).toBe('2');
    expect(await verifyPassword('hello1', snapshot(currentMaterial), rotated)).toBe(true);
    expect(await verifyPassword('hello1', snapshot(oldMaterial, { keyVersion: '2' }), rotated)).toBe(false);
  });

  it('seals with the current key, opens a previous version, and binds ciphertext to mail context and key version', async () => {
    const context = { mailId: '123e4567-e89b-12d3-a456-426614174000', purpose: 'VERIFY_EMAIL' as const };
    const oldConfig = resolveAuthConfig(bindings());
    const previousPayload = await sealMailPayload('verification payload', context, oldConfig);
    const rotated = resolveAuthConfig(bindings({
      AUTH_MAIL_PAYLOAD_SECRET: standardBase64(8),
      AUTH_MAIL_PAYLOAD_KEY_VERSION: '2',
      AUTH_MAIL_PAYLOAD_PREVIOUS_SECRET: standardBase64(4),
      AUTH_MAIL_PAYLOAD_PREVIOUS_KEY_VERSION: '1',
    }));

    expect(previousPayload.payloadKeyVersion).toBe('1');
    expect(await openMailPayload(previousPayload, context, rotated)).toBe('verification payload');

    const currentPayload = await sealMailPayload('new verification payload', context, rotated);
    expect(currentPayload.payloadKeyVersion).toBe('2');
    expect(await openMailPayload(currentPayload, context, rotated)).toBe('new verification payload');
    await expect(openMailPayload(currentPayload, { ...context, purpose: 'RESET_PASSWORD' }, rotated)).rejects.toMatchObject({
      code: 'MAIL_PAYLOAD_UNREADABLE',
      status: 503,
    });

    const mixedVersion = { ...currentPayload, payloadKeyVersion: '1' };
    await expect(openMailPayload(mixedVersion, context, rotated)).rejects.toMatchObject({ code: 'MAIL_PAYLOAD_UNREADABLE', status: 503 });
    const noPreviousKey = resolveAuthConfig(bindings({ AUTH_MAIL_PAYLOAD_SECRET: standardBase64(8), AUTH_MAIL_PAYLOAD_KEY_VERSION: '2' }));
    const before = { ...previousPayload };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(openMailPayload(previousPayload, context, noPreviousKey)).rejects.toMatchObject({
      code: 'MAIL_PAYLOAD_KEY_UNAVAILABLE',
      status: 503,
      });
      expect(previousPayload).toEqual(before);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(standardBase64(4));
    } finally {
      warn.mockRestore();
    }
  });

  it('bounds encrypted mail plaintext to 8192 UTF-8 bytes', async () => {
    const config = resolveAuthConfig(bindings());
    const context = { mailId: '123e4567-e89b-12d3-a456-426614174000', purpose: 'VERIFY_EMAIL' as const };
    const allowed = 'a'.repeat(8192);
    const sealed = await sealMailPayload(allowed, context, config);
    expect(await openMailPayload(sealed, context, config)).toBe(allowed);
    await expect(sealMailPayload(`${allowed}a`, context, config)).rejects.toMatchObject({ status: 413 });
  });

  it('fails closed for unknown schemes and key versions without logging credential material', async () => {
    const config = resolveAuthConfig(bindings());
    const material = await createPasswordMaterial('secret-password', config);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await verifyPassword('secret-password', snapshot(material, { scheme: 'sha1' }), config)).toBe(false);
      expect(await verifyPassword('secret-password', snapshot(material, { keyVersion: 'missing' }), config)).toBe(false);
      const warningText = JSON.stringify(warn.mock.calls);
      expect(warningText).not.toContain('secret-password');
      expect(warningText).not.toContain(standardBase64(1));
    } finally {
      warn.mockRestore();
    }
  });

  it('creates opaque 32-byte tokens and hashes decoded token bytes', async () => {
    const token = createOpaqueToken();
    const another = createOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(token).not.toBe(another);
    expect(token).not.toBe('10000');

    const decoded = Uint8Array.from(atob(token.replace(/-/gu, '+').replace(/_/gu, '/') + '='), (character) => character.charCodeAt(0));
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', decoded));
    expect(await digestToken(token)).toEqual(expected);
    await expect(digestToken('not a token')).rejects.toBeInstanceOf(AuthFailure);
  });

  it('defaults account auth to disabled and reports missing enabled secrets as a generic 503', () => {
    const disabledEnv = {
      ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
      MYSQL_URL: undefined,
    } as AppEnv & AuthBindings;
    const disabled = resolveAuthConfig(disabledEnv);
    expect(disabled.enabled).toBe(false);
    expect(() => requireAuthConfig(disabled)).toThrow(AuthFailure);

    const sensitiveSecret = 'private-rate-secret';
    try {
      resolveAuthConfig(bindings({ AUTH_PASSWORD_SECRET: undefined, AUTH_RATE_SECRET: sensitiveSecret }));
      throw new Error('Expected missing secret to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthFailure);
      expect(error).toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE' });
      expect((error as Error).message).not.toContain(sensitiveSecret);
    }
  });

  it('rejects incomplete or conflicting previous-key pairs without exposing secrets', () => {
    const secret = standardBase64(5);
    expect(() => resolveAuthConfig(bindings({ AUTH_PASSWORD_PREVIOUS_SECRET: secret }))).toThrow(AuthFailure);
    expect(() => resolveAuthConfig(bindings({
      AUTH_PASSWORD_KEY_VERSION: '2',
      AUTH_PASSWORD_PREVIOUS_KEY_VERSION: '2',
      AUTH_PASSWORD_PREVIOUS_SECRET: secret,
    }))).toThrow(AuthFailure);
    expect(() => resolveAuthConfig(bindings({ AUTH_RATE_SECRET: secret.slice(0, -4) }))).toThrow(AuthFailure);
  });

  it('uses positive mail limits no higher than the current free-plan defaults', () => {
    expect(resolveAuthConfig(bindings({ AUTH_MAIL_DAILY_LIMIT: '25', AUTH_MAIL_MONTHLY_LIMIT: '700' })))
      .toMatchObject({ mailDailyLimit: 25, mailMonthlyLimit: 700 });
    expect(resolveAuthConfig(bindings())).toMatchObject({ mailDailyLimit: 100, mailMonthlyLimit: 3000 });
    for (const value of ['0', '-1', '101', 'not-a-number']) {
      expect(() => resolveAuthConfig(bindings({ AUTH_MAIL_DAILY_LIMIT: value }))).toThrow(AuthFailure);
    }
    for (const value of ['0', '-1', '3001', 'not-a-number']) {
      expect(() => resolveAuthConfig(bindings({ AUTH_MAIL_MONTHLY_LIMIT: value }))).toThrow(AuthFailure);
    }
  });
});
