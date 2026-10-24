import { describe, expect, it, vi } from 'vitest';
import { resolveAuthConfig } from '../src/auth/config';
import { preparePasswordChangedMail } from '../src/auth/mail';
import { runAuthJobTick } from '../src/auth/jobs';
import type { MailFinishResult } from '../src/auth/repository';
import type { AppEnv } from '../src/env';
import type { AuthBindings, ClaimedMailJob, MailAttemptContext, MailReservation, SealedMailPayload } from '../src/auth/types';

const NOW = Date.UTC(2026, 9, 13, 12);

function secret(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function config(apiKey?: string) {
  const env: AppEnv & AuthBindings = {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2),
    AUTH_RATE_SECRET: secret(3), AUTH_MAIL_PAYLOAD_SECRET: secret(4),
    ...(apiKey ? { RESEND_API_KEY: apiKey, MAIL_FROM: 'LTSD <auth@example.test>' } : {}),
  };
  return resolveAuthConfig(env);
}

async function claimedMail(): Promise<ClaimedMailJob> {
  const draft = await preparePasswordChangedMail({
    mailId: '123e4567-e89b-12d3-a456-426614174081',
    userId: '10000', email: 'pilot@example.test', displayName: 'Pilot', createdAt: NOW,
  }, config('re_test-key'));
  return {
    ...draft,
    state: 'CLAIMED', leaseId: 'lease-1', leaseUntil: NOW + 60_000,
    attemptCount: 0, nextAttemptAt: NOW, firstAttemptAt: null,
    providerMessageId: null, lastErrorCode: null,
  };
}

type TickClaim = { kind: 'claimed'; job: ClaimedMailJob } | { kind: 'cleaned' } | { kind: 'idle' };

/** 依次返回给定的领取结果，用完后一直返回最后一个。 */
function tickRepository(claimResults: TickClaim | TickClaim[], cleanupCount = 0) {
  const queue = Array.isArray(claimResults) ? [...claimResults] : [claimResults];
  const claimOneMailForTick = vi.fn(async () => (queue.length > 1 ? queue.shift()! : queue[0]!));
  const cleanupAuthBatch = vi.fn(async (_now: number, _limit: number) => cleanupCount);
  const readMailAvailability = vi.fn(async () => ({ code: 'AVAILABLE' as const, retry_at: null }));
  const freezeMailPayload = vi.fn(async (
    _id: string, _leaseId: string, _expected: SealedMailPayload, _frozen: SealedMailPayload, _observedAt: number,
  ) => true);
  const finishes: MailFinishResult[] = [];
  const finishMail = vi.fn(async (_id: string, _leaseId: string, result: MailFinishResult) => {
    finishes.push(result);
    return true;
  });
  const reserveMailAttempt = vi.fn(async (_id: string, _leaseId: string, readNow: () => number): Promise<MailReservation> => {
    const reservedAt = readNow();
    const date = new Date(reservedAt);
    return {
      status: 'reserved',
      attempt: {
        provider: 'resend',
        reservedAt,
        dayBucketStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
        monthBucketStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      },
    };
  });
  const recordProviderQuota = vi.fn(async () => ({ pauseRecorded: true, jobUpdated: true }));
  const repository = {
    claimOneMailForTick, cleanupAuthBatch, readMailAvailability, freezeMailPayload,
    finishMail, reserveMailAttempt, recordProviderQuota,
  } as unknown as Parameters<typeof runAuthJobTick>[0];
  return { repository, claimOneMailForTick, cleanupAuthBatch, freezeMailPayload, finishMail, reserveMailAttempt, recordProviderQuota, finishes };
}

describe('auth background job tick', () => {
  it('sends one claimed mail and does not add cleanup work to the same tick', async () => {
    const job = await claimedMail();
    const repository = tickRepository([{ kind: 'claimed', job }, { kind: 'idle' }]);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'email_accepted_1' }), { status: 200 }));

    const result = await runAuthJobTick(repository.repository, config('re_test-key'), { now: () => NOW, fetch: fetch as typeof globalThis.fetch });

    expect(result).toEqual({ kind: 'mail', result: 'sent' });
    expect(repository.claimOneMailForTick).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(repository.cleanupAuthBatch).not.toHaveBeenCalled();
    expect(repository.finishes).toMatchObject([{ status: 'sent', providerMessageId: 'email_accepted_1' }]);
  });

  it('drains at most five mails per tick', async () => {
    const job = await claimedMail();
    const repository = tickRepository({ kind: 'claimed', job });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'email_accepted_n' }), { status: 200 }));

    const result = await runAuthJobTick(repository.repository, config('re_test-key'), { now: () => NOW, fetch: fetch as typeof globalThis.fetch });

    expect(result).toEqual({ kind: 'mail', result: 'sent' });
    expect(repository.claimOneMailForTick).toHaveBeenCalledTimes(5);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('keeps draining past a failed mail but stops once delivery pauses', async () => {
    const job = await claimedMail();
    const repository = tickRepository({ kind: 'claimed', job });
    const responses = [
      new Response(JSON.stringify({ name: 'validation_error' }), { status: 422 }),
      new Response(JSON.stringify({ id: 'email_accepted_2' }), { status: 200 }),
      new Response(JSON.stringify({ name: 'unauthorized' }), { status: 401 }),
    ];
    const fetch = vi.fn(async () => responses.shift()!);

    const result = await runAuthJobTick(repository.repository, config('re_test-key'), { now: () => NOW, fetch: fetch as typeof globalThis.fetch });

    expect(result).toEqual({ kind: 'mail', result: 'paused' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(repository.finishes.map((entry) => entry.status)).toEqual(['failed', 'sent', 'paused']);
    expect(repository.cleanupAuthBatch).not.toHaveBeenCalled();
  });

  it('treats an expired outbox cleanup as this tick’s work and does not clean another category', async () => {
    const repository = tickRepository({ kind: 'cleaned' });

    const result = await runAuthJobTick(repository.repository, config('re_test-key'), { now: () => NOW, fetch: vi.fn() as unknown as typeof globalThis.fetch });

    expect(result.kind).toBe('cleanup');
    expect(repository.claimOneMailForTick).toHaveBeenCalledTimes(1);
    expect(repository.cleanupAuthBatch).not.toHaveBeenCalled();
  });

  it('skips delivery without Resend credentials but still runs one capped cleanup batch', async () => {
    const repository = tickRepository({ kind: 'idle' }, 4);
    const fetch = vi.fn();

    const result = await runAuthJobTick(repository.repository, config(), { now: () => NOW, fetch: fetch as typeof globalThis.fetch });

    expect(result.kind).toBe('cleanup');
    expect(repository.claimOneMailForTick).not.toHaveBeenCalled();
    expect(repository.cleanupAuthBatch).toHaveBeenCalledTimes(1);
    expect(repository.cleanupAuthBatch).toHaveBeenCalledWith(NOW, 50);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not open background work when account auth is disabled', async () => {
    const repository = tickRepository({ kind: 'idle' }, 4);
    const disabled = resolveAuthConfig({
      ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
      AUTH_ENABLED: 'false',
    } as AppEnv & AuthBindings);

    const result = await runAuthJobTick(repository.repository, disabled, { now: () => NOW, fetch: vi.fn() as unknown as typeof globalThis.fetch });

    expect(result.kind).toBe('idle');
    expect(repository.claimOneMailForTick).not.toHaveBeenCalled();
    expect(repository.cleanupAuthBatch).not.toHaveBeenCalled();
  });

  it('runs one cleanup batch only when mail is idle', async () => {
    const repository = tickRepository({ kind: 'idle' }, 0);

    const result = await runAuthJobTick(repository.repository, config('re_test-key'), { now: () => NOW, fetch: vi.fn() as unknown as typeof globalThis.fetch });

    expect(result).toEqual({ kind: 'idle', result: expect.any(String) });
    expect(repository.cleanupAuthBatch).toHaveBeenCalledTimes(1);
    expect(repository.cleanupAuthBatch).toHaveBeenCalledWith(NOW, 50);
  });
});
