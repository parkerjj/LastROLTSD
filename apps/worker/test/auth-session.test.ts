import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';
import { createPasswordMaterial } from '../src/auth/crypto';
import { resolveAuthConfig } from '../src/auth/config';
import { issueCsrf } from '../src/auth/csrf';
import { authRateLimitKey } from '../src/auth/rate-limit';
import { registerAuthRoutes } from '../src/auth/router';
import type { AccountStatus, AuthBindings, PasswordMaterial } from '../src/auth/types';
import type { AppEnv } from '../src/env';

const SESSION_BASE = 1_800_000_000_000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const TEST_PASSWORD = 'correct horse battery';

function standardBase64(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bindings(): AppEnv & AuthBindings {
  return {
    ENVIRONMENT: 'production', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test', AUTH_ENABLED: 'true',
    AUTH_SITE_URL: 'https://lastro.example', AUTH_PASSWORD_SECRET: standardBase64(1),
    AUTH_CSRF_SECRET: standardBase64(2), AUTH_RATE_SECRET: standardBase64(3),
    AUTH_MAIL_PAYLOAD_SECRET: standardBase64(4),
  };
}

class MeDatabase implements MysqlDatabase {
  readonly expiresAt = 1_800_000_000_000 + 30 * 24 * 60 * 60 * 1000;

  constructor(private readonly hasSession = true) {}

  async all<T extends MysqlRow>(): Promise<T[]> {
    return [];
  }

  async first<T extends MysqlRow>(sql: string): Promise<T | null> {
    if (sql.includes('FROM auth_sessions AS s')) {
      if (!this.hasSession) return null;
      return {
        user_id: '10000', status: 'ACTIVE', credential_version: 1, auth_version: 1, expires_at: this.expiresAt,
      } as unknown as T;
    }
    if (sql.includes('EXISTS (SELECT 1 FROM auth_avatars')) {
      return {
        id: '10000', email: 'player@example.test', display_name: 'Player', status: 'ACTIVE',
        email_verified_at: 1_700_000_000_000, created_at: 1_700_000_000_000, avatar_version: 0, has_avatar: 0,
        admin: 1,
      } as unknown as T;
    }
    return null;
  }

  async run(): Promise<MysqlWriteResult> {
    return { affectedRows: 0, insertId: 0 };
  }

  async transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> {
    return work(this);
  }

  async healthcheck(): Promise<void> {}
  async close(): Promise<void> {}
}

interface StoredSession {
  token_digest: Uint8Array;
  user_id: string;
  credential_version: number;
  auth_version: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

class SessionDatabase implements MysqlDatabase {
  user: {
    id: string;
    email: string;
    email_normalized: string;
    display_name: string;
    status: AccountStatus;
    email_verified_at: number | null;
    credential_version: number;
    auth_version: number;
    avatar_version: number;
    created_at: number;
    updated_at: number;
  } | null;
  material: PasswordMaterial;
  readonly sessions = new Map<string, StoredSession>();
  readonly events: Array<{
    user_id: string | null;
    event: string;
    request_id: string | null;
    result: string;
    reason: string | null;
    created_at: number;
  }> = [];
  readonly runCalls: Array<{ sql: string; values: readonly unknown[] }> = [];
  auditFailure = false;
  beforeUserLock: (() => Promise<void>) | undefined;
  afterCredentialSnapshot: (() => void) | undefined;
  onIdentityRead: (() => void | Promise<void>) | undefined;
  afterSessionLock: (() => void) | undefined;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(options: { status: AccountStatus; verifiedAt: number | null; material: PasswordMaterial; exists?: boolean }) {
    this.material = options.material;
    this.beforeUserLock = undefined;
    this.afterCredentialSnapshot = undefined;
    this.onIdentityRead = undefined;
    this.afterSessionLock = undefined;
    this.user = options.exists === false ? null : {
      id: '10000', email: 'player@example.test', email_normalized: 'player@example.test',
      display_name: 'Player', status: options.status, email_verified_at: options.verifiedAt,
      credential_version: 1, auth_version: 1, avatar_version: 0,
      created_at: SESSION_BASE - 60_000, updated_at: SESSION_BASE - 60_000,
    };
  }

  async all<T extends MysqlRow>(): Promise<T[]> {
    return [];
  }

  async first<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T | null> {
    if (sql.includes('FROM auth_rate_limits')) {
      return { request_count: 0, next_allowed_at: 0, expires_at: Number.MAX_SAFE_INTEGER } as unknown as T;
    }
    if (sql.includes('FROM auth_sessions AS s')) {
      await this.onIdentityRead?.();
      const session = this.findSession(values[0]);
      const now = Number(values[1]);
      if (!session || !this.user || session.revoked_at !== null || session.expires_at <= now
        || session.credential_version !== this.user.credential_version
        || session.auth_version !== this.user.auth_version
        || this.user.status === 'DISABLED'
        || (this.user.status === 'ACTIVE' && this.user.email_verified_at === null)) return null;
      return {
        user_id: session.user_id, status: this.user.status,
        credential_version: session.credential_version, auth_version: session.auth_version,
        expires_at: session.expires_at,
      } as unknown as T;
    }
    if (sql.includes('FROM auth_sessions') && sql.includes('FOR UPDATE')) {
      const session = this.findSession(values[0]);
      if (!session || session.user_id !== String(values[1])) return null;
      const row = { ...session };
      this.afterSessionLock?.();
      return row as unknown as T;
    }
    if (sql.includes('FROM auth_users AS u') && sql.includes('auth_credentials')) {
      if (!this.user) return null;
      if (sql.includes('email_normalized = ?') && values[0] !== this.user.email_normalized) return null;
      const snapshot = this.credentialRow() as T;
      this.afterCredentialSnapshot?.();
      this.afterCredentialSnapshot = undefined;
      return snapshot;
    }
    if (sql.includes('FROM auth_users') && sql.includes('FOR UPDATE')) {
      const userId = String(values[0]);
      if (!this.user || this.user.id !== userId) return null;
      const pause = this.beforeUserLock;
      this.beforeUserLock = undefined;
      await pause?.();
      return { ...this.user } as unknown as T;
    }
    if (sql.includes('EXISTS (SELECT 1 FROM auth_avatars')) {
      if (!this.user || this.user.id !== String(values[0])) return null;
      return {
        id: this.user.id, email: this.user.email, display_name: this.user.display_name,
        status: this.user.status, email_verified_at: this.user.email_verified_at,
        created_at: this.user.created_at, avatar_version: this.user.avatar_version, has_avatar: 0,
        admin: 0,
      } as unknown as T;
    }
    return null;
  }

  async run(sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> {
    this.runCalls.push({ sql, values });
    let affectedRows = 1;
    if (sql.includes('INSERT INTO auth_sessions')) {
      const session: StoredSession = {
        token_digest: values[0] as Uint8Array,
        user_id: String(values[1]),
        credential_version: Number(values[2]),
        auth_version: Number(values[3]),
        created_at: Number(values[4]),
        last_seen_at: Number(values[5]),
        expires_at: Number(values[6]),
        revoked_at: null,
      };
      this.sessions.set(this.digestKey(session.token_digest), session);
    } else if (sql.includes('UPDATE auth_sessions') && sql.includes('SET revoked_at')) {
      const session = this.findSession(values[1]);
      if (session && session.user_id === String(values[2]) && session.revoked_at === null) {
        session.revoked_at = Number(values[0]);
      } else {
        affectedRows = 0;
      }
    } else if (sql.includes('UPDATE auth_sessions') && sql.includes('SET last_seen_at')) {
      const session = this.findSession(values[3]);
      if (session && session.revoked_at === null && session.expires_at > Number(values[5])) {
        if (session.last_seen_at <= Number(values[0])) session.last_seen_at = Number(values[1]);
        session.expires_at = Math.max(session.expires_at, Number(values[2]));
      }
    } else if (sql.includes('UPDATE auth_users') && sql.includes('auth_version = auth_version + 1')) {
      if (this.user && this.user.id === String(values[1])) this.user.auth_version += 1;
    } else if (sql.includes('INSERT INTO auth_security_events')) {
      if (this.auditFailure) throw new Error('security audit unavailable');
      this.events.push({
        user_id: values[0] === null ? null : String(values[0]),
        event: String(values[1]),
        request_id: values[2] === null ? null : String(values[2]),
        result: String(values[3]),
        reason: values[4] === null ? null : String(values[4]),
        created_at: Number(values[5]),
      });
    }
    return { affectedRows, insertId: 0 };
  }

  async transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const userBefore = this.user ? { ...this.user } : null;
    const sessionsBefore = new Map([...this.sessions].map(([key, session]) => [key, { ...session }]));
    const eventCountBefore = this.events.length;
    try {
      return await work(this);
    } catch (error) {
      this.user = userBefore;
      this.sessions.clear();
      for (const [key, session] of sessionsBefore) this.sessions.set(key, session);
      this.events.length = eventCountBefore;
      throw error;
    } finally {
      release();
    }
  }

  async healthcheck(): Promise<void> {}
  async close(): Promise<void> {}

  private credentialRow(): MysqlRow {
    return {
      user_id: this.user!.id, status: this.user!.status,
      credential_version: this.user!.credential_version, auth_version: this.user!.auth_version,
      scheme: this.material.scheme, salt: this.material.salt, digest: this.material.digest,
      key_version: this.material.keyVersion,
    };
  }

  private findSession(digest: unknown): StoredSession | null {
    if (!(digest instanceof Uint8Array)) return null;
    return this.sessions.get(this.digestKey(digest)) ?? null;
  }

  private digestKey(digest: Uint8Array): string {
    return Array.from(digest).join(',');
  }
}

function tokenFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function sessionApp(database: MysqlDatabase, now: () => number): Hono {
  const app = new Hono();
  registerAuthRoutes(app, bindings(), database, { now, fetch: globalThis.fetch });
  return app;
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('session cookie missing');
  return cookie;
}

async function anonymousLogin(
  app: Hono,
  config: ReturnType<typeof resolveAuthConfig>,
  email = 'player@example.test',
  password = TEST_PASSWORD,
  now = SESSION_BASE,
): Promise<Response> {
  const csrf = await issueCsrf(new Request('https://lastro.example/api/v1/auth/csrf', {
    headers: { origin: 'https://lastro.example' },
  }), config, 'anonymous', undefined, () => now);
  return app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: {
      origin: 'https://lastro.example',
      'content-type': 'application/json',
      'x-csrf-token': csrf.token,
      cookie: csrf.cookie!.split(';', 1)[0]!,
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.9',
    },
    body: JSON.stringify({ email, password }),
  });
}

async function sessionCsrf(app: Hono, cookie: string): Promise<string> {
  const response = await app.request('/api/v1/auth/me', { headers: { cookie } });
  if (response.status !== 200) throw new Error('session bootstrap failed');
  return (await response.json() as { csrf_token: string }).csrf_token;
}

async function sessionWrite(app: Hono, path: string, cookie: string, csrfToken: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      origin: 'https://lastro.example', 'content-type': 'application/json',
      cookie, 'x-csrf-token': csrfToken,
    },
    body: '{}',
  });
}

describe('account session routes', () => {
  it('returns the database expiry from /me without exposing the Cookie token or clearing it', async () => {
    const token = tokenFromBytes(new Uint8Array(32).fill(7));
    const app = new Hono();
    registerAuthRoutes(app, bindings(), new MeDatabase(), {
      now: () => 1_800_000_000_000,
      fetch: globalThis.fetch,
    });

    const response = await app.request('/api/v1/auth/me', {
      headers: { cookie: `__Host-ltsd-session=${token}` },
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ expires_at: new MeDatabase().expiresAt });
    expect(JSON.stringify(body)).not.toContain(token);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('returns an ordinary 401 without a deletion Cookie for an invalid /me session', async () => {
    const app = new Hono();
    registerAuthRoutes(app, bindings(), new MeDatabase(false), {
      now: () => 1_800_000_000_000,
      fetch: globalThis.fetch,
    });

    const response = await app.request('/api/v1/auth/me', {
      headers: { cookie: '__Host-ltsd-session=invalid' },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not let a delayed /me 401 clear the Cookie from a newer login response', async () => {
    const config = resolveAuthConfig(bindings());
    const material = await createPasswordMaterial(TEST_PASSWORD, config);
    const database = new SessionDatabase({ status: 'ACTIVE', verifiedAt: SESSION_BASE - 60_000, material });
    const app = sessionApp(database, () => SESSION_BASE);
    let identityRead!: () => void;
    const identityReadStarted = new Promise<void>((resolve) => { identityRead = resolve; });
    let releaseRead!: () => void;
    const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
    database.onIdentityRead = async () => {
      database.onIdentityRead = undefined;
      identityRead();
      await readRelease;
    };
    const oldToken = tokenFromBytes(new Uint8Array(32).fill(44));
    const oldMePromise = app.request('/api/v1/auth/me', {
      headers: { cookie: `__Host-ltsd-session=${oldToken}` },
    });
    await identityReadStarted;

    const newLogin = await anonymousLogin(app, config);
    expect(newLogin.status).toBe(200);
    const newCookie = sessionCookie(newLogin);
    releaseRead();
    const oldMe = await oldMePromise;

    expect(oldMe.status).toBe(401);
    expect(oldMe.headers.get('set-cookie')).toBeNull();
    expect(newCookie).toMatch(/^__Host-ltsd-session=[A-Za-z0-9_-]{43}$/u);
  });

  it('fails closed with 503 when session-token digesting is unavailable', async () => {
    const token = tokenFromBytes(new Uint8Array(32).fill(8));
    const app = new Hono();
    registerAuthRoutes(app, bindings(), new MeDatabase(), {
      now: () => SESSION_BASE,
      fetch: globalThis.fetch,
    });
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('digest unavailable'));

    try {
      const response = await app.request('/api/v1/auth/me', {
        headers: { cookie: `__Host-ltsd-session=${token}` },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie')).toBeNull();
    } finally {
      digest.mockRestore();
    }
  });

  it('allows an unauthenticated logout only from the trusted Origin and then clears the Cookie', async () => {
    const app = new Hono();
    registerAuthRoutes(app, bindings(), new MeDatabase(false), {
      now: () => 1_800_000_000_000,
      fetch: globalThis.fetch,
    });
    const post = (origin?: string) => app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        ...(origin ? { origin } : {}),
        'content-type': 'application/json',
        cookie: '__Host-ltsd-session=invalid',
      },
      body: '{}',
    });

    const missingOrigin = await post();
    const untrustedOrigin = await post('https://evil.example');
    const trustedOrigin = await post('https://lastro.example');

    expect(missingOrigin.status).toBe(403);
    expect(missingOrigin.headers.get('set-cookie')).toBeNull();
    expect(untrustedOrigin.status).toBe(403);
    expect(untrustedOrigin.headers.get('set-cookie')).toBeNull();
    expect(trustedOrigin.status).toBe(204);
    expect(trustedOrigin.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('logs in ACTIVE and PENDING accounts with a new 30-day session Cookie', async () => {
    const config = resolveAuthConfig(bindings());
    const material = await createPasswordMaterial(TEST_PASSWORD, config);

    for (const status of ['ACTIVE', 'PENDING_EMAIL'] as const) {
      const now = SESSION_BASE;
      const database = new SessionDatabase({
        status, verifiedAt: status === 'ACTIVE' ? SESSION_BASE - 60_000 : null, material,
      });
      const app = sessionApp(database, () => now);
      const response = await anonymousLogin(app, config, 'Player@Example.test', TEST_PASSWORD, now);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      const cookie = sessionCookie(response);
      const token = cookie.slice(cookie.indexOf('=') + 1);

      expect(cookie).toMatch(/^__Host-ltsd-session=[A-Za-z0-9_-]{43}$/u);
      expect(response.headers.get('set-cookie')).toContain('Max-Age=2592000');
      expect(response.headers.get('set-cookie')).toContain('HttpOnly');
      expect(response.headers.get('set-cookie')).toContain('Secure');
      expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
      expect(body).toMatchObject({
        user: { id: '10000', status }, expires_at: SESSION_BASE + SESSION_TTL,
      });
      expect(JSON.stringify(body)).not.toContain(token);
      expect(database.sessions.size).toBe(1);
      expect(database.events).toEqual([{
        user_id: '10000', event: 'LOGIN', request_id: null, result: 'SUCCESS', reason: null, created_at: SESSION_BASE,
      }]);
      if (status === 'ACTIVE') expect(body.mail_availability).toBeNull();
      else expect(body.mail_availability).toEqual({ code: 'AVAILABLE', retry_at: null });
      if (!config.enabled) throw new Error('test auth config is disabled');
      const ipKey = await authRateLimitKey(config.rateSecret, 'ip', '203.0.113.7');
      const ipRateWrite = database.runCalls.find(({ sql, values }) => sql.includes('INSERT INTO auth_rate_limits') && values[0] === 'login_ip');
      expect(ipRateWrite?.values[1]).toEqual(ipKey);
    }
  });

  it('gives unknown, wrong-password, disabled, inconsistent ACTIVE, and raced credentials the same 401', async () => {
    const config = resolveAuthConfig(bindings());
    const material = await createPasswordMaterial(TEST_PASSWORD, config);
    const cases = [
      new SessionDatabase({ status: 'PENDING_EMAIL', verifiedAt: null, material, exists: false }),
      new SessionDatabase({ status: 'DISABLED', verifiedAt: null, material }),
      new SessionDatabase({ status: 'ACTIVE', verifiedAt: SESSION_BASE - 1, material }),
      new SessionDatabase({ status: 'ACTIVE', verifiedAt: null, material }),
    ];
    const raced = new SessionDatabase({ status: 'ACTIVE', verifiedAt: SESSION_BASE - 1, material });
    raced.afterCredentialSnapshot = () => {
      if (raced.user) raced.user.credential_version += 1;
    };
    cases.push(raced);

    const responses = await Promise.all(cases.map((database, index) => {
      const app = sessionApp(database, () => SESSION_BASE);
      const password = index === 2 ? 'wrong password' : TEST_PASSWORD;
      return anonymousLogin(app, config, 'player@example.test', password);
    }));
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ error: { code: string; message: string } }>));

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    expect(bodies.map(({ error }) => ({ code: error.code, message: error.message }))).toEqual(
      Array.from({ length: 5 }, () => ({ code: bodies[0]!.error.code, message: bodies[0]!.error.message })),
    );
    expect(cases.map((database) => database.sessions.size)).toEqual([0, 0, 0, 0, 0]);
  });

  it('extends the same token on repeated day-29 visits and rejects a request that reaches expiry while locked', async () => {
    const config = resolveAuthConfig(bindings());
    const material = await createPasswordMaterial(TEST_PASSWORD, config);
    let now = SESSION_BASE;
    const database = new SessionDatabase({ status: 'ACTIVE', verifiedAt: SESSION_BASE - 60_000, material });
    const app = sessionApp(database, () => now);
    const login = await anonymousLogin(app, config, 'player@example.test', TEST_PASSWORD, now);
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);
    const bootstrapWrites = database.runCalls.length;
    const csrfToken = await sessionCsrf(app, cookie);

    expect(database.runCalls).toHaveLength(bootstrapWrites);
    expect(login.headers.get('set-cookie')).toContain(`Max-Age=2592000`);

    now = SESSION_BASE + 29 * 24 * 60 * 60 * 1000;
    const firstRefresh = await sessionWrite(app, '/api/v1/auth/session/refresh', cookie, csrfToken);
    const firstBody = await firstRefresh.json() as { expires_at: number };
    expect(firstRefresh.status).toBe(200);
    expect(firstBody.expires_at).toBe(now + SESSION_TTL);
    expect(sessionCookie(firstRefresh)).toBe(cookie);

    now += 29 * 24 * 60 * 60 * 1000;
    const simultaneous = await Promise.all([
      sessionWrite(app, '/api/v1/auth/session/refresh', cookie, csrfToken),
      sessionWrite(app, '/api/v1/auth/session/refresh', cookie, csrfToken),
    ]);
    const simultaneousBodies = await Promise.all(simultaneous.map((response) => response.json() as Promise<{ expires_at: number }>));
    expect(simultaneous.map((response) => response.status)).toEqual([200, 200]);
    expect(simultaneousBodies.map((body) => body.expires_at)).toEqual([now + SESSION_TTL, now + SESSION_TTL]);
    expect(simultaneous.map(sessionCookie)).toEqual([cookie, cookie]);

    const expiry = now + SESSION_TTL;
    now = expiry - 1;
    database.afterSessionLock = () => { now = expiry; };
    const lateRefresh = await sessionWrite(app, '/api/v1/auth/session/refresh', cookie, csrfToken);
    expect(lateRefresh.status).toBe(401);
    expect(lateRefresh.headers.get('set-cookie')).toBeNull();
    expect([...database.sessions.values()][0]?.expires_at).toBe(expiry);
  });

  it('revokes the current digest on explicit logout and clears only after the request is authorized', async () => {
    const config = resolveAuthConfig(bindings());
    const material = await createPasswordMaterial(TEST_PASSWORD, config);
    const database = new SessionDatabase({ status: 'ACTIVE', verifiedAt: SESSION_BASE - 60_000, material });
    const app = sessionApp(database, () => SESSION_BASE);
    const login = await anonymousLogin(app, config);
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);
    const csrfToken = await sessionCsrf(app, cookie);

    const [logout, repeatedLogout] = await Promise.all([
      sessionWrite(app, '/api/v1/auth/logout', cookie, csrfToken),
      sessionWrite(app, '/api/v1/auth/logout', cookie, csrfToken),
    ]);
    const afterLogout = await app.request('/api/v1/auth/me', { headers: { cookie } });

    expect(logout.status).toBe(204);
    expect(repeatedLogout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect([...database.sessions.values()][0]?.revoked_at).toBe(SESSION_BASE);
    expect(database.events).toEqual([
      { user_id: '10000', event: 'LOGIN', request_id: null, result: 'SUCCESS', reason: null, created_at: SESSION_BASE },
      { user_id: '10000', event: 'LOGOUT', request_id: null, result: 'SUCCESS', reason: null, created_at: SESSION_BASE },
    ]);
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a refresh that authenticated before a competing logout-all acquired the user lock', async () => {
    const config = resolveAuthConfig(bindings());
    const material = await createPasswordMaterial(TEST_PASSWORD, config);
    const database = new SessionDatabase({ status: 'ACTIVE', verifiedAt: SESSION_BASE - 60_000, material });
    const app = sessionApp(database, () => SESSION_BASE);
    const login = await anonymousLogin(app, config);
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);
    const csrfToken = await sessionCsrf(app, cookie);

    let enteredLock!: () => void;
    const lockEntered = new Promise<void>((resolve) => { enteredLock = resolve; });
    let releaseLock!: () => void;
    const lockRelease = new Promise<void>((resolve) => { releaseLock = resolve; });
    database.beforeUserLock = async () => {
      enteredLock();
      await lockRelease;
    };
    const logoutAllPromise = sessionWrite(app, '/api/v1/auth/logout-all', cookie, csrfToken);
    const acquired = await Promise.race([
      lockEntered.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    if (!acquired) {
      releaseLock();
      expect(acquired).toBe(true);
      return;
    }

    let refreshAuthenticated!: () => void;
    const refreshIdentityRead = new Promise<void>((resolve) => { refreshAuthenticated = resolve; });
    database.onIdentityRead = () => {
      database.onIdentityRead = undefined;
      refreshAuthenticated();
    };
    const refreshPromise = sessionWrite(app, '/api/v1/auth/session/refresh', cookie, csrfToken);
    await refreshIdentityRead;
    releaseLock();

    const logoutAll = await logoutAllPromise;
    expect(logoutAll.status).toBe(204);
    expect(logoutAll.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(database.events.map((event) => event.event)).toEqual(['LOGIN', 'LOGOUT_ALL']);
    const newLogin = await anonymousLogin(app, config);
    expect(newLogin.status).toBe(200);
    const refresh = await refreshPromise;
    expect(refresh.status).toBe(401);
    expect(refresh.headers.get('set-cookie')).toBeNull();
    expect(database.user?.auth_version).toBe(2);
    expect(database.events.map((event) => event.event)).toEqual(['LOGIN', 'LOGOUT_ALL', 'LOGIN']);
  });

  it('rolls back session and version writes and withholds Cookies when audit insertion fails', async () => {
    const config = resolveAuthConfig(bindings());
    const material = await createPasswordMaterial(TEST_PASSWORD, config);

    const loginDatabase = new SessionDatabase({ status: 'ACTIVE', verifiedAt: SESSION_BASE - 60_000, material });
    loginDatabase.auditFailure = true;
    const failedLogin = await anonymousLogin(sessionApp(loginDatabase, () => SESSION_BASE), config);
    expect(failedLogin.status).toBe(503);
    expect(failedLogin.headers.get('set-cookie')).toBeNull();
    expect(loginDatabase.sessions.size).toBe(0);
    expect(loginDatabase.events).toEqual([]);

    const database = new SessionDatabase({ status: 'ACTIVE', verifiedAt: SESSION_BASE - 60_000, material });
    const app = sessionApp(database, () => SESSION_BASE);
    const login = await anonymousLogin(app, config);
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);
    const csrfToken = await sessionCsrf(app, cookie);
    database.auditFailure = true;

    const failedLogout = await sessionWrite(app, '/api/v1/auth/logout', cookie, csrfToken);
    expect(failedLogout.status).toBe(503);
    expect(failedLogout.headers.get('set-cookie')).toBeNull();
    expect([...database.sessions.values()][0]?.revoked_at).toBeNull();

    const failedLogoutAll = await sessionWrite(app, '/api/v1/auth/logout-all', cookie, csrfToken);
    expect(failedLogoutAll.status).toBe(503);
    expect(failedLogoutAll.headers.get('set-cookie')).toBeNull();
    expect(database.user?.auth_version).toBe(1);
    expect(database.events.map((event) => event.event)).toEqual(['LOGIN']);
  });
});
