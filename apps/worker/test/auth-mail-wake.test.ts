import { describe, expect, it, vi } from 'vitest';
import { resolveAuthConfig } from '../src/auth/config';
import { createActionService } from '../src/auth/action-service';
import { createAccountService } from '../src/auth/account-service';
import { createMailWake, drainMail, isMailWakeMessage, MAIL_WAKE_MAX_SENDS, MAIL_WAKE_MESSAGE } from '../src/auth/mail-wake';
import type { AuthRepository, AuthTx } from '../src/auth/repository';
import type { AuthBindings, CredentialSnapshot } from '../src/auth/types';
import type { AppEnv } from '../src/env';

function secret(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function config() {
  const env: AppEnv & AuthBindings = {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2),
    AUTH_RATE_SECRET: secret(3), AUTH_MAIL_PAYLOAD_SECRET: secret(4),
  };
  return resolveAuthConfig(env);
}

describe('mail wake message', () => {
  it('accepts only the wake marker', () => {
    expect(isMailWakeMessage(MAIL_WAKE_MESSAGE)).toBe(true);
    expect(isMailWakeMessage({ kind: 'auth_mail_wake', extra: 1 })).toBe(true);
    expect(isMailWakeMessage({ sourceId: 's', snapshotId: 'x', generation: 1 })).toBe(false);
    expect(isMailWakeMessage(null)).toBe(false);
    expect(isMailWakeMessage('auth_mail_wake')).toBe(false);
  });
});

describe('createMailWake', () => {
  it('is absent without a queue binding', () => {
    expect(createMailWake(undefined, vi.fn())).toBeUndefined();
  });

  it('sends one wake message and keeps it alive through waitUntil', async () => {
    const send = vi.fn(async () => undefined);
    const waitUntil = vi.fn();

    createMailWake({ send }, waitUntil)!();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(MAIL_WAKE_MESSAGE);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
  });

  it('never throws or rejects when the queue is unavailable, leaving the outbox to Cron', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const waitUntil = vi.fn();
    const failing = { send: vi.fn(async () => { throw new Error('queue down'); }) };
    const throwing = { send: vi.fn(() => { throw new Error('binding broken'); }) };

    expect(() => createMailWake(failing, waitUntil)!()).not.toThrow();
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
    expect(() => createMailWake(throwing, waitUntil)!()).not.toThrow();
    expect(errorLog).toHaveBeenCalledTimes(2);
    errorLog.mockRestore();
  });

  it('still sends when the invocation exposes no waitUntil', async () => {
    const send = vi.fn(async () => undefined);
    createMailWake({ send })!();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('drainMail', () => {
  it('keeps sending while mail is delivered and stops at the first idle result', async () => {
    const sendOne = vi.fn()
      .mockResolvedValueOnce('sent').mockResolvedValueOnce('sent').mockResolvedValueOnce('idle');

    await expect(drainMail(sendOne, () => 1_000)).resolves.toEqual(['sent', 'sent', 'idle']);
    expect(sendOne).toHaveBeenCalledTimes(3);
  });

  it('stops immediately on any non-sent outcome so retries and pauses are not hammered', async () => {
    for (const outcome of ['retry', 'paused', 'failed', 'idle'] as const) {
      const sendOne = vi.fn(async () => outcome);
      await expect(drainMail(sendOne, () => 1_000)).resolves.toEqual([outcome]);
      expect(sendOne).toHaveBeenCalledTimes(1);
    }
  });

  it('caps one invocation so a large backlog is left to later wakeups and Cron', async () => {
    const sendOne = vi.fn(async () => 'sent' as const);

    const results = await drainMail(sendOne, () => 1_000);

    expect(results).toHaveLength(MAIL_WAKE_MAX_SENDS);
    expect(sendOne).toHaveBeenCalledTimes(MAIL_WAKE_MAX_SENDS);
  });

  it('reads the clock for every attempt', async () => {
    const times = [1_000, 2_000];
    const sendOne = vi.fn(async (_now: number) => 'sent' as const);
    let call = 0;
    await drainMail(sendOne, () => times[Math.min(call++, times.length - 1)]!);
    expect(sendOne.mock.calls.slice(0, 2).map(([now]) => now)).toEqual([1_000, 2_000]);
  });
});

describe('services wake the mail queue after the outbox commit', () => {
  const user = {
    id: '10000', email: 'pilot@example.test', emailNormalized: 'pilot@example.test', displayName: 'Pilot',
    status: 'ACTIVE', emailVerifiedAt: 1_000, credentialVersion: 1, authVersion: 1,
    avatarVersion: 0, createdAt: 1_000, updatedAt: 1_000,
  };

  it('wakes once after registration commits, not before', async () => {
    const calls: string[] = [];
    const repository = {
      readMailAvailability: async () => ({ code: 'AVAILABLE', retry_at: null }),
      transaction: async <T>(work: (tx: AuthTx) => Promise<T>): Promise<T> => {
        const result = await work({
          insertUser: async () => user,
          insertCredential: async () => undefined,
          insertAction: async () => undefined,
          insertMailJob: async () => { calls.push('insertMailJob'); },
          appendEvent: async () => undefined,
        } as unknown as AuthTx);
        calls.push('commit');
        return result;
      },
    } as unknown as AuthRepository;
    const service = createAccountService(repository, config(), {
      now: () => 1_000, fetch: globalThis.fetch, wakeMail: () => { calls.push('wake'); },
    });

    await service.register({
      email: 'pilot@example.test', password: '12345', password_confirmation: '12345',
      display_name: 'Pilot', requestId: 'wake-register',
    });

    expect(calls).toEqual(['insertMailJob', 'commit', 'wake']);
  });

  it('wakes after a password-reset request commits', async () => {
    const calls: string[] = [];
    const credential: CredentialSnapshot = {
      userId: '10000', status: 'ACTIVE', credentialVersion: 1, authVersion: 1,
      scheme: 'pbkdf2', salt: new Uint8Array(16), digest: new Uint8Array(32), keyVersion: '1',
    };
    const profile = { id: '10000', email: 'pilot@example.test', display_name: 'Pilot', status: 'ACTIVE' };
    const repository = {
      readMailAvailability: async () => ({ code: 'AVAILABLE', retry_at: null }),
      readCredentialByEmail: async () => credential,
      readProfile: async () => profile,
      transaction: async <T>(work: (tx: AuthTx) => Promise<T>): Promise<T> => {
        const result = await work({
          lockUser: async () => user,
          readCredential: async () => credential,
          insertAction: async () => undefined,
          insertMailJob: async () => { calls.push('insertMailJob'); },
          appendEvent: async () => undefined,
        } as unknown as AuthTx);
        calls.push('commit');
        return result;
      },
    } as unknown as AuthRepository;
    const service = createActionService(repository, config(), {
      now: () => 2_000, fetch: globalThis.fetch, wakeMail: () => { calls.push('wake'); },
    });

    await service.requestReset('pilot@example.test');

    expect(calls).toEqual(['insertMailJob', 'commit', 'wake']);
  });

  it('still works with no wake callback', async () => {
    const repository = {
      readMailAvailability: async () => ({ code: 'AVAILABLE', retry_at: null }),
      transaction: async <T>(work: (tx: AuthTx) => Promise<T>): Promise<T> => work({
        insertUser: async () => user, insertCredential: async () => undefined, insertAction: async () => undefined,
        insertMailJob: async () => undefined, appendEvent: async () => undefined,
      } as unknown as AuthTx),
    } as unknown as AuthRepository;
    const service = createAccountService(repository, config(), { now: () => 1_000, fetch: globalThis.fetch });

    await expect(service.register({
      email: 'pilot@example.test', password: '12345', password_confirmation: '12345',
      display_name: 'Pilot', requestId: 'no-wake',
    })).resolves.toMatchObject({ accepted: true });
  });
});
