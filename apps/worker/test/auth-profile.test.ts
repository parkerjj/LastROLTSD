import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { resolveAuthConfig } from '../src/auth/config';
import { createAccountService } from '../src/auth/account-service';
import type { AuthRepository, AuthSecurityEventInput, AuthTx, UserRecord } from '../src/auth/repository';
import type { AuthBindings, AuthIdentity, AuthRuntime, AccountProfile, AccountStatus } from '../src/auth/types';
import { registerAuthRoutes } from '../src/auth/router';
import type { AppEnv } from '../src/env';
import type { MysqlDatabase } from '../src/db/mysql-client';

const profileBindings = (): AppEnv & AuthBindings => {
  const secret = (fill: number) => {
    const bytes = new Uint8Array(32).fill(fill);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: secret(1), AUTH_CSRF_SECRET: secret(2),
    AUTH_RATE_SECRET: secret(3), AUTH_MAIL_PAYLOAD_SECRET: secret(4),
  };
};

interface EditableAccountService {
  updateDisplayName?: (identity: AuthIdentity, displayName: string, requestId?: string | null) => Promise<AccountProfile>;
  setAvatar?: (identity: AuthIdentity, base64OrNull: string | null, requestId?: string | null) => Promise<AccountProfile>;
}

function profileHarness(status: AccountStatus = 'PENDING_EMAIL', identityStatus: AccountStatus = status) {
  const calls: string[] = [];
  const auditEvents: AuthSecurityEventInput[] = [];
  const user: UserRecord = {
    id: '10000', email: 'pilot@example.test', emailNormalized: 'pilot@example.test', displayName: 'Pilot',
    status, emailVerifiedAt: status === 'ACTIVE' ? 900 : null, credentialVersion: 1, authVersion: 1,
    avatarVersion: 1, createdAt: 500, updatedAt: 900,
  };
  const session = {
    tokenDigest: new Uint8Array([7]), userId: user.id, credentialVersion: 1, authVersion: 1,
    createdAt: 500, lastSeenAt: 900, expiresAt: 10_000, revokedAt: null,
  };
  const identity: AuthIdentity = {
    userId: user.id, status: identityStatus, credentialVersion: 1, authVersion: 1, sessionDigest: new Uint8Array([7]),
  };
  let storedAvatar: string | null = null;
  const tx = {
    lockUser: async () => { calls.push('lockUser'); return user; },
    readSessionForUpdate: async () => { calls.push('readSessionForUpdate'); return session; },
    saveDisplayName: async (_userId: string, displayName: string) => {
      calls.push('saveDisplayName');
      user.displayName = displayName;
    },
    saveAvatar: async (_userId: string, base64OrNull: string | null) => {
      calls.push('saveAvatar');
      user.avatarVersion += 1;
      storedAvatar = base64OrNull;
    },
    appendEvent: async (input: AuthSecurityEventInput) => {
      calls.push('appendEvent');
      auditEvents.push(input);
    },
  } as unknown as AuthTx;
  const repository = {
    transaction: async <T>(work: (bound: AuthTx) => Promise<T>): Promise<T> => {
      calls.push('transaction:start');
      const result = await work(tx);
      calls.push('transaction:commit');
      return result;
    },
    readProfile: async (): Promise<AccountProfile> => {
      calls.push('readProfile');
      return {
        id: user.id, email: user.email, display_name: user.displayName, status: user.status, permission_level: 0,
        email_verified_at: user.emailVerifiedAt, created_at: user.createdAt,
        has_avatar: storedAvatar !== null, avatar_version: user.avatarVersion,
        avatar_url: `/api/v1/users/${user.id}/avatar?v=${user.avatarVersion}`,
      };
    },
  } as unknown as AuthRepository;
  const runtime: AuthRuntime = {
    now: () => { calls.push('now'); return 2_000; },
    fetch: globalThis.fetch,
  };
  const service = createAccountService(repository, resolveAuthConfig(profileBindings()), runtime) as ReturnType<typeof createAccountService> & EditableAccountService;
  return { service, identity, calls, user, auditEvents, get storedAvatar() { return storedAvatar; } };
}

describe('editable account profile', () => {
  it('allows the pending owner to save the same display name after rechecking the locked session', async () => {
    const { service, identity, calls, auditEvents } = profileHarness('PENDING_EMAIL');
    expect(typeof service.updateDisplayName).toBe('function');
    if (!service.updateDisplayName) return;

    const profile = await service.updateDisplayName(identity, 'Pilot', 'profile-request');

    expect(profile.display_name).toBe('Pilot');
    expect(auditEvents[0]).toMatchObject({ event: 'DISPLAY_NAME_UPDATED', requestId: 'profile-request' });
    expect(calls).toEqual([
      'transaction:start', 'lockUser', 'readSessionForUpdate', 'now',
      'saveDisplayName', 'appendEvent', 'transaction:commit', 'readProfile',
    ]);
  });

  it('allows the active owner to replace their avatar and increments its version', async () => {
    const { service, identity, calls, auditEvents } = profileHarness('ACTIVE');
    const avatarBase64 = readFileSync(new URL('../../../tests/fixtures/auth/avatar-256-browser.webp', import.meta.url)).toString('base64');
    expect(typeof service.setAvatar).toBe('function');
    if (!service.setAvatar) return;

    const profile = await service.setAvatar(identity, avatarBase64, 'avatar-request');

    expect(profile).toMatchObject({ has_avatar: true, avatar_version: 2 });
    expect(auditEvents[0]).toMatchObject({ event: 'AVATAR_UPDATED', requestId: 'avatar-request', reason: 'avatar_version=2' });
    expect(calls).toEqual([
      'transaction:start', 'lockUser', 'readSessionForUpdate', 'now',
      'saveAvatar', 'appendEvent', 'transaction:commit', 'readProfile',
    ]);
  });

  it('allows the pending owner to delete an avatar and advances the cache version', async () => {
    const { service, identity, calls } = profileHarness('PENDING_EMAIL');
    expect(typeof service.setAvatar).toBe('function');
    if (!service.setAvatar) return;

    const profile = await service.setAvatar(identity, null);

    expect(profile).toMatchObject({ has_avatar: false, avatar_version: 2 });
    expect(calls).toEqual([
      'transaction:start', 'lockUser', 'readSessionForUpdate', 'now',
      'saveAvatar', 'appendEvent', 'transaction:commit', 'readProfile',
    ]);
  });

  it('refuses a session whose account became disabled after authentication', async () => {
    const { service, identity, calls } = profileHarness('DISABLED', 'PENDING_EMAIL');
    expect(typeof service.updateDisplayName).toBe('function');
    if (!service.updateDisplayName) return;

    await expect(service.updateDisplayName(identity, 'Attacker')).rejects.toMatchObject({
      code: 'AUTH_UNAUTHENTICATED', status: 401,
    });
    expect(calls).toEqual(['transaction:start', 'lockUser', 'readSessionForUpdate', 'now']);
  });

  it('rejects a profile body that tries to select another user', async () => {
    const app = new Hono();
    registerAuthRoutes(app, profileBindings(), { first: async () => null } as unknown as MysqlDatabase, {
      now: () => 1_000, fetch: globalThis.fetch,
    });

    const response = await app.request('/api/v1/account/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Attacker', user_id: '10000' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_BAD_REQUEST' } });
  });

  it('rejects a body on avatar deletion', async () => {
    const app = new Hono();
    registerAuthRoutes(app, profileBindings(), { first: async () => null } as unknown as MysqlDatabase, {
      now: () => 1_000, fetch: globalThis.fetch,
    });

    const response = await app.request('/api/v1/account/avatar', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_BAD_REQUEST' } });
  });
});
