import { describe, expect, it, vi } from 'vitest';
import { resolveAuthConfig } from '../src/auth/config';
import { createOpaqueToken, openMailPayload, sealMailPayload } from '../src/auth/crypto';
import { createMailDispatcher, prepareActionMail, preparePasswordChangedMail } from '../src/auth/mail';
import type { MailRepository, MailFinishResult } from '../src/auth/repository';
import type { AppEnv } from '../src/env';
import type { AuthBindings, ClaimedMailJob, MailAttemptContext, MailAvailability, MailPurpose, MailReservation, NewMailJob, SealedMailPayload } from '../src/auth/types';

type MailBindingOverrides = Partial<AuthBindings> & {
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  MAIL_REPLY_TO?: string;
};

function standardBase64(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function authConfig(overrides: MailBindingOverrides = {}) {
  const env: AppEnv & AuthBindings = {
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
  return resolveAuthConfig(env);
}

interface MailIntent {
  kind: 'intent';
  to: string[];
  subject: string;
  html: string;
  text: string;
}

async function readIntent(job: Awaited<ReturnType<typeof prepareActionMail>> | Awaited<ReturnType<typeof preparePasswordChangedMail>>): Promise<MailIntent> {
  return JSON.parse(await openMailPayload(job, { mailId: job.id, purpose: job.purpose }, authConfig())) as MailIntent;
}

class FakeMailRepository implements MailRepository {
  private job: NewMailJob;
  private state: 'PENDING' | 'CLAIMED' | 'SENT' | 'FAILED' | 'CANCELLED' = 'PENDING';
  private leaseId: string | null = null;
  private leaseUntil = 0;
  private attemptCount = 0;
  private firstAttemptAt: number | null = null;
  private nextAttemptAt: number;
  private leaseSequence = 0;
  private claims = 0;
  readonly requests: Array<{ leaseId: string; sealed: SealedMailPayload }> = [];
  readonly finishes: MailFinishResult[] = [];
  readonly quotaKinds: Array<'daily' | 'monthly'> = [];
  crashBeforeSentFinish = false;
  availability: MailAvailability = { code: 'AVAILABLE', retry_at: null };

  constructor(job: NewMailJob) {
    this.job = { ...job };
    this.nextAttemptAt = job.createdAt;
  }

  get reservedAttempts(): number {
    return this.attemptCount;
  }

  get claimCount(): number {
    return this.claims;
  }

  async claimOneMail(now: number, leaseMs: number): Promise<ClaimedMailJob | null> {
    if (this.state === 'CLAIMED' && this.leaseUntil <= now) this.state = 'PENDING';
    if (this.state !== 'PENDING' || this.nextAttemptAt > now || this.job.expiresAt <= now) return null;
    this.claims += 1;
    this.state = 'CLAIMED';
    this.leaseId = `lease-${++this.leaseSequence}`;
    this.leaseUntil = now + leaseMs;
    return {
      ...this.job,
      state: 'CLAIMED',
      leaseId: this.leaseId,
      leaseUntil: this.leaseUntil,
      attemptCount: this.attemptCount,
      nextAttemptAt: this.nextAttemptAt,
      firstAttemptAt: this.firstAttemptAt,
      providerMessageId: null,
      lastErrorCode: null,
    };
  }

  async freezeMailPayload(id: string, leaseId: string, expected: SealedMailPayload, frozen: SealedMailPayload, observedAt: number): Promise<boolean> {
    if (id !== this.job.id || leaseId !== this.leaseId || this.state !== 'CLAIMED'
      || this.leaseUntil <= observedAt || this.attemptCount !== 0
      || expected.payloadCiphertext !== this.job.payloadCiphertext || expected.payloadIv !== this.job.payloadIv
      || expected.payloadKeyVersion !== this.job.payloadKeyVersion) return false;
    this.requests.push({ leaseId, sealed: { ...frozen } });
    this.job = { ...this.job, ...frozen };
    return true;
  }

  async finishMail(id: string, leaseId: string, result: MailFinishResult): Promise<boolean> {
    this.finishes.push(result);
    if (id !== this.job.id || leaseId !== this.leaseId || this.state !== 'CLAIMED' || this.leaseUntil <= result.observedAt) return false;
    if (result.status === 'sent' && this.crashBeforeSentFinish) {
      this.crashBeforeSentFinish = false;
      throw new Error('simulated outbox finish crash');
    }
    if (result.status === 'sent') this.state = 'SENT';
    else if (result.status === 'failed') this.state = 'FAILED';
    else {
      this.state = 'PENDING';
      this.nextAttemptAt = result.status === 'retry' || result.status === 'paused' ? result.nextAttemptAt : result.observedAt;
    }
    this.leaseId = null;
    return true;
  }

  async reserveMailAttempt(_id: string, leaseId: string, now: () => number): Promise<MailReservation> {
    const reservedAt = now();
    if (leaseId !== this.leaseId || this.state !== 'CLAIMED' || this.leaseUntil <= reservedAt) return { status: 'stale' };
    this.attemptCount += 1;
    if (this.firstAttemptAt === null) this.firstAttemptAt = reservedAt;
    return { status: 'reserved', attempt: this.attemptContext(reservedAt) };
  }

  async readMailAvailability(_now: number): Promise<MailAvailability> {
    return this.availability;
  }

  async recordProviderQuota(
    _id: string,
    leaseId: string,
    kind: 'daily' | 'monthly',
    _attempt: MailAttemptContext,
    _observedAt: number,
  ): Promise<{ pauseRecorded: boolean; jobUpdated: boolean }> {
    this.quotaKinds.push(kind);
    if (leaseId === this.leaseId && this.state === 'CLAIMED') this.state = 'FAILED';
    return { pauseRecorded: true, jobUpdated: leaseId === this.leaseId };
  }

  private attemptContext(reservedAt: number): MailAttemptContext {
    const date = new Date(reservedAt);
    return {
      reservedAt,
      dayBucketStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
      monthBucketStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    };
  }
}

describe('account mail preparation', () => {
  it('keeps account auth enabled when optional Resend delivery configuration is absent', async () => {
    const config = authConfig();
    const job = await preparePasswordChangedMail({
      mailId: '123e4567-e89b-12d3-a456-426614174008',
      userId: '10000', email: 'pilot@example.test', displayName: 'Pilot', createdAt: 1_800_000_000_000,
    }, config);
    const repository = new FakeMailRepository(job);
    const fetch = vi.fn();

    expect(config.enabled).toBe(true);
    expect(Reflect.get(config, 'mailDelivery')).toEqual({ apiKey: null, from: null, replyTo: null });
    expect(await createMailDispatcher(repository, config, { now: () => 1_800_000_000_000, fetch: fetch as typeof globalThis.fetch })
      .sendOne(1_800_000_000_000)).toBe('paused');
    expect(repository.claimCount).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { purpose: 'VERIFY_EMAIL' as const, path: '/verify-email', lifetime: '24 小时', ttl: 24 * 60 * 60 * 1000 },
    { purpose: 'RESET_PASSWORD' as const, path: '/reset-password', lifetime: '30 分钟', ttl: 30 * 60 * 1000 },
  ])('builds the $purpose link and retains its exact authorization expiry', async ({ purpose, path, lifetime, ttl }) => {
    const config = authConfig();
    const token = createOpaqueToken();
    const input = {
      mailId: `123e4567-e89b-12d3-a456-${purpose === 'VERIFY_EMAIL' ? '426614174001' : '426614174002'}`,
      actionDigest: new Uint8Array(32).fill(7),
      userId: '10000',
      email: 'pilot@example.test',
      displayName: '<pilot>',
      token,
      purpose,
      createdAt: 1_800_000_000_000,
      expiresAt: 1_800_000_000_000 + ttl,
    };

    const job = await prepareActionMail(input, config);
    const intent = await readIntent(job);
    const rendered = `${intent.html}\n${intent.text}`;

    expect(job.purpose).toBe(purpose satisfies MailPurpose);
    expect(job.expiresAt).toBe(input.expiresAt);
    expect(intent.to).toEqual(['pilot@example.test']);
    expect(rendered).toContain(`https://lastro.example${path}#token=${token}`);
    expect(rendered).toContain(lifetime);
    expect(rendered).not.toContain('secret-password');
    expect(job.payloadCiphertext).not.toContain(token);
  });

  it('escapes the nickname in HTML instead of treating it as markup', async () => {
    const input = {
      mailId: '123e4567-e89b-12d3-a456-426614174003',
      actionDigest: new Uint8Array(32).fill(8),
      userId: '10000',
      email: 'pilot@example.test',
      displayName: '<img src=x onerror=alert(1)>',
      token: createOpaqueToken(),
      purpose: 'VERIFY_EMAIL' as const,
      createdAt: 1_800_000_000_000,
      expiresAt: 1_800_000_000_000 + 24 * 60 * 60 * 1000,
    };

    const intent = await readIntent(await prepareActionMail(input, authConfig()));

    expect(intent.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(intent.html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('queues a password-change notice without an action token', async () => {
    const createdAt = 1_800_000_000_000;
    const job = await preparePasswordChangedMail({
      mailId: '123e4567-e89b-12d3-a456-426614174004',
      userId: '10000',
      email: 'pilot@example.test',
      displayName: 'Pilot',
      createdAt,
    }, authConfig());
    const intent = await readIntent(job);

    expect(job.purpose).toBe('PASSWORD_CHANGED');
    expect(job.priority).toBe(0);
    expect(job.actionDigest).toBeNull();
    expect(job.expiresAt).toBe(createdAt + 24 * 60 * 60 * 1000);
    expect(`${intent.html}\n${intent.text}`).toContain('密码已修改');
    expect(`${intent.html}\n${intent.text}`).not.toContain('#token=');
  });

  it('reuses the frozen request body and idempotency key after an unknown timeout', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_800_000_000_000;
      const oldConfig = authConfig({
        RESEND_API_KEY: 're_old-key',
        MAIL_FROM: 'LTSD <auth@old.example.test>',
        MAIL_REPLY_TO: 'help@old.example.test',
      });
      const changedConfig = authConfig({
        RESEND_API_KEY: 're_rotated-key',
        MAIL_FROM: 'LTSD <auth@new.example.test>',
        MAIL_REPLY_TO: 'help@new.example.test',
      });
      const job = await preparePasswordChangedMail({
        mailId: '123e4567-e89b-12d3-a456-426614174005',
        userId: '10000', email: 'pilot@example.test', displayName: 'Pilot', createdAt: now,
      }, oldConfig);
      const repository = new FakeMailRepository(job);
      let signalFetchStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => { signalFetchStarted = resolve; });
      const firstFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signalFetchStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true });
        });
      });
      const runtime = { now: () => now, fetch: firstFetch as typeof fetch };
      const firstSend = createMailDispatcher(repository, oldConfig, runtime).sendOne(now);
      await fetchStarted;
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await firstSend).toBe('retry');
      const firstRequest = firstFetch.mock.calls[0]!;
      const firstBody = String(firstRequest[1]?.body);
      const firstKey = new Headers(firstRequest[1]?.headers).get('Idempotency-Key');
      expect(firstKey).toBe(`ltsd-auth/${job.id}`);
      expect(repository.finishes[0]?.status).toBe('retry');

      now = repository.finishes[0]!.status === 'retry' ? repository.finishes[0]!.nextAttemptAt : now;
      const secondFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
        JSON.stringify({ id: 'email_provider_accepted_1' }), { status: 200 },
      ));
      const secondSend = createMailDispatcher(repository, changedConfig, { now: () => now, fetch: secondFetch as typeof fetch });
      expect(await secondSend.sendOne(now)).toBe('sent');
      const secondRequest = secondFetch.mock.calls[0]!;
      expect(String(secondRequest[1]?.body)).toBe(firstBody);
      expect(new Headers(secondRequest[1]?.headers).get('Idempotency-Key')).toBe(firstKey);
      expect(JSON.parse(firstBody)).toMatchObject({ from: 'LTSD <auth@old.example.test>', reply_to: 'help@old.example.test' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses the same body and idempotency key when Resend accepted before outbox finish crashed', async () => {
    let now = 1_800_000_000_000;
    const firstConfig = authConfig({
      RESEND_API_KEY: 're_old-key', MAIL_FROM: 'LTSD <auth@old.example.test>', MAIL_REPLY_TO: 'help@old.example.test',
    });
    const changedConfig = authConfig({
      RESEND_API_KEY: 're_rotated-key', MAIL_FROM: 'LTSD <auth@new.example.test>', MAIL_REPLY_TO: 'help@new.example.test',
    });
    const job = await preparePasswordChangedMail({
      mailId: '123e4567-e89b-12d3-a456-426614174012',
      userId: '10000', email: 'pilot@example.test', displayName: 'Pilot', createdAt: now,
    }, firstConfig);
    const repository = new FakeMailRepository(job);
    repository.crashBeforeSentFinish = true;
    const firstFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ id: 'email_accepted_before_db_crash' }), { status: 200 },
    ));
    const firstDispatcher = createMailDispatcher(repository, firstConfig, { now: () => now, fetch: firstFetch as typeof globalThis.fetch });

    await expect(firstDispatcher.sendOne(now)).rejects.toThrow('simulated outbox finish crash');
    const firstRequest = firstFetch.mock.calls[0]!;
    const firstBody = String(firstRequest[1]?.body);
    const firstKey = new Headers(firstRequest[1]?.headers).get('Idempotency-Key');

    now += 30_001;
    const secondFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ id: 'email_accepted_before_db_crash' }), { status: 200 },
    ));
    const secondDispatcher = createMailDispatcher(repository, changedConfig, { now: () => now, fetch: secondFetch as typeof globalThis.fetch });
    expect(await secondDispatcher.sendOne(now)).toBe('sent');
    const secondRequest = secondFetch.mock.calls[0]!;
    expect(String(secondRequest[1]?.body)).toBe(firstBody);
    expect(new Headers(secondRequest[1]?.headers).get('Idempotency-Key')).toBe(firstKey);
    expect(repository.reservedAttempts).toBe(2);
  });

  it.each([
    { name: 'daily_quota_exceeded', kind: 'daily' as const, expected: 'paused' as const },
    { name: 'monthly_quota_exceeded', kind: 'monthly' as const, expected: 'paused' as const },
    { name: 'rate_limit_exceeded', kind: null, expected: 'retry' as const },
  ])('classifies Resend 429 $name by provider error name', async ({ name, kind, expected }) => {
    const now = 1_800_000_000_000;
    const config = authConfig({ RESEND_API_KEY: 're_test-key', MAIL_FROM: 'LTSD <auth@example.test>' });
    const job = await preparePasswordChangedMail({
      mailId: '123e4567-e89b-12d3-a456-426614174006',
      userId: '10000', email: 'pilot@example.test', displayName: 'Pilot', createdAt: now,
    }, config);
    const repository = new FakeMailRepository(job);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ name }), { status: 429 }));

    const result = await createMailDispatcher(repository, config, { now: () => now, fetch: fetch as typeof globalThis.fetch }).sendOne(now);

    expect(result).toBe(expected);
    expect(repository.quotaKinds).toEqual(kind ? [kind] : []);
    expect(repository.finishes.map((entry) => entry.status)).toEqual(kind ? [] : ['retry']);
  });

  it.each([
    { name: 'concurrent_idempotent_requests', expected: 'retry' as const, finish: 'retry' as const },
    { name: 'invalid_idempotent_request', expected: 'failed' as const, finish: 'failed' as const },
    { name: 'some_other_conflict', expected: 'failed' as const, finish: 'failed' as const },
  ])('handles Resend 409 $name without retrying permanent conflicts', async ({ name, expected, finish }) => {
    const now = 1_800_000_000_000;
    const config = authConfig({ RESEND_API_KEY: 're_test-key', MAIL_FROM: 'LTSD <auth@example.test>' });
    const job = await preparePasswordChangedMail({
      mailId: '123e4567-e89b-12d3-a456-426614174010',
      userId: '10000', email: 'pilot@example.test', displayName: 'Pilot', createdAt: now,
    }, config);
    const repository = new FakeMailRepository(job);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ name }), { status: 409 }));

    expect(await createMailDispatcher(repository, config, { now: () => now, fetch: fetch as typeof globalThis.fetch }).sendOne(now)).toBe(expected);
    expect(repository.finishes.map((entry) => entry.status)).toEqual([finish]);
  });

  it('pauses a provider authentication error until the job expires without repeating HTTP', async () => {
    const now = 1_800_000_000_000;
    const config = authConfig({ RESEND_API_KEY: 're_misconfigured-key', MAIL_FROM: 'LTSD <auth@example.test>' });
    const job = await preparePasswordChangedMail({
      mailId: '123e4567-e89b-12d3-a456-426614174011',
      userId: '10000', email: 'pilot@example.test', displayName: 'Pilot', createdAt: now,
    }, config);
    const repository = new FakeMailRepository(job);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ name: 'invalid_api_key' }), { status: 401 }));
    const dispatcher = createMailDispatcher(repository, config, { now: () => now, fetch: fetch as typeof globalThis.fetch });

    expect(await dispatcher.sendOne(now)).toBe('paused');
    expect(repository.finishes[0]).toMatchObject({ status: 'paused', errorCode: 'MAIL_PROVIDER_AUTH', nextAttemptAt: job.expiresAt });
    expect(await dispatcher.sendOne(now)).toBe('idle');
    expect(repository.reservedAttempts).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps ciphertext queued when its old mail key is unavailable and never fetches', async () => {
    const createdAt = 1_800_000_000_000;
    const oldConfig = authConfig({ RESEND_API_KEY: 're_old-key', MAIL_FROM: 'LTSD <auth@example.test>' });
    const job = await preparePasswordChangedMail({
      mailId: '123e4567-e89b-12d3-a456-426614174007',
      userId: '10000', email: 'pilot@example.test', displayName: 'Pilot', createdAt,
    }, oldConfig);
    const rotatedConfig = authConfig({
      AUTH_MAIL_PAYLOAD_SECRET: standardBase64(8),
      AUTH_MAIL_PAYLOAD_KEY_VERSION: '2',
      RESEND_API_KEY: 're_new-key',
      MAIL_FROM: 'LTSD <auth@example.test>',
    });
    const repository = new FakeMailRepository(job);
    const fetch = vi.fn();

    expect(await createMailDispatcher(repository, rotatedConfig, { now: () => createdAt, fetch: fetch as typeof globalThis.fetch }).sendOne(createdAt)).toBe('paused');

    expect(fetch).not.toHaveBeenCalled();
    expect(repository.reservedAttempts).toBe(0);
  });

  it('permanently rejects mail ciphertext bound to a different purpose before fetch', async () => {
    const now = 1_800_000_000_000;
    const config = authConfig({ RESEND_API_KEY: 're_test-key', MAIL_FROM: 'LTSD <auth@example.test>' });
    const job = await preparePasswordChangedMail({
      mailId: '123e4567-e89b-12d3-a456-426614174013',
      userId: '10000', email: 'pilot@example.test', displayName: 'Pilot', createdAt: now,
    }, config);
    const wrongContextPayload = await sealMailPayload('not the password-change intent', {
      mailId: job.id, purpose: 'RESET_PASSWORD',
    }, config);
    const repository = new FakeMailRepository({ ...job, ...wrongContextPayload });
    const fetch = vi.fn();

    expect(await createMailDispatcher(repository, config, { now: () => now, fetch: fetch as typeof globalThis.fetch }).sendOne(now)).toBe('failed');
    expect(repository.finishes).toMatchObject([{ status: 'failed', errorCode: 'MAIL_PAYLOAD_UNREADABLE' }]);
    expect(repository.reservedAttempts).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not consume an attempt or send an oversized provider error response', async () => {
    const now = 1_800_000_000_000;
    const config = authConfig({ RESEND_API_KEY: 're_test-key', MAIL_FROM: 'LTSD <auth@example.test>' });
    const job = await preparePasswordChangedMail({
      mailId: '123e4567-e89b-12d3-a456-426614174009',
      userId: '10000', email: 'pilot@example.test', displayName: 'Pilot', createdAt: now,
    }, config);
    const repository = new FakeMailRepository(job);
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8_193).fill(65));
        controller.close();
      },
    }), { status: 500 }));

    expect(await createMailDispatcher(repository, config, { now: () => now, fetch: fetch as typeof globalThis.fetch }).sendOne(now)).toBe('retry');
    expect(repository.reservedAttempts).toBe(1);
    expect(repository.finishes[0]?.status).toBe('retry');
  });
});
