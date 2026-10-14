import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createAuthRepository } from '../../apps/worker/src/auth/repository';
import { resolveAuthConfig } from '../../apps/worker/src/auth/config';
import { createOpaqueToken, createPasswordMaterial, digestToken } from '../../apps/worker/src/auth/crypto';
import { issueCsrf } from '../../apps/worker/src/auth/csrf';
import type { EnabledAuthConfig } from '../../apps/worker/src/auth/types';
import type { MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const runBenchmark = process.env.AUTH_CPU_BENCHMARK === '1';
const siteUrl = 'http://127.0.0.1:8787';
const resetClockTime = 600_000;

interface SampleSet {
  name: string;
  wallSamplesMs: number[];
  localCpuSamplesMs: number[];
  remoteCpuSamplesMs: number[];
  coldConfirmation: string;
}

describe('local full Worker account CPU approximation', () => {
  it.skipIf(!runBenchmark)('records synthetic auth flows through the Worker entry and dedicated MySQL', async () => {
    const mysqlTestUrl = process.env.MYSQL_TEST_URL;
    const reportPath = process.env.AUTH_CPU_BENCHMARK_REPORT;
    if (process.env.REQUIRE_AUTH_MYSQL_TESTS !== '1' || process.env.AUTH_TEST_DB_ALLOW_RESET !== '1'
      || !mysqlTestUrl || process.env.MYSQL_URL !== undefined || !isPrivateReportPath(reportPath)) {
      throw new Error('AUTH_BENCHMARK_GUARDS_REQUIRED');
    }

    await withAuthTestDatabase(async ({ database }) => {
      const workerBindings = {
        MYSQL_URL: mysqlTestUrl,
        ENVIRONMENT: 'local',
        BUILD_VERSION: process.env.AUTH_CPU_BUILD_SHA ?? 'unknown',
        MAX_BODY_BYTES: 512 * 1024,
        AUTH_ENABLED: 'true',
        AUTH_SITE_URL: siteUrl,
        AUTH_PASSWORD_SECRET: testSecret(1),
        AUTH_CSRF_SECRET: testSecret(2),
        AUTH_RATE_SECRET: testSecret(3),
        AUTH_MAIL_PAYLOAD_SECRET: testSecret(4),
        RESEND_API_KEY: 'synthetic-auth-cpu-test-key',
        MAIL_FROM: 'auth@example.test',
      };
      const authConfig = resolveAuthConfig(workerBindings);
      if (!authConfig.enabled) throw new Error('AUTH_BENCHMARK_CONFIG_UNAVAILABLE');
      const repository = createAuthRepository(database);
      const databaseVersion = await database.first<{ version: unknown }>('SELECT VERSION() AS version');
      if (!/^8\.4\.5(?:[-+]|$)/u.test(String(databaseVersion?.version ?? ''))) {
        throw new Error('AUTH_BENCHMARK_MYSQL_VERSION_UNSUPPORTED');
      }
      const loginEmail = syntheticEmail('login');
      const loginPassword = 'Pilot5';
      const loginUserId = await seedActiveUser(database, repository, authConfig, loginEmail, loginPassword);
      const resetEmail = syntheticEmail('reset');
      const resetPassword = 'Reset5';
      await seedActiveUser(database, repository, authConfig, resetEmail, resetPassword);
      const anonymousCsrf = await issueCsrf(new Request(siteUrl), authConfig, 'anonymous');
      if (!anonymousCsrf.cookie) throw new Error('AUTH_BENCHMARK_CSRF_SETUP_FAILED');

      const records = new Map<string, SampleSet>();
      const addSample = (name: string, wallMs: number, cpuMs: number, coldConfirmation: string) => {
        let record = records.get(name);
        if (!record) {
          record = { name, wallSamplesMs: [], localCpuSamplesMs: [], remoteCpuSamplesMs: [], coldConfirmation };
          records.set(name, record);
        }
        record.wallSamplesMs.push(wallMs);
        record.localCpuSamplesMs.push(cpuMs);
      };
      const timed = async <T>(name: string, coldConfirmation: string, work: () => Promise<T>): Promise<T> => {
        const wallStarted = performance.now();
        const cpuStarted = process.cpuUsage();
        const value = await work();
        const cpuElapsed = process.cpuUsage(cpuStarted);
        addSample(name, performance.now() - wallStarted, (cpuElapsed.user + cpuElapsed.system) / 1000, coldConfirmation);
        return value;
      };
      const timedResponse = (name: string, work: () => Promise<Response>, coldConfirmation = 'not_applicable_isolate_unconfirmed') => timed(
        name,
        coldConfirmation,
        async () => {
          const response = await work();
          return { response, body: await response.arrayBuffer() };
        },
      );

      const anonymousHeaders = {
        origin: siteUrl,
        'content-type': 'application/json',
        cookie: anonymousCsrf.cookie,
        'x-csrf-token': anonymousCsrf.token,
      };
      const loginRequest = () => jsonRequest('/api/v1/auth/login', {
        email: loginEmail,
        password: loginPassword,
      }, anonymousHeaders);

      const firstLogin = await timed('login_cold_first_entry', 'first_worker_module_import_inside_vitest_isolate_unconfirmed', async () => {
        const loaded = await import('../../apps/worker/src/index');
        const response = await loaded.default.fetch(loginRequest(), workerBindings);
        return { worker: loaded.default, response, body: await response.arrayBuffer() };
      });
      requireOk(firstLogin.response, 'login_cold_first_entry');
      const workerModule = { worker: firstLogin.worker, session: await readSession(firstLogin.response, firstLogin.body) };

      for (let index = 0; index < 5; index += 1) {
        const result = await timedResponse(
          'login_hot',
          () => workerModule.worker.fetch(loginRequest(), workerBindings),
          'subsequent_local_entry_request_isolate_unconfirmed',
        );
        requireOk(result.response, 'login_hot');
      }

      const profileResponse = await timedResponse('profile', () =>
        workerModule.worker.fetch(jsonRequest('/api/v1/account/profile', { display_name: 'Benchmark Profile' }, {
          origin: siteUrl,
          'content-type': 'application/json',
          cookie: workerModule.session.cookie,
          'x-csrf-token': workerModule.session.csrfToken,
        }, 'PATCH'), workerBindings));
      requireOk(profileResponse.response, 'profile');

      const meResponse = await timedResponse('me', () =>
        workerModule.worker.fetch(new Request(`${siteUrl}/api/v1/auth/me`, {
          headers: { origin: siteUrl, cookie: workerModule.session.cookie },
        }), workerBindings));
      requireOk(meResponse.response, 'me');

      const refreshResponse = await timedResponse('refresh', () =>
        workerModule.worker.fetch(jsonRequest('/api/v1/auth/session/refresh', {}, {
          origin: siteUrl,
          'content-type': 'application/json',
          cookie: workerModule.session.cookie,
          'x-csrf-token': workerModule.session.csrfToken,
        }), workerBindings));
      requireOk(refreshResponse.response, 'refresh');
      const refreshedSession = await readSession(refreshResponse.response, refreshResponse.body, workerModule.session.cookie);

      const resetRequestResponse = await timedResponse('password_reset_request', () =>
        workerModule.worker.fetch(jsonRequest('/api/v1/auth/password-reset/request', { email: resetEmail }, anonymousHeaders), workerBindings));
      requireOk(resetRequestResponse.response, 'password_reset_request');

      let fakeMailCalls = 0;
      let deliveredResetToken: string | null = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== 'https://api.resend.com/emails') throw new Error('AUTH_BENCHMARK_UNEXPECTED_NETWORK');
        fakeMailCalls += 1;
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { text?: unknown } : {};
        if (typeof body.text === 'string') {
          deliveredResetToken = /#token=([A-Za-z0-9_-]{43})/u.exec(body.text)?.[1] ?? null;
        }
        return new Response('{"id":"synthetic-message"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch;
      try {
        await timed('single_mail_send', 'not_applicable_isolate_unconfirmed', () =>
          workerModule.worker.scheduled({
            cron: '*/2 * * * *',
            scheduledTime: Date.now(),
            noRetry: () => undefined,
          } as unknown as ScheduledEvent, workerBindings));
      } finally {
        globalThis.fetch = originalFetch;
      }
      if (fakeMailCalls !== 1 || !deliveredResetToken) throw new Error('AUTH_BENCHMARK_MAIL_FIXTURE_FAILED');

      const resetConfirmResponse = await timedResponse('password_reset_confirm', () =>
        workerModule.worker.fetch(jsonRequest('/api/v1/auth/password-reset/confirm', {
          token: deliveredResetToken,
          new_password: 'Reset6',
          new_password_confirmation: 'Reset6',
        }, anonymousHeaders), workerBindings));
      requireOk(resetConfirmResponse.response, 'password_reset_confirm');
      deliveredResetToken = null;

      const avatarBase64 = make32KiBAvatarBase64();
      if (avatarBase64.length !== 43_692) throw new Error('AUTH_BENCHMARK_AVATAR_FIXTURE_FAILED');
      const avatarResponse = await timedResponse('avatar_32kib', () =>
        workerModule.worker.fetch(jsonRequest('/api/v1/account/avatar', { avatar_base64: avatarBase64 }, {
          origin: siteUrl,
          'content-type': 'application/json',
          cookie: refreshedSession.cookie,
          'x-csrf-token': refreshedSession.csrfToken,
        }, 'PUT'), workerBindings));
      requireOk(avatarResponse.response, 'avatar_32kib');

      const changeResponse = await timedResponse('password_change', () =>
        workerModule.worker.fetch(jsonRequest('/api/v1/auth/password/change', {
          current_password: loginPassword,
          new_password: 'Pilot6',
          new_password_confirmation: 'Pilot6',
        }, {
          origin: siteUrl,
          'content-type': 'application/json',
          cookie: refreshedSession.cookie,
          'x-csrf-token': refreshedSession.csrfToken,
        }), workerBindings));
      requireOk(changeResponse.response, 'password_change');

      const shortPassword = 'A🧭B😀C';
      const shortRegisterResponse = await timedResponse('register_password_5_unicode', () =>
        workerModule.worker.fetch(jsonRequest('/api/v1/auth/register', {
          email: syntheticEmail('short'),
          password: shortPassword,
          password_confirmation: shortPassword,
          display_name: 'Benchmark Short',
        }, anonymousHeaders), workerBindings));
      requireStatus(shortRegisterResponse.response, 202);

      const longPassword = '🛡'.repeat(256);
      const longRegisterResponse = await timedResponse('register_password_256_unicode', () =>
        workerModule.worker.fetch(jsonRequest('/api/v1/auth/register', {
          email: syntheticEmail('long'),
          password: longPassword,
          password_confirmation: longPassword,
          display_name: 'Benchmark Long',
        }, anonymousHeaders), workerBindings));
      requireStatus(longRegisterResponse.response, 202);

      const oversizedBody = 'x'.repeat(64 * 1024 + 1);
      const oversizedResponse = await timedResponse('register_body_64kib_plus_1', () =>
        workerModule.worker.fetch(new Request(`${siteUrl}/api/v1/auth/register`, {
          method: 'POST',
          headers: { origin: siteUrl, 'content-type': 'application/json' },
          body: oversizedBody,
        }), workerBindings));
      requireStatus(oversizedResponse.response, 413);

      await database.run('DELETE FROM auth_mail_outbox');
      const expiredSessionTokens = await Promise.all(Array.from({ length: 50 }, async () => digestToken(createOpaqueToken())));
      await repository.transaction(async (tx) => {
        const user = await tx.lockUser(loginUserId);
        if (!user) throw new Error('AUTH_BENCHMARK_USER_FIXTURE_FAILED');
        for (const tokenDigest of expiredSessionTokens) {
          await tx.insertSession({
            tokenDigest,
            userId: loginUserId,
            credentialVersion: user.credentialVersion,
            authVersion: user.authVersion,
            createdAt: 0,
            lastSeenAt: 0,
            expiresAt: 1,
          });
        }
      });
      const originalNow = Date.now;
      Date.now = () => resetClockTime;
      try {
        await timed('cleanup_50_expired_sessions', 'not_applicable_isolate_unconfirmed', () =>
          workerModule.worker.scheduled({
            cron: '*/2 * * * *',
            scheduledTime: resetClockTime,
            noRetry: () => undefined,
          } as unknown as ScheduledEvent, { ...workerBindings, RESEND_API_KEY: undefined }));
      } finally {
        Date.now = originalNow;
      }
      const remainingExpired = await database.first<{ count: unknown }>(
        'SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ? AND expires_at <= ?',
        [loginUserId, resetClockTime],
      );
      if (Number(remainingExpired?.count) !== 0) throw new Error('AUTH_BENCHMARK_CLEANUP_FIXTURE_FAILED');

      const rawReport = {
        metadata: {
          runtime: process.version,
          buildSHA: process.env.AUTH_CPU_BUILD_SHA ?? 'unknown',
          databaseVersion: String(databaseVersion?.version ?? 'unknown').split('-')[0],
        },
        scenarios: [...records.values()],
      };
      writeFileSync(reportPath, JSON.stringify(rawReport), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      expect(records.size).toBe(14);
    });
  }, 120_000);
});

async function seedActiveUser(
  database: MysqlDatabase,
  repository: ReturnType<typeof createAuthRepository>,
  config: EnabledAuthConfig,
  email: string,
  password: string,
): Promise<string> {
  const now = Date.now();
  const material = await createPasswordMaterial(password, config);
  const user = await repository.transaction(async (tx) => {
    const created = await tx.insertUser({ email, emailNormalized: email.toLowerCase(), displayName: 'CPU Benchmark', createdAt: now });
    await tx.insertCredential(created.id, material);
    return created;
  });
  await database.run('UPDATE auth_users SET status = ?, email_verified_at = ?, updated_at = ? WHERE id = ?', [
    'ACTIVE', now, now, user.id,
  ]);
  return user.id;
}

function testSecret(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64');
}

function syntheticEmail(label: string): string {
  return `auth-cpu-${label}-${randomUUID()}@example.test`;
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string>, method = 'POST'): Request {
  return new Request(`${siteUrl}${path}`, { method, headers, body: JSON.stringify(body) });
}

function requireOk(response: Response, stage: string): void {
  if (!response.ok) throw new Error(`AUTH_BENCHMARK_REQUEST_FAILED:${stage}:${response.status}`);
}

function requireStatus(response: Response, expected: number): void {
  if (response.status !== expected) throw new Error(`AUTH_BENCHMARK_EXPECTED_STATUS_${expected}_GOT_${response.status}`);
}

async function readSession(response: Response, body: ArrayBuffer, fallbackCookie?: string): Promise<{ cookie: string; csrfToken: string }> {
  let payload: { csrf_token?: unknown };
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as { csrf_token?: unknown };
  } catch {
    throw new Error('AUTH_BENCHMARK_SESSION_FIXTURE_FAILED');
  }
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? fallbackCookie;
  if (!cookie || typeof payload.csrf_token !== 'string') throw new Error('AUTH_BENCHMARK_SESSION_FIXTURE_FAILED');
  return { cookie, csrfToken: payload.csrf_token };
}

function make32KiBAvatarBase64(): string {
  const source = readFileSync(new URL('../fixtures/auth/avatar-256-browser.webp', import.meta.url));
  const chunks: Array<{ type: string; data: Buffer }> = [];
  for (let offset = 12; offset + 8 <= source.byteLength;) {
    const type = source.toString('ascii', offset, offset + 4);
    const size = source.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > source.byteLength) throw new Error('AUTH_BENCHMARK_AVATAR_FIXTURE_FAILED');
    chunks.push({ type, data: Buffer.from(source.subarray(dataStart, dataEnd)) });
    offset = dataEnd + (size % 2);
  }
  const extended = chunks.find((chunk) => chunk.type === 'VP8X');
  if (!extended || extended.data.byteLength !== 10) throw new Error('AUTH_BENCHMARK_AVATAR_FIXTURE_FAILED');
  extended.data[0] = extended.data[0]! | 0x04;

  const prefix = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="">';
  const suffix = '</rdf:Description></rdf:RDF></x:xmpmeta>';
  const targetBytes = 32 * 1024;
  const previousChunksBytes = chunks.reduce((total, chunk) => total + 8 + chunk.data.byteLength + (chunk.data.byteLength % 2), 0);
  const xmpLength = targetBytes - 12 - previousChunksBytes - 8;
  if (xmpLength < prefix.length + suffix.length) throw new Error('AUTH_BENCHMARK_AVATAR_FIXTURE_FAILED');
  const xmp = Buffer.from(`${prefix}${' '.repeat(xmpLength - prefix.length - suffix.length)}${suffix}`, 'ascii');
  chunks.push({ type: 'XMP ', data: xmp });

  const encodedChunks = chunks.map(({ type, data }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32LE(data.byteLength, 4);
    return data.byteLength % 2 === 0 ? Buffer.concat([header, data]) : Buffer.concat([header, data, Buffer.from([0])]);
  });
  const webp = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'ascii'), ...encodedChunks]);
  webp.writeUInt32LE(webp.byteLength - 8, 4);
  if (webp.byteLength !== targetBytes) throw new Error('AUTH_BENCHMARK_AVATAR_FIXTURE_FAILED');
  return webp.toString('base64');
}

function isPrivateReportPath(value: string | undefined): value is string {
  if (!value || !resolve(value).startsWith(`${resolve(tmpdir())}${sep}`)) return false;
  return basename(dirname(resolve(value))).startsWith('lastroweb-auth-cpu-');
}
