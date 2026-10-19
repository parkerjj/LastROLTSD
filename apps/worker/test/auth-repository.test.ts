import { describe, expect, it } from 'vitest';
import { createAuthRepository } from '../src/auth/repository';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';

const credentialRow = {
  user_id: '9007199254740993', status: 'PENDING_EMAIL', credential_version: 2, auth_version: 3,
  scheme: 'hmac-sha256-v1', salt: new Uint8Array(16), digest: new Uint8Array(32), key_version: 'v1',
};
const userRow = {
  id: '9007199254740993', email: 'player@example.test', email_normalized: 'player@example.test',
  display_name: 'Player', status: 'PENDING_EMAIL', email_verified_at: null, credential_version: 2,
  auth_version: 3, avatar_version: 4, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
};

class FakeDatabase implements MysqlDatabase {
  readonly calls: Array<{ method: 'all' | 'first' | 'run'; sql: string; values: readonly unknown[] }> = [];
  transactionDatabase: FakeDatabase | null = null;
  rateRows: MysqlRow[] = [];
  authUserRow: MysqlRow = userRow;
  sessionRow: MysqlRow | null = null;
  actionRow: MysqlRow | null = null;

  async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    this.calls.push({ method: 'all', sql, values });
    if (sql.includes('auth_rate_limits')) return this.rateRows as T[];
    if (sql.includes('auth_credentials')) return [credentialRow as unknown as T];
    if (sql.includes('EXISTS (SELECT 1 FROM auth_avatars')) return [{
      id: userRow.id, email: userRow.email, display_name: userRow.display_name, status: userRow.status,
      email_verified_at: null, created_at: userRow.created_at, has_avatar: 1, avatar_version: 4, permission_level: 2,
    } as unknown as T];
    return [];
  }

  async first<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T | null> {
    this.calls.push({ method: 'first', sql, values });
    if (sql.includes('auth_credentials')) return credentialRow as unknown as T;
    if (sql.includes('FROM auth_sessions')) return this.sessionRow as T | null;
    if (sql.includes('FROM auth_action_tokens')) return this.actionRow as T | null;
    if (sql.includes('EXISTS (SELECT 1 FROM auth_avatars')) return {
      id: userRow.id, email: userRow.email, email_normalized: userRow.email_normalized,
      display_name: userRow.display_name, status: userRow.status, email_verified_at: null,
      credential_version: 2, auth_version: 3, avatar_version: 4, created_at: userRow.created_at,
      updated_at: userRow.updated_at, has_avatar: 1, permission_level: 2,
    } as unknown as T;
    if (sql.includes('FROM auth_users')) {
      if (sql.includes('FOR UPDATE') && String(values[0]) !== String(this.authUserRow.id)) return null;
      return this.authUserRow as T;
    }
    return null;
  }

  async run(sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> {
    this.calls.push({ method: 'run', sql, values });
    return { affectedRows: 1, insertId: 7 };
  }

  async transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> {
    this.transactionDatabase = new FakeDatabase();
    this.transactionDatabase.authUserRow = this.authUserRow;
    this.transactionDatabase.sessionRow = this.sessionRow;
    this.transactionDatabase.actionRow = this.actionRow;
    return work(this.transactionDatabase);
  }

  async healthcheck(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('account MySQL repository', () => {
  it('reads string IDs without selecting avatar data', async () => {
    const db = new FakeDatabase();
    const repository = createAuthRepository(db);

    await expect(repository.readCredentialByEmail('player@example.test')).resolves.toMatchObject({
      userId: '9007199254740993', status: 'PENDING_EMAIL', credentialVersion: 2, authVersion: 3,
      scheme: 'hmac-sha256-v1', keyVersion: 'v1',
    });
    await expect(repository.readProfile('9007199254740993')).resolves.toMatchObject({
      id: '9007199254740993', permission_level: 2, has_avatar: true, avatar_version: 4,
      avatar_url: '/api/v1/users/9007199254740993/avatar?v=4',
    });
    expect(db.calls.every(({ sql }) => !sql.includes('avatar_base64'))).toBe(true);
    expect(db.calls.find(({ sql }) => sql.includes('EXISTS'))?.sql).toContain('u.permission_level');
  });

  it('returns the live session expiry with the joined identity', async () => {
    const db = new FakeDatabase();
    const now = 1_800_000_000_000;
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
    const sessionDigest = new Uint8Array(32).fill(9);
    db.sessionRow = {
      user_id: userRow.id,
      status: userRow.status,
      credential_version: userRow.credential_version,
      auth_version: userRow.auth_version,
      expires_at: expiresAt,
    };

    const identity = await createAuthRepository(db).readIdentity(sessionDigest, now);

    expect(identity).toEqual({
      userId: userRow.id,
      status: userRow.status,
      credentialVersion: userRow.credential_version,
      authVersion: userRow.auth_version,
      sessionDigest,
      expiresAt,
    });
    expect(db.calls[0]?.sql).toContain('s.expires_at');
  });

  it('binds transaction work and resolves the inserted user through its unique email', async () => {
    const db = new FakeDatabase();
    const repository = createAuthRepository(db);
    let nestedTransaction: unknown;

    const user = await repository.transaction(async (tx) => {
      nestedTransaction = (tx as unknown as { transaction?: unknown }).transaction;
      return tx.insertUser({
        email: 'player@example.test', emailNormalized: 'player@example.test', displayName: 'Player', createdAt: 1_700_000_000_000,
      });
    });

    expect(user.id).toBe('9007199254740993');
    expect(nestedTransaction).toBeUndefined();
    expect(db.calls).toHaveLength(0);
    expect(db.transactionDatabase?.calls.map(({ method }) => method)).toEqual(['run', 'first']);
    expect(db.transactionDatabase?.calls[0]?.values).toContain('player@example.test');
    expect(db.transactionDatabase?.calls[1]?.sql).toContain('CAST(id AS CHAR)');
    expect(db.transactionDatabase?.calls[1]?.sql).toContain('WHERE email_normalized = ?');
  });

  it('returns monthly mail quota before daily quota and reads the current UTC buckets', async () => {
    const db = new FakeDatabase();
    const now = Date.UTC(2026, 9, 12, 0, 30);
    const dayStart = Date.UTC(2026, 9, 12);
    const monthStart = Date.UTC(2026, 9, 1);
    db.rateRows = [
      { scope: 'mail-budget-monthly', request_count: 3_000, next_allowed_at: 0, expires_at: 1_800_000_000_000 },
      { scope: 'mail-provider-daily', request_count: 0, next_allowed_at: dayStart + 86_400_000, expires_at: dayStart + 172_800_000 },
    ];
    const repository = createAuthRepository(db);

    await expect(repository.readMailAvailability(now)).resolves.toEqual({
      code: 'MAIL_MONTHLY_QUOTA', retry_at: null,
    });
    const call = db.calls[0];
    expect(call?.sql).toContain('FROM auth_rate_limits');
    expect(call?.values[0]).toEqual(new Uint8Array(32));
    expect(call?.values).toContain(dayStart);
    expect(call?.values).toContain(monthStart);
  });

  it('uses configured budgets and reports the next UTC midnight for daily quota', async () => {
    const db = new FakeDatabase();
    const now = Date.UTC(2026, 9, 12, 20);
    db.rateRows = [{ scope: 'mail-budget-daily', request_count: 2, next_allowed_at: 0, expires_at: now + 100_000 }];
    const repository = createAuthRepository(db, { mailDailyLimit: 2, mailMonthlyLimit: 5 });

    await expect(repository.readMailAvailability(now)).resolves.toEqual({
      code: 'MAIL_DAILY_QUOTA', retry_at: Date.UTC(2026, 9, 13),
    });
  });

  it('does not mutate a session or action owned by a different locked user', async () => {
    const db = new FakeDatabase();
    db.authUserRow = { ...userRow, id: '10000' };
    const sessionDigest = new Uint8Array(32).fill(1);
    const actionDigest = new Uint8Array(32).fill(2);
    db.sessionRow = {
      token_digest: sessionDigest, user_id: '10001', credential_version: 2, auth_version: 3,
      created_at: 1_700_000_000_000, last_seen_at: 1_700_000_000_000,
      expires_at: 1_800_000_000_000, revoked_at: null,
    };
    db.actionRow = {
      token_digest: actionDigest, user_id: '10001', purpose: 'VERIFY_EMAIL', email_snapshot: 'other@example.test',
      credential_version: 2, created_at: 1_700_000_000_000, expires_at: 1_800_000_000_000,
      consumed_at: null, revoked_at: null,
    };
    const repository = createAuthRepository(db);
    let sessionSnapshot: unknown;
    let sessionRenewed: boolean | undefined;
    let actionSnapshot: unknown;
    let actionConsumed: boolean | undefined;

    await repository.transaction(async (tx) => {
      await expect(tx.lockUser('10000')).resolves.toMatchObject({ id: '10000' });
      sessionSnapshot = await tx.readSessionForUpdate(sessionDigest);
      sessionRenewed = await tx.renewSession(sessionDigest, 1_800_000_000_001, 1_700_000_000_001);
      actionSnapshot = await tx.readActionForUpdate(actionDigest);
      actionConsumed = await tx.consumeAction(actionDigest, 1_700_000_000_001);
    });

    expect(sessionSnapshot).toBeNull();
    expect(sessionRenewed).toBe(false);
    expect(actionSnapshot).toBeNull();
    expect(actionConsumed).toBe(false);
    const calls = db.transactionDatabase?.calls ?? [];
    const sessionLock = calls.find(({ sql }) => sql.includes('FROM auth_sessions'));
    const actionLock = calls.find(({ sql }) => sql.includes('FROM auth_action_tokens'));
    expect(sessionLock?.sql).toMatch(/token_digest = \? AND user_id = \?/u);
    expect(sessionLock?.values).toEqual([sessionDigest, '10000']);
    expect(actionLock?.sql).toMatch(/token_digest = \? AND user_id = \?/u);
    expect(actionLock?.values).toEqual([actionDigest, '10000']);
    expect(calls.filter(({ method, sql }) => method === 'run' && /UPDATE auth_(sessions|action_tokens)/u.test(sql))).toHaveLength(0);

    const ownedDatabase = new FakeDatabase();
    ownedDatabase.authUserRow = { ...userRow, id: '10000' };
    const ownedSessionDigest = new Uint8Array(32).fill(3);
    const ownedActionDigest = new Uint8Array(32).fill(4);
    ownedDatabase.sessionRow = { ...db.sessionRow, token_digest: ownedSessionDigest, user_id: '10000' };
    ownedDatabase.actionRow = { ...db.actionRow, token_digest: ownedActionDigest, user_id: '10000' };
    const ownedRepository = createAuthRepository(ownedDatabase);
    await ownedRepository.transaction(async (tx) => {
      await tx.lockUser('10000');
      await expect(tx.readSessionForUpdate(ownedSessionDigest)).resolves.toMatchObject({ userId: '10000' });
      await expect(tx.renewSession(ownedSessionDigest, 1_800_000_000_001, 1_700_000_000_001)).resolves.toBe(true);
      await expect(tx.readActionForUpdate(ownedActionDigest)).resolves.toMatchObject({ userId: '10000' });
      await expect(tx.consumeAction(ownedActionDigest, 1_700_000_000_001)).resolves.toBe(true);
    });
    const ownedCalls = ownedDatabase.transactionDatabase?.calls ?? [];
    const sessionUpdate = ownedCalls.find(({ method, sql }) => method === 'run' && sql.includes('UPDATE auth_sessions'));
    const actionUpdate = ownedCalls.find(({ method, sql }) => method === 'run' && sql.includes('UPDATE auth_action_tokens'));
    expect(sessionUpdate?.sql).toMatch(/WHERE token_digest = \? AND user_id = \?/u);
    expect(sessionUpdate?.sql).toContain('GREATEST(expires_at, ?)');
    expect(sessionUpdate?.sql).toContain('last_seen_at <= ?');
    expect(sessionUpdate?.values).toEqual([
      1_700_000_000_001 - 86_400_000, 1_700_000_000_001, 1_800_000_000_001,
      ownedSessionDigest, '10000', 1_700_000_000_001,
    ]);
    expect(actionUpdate?.sql).toMatch(/WHERE token_digest = \? AND user_id = \?/u);
    expect(actionUpdate?.values).toEqual([1_700_000_000_001, ownedActionDigest, '10000', 1_700_000_000_001]);
  });

  it('blocks account writes after mail/audit phases and checks credentials with a projection', async () => {
    const db = new FakeDatabase();
    db.authUserRow = { ...userRow, id: '10000' };
    const repository = createAuthRepository(db);
    const now = 1_700_000_000_000;
    const material = { scheme: 'hmac-sha256-v1' as const, salt: new Uint8Array(16), digest: new Uint8Array(32), keyVersion: 'v1' };

    await repository.transaction(async (tx) => {
      await tx.lockUser('10000');
      await tx.saveCredential('10000', material, 3, now);
      await tx.insertMailJob({
        id: '00000000-0000-4000-8000-000000000001', actionDigest: null, userId: '10000', purpose: 'PASSWORD_CHANGED',
        payloadCiphertext: 'ciphertext', payloadIv: 'iv', payloadKeyVersion: 'v1', priority: 0,
        createdAt: now, expiresAt: now + 86_400_000,
      });
      await expect(tx.saveAvatar('10000', 'QUJD', now)).rejects.toThrow(/auth state must be written before mail outbox/u);
      await tx.appendEvent({ userId: '10000', event: 'test', requestId: null, result: 'ok', reason: null, createdAt: now });
      await expect(tx.saveDisplayName('10000', 'Changed', now)).rejects.toThrow(/auth state must be written before mail outbox/u);
      await expect(tx.saveCredential('10000', material, 4, now)).rejects.toThrow(/auth state must be written before mail outbox/u);
    });

    const calls = db.transactionDatabase?.calls ?? [];
    expect(calls.find(({ sql }) => sql.includes('FROM auth_credentials'))?.sql).toMatch(/SELECT 1 AS credential_exists/u);
    const mailWriteIndex = calls.findIndex(({ sql }) => sql.includes('INSERT INTO auth_mail_outbox'));
    const lateAccountWrites = calls.slice(mailWriteIndex + 1).filter(({ method, sql }) => method === 'run' && /UPDATE auth_users|INSERT INTO auth_avatars/u.test(sql));
    expect(lateAccountWrites).toHaveLength(0);
  });
});
