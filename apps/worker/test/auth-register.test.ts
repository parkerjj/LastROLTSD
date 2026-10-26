import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveAuthConfig } from '../src/auth/config';
import { createAccountService } from '../src/auth/account-service';
import type { AuthBindings } from '../src/auth/types';
import type { AuthRepository, AuthSecurityEventInput, AuthTx } from '../src/auth/repository';
import type { AppEnv } from '../src/env';

function standardBase64(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bindings(): AppEnv & AuthBindings {
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: standardBase64(1), AUTH_CSRF_SECRET: standardBase64(2),
    AUTH_RATE_SECRET: standardBase64(3), AUTH_MAIL_PAYLOAD_SECRET: standardBase64(4),
  };
}

describe('account registration', () => {
  it('stores a browser-generated WebP inside registration before outbox and audit writes', async () => {
    const avatarBase64 = readFileSync(new URL('../../../tests/fixtures/auth/avatar-256-browser.webp', import.meta.url)).toString('base64');
    const calls: string[] = [];
    const auditEvents: AuthSecurityEventInput[] = [];
    let storedAvatar: { userId: string; base64: string | null } | null = null;
    const user = {
      id: '10000', email: 'pilot@example.test', emailNormalized: 'pilot@example.test', displayName: 'Pilot',
      status: 'PENDING_EMAIL', emailVerifiedAt: null, credentialVersion: 1, authVersion: 1,
      avatarVersion: 0, createdAt: 1_000, updatedAt: 1_000,
    };
    const transaction = async <T>(work: (tx: AuthTx) => Promise<T>): Promise<T> => {
      calls.push('transaction:start');
      const result = await work({
        insertUser: async () => { calls.push('insertUser'); return user; },
        insertCredential: async () => { calls.push('insertCredential'); },
        insertAction: async () => { calls.push('insertAction'); },
        saveAvatar: async (userId: string, base64: string | null) => {
          calls.push('saveAvatar');
          storedAvatar = { userId, base64 };
        },
        insertMailJob: async () => { calls.push('insertMailJob'); },
        appendEvent: async (input: AuthSecurityEventInput) => {
          calls.push('appendEvent:' + input.event);
          auditEvents.push(input);
        },
      } as unknown as AuthTx);
      calls.push('transaction:commit');
      return result;
    };
    const repository = {
      readMailAvailability: async () => {
        calls.push('readMailAvailability');
        return { code: 'AVAILABLE', retry_at: null };
      },
      transaction,
    } as unknown as AuthRepository;
    const service = createAccountService(repository, resolveAuthConfig(bindings()), {
      now: () => 1_000, fetch: globalThis.fetch,
    });

    await expect(service.register({
      email: 'pilot@example.test', password: '12345', password_confirmation: '12345',
      display_name: 'Pilot', avatar_base64: avatarBase64, requestId: 'avatar-registration-request',
    })).resolves.toEqual({
      response: { accepted: true, mail_availability: { code: 'AVAILABLE', retry_at: null } },
      userId: '10000',
    });

    expect(storedAvatar).toEqual({ userId: '10000', base64: avatarBase64 });
    expect(calls).toEqual([
      'readMailAvailability', 'transaction:start', 'insertUser', 'insertCredential', 'insertAction',
      'saveAvatar', 'insertMailJob', 'appendEvent:REGISTER', 'appendEvent:AVATAR_UPDATED', 'transaction:commit',
    ]);
    expect(auditEvents).toEqual([
      {
        userId: '10000', event: 'REGISTER', requestId: 'avatar-registration-request',
        result: 'SUCCESS', reason: null, createdAt: 1_000,
      },
      {
        userId: '10000', event: 'AVATAR_UPDATED', requestId: 'avatar-registration-request',
        result: 'SUCCESS', reason: 'avatar_version=1', createdAt: 1_000,
      },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain(avatarBase64);
  });

  it('rejects a malformed registration avatar before touching the repository', async () => {
    const service = createAccountService({} as AuthRepository, resolveAuthConfig(bindings()), {
      now: () => 1_000, fetch: globalThis.fetch,
    });

    await expect(service.register({
      email: 'pilot@example.test', password: '12345', password_confirmation: '12345',
      display_name: 'Pilot', avatar_base64: 'AA==',
    })).rejects.toMatchObject({ code: 'AUTH_AVATAR_UNSUPPORTED', status: 415 });
  });
});
