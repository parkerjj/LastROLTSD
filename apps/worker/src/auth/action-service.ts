import {
  createOpaqueToken,
  createPasswordMaterial,
  digestToken,
  verifyPassword,
} from './crypto';
import { normalizeEmail, validatePassword, validatePasswordConfirmation } from './input';
import { prepareActionMail, preparePasswordChangedMail } from './mail';
import type {
  ActionSnapshot,
  AuthRepository,
  AuthSessionRecord,
  AuthTx,
  UserRecord,
} from './repository';
import { createSessionService, sessionCookie, type AuthenticatedSessionIdentity } from './session-service';
import type {
  AuthAcceptedResponse,
  AuthConfig,
  AuthRuntime,
  CredentialSnapshot,
  PasswordMaterial,
  UserId,
} from './types';
import { AuthFailure } from './types';

const EMAIL_VERIFICATION_LIFETIME = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_LIFETIME = 30 * 60 * 1000;
const SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1000;

function unavailable(): AuthFailure {
  return new AuthFailure('AUTH_UNAVAILABLE', 503, '账号服务暂不可用');
}

function unauthenticated(): AuthFailure {
  return new AuthFailure('AUTH_UNAUTHENTICATED', 401, '请先登录');
}

function verifiedAccountRequired(): AuthFailure {
  return new AuthFailure('AUTH_VERIFIED_ACCOUNT_REQUIRED', 403, '请先验证邮箱后再修改密码');
}

function invalidAction(): AuthFailure {
  return new AuthFailure('AUTH_ACTION_INVALID', 400, '链接已失效，请登录后重新申请');
}

function invalidCurrentPassword(): AuthFailure {
  return new AuthFailure('AUTH_CURRENT_PASSWORD_INVALID', 400, '当前密码不正确');
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function sameCredential(left: CredentialSnapshot, right: CredentialSnapshot | null): boolean {
  return right !== null
    && left.userId === right.userId
    && left.status === right.status
    && left.credentialVersion === right.credentialVersion
    && left.authVersion === right.authVersion
    && left.scheme === right.scheme
    && left.keyVersion === right.keyVersion
    && sameBytes(left.salt, right.salt)
    && sameBytes(left.digest, right.digest);
}

function currentSession(
  user: UserRecord,
  session: AuthSessionRecord | null,
  identity: AuthenticatedSessionIdentity,
  now: number,
): session is AuthSessionRecord {
  return session !== null
    && user.id === identity.userId
    && session.userId === user.id
    && session.revokedAt === null
    && session.expiresAt > now
    && user.status !== 'DISABLED'
    && (user.status !== 'ACTIVE' || user.emailVerifiedAt !== null)
    && (user.status !== 'PENDING_EMAIL' || user.emailVerifiedAt === null)
    && session.credentialVersion === user.credentialVersion
    && session.authVersion === user.authVersion
    && identity.credentialVersion === user.credentialVersion
    && identity.authVersion === user.authVersion
    && sameBytes(session.tokenDigest, identity.sessionDigest);
}

function validAction(
  action: ActionSnapshot | null,
  user: UserRecord,
  digest: Uint8Array,
  purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD',
  now: number,
): action is ActionSnapshot {
  return action !== null
    && action.userId === user.id
    && action.purpose === purpose
    && action.emailSnapshot === user.email
    && action.credentialVersion === user.credentialVersion
    && action.expiresAt > now
    && action.consumedAt === null
    && action.revokedAt === null
    && sameBytes(action.tokenDigest, digest);
}

function actionInput(
  tokenDigest: Uint8Array,
  user: UserRecord,
  purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD',
  createdAt: number,
  expiresAt: number,
) {
  return {
    tokenDigest,
    userId: user.id,
    purpose,
    emailSnapshot: user.email,
    credentialVersion: user.credentialVersion,
    createdAt,
    expiresAt,
  };
}

async function prepareAction(
  user: Pick<UserRecord, 'id' | 'email' | 'displayName'>,
  purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD',
  createdAt: number,
  lifetime: number,
  config: AuthConfig,
) {
  const token = createOpaqueToken();
  const tokenDigest = await digestToken(token);
  const expiresAt = createdAt + lifetime;
  const mail = await prepareActionMail({
    mailId: crypto.randomUUID(),
    actionDigest: tokenDigest,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    token,
    purpose,
    createdAt,
    expiresAt,
  }, config);
  return { tokenDigest, createdAt, expiresAt, mail };
}

function appendEvent(tx: AuthTx, userId: UserId, event: string, createdAt: number): Promise<void> {
  return tx.appendEvent({
    userId,
    event,
    requestId: null,
    result: 'SUCCESS',
    reason: null,
    createdAt,
  });
}

export function createActionService(repository: AuthRepository, config: AuthConfig, runtime: AuthRuntime) {
  if (!config.enabled) throw unavailable();
  const sessions = createSessionService(repository, config, runtime);

  return {
    async requestVerification(identity: AuthenticatedSessionIdentity): Promise<AuthAcceptedResponse | { verified: true }> {
      const profile = await repository.readProfile(identity.userId);
      if (!profile) throw unauthenticated();

      const shouldPrepareMail = profile.status === 'PENDING_EMAIL';
      const availability = shouldPrepareMail ? await repository.readMailAvailability(runtime.now()) : null;
      const draft = shouldPrepareMail
        ? await prepareAction({
          id: profile.id,
          email: profile.email,
          displayName: profile.display_name,
        }, 'VERIFY_EMAIL', runtime.now(), EMAIL_VERIFICATION_LIFETIME, config)
        : null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const outcome = await repository.transaction(async (tx) => {
          const user = await tx.lockUser(identity.userId);
          if (!user) throw unauthenticated();
          const session = await tx.readSessionForUpdate(identity.sessionDigest);
          const sessionCheckAt = runtime.now();
          if (!currentSession(user, session, identity, sessionCheckAt)) throw unauthenticated();
          if (user.status === 'ACTIVE' && user.emailVerifiedAt !== null) return { status: 'verified' as const };
          if (user.status !== 'PENDING_EMAIL' || user.emailVerifiedAt !== null) throw unauthenticated();
          if (!draft || !availability) throw unavailable();

          const reusable = await tx.readReusableActionMail(
            user.id,
            'VERIFY_EMAIL',
            user.credentialVersion,
            user.email,
            () => runtime.now(),
          );
          if (reusable.status === 'retry') return { status: 'retry' as const };
          const now = reusable.now;
          if (!currentSession(user, session, identity, now)) throw unauthenticated();

          if (reusable.status === 'reuse') {
            if (!validAction(reusable.action, user, reusable.action.tokenDigest, 'VERIFY_EMAIL', now)) return { status: 'retry' as const };
            await appendEvent(tx, user.id, 'EMAIL_VERIFICATION_REQUEST', now);
            return { status: 'accepted' as const, mailAvailability: availability };
          }

          if (user.email !== profile.email || draft.expiresAt <= now || draft.createdAt >= draft.expiresAt) {
            throw unavailable();
          }
          await tx.insertAction(actionInput(draft.tokenDigest, user, 'VERIFY_EMAIL', draft.createdAt, draft.expiresAt));
          await tx.insertMailJob(draft.mail);
          await appendEvent(tx, user.id, 'EMAIL_VERIFICATION_REQUEST', now);
          return { status: 'accepted' as const, mailAvailability: availability };
        });

        if (outcome.status === 'retry') continue;
        if (outcome.status === 'verified') return { verified: true };
        return { accepted: true, mail_availability: outcome.mailAvailability };
      }
      throw unavailable();
    },

    async confirmVerification(identity: AuthenticatedSessionIdentity, token: string) {
      let tokenDigest: Uint8Array;
      try {
        tokenDigest = await digestToken(token);
      } catch (error) {
        if (error instanceof AuthFailure && error.code === 'INVALID_TOKEN') throw invalidAction();
        throw error;
      }
      const snapshot = await repository.readActionSnapshot(tokenDigest);
      if (!snapshot || snapshot.userId !== identity.userId || snapshot.purpose !== 'VERIFY_EMAIL') throw invalidAction();

      const nextSessionToken = createOpaqueToken();
      const nextSessionDigest = await digestToken(nextSessionToken);
      const nextIdentity = await repository.transaction(async (tx) => {
        const user = await tx.lockUser(snapshot.userId);
        if (!user) throw invalidAction();
        const action = await tx.readActionForUpdate(tokenDigest);
        const session = await tx.readSessionForUpdate(identity.sessionDigest);
        const now = runtime.now();
        if (!currentSession(user, session, identity, now)) throw unauthenticated();
        if (user.status !== 'PENDING_EMAIL' || user.emailVerifiedAt !== null
          || !validAction(action, user, tokenDigest, 'VERIFY_EMAIL', now)) throw invalidAction();
        if (!await tx.consumeAction(tokenDigest, now)) throw invalidAction();
        if (!await tx.markEmailVerified(user.id, now)) throw invalidAction();
        await tx.revokeActions(user.id, 'VERIFY_EMAIL', now);
        if (!await tx.revokeSession(identity.sessionDigest, now)) throw unauthenticated();

        const expiresAt = now + SESSION_LIFETIME;
        await tx.insertSession({
          tokenDigest: nextSessionDigest,
          userId: user.id,
          credentialVersion: user.credentialVersion,
          authVersion: user.authVersion,
          createdAt: now,
          lastSeenAt: now,
          expiresAt,
        });
        await appendEvent(tx, user.id, 'EMAIL_VERIFIED', now);
        return {
          userId: user.id,
          status: 'ACTIVE' as const,
          credentialVersion: user.credentialVersion,
          authVersion: user.authVersion,
          sessionDigest: nextSessionDigest,
          expiresAt,
        };
      });

      return {
        response: await sessions.me(nextIdentity),
        cookie: sessionCookie(config, nextSessionToken),
      };
    },

    async changePassword(
      identity: AuthenticatedSessionIdentity,
      currentPasswordValue: string,
      newPasswordValue: string,
      confirmationValue: string,
    ): Promise<void> {
      const currentPassword = validatePassword(currentPasswordValue);
      const newPassword = validatePasswordConfirmation(newPasswordValue, confirmationValue);
      const profile = await repository.readProfile(identity.userId);
      if (!profile) throw unauthenticated();
      if (profile.status !== 'ACTIVE') throw verifiedAccountRequired();
      const emailNormalized = normalizeEmail(profile.email).normalized;
      const snapshot = await repository.readCredentialByEmail(emailNormalized);
      if (!snapshot || snapshot.userId !== identity.userId) throw unauthenticated();
      if (snapshot.status !== 'ACTIVE' || snapshot.credentialVersion !== identity.credentialVersion
        || snapshot.authVersion !== identity.authVersion) throw unauthenticated();
      if (!await verifyPassword(currentPassword, snapshot, config)) throw invalidCurrentPassword();

      const material = await createPasswordMaterial(newPassword, config);
      const notification = await preparePasswordChangedMail({
        mailId: crypto.randomUUID(),
        userId: profile.id,
        email: profile.email,
        displayName: profile.display_name,
        createdAt: runtime.now(),
      }, config);

      await repository.transaction(async (tx) => {
        const user = await tx.lockUser(identity.userId);
        if (!user) throw unauthenticated();
        const session = await tx.readSessionForUpdate(identity.sessionDigest);
        const credential = await tx.readCredential(identity.userId);
        const now = runtime.now();
        if (!currentSession(user, session, identity, now)) throw unauthenticated();
        if (user.status !== 'ACTIVE' || user.emailVerifiedAt === null) throw verifiedAccountRequired();
        if (!sameCredential(snapshot, credential)) throw invalidCurrentPassword();

        const nextCredentialVersion = user.credentialVersion + 1;
        await tx.saveCredential(user.id, material, nextCredentialVersion, now);
        await tx.bumpAuthVersion(user.id, now);
        await tx.revokeActions(user.id, 'all', now);
        await tx.insertMailJob(notification);
        await appendEvent(tx, user.id, 'PASSWORD_CHANGE', now);
      });
    },

    async requestReset(emailValue: string): Promise<AuthAcceptedResponse> {
      const email = normalizeEmail(emailValue);
      const availability = await repository.readMailAvailability(runtime.now());
      const snapshot = await repository.readCredentialByEmail(email.normalized);
      if (!snapshot || snapshot.status === 'DISABLED') return { accepted: true, mail_availability: availability };

      const profile = await repository.readProfile(snapshot.userId);
      if (!profile || normalizeEmail(profile.email).normalized !== email.normalized || profile.status === 'DISABLED') {
        return { accepted: true, mail_availability: availability };
      }

      const draft = await prepareAction({
        id: profile.id,
        email: profile.email,
        displayName: profile.display_name,
      }, 'RESET_PASSWORD', runtime.now(), PASSWORD_RESET_LIFETIME, config);

      await repository.transaction(async (tx) => {
        const user = await tx.lockUser(snapshot.userId);
        if (!user) return;
        const credential = await tx.readCredential(snapshot.userId);
        const now = runtime.now();
        if (user.status === 'DISABLED' || !sameCredential(snapshot, credential)
          || normalizeEmail(user.email).normalized !== email.normalized
          || user.email !== profile.email || draft.expiresAt <= now) return;

        await tx.insertAction(actionInput(draft.tokenDigest, user, 'RESET_PASSWORD', draft.createdAt, draft.expiresAt));
        await tx.insertMailJob(draft.mail);
        await appendEvent(tx, user.id, 'PASSWORD_RESET_REQUEST', now);
      });
      return { accepted: true, mail_availability: availability };
    },

    async confirmReset(token: string, newPasswordValue: string, confirmationValue: string): Promise<{ changedUserId: UserId }> {
      const newPassword = validatePasswordConfirmation(newPasswordValue, confirmationValue);
      let tokenDigest: Uint8Array;
      try {
        tokenDigest = await digestToken(token);
      } catch (error) {
        if (error instanceof AuthFailure && error.code === 'INVALID_TOKEN') throw invalidAction();
        throw error;
      }
      const snapshot = await repository.readActionSnapshot(tokenDigest);
      if (!snapshot || snapshot.purpose !== 'RESET_PASSWORD') throw invalidAction();
      const profile = await repository.readProfile(snapshot.userId);
      if (!profile || profile.email !== snapshot.emailSnapshot || profile.status === 'DISABLED') throw invalidAction();

      const material: PasswordMaterial = await createPasswordMaterial(newPassword, config);
      const notification = await preparePasswordChangedMail({
        mailId: crypto.randomUUID(),
        userId: profile.id,
        email: profile.email,
        displayName: profile.display_name,
        createdAt: runtime.now(),
      }, config);

      const changedUserId = await repository.transaction(async (tx) => {
        const user = await tx.lockUser(snapshot.userId);
        if (!user) throw invalidAction();
        const action = await tx.readActionForUpdate(tokenDigest);
        const credential = await tx.readCredential(user.id);
        const now = runtime.now();
        if (user.status === 'DISABLED' || !validAction(action, user, tokenDigest, 'RESET_PASSWORD', now)
          || !credential || credential.credentialVersion !== user.credentialVersion
          || credential.userId !== user.id) throw invalidAction();
        if (!await tx.consumeAction(tokenDigest, now)) throw invalidAction();

        await tx.saveCredential(user.id, material, user.credentialVersion + 1, now);
        await tx.bumpAuthVersion(user.id, now);
        await tx.revokeActions(user.id, 'all', now);
        await tx.insertMailJob(notification);
        await appendEvent(tx, user.id, 'PASSWORD_RESET', now);
        return user.id;
      });
      return { changedUserId };
    },
  };
}
