import { describe, expect, it } from 'vitest';
import { createActionService } from '../../apps/worker/src/auth/action-service';
import { createAccountService } from '../../apps/worker/src/auth/account-service';
import { resolveAuthConfig } from '../../apps/worker/src/auth/config';
import { createPasswordMaterial, createOpaqueToken, digestToken, verifyPassword } from '../../apps/worker/src/auth/crypto';
import { prepareActionMail } from '../../apps/worker/src/auth/mail';
import { createAuthRepository, type AuthRepository, type AuthTx } from '../../apps/worker/src/auth/repository';
import { createSessionService } from '../../apps/worker/src/auth/session-service';
import type { AuthBindings, AuthRuntime, PasswordMaterial } from '../../apps/worker/src/auth/types';
import type { AppEnv } from '../../apps/worker/src/env';
import { withAuthTestDatabase } from '../helpers/auth-mysql';

const requireMysqlTests = process.env.REQUIRE_AUTH_MYSQL_TESTS === '1';
const runMysqlTests = Boolean(process.env.MYSQL_TEST_URL) || requireMysqlTests;
const BASE_TIME = Date.UTC(2026, 9, 13, 12);
const INITIAL_PASSWORD = 'initial-account-password';

function testSecret(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function testAuthBindings(): AppEnv & AuthBindings {
  return {
    ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 8192,
    MYSQL_URL: 'mysql://auth:local@127.0.0.1/lastro_test',
    AUTH_ENABLED: 'true', AUTH_SITE_URL: 'https://lastro.example',
    AUTH_PASSWORD_SECRET: testSecret(1), AUTH_CSRF_SECRET: testSecret(2),
    AUTH_RATE_SECRET: testSecret(3), AUTH_MAIL_PAYLOAD_SECRET: testSecret(4),
  };
}

function testRuntime(now: () => number): AuthRuntime {
  return {
    now,
    fetch: (async () => { throw new Error('auth race tests must not send mail'); }) as typeof globalThis.fetch,
  };
}

function arrivalBarrier(expected: number, phase: string) {
  let arrivals = 0;
  let readySignaled = false;
  let released = false;
  let aborted = false;
  let signalReady!: () => void;
  let openGate!: () => void;
  const ready = new Promise<void>((resolve) => { signalReady = resolve; });
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  return {
    phase,
    expected,
    ready,
    get arrivals() { return arrivals; },
    get aborted() { return aborted; },
    abort(): void {
      if (readySignaled || released) return;
      aborted = true;
      readySignaled = true;
      signalReady();
      openGate();
    },
    release(): void {
      released = true;
      openGate();
    },
    async pause(): Promise<void> {
      arrivals += 1;
      if (arrivals === expected && !readySignaled) {
        readySignaled = true;
        signalReady();
      }
      await gate;
    },
  };
}

function releaseBarrierOnFailure<T>(
  operation: Promise<T>,
  barrier: ReturnType<typeof arrivalBarrier>,
): Promise<T> {
  return operation.catch((error: unknown) => {
    barrier.abort();
    throw error;
  });
}

function expectBarrierArrivals(barrier: ReturnType<typeof arrivalBarrier>): void {
  expect(barrier.aborted, `${barrier.phase} barrier aborted early`).toBe(false);
  expect(barrier.arrivals, `${barrier.phase} arrivals`).toBe(barrier.expected);
}

function beforeTransactionMethod(
  repository: AuthRepository,
  method: 'insertUser' | 'lockUser',
  barrier: ReturnType<typeof arrivalBarrier>,
  afterCommittedMethod?: () => void,
): AuthRepository {
  const transaction = repository.transaction.bind(repository);
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return <T>(work: (tx: AuthTx) => Promise<T>): Promise<T> => {
          let methodSucceeded = false;
          return transaction((tx) => {
            const guarded = new Proxy(tx, {
              get(txTarget, txProperty, txReceiver) {
                const value: unknown = Reflect.get(txTarget, txProperty, txReceiver);
                if (txProperty === method && typeof value === 'function') {
                  return async (...args: unknown[]) => {
                    await barrier.pause();
                    const result = await value.apply(txTarget, args);
                    if (method === 'insertUser') methodSucceeded = true;
                    return result;
                  };
                }
                return typeof value === 'function' ? value.bind(txTarget) : value;
              }
            });
            return work(guarded);
          }).then((result) => {
            if (methodSucceeded) afterCommittedMethod?.();
            return result;
          });
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as AuthRepository;
}

function afterCredentialSnapshot(
  repository: AuthRepository,
  barrier: ReturnType<typeof arrivalBarrier>,
): AuthRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === 'readCredentialByEmail') {
        return async (emailNormalized: string) => {
          const snapshot = await target.readCredentialByEmail(emailNormalized);
          if (snapshot) await barrier.pause();
          return snapshot;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as AuthRepository;
}

async function seedUser(
  repository: AuthRepository,
  database: { run(sql: string, values?: readonly unknown[]): Promise<unknown> },
  email: string,
  password: string,
  config: ReturnType<typeof resolveAuthConfig>,
  createdAt: number,
  active = false,
): Promise<string> {
  const material = await createPasswordMaterial(password, config);
  const user = await repository.transaction(async (tx) => {
    const created = await tx.insertUser({
      email,
      emailNormalized: email.toLowerCase(),
      displayName: 'Race fixture',
      createdAt,
    });
    await tx.insertCredential(created.id, material);
    return created;
  });
  if (active) {
    await database.run(`UPDATE auth_users
      SET status = 'ACTIVE', email_verified_at = ?, updated_at = ? WHERE id = ?`, [createdAt, createdAt, user.id]);
  }
  return user.id;
}

async function addResetAction(
  repository: AuthRepository,
  userId: string,
  config: ReturnType<typeof resolveAuthConfig>,
  createdAt: number,
): Promise<string> {
  const token = createOpaqueToken();
  const tokenDigest = await digestToken(token);
  const expiresAt = createdAt + 30 * 60 * 1000;
  await repository.transaction(async (tx) => {
    const user = await tx.lockUser(userId);
    if (!user) throw new Error('reset fixture user is missing');
    const mail = await prepareActionMail({
      mailId: crypto.randomUUID(), actionDigest: tokenDigest, userId, email: user.email,
      displayName: user.displayName, token, purpose: 'RESET_PASSWORD', createdAt, expiresAt,
    }, config);
    await tx.insertAction({
      tokenDigest, userId, purpose: 'RESET_PASSWORD', emailSnapshot: user.email,
      credentialVersion: user.credentialVersion, createdAt, expiresAt,
    });
    await tx.insertMailJob(mail);
  });
  return token;
}

async function expectOnePasswordWinner(
  repository: AuthRepository,
  config: ReturnType<typeof resolveAuthConfig>,
  email: string,
  passwords: readonly [string, string],
): Promise<number> {
  const snapshot = await repository.readCredentialByEmail(email);
  if (!snapshot) throw new Error('race fixture credential is missing');
  const matches = await Promise.all(passwords.map((password) => verifyPassword(password, snapshot, config)));
  expect(matches.filter(Boolean)).toHaveLength(1);
  return matches.findIndex(Boolean);
}

async function seedLogin(
  repository: AuthRepository,
  email: string,
  password: string,
  config: ReturnType<typeof resolveAuthConfig>,
  runtime: AuthRuntime,
): Promise<{ userId: string; cookie: string; identity: Awaited<ReturnType<ReturnType<typeof createSessionService>['authenticate']>> }> {
  const sessions = createSessionService(repository, config, runtime);
  const login = await sessions.login(email, password);
  const cookie = login.cookie.split(';', 1)[0];
  const identity = await sessions.authenticate(new Request('https://lastro.example/api/v1/auth/me', {
    headers: { cookie },
  }));
  return { userId: login.response.user.id, cookie, identity };
}

describe('deterministic real MySQL account races', () => {
  it.skipIf(!runMysqlTests)('commits one registration and one winner across same and distinct reset-token races', async () => {
    await withAuthTestDatabase(async ({ database, createDatabase }) => {
      const secondDatabase = createDatabase();
      const config = resolveAuthConfig(testAuthBindings());
      const now = BASE_TIME;
      const runtime = testRuntime(() => now);
      const firstRepository = createAuthRepository(database);
      const secondRepository = createAuthRepository(secondDatabase);

      const registerBarrier = arrivalBarrier(2, 'registration insertUser');
      const committedRegistrationInserts: Array<'first' | 'second'> = [];
      const firstRegister = createAccountService(
        beforeTransactionMethod(firstRepository, 'insertUser', registerBarrier, () => {
          committedRegistrationInserts.push('first');
        }), config, runtime,
      );
      const secondRegister = createAccountService(
        beforeTransactionMethod(secondRepository, 'insertUser', registerBarrier, () => {
          committedRegistrationInserts.push('second');
        }), config, runtime,
      );
      const registrationResultsPromise = Promise.allSettled([
        releaseBarrierOnFailure(firstRegister.register({
          email: 'Race@example.test', password: 'race-winner-password',
          password_confirmation: 'race-winner-password', display_name: 'Race One',
        }), registerBarrier),
        releaseBarrierOnFailure(secondRegister.register({
          email: 'race@example.test', password: 'race-loser-password',
          password_confirmation: 'race-loser-password', display_name: 'Race Two',
        }), registerBarrier),
      ]);
      await registerBarrier.ready;
      registerBarrier.release();
      const registrationResults = await registrationResultsPromise;
      expectBarrierArrivals(registerBarrier);
      const registrationFailures = registrationResults.filter((result) => result.status === 'rejected');
      if (registrationFailures[0]?.status === 'rejected') throw registrationFailures[0].reason;
      const acceptedResults = registrationResults.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      expect(acceptedResults[0]).toEqual(acceptedResults[1]);
      expect(acceptedResults[0]).toMatchObject({
        accepted: true, mail_availability: { code: 'AVAILABLE', retry_at: null },
      });

      const created = await database.first<{ id: unknown; status: unknown }>(`SELECT CAST(id AS CHAR) AS id, status
        FROM auth_users WHERE email_normalized = ?`, ['race@example.test']);
      expect(created).toEqual({ id: '10000', status: 'PENDING_EMAIL' });
      const registrationCounts = await database.first<{ users: unknown; credentials: unknown; actions: unknown; mail: unknown; sessions: unknown }>(`SELECT
        (SELECT COUNT(*) FROM auth_users WHERE email_normalized = ?) AS users,
        (SELECT COUNT(*) FROM auth_credentials AS c INNER JOIN auth_users AS u ON u.id = c.user_id WHERE u.email_normalized = ?) AS credentials,
        (SELECT COUNT(*) FROM auth_action_tokens WHERE user_id = ?) AS actions,
        (SELECT COUNT(*) FROM auth_mail_outbox WHERE user_id = ?) AS mail,
        (SELECT COUNT(*) FROM auth_sessions WHERE user_id = ?) AS sessions`, [
        'race@example.test', 'race@example.test', created.id, created.id, created.id,
      ]);
      expect(Object.values(registrationCounts ?? {}).map(Number)).toEqual([1, 1, 1, 1, 0]);
      expect(committedRegistrationInserts).toHaveLength(1);
      const registrationWinner = committedRegistrationInserts[0];
      if (!registrationWinner) throw new Error('registration INSERT winner was not recorded');
      const registrationPasswords = {
        first: 'race-winner-password',
        second: 'race-loser-password',
      } as const;
      const losingRegistration = registrationWinner === 'first' ? 'second' : 'first';
      const registrationCredential = await firstRepository.readCredentialByEmail('race@example.test');
      if (!registrationCredential) throw new Error('registration race credential is missing');
      await expect(verifyPassword(registrationPasswords[registrationWinner], registrationCredential, config)).resolves.toBe(true);
      await expect(verifyPassword(registrationPasswords[losingRegistration], registrationCredential, config)).resolves.toBe(false);

      const userId = String(created.id);
      const winningProfile = await firstRepository.readProfile(userId);
      if (!winningProfile) throw new Error('registration winner profile is missing');
      const sameReset = await addResetAction(firstRepository, userId, config, now);
      const sameResetAction = await firstRepository.readActionSnapshot(await digestToken(sameReset));
      expect(sameResetAction?.emailSnapshot, 'same RESET action email snapshot').toBe(winningProfile.email);
      const sameResetBarrier = arrivalBarrier(2, 'same RESET lockUser');
      const sameResetServices = [
        createActionService(beforeTransactionMethod(firstRepository, 'lockUser', sameResetBarrier), config, runtime),
        createActionService(beforeTransactionMethod(secondRepository, 'lockUser', sameResetBarrier), config, runtime),
      ];
      const samePasswords = ['same-reset-first-password', 'same-reset-second-password'] as const;
      const sameResetResultsPromise = Promise.allSettled([
        releaseBarrierOnFailure(sameResetServices[0]!.confirmReset(sameReset, samePasswords[0], samePasswords[0]), sameResetBarrier),
        releaseBarrierOnFailure(sameResetServices[1]!.confirmReset(sameReset, samePasswords[1], samePasswords[1]), sameResetBarrier),
      ]);
      await sameResetBarrier.ready;
      sameResetBarrier.release();
      const sameResetResults = await sameResetResultsPromise;
      expectBarrierArrivals(sameResetBarrier);
      expect(sameResetResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(sameResetResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await expectOnePasswordWinner(firstRepository, config, 'race@example.test', samePasswords)).toBe(
        sameResetResults[0]?.status === 'fulfilled' ? 0 : 1,
      );

      const distinctTokens = await Promise.all([
        addResetAction(firstRepository, userId, config, now + 1),
        addResetAction(firstRepository, userId, config, now + 2),
      ]);
      const distinctResetBarrier = arrivalBarrier(2, 'distinct RESET lockUser');
      const distinctResetServices = [
        createActionService(beforeTransactionMethod(firstRepository, 'lockUser', distinctResetBarrier), config, runtime),
        createActionService(beforeTransactionMethod(secondRepository, 'lockUser', distinctResetBarrier), config, runtime),
      ];
      const distinctPasswords = ['distinct-reset-first-password', 'distinct-reset-second-password'] as const;
      const distinctResetResultsPromise = Promise.allSettled([
        releaseBarrierOnFailure(
          distinctResetServices[0]!.confirmReset(distinctTokens[0]!, distinctPasswords[0], distinctPasswords[0]),
          distinctResetBarrier,
        ),
        releaseBarrierOnFailure(
          distinctResetServices[1]!.confirmReset(distinctTokens[1]!, distinctPasswords[1], distinctPasswords[1]),
          distinctResetBarrier,
        ),
      ]);
      await distinctResetBarrier.ready;
      distinctResetBarrier.release();
      const distinctResetResults = await distinctResetResultsPromise;
      expectBarrierArrivals(distinctResetBarrier);
      expect(distinctResetResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(distinctResetResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await expectOnePasswordWinner(firstRepository, config, 'race@example.test', distinctPasswords)).toBe(
        distinctResetResults[0]?.status === 'fulfilled' ? 0 : 1,
      );

      const finalState = await database.first<{ status: unknown; credential_version: unknown; auth_version: unknown }>(`SELECT status, credential_version, auth_version
        FROM auth_users WHERE id = ?`, [userId]);
      expect(finalState).toEqual({ status: 'PENDING_EMAIL', credential_version: 3, auth_version: 3 });
      await expect(database.first<{ count: unknown }>(`SELECT COUNT(*) AS count FROM auth_action_tokens
        WHERE user_id = ? AND purpose = 'RESET_PASSWORD' AND consumed_at IS NOT NULL`, [userId]))
        .resolves.toEqual({ count: 2 });
      await expect(database.first<{ count: unknown }>(`SELECT COUNT(*) AS count FROM auth_mail_outbox
        WHERE user_id = ? AND purpose = 'PASSWORD_CHANGED'`, [userId]))
        .resolves.toEqual({ count: 2 });
      expect(now).toBe(BASE_TIME);
    });
  }, 120_000);

  it.skipIf(!runMysqlTests)('rejects a stale login snapshot and keeps logout-all or deactivation ahead of a racing refresh', async () => {
    await withAuthTestDatabase(async ({ database, createDatabase }) => {
      const secondDatabase = createDatabase();
      const config = resolveAuthConfig(testAuthBindings());
      const now = BASE_TIME;
      const runtime = testRuntime(() => now);
      const firstRepository = createAuthRepository(database);
      const secondRepository = createAuthRepository(secondDatabase);

      const loginRaceUser = await seedUser(firstRepository, database, 'login-race@example.test', INITIAL_PASSWORD, config, now, true);
      const seedSession = await seedLogin(firstRepository, 'login-race@example.test', INITIAL_PASSWORD, config, runtime);
      expect(seedSession.userId).toBe(loginRaceUser);
      const credentialBeforeWrongCurrent = await firstRepository.readCredentialByEmail('login-race@example.test');
      if (!credentialBeforeWrongCurrent) throw new Error('wrong-current fixture credential is missing');
      await expect(createActionService(secondRepository, config, runtime).changePassword(
        seedSession.identity,
        'wrong-current-password',
        'unused-password-candidate',
        'unused-password-candidate',
      )).rejects.toMatchObject({ status: 400 });
      const credentialAfterWrongCurrent = await firstRepository.readCredentialByEmail('login-race@example.test');
      if (!credentialAfterWrongCurrent) throw new Error('wrong-current credential disappeared');
      expect({
        ...credentialAfterWrongCurrent,
        salt: Array.from(credentialAfterWrongCurrent.salt),
        digest: Array.from(credentialAfterWrongCurrent.digest),
      }).toEqual({
        ...credentialBeforeWrongCurrent,
        salt: Array.from(credentialBeforeWrongCurrent.salt),
        digest: Array.from(credentialBeforeWrongCurrent.digest),
      });
      await expect(firstRepository.readIdentity(seedSession.identity.sessionDigest, now))
        .resolves.toMatchObject({ userId: loginRaceUser });

      const loginBarrier = arrivalBarrier(1, 'stale login credential snapshot');
      const staleLoginPromise = releaseBarrierOnFailure(createSessionService(
        afterCredentialSnapshot(firstRepository, loginBarrier), config, runtime,
      ).login('login-race@example.test', INITIAL_PASSWORD), loginBarrier);
      await loginBarrier.ready;

      await createActionService(secondRepository, config, runtime).changePassword(
        seedSession.identity,
        INITIAL_PASSWORD,
        'changed-during-login-password',
        'changed-during-login-password',
      );
      loginBarrier.release();
      await expect(staleLoginPromise).rejects.toMatchObject({ status: 401 });
      expectBarrierArrivals(loginBarrier);
      await expect(database.first<{ count: unknown }>('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?', [loginRaceUser]))
        .resolves.toEqual({ count: 1 });
      await expect(firstRepository.readIdentity(seedSession.identity.sessionDigest, now)).resolves.toBeNull();
      const updatedCredential = await firstRepository.readCredentialByEmail('login-race@example.test');
      expect(updatedCredential?.credentialVersion).toBe(2);
      expect(await verifyPassword('changed-during-login-password', updatedCredential!, config)).toBe(true);

      const samePassword = await seedActiveSession(
        firstRepository, database, 'same-password@example.test', config, runtime, now,
      );
      await createActionService(firstRepository, config, runtime).changePassword(
        samePassword.identity,
        INITIAL_PASSWORD,
        INITIAL_PASSWORD,
        INITIAL_PASSWORD,
      );
      await expect(database.first<{ credential_version: unknown; auth_version: unknown }>(
        'SELECT credential_version, auth_version FROM auth_users WHERE id = ?', [samePassword.userId],
      )).resolves.toEqual({ credential_version: 2, auth_version: 2 });
      const samePasswordCredential = await firstRepository.readCredentialByEmail('same-password@example.test');
      if (!samePasswordCredential) throw new Error('same-password credential is missing');
      await expect(verifyPassword(INITIAL_PASSWORD, samePasswordCredential, config)).resolves.toBe(true);
      await expect(firstRepository.readIdentity(samePassword.identity.sessionDigest, now)).resolves.toBeNull();

      const changeRace = await seedActiveSession(
        firstRepository, database, 'change-race@example.test', config, runtime, now,
      );
      const changeRaceBarrier = arrivalBarrier(2, 'concurrent changePassword lockUser');
      const changeRaceServices = [
        createActionService(beforeTransactionMethod(firstRepository, 'lockUser', changeRaceBarrier), config, runtime),
        createActionService(beforeTransactionMethod(secondRepository, 'lockUser', changeRaceBarrier), config, runtime),
      ];
      const changeRacePasswords = ['change-race-first-password', 'change-race-second-password'] as const;
      const changeRaceResultsPromise = Promise.allSettled([
        releaseBarrierOnFailure(changeRaceServices[0]!.changePassword(
          changeRace.identity, INITIAL_PASSWORD, changeRacePasswords[0], changeRacePasswords[0],
        ), changeRaceBarrier),
        releaseBarrierOnFailure(changeRaceServices[1]!.changePassword(
          changeRace.identity, INITIAL_PASSWORD, changeRacePasswords[1], changeRacePasswords[1],
        ), changeRaceBarrier),
      ]);
      await changeRaceBarrier.ready;
      changeRaceBarrier.release();
      const changeRaceResults = await changeRaceResultsPromise;
      expectBarrierArrivals(changeRaceBarrier);
      expect(changeRaceResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(changeRaceResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const changeRaceWinner = changeRaceResults.findIndex((result) => result.status === 'fulfilled');
      if (changeRaceWinner < 0) throw new Error('concurrent password change has no committed winner');
      const rejectedChange = changeRaceResults.find((result) => result.status === 'rejected');
      expect(rejectedChange).toMatchObject({ status: 'rejected', reason: { status: 401 } });
      await expect(database.first<{ credential_version: unknown; auth_version: unknown }>(
        'SELECT credential_version, auth_version FROM auth_users WHERE id = ?', [changeRace.userId],
      )).resolves.toEqual({ credential_version: 2, auth_version: 2 });
      const changeRaceCredential = await firstRepository.readCredentialByEmail('change-race@example.test');
      if (!changeRaceCredential) throw new Error('password-change race credential is missing');
      await expect(verifyPassword(changeRacePasswords[changeRaceWinner]!, changeRaceCredential, config)).resolves.toBe(true);
      await expect(verifyPassword(changeRacePasswords[1 - changeRaceWinner]!, changeRaceCredential, config)).resolves.toBe(false);
      await expect(firstRepository.readIdentity(changeRace.identity.sessionDigest, now)).resolves.toBeNull();

      const logoutRace = await seedActiveSession(
        firstRepository, database, 'logout-race@example.test', config, runtime, now,
      );
      const logoutExpiryBefore = await database.first<{ expires_at: string }>(`SELECT CAST(expires_at AS CHAR) AS expires_at
        FROM auth_sessions WHERE user_id = ?`, [logoutRace.userId]);
      if (!logoutExpiryBefore) throw new Error('logout-all fixture session is missing');
      const logoutRefreshBarrier = arrivalBarrier(1, 'refresh before logout-all lock');
      const logoutRefreshPromise = releaseBarrierOnFailure(createSessionService(
        beforeTransactionMethod(firstRepository, 'lockUser', logoutRefreshBarrier), config, runtime,
      ).refresh(logoutRace.identity), logoutRefreshBarrier);
      const logoutRefreshSettledPromise = Promise.allSettled([logoutRefreshPromise]);
      await logoutRefreshBarrier.ready;
      const logoutAllSettled = await Promise.allSettled([
        createSessionService(secondRepository, config, runtime).logoutAll(logoutRace.identity),
      ]);
      logoutRefreshBarrier.release();
      const [logoutRefreshResult] = await logoutRefreshSettledPromise;
      expectBarrierArrivals(logoutRefreshBarrier);
      expect(logoutAllSettled[0]?.status).toBe('fulfilled');
      expect(logoutRefreshResult).toMatchObject({ status: 'rejected', reason: { status: 401 } });
      await expect(database.first<{ expires_at: string }>(`SELECT CAST(expires_at AS CHAR) AS expires_at
        FROM auth_sessions WHERE user_id = ?`, [logoutRace.userId])).resolves.toEqual(logoutExpiryBefore);
      await expect(firstRepository.readIdentity(logoutRace.identity.sessionDigest, now)).resolves.toBeNull();
      await expect(createSessionService(firstRepository, config, runtime).authenticate(new Request(
        'https://lastro.example/api/v1/auth/me', { headers: { cookie: logoutRace.cookie } },
      ))).rejects.toMatchObject({ status: 401 });
      await expect(database.first<{ auth_version: unknown }>(
        'SELECT auth_version FROM auth_users WHERE id = ?', [logoutRace.userId],
      )).resolves.toEqual({ auth_version: 2 });

      const disabledRace = await seedActiveSession(
        firstRepository, database, 'disabled-race@example.test', config, runtime, now,
      );
      const disabledExpiryBefore = await database.first<{ expires_at: string }>(`SELECT CAST(expires_at AS CHAR) AS expires_at
        FROM auth_sessions WHERE user_id = ?`, [disabledRace.userId]);
      if (!disabledExpiryBefore) throw new Error('deactivation fixture session is missing');
      const disabledRefreshBarrier = arrivalBarrier(1, 'refresh before deactivation lock');
      const disabledRefresh = releaseBarrierOnFailure(createSessionService(
        beforeTransactionMethod(firstRepository, 'lockUser', disabledRefreshBarrier), config, runtime,
      ).refresh(disabledRace.identity), disabledRefreshBarrier);
      const disabledRefreshSettledPromise = Promise.allSettled([disabledRefresh]);
      await disabledRefreshBarrier.ready;
      const deactivationSettled = await Promise.allSettled([secondDatabase.transaction(async (transaction) => {
        const user = await transaction.first<{ id: unknown }>(
          'SELECT id FROM auth_users WHERE id = ? FOR UPDATE', [disabledRace.userId],
        );
        if (!user) throw new Error('deactivation fixture user is missing');
        await transaction.run(`UPDATE auth_users SET status = 'DISABLED', auth_version = auth_version + 1, updated_at = ?
          WHERE id = ?`, [now + 1, disabledRace.userId]);
      })]);
      disabledRefreshBarrier.release();
      const [disabledRefreshResult] = await disabledRefreshSettledPromise;
      expectBarrierArrivals(disabledRefreshBarrier);
      expect(deactivationSettled[0]?.status).toBe('fulfilled');
      expect(disabledRefreshResult).toMatchObject({ status: 'rejected', reason: { status: 401 } });
      await expect(database.first<{ expires_at: string }>(`SELECT CAST(expires_at AS CHAR) AS expires_at
        FROM auth_sessions WHERE user_id = ?`, [disabledRace.userId])).resolves.toEqual(disabledExpiryBefore);
      await expect(database.first<{ status: unknown; auth_version: unknown }>(
        'SELECT status, auth_version FROM auth_users WHERE id = ?', [disabledRace.userId],
      )).resolves.toEqual({ status: 'DISABLED', auth_version: 2 });
      await expect(firstRepository.readIdentity(disabledRace.identity.sessionDigest, now)).resolves.toBeNull();
      await expect(createSessionService(firstRepository, config, runtime).authenticate(new Request(
        'https://lastro.example/api/v1/auth/me', { headers: { cookie: disabledRace.cookie } },
      ))).rejects.toMatchObject({ status: 401 });
    });
  }, 120_000);
});

async function seedActiveSession(
  repository: AuthRepository,
  database: Parameters<typeof seedUser>[1],
  email: string,
  config: ReturnType<typeof resolveAuthConfig>,
  runtime: AuthRuntime,
  now: number,
) {
  const userId = await seedUser(repository, database, email, INITIAL_PASSWORD, config, now, true);
  const session = await seedLogin(repository, email, INITIAL_PASSWORD, config, runtime);
  return { userId, ...session };
}
