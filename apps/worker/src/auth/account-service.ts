import { MysqlDatabaseError } from '../db/mysql-client';
import { requireAuthConfig } from './config';
import { createOpaqueToken, createPasswordMaterial, digestToken } from './crypto';
import { normalizeEmail, parseDisplayName, validatePasswordConfirmation } from './input';
import { validateAvatarBase64 } from './avatar';
import { prepareActionMail } from './mail';
import type { AuthRepository, AuthSessionRecord, UserRecord } from './repository';
import type { AccountProfile, AuthAcceptedResponse, AuthConfig, AuthIdentity, AuthRuntime } from './types';
import { AuthFailure } from './types';

const EMAIL_VERIFICATION_LIFETIME = 24 * 60 * 60 * 1000;

export interface RegisterInput {
  email: string;
  password: string;
  password_confirmation: string;
  display_name: string;
  avatar_base64?: string;
  requestId?: string | null;
}

function emailUniqueConflict(error: unknown): boolean {
  return error instanceof MysqlDatabaseError && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062);
}

function unauthenticatedProfile(): AuthFailure {
  return new AuthFailure('AUTH_UNAUTHENTICATED', 401, '请先登录');
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function validProfileSession(identity: AuthIdentity, user: UserRecord, session: AuthSessionRecord | null, now: number): boolean {
  return (user.status === 'PENDING_EMAIL' || user.status === 'ACTIVE')
    && (user.status !== 'ACTIVE' || user.emailVerifiedAt !== null)
    && user.id === identity.userId
    && user.credentialVersion === identity.credentialVersion
    && user.authVersion === identity.authVersion
    && session !== null
    && session.userId === user.id
    && session.revokedAt === null
    && session.expiresAt > now
    && session.credentialVersion === user.credentialVersion
    && session.authVersion === user.authVersion
    && sameBytes(session.tokenDigest, identity.sessionDigest);
}

async function currentProfile(repository: AuthRepository, userId: string): Promise<AccountProfile> {
  const profile = await repository.readProfile(userId);
  if (!profile) throw unauthenticatedProfile();
  return profile;
}

export function createAccountService(repository: AuthRepository, config: AuthConfig, runtime: AuthRuntime) {
  return {
    async register(input: RegisterInput): Promise<AuthAcceptedResponse> {
      requireAuthConfig(config);

      const email = normalizeEmail(input.email);
      const password = validatePasswordConfirmation(input.password, input.password_confirmation);
      const displayName = parseDisplayName(input.display_name);
      const avatarBase64 = input.avatar_base64 === undefined
        ? null
        : validateAvatarBase64(input.avatar_base64).base64;
      const createdAt = runtime.now();
      const mailAvailability = await repository.readMailAvailability(createdAt);

      const material = await createPasswordMaterial(password, config);
      const token = createOpaqueToken();
      const actionDigest = await digestToken(token);
      const mailId = crypto.randomUUID();
      const expiresAt = createdAt + EMAIL_VERIFICATION_LIFETIME;
      const mailDraft = await prepareActionMail({
        mailId,
        actionDigest,
        userId: null,
        email: email.delivery,
        displayName,
        token,
        purpose: 'VERIFY_EMAIL',
        createdAt,
        expiresAt,
      }, config);

      await repository.transaction(async (tx) => {
        let user;
        try {
          user = await tx.insertUser({
            email: email.delivery,
            emailNormalized: email.normalized,
            displayName,
            createdAt,
          });
        } catch (error) {
          if (emailUniqueConflict(error)) return;
          throw error;
        }

        await tx.insertCredential(user.id, material);
        await tx.insertAction({
          tokenDigest: actionDigest,
          userId: user.id,
          purpose: 'VERIFY_EMAIL',
          emailSnapshot: email.delivery,
          credentialVersion: user.credentialVersion,
          createdAt,
          expiresAt,
        });
        if (avatarBase64 !== null) await tx.saveAvatar(user.id, avatarBase64, createdAt);
        await tx.insertMailJob({ ...mailDraft, userId: user.id });
        await tx.appendEvent({
          userId: user.id,
          event: 'REGISTER',
          requestId: input.requestId ?? null,
          result: 'SUCCESS',
          reason: null,
          createdAt,
        });
        if (avatarBase64 !== null) {
          await tx.appendEvent({
            userId: user.id,
            event: 'AVATAR_UPDATED',
            requestId: input.requestId ?? null,
            result: 'SUCCESS',
            reason: 'avatar_version=' + (user.avatarVersion + 1),
            createdAt,
          });
        }
      });
      runtime.wakeMail?.();

      return { accepted: true, mail_availability: mailAvailability };
    },

    async updateDisplayName(identity: AuthIdentity, name: string, requestIdValue: string | null = null): Promise<AccountProfile> {
      requireAuthConfig(config);
      const displayName = parseDisplayName(name);
      await repository.transaction(async (tx) => {
        const user = await tx.lockUser(identity.userId);
        if (!user) throw unauthenticatedProfile();
        const session = await tx.readSessionForUpdate(identity.sessionDigest);
        const now = runtime.now();
        if (!validProfileSession(identity, user, session, now)) throw unauthenticatedProfile();
        await tx.saveDisplayName(user.id, displayName, now);
        await tx.appendEvent({
          userId: user.id,
          event: 'DISPLAY_NAME_UPDATED',
          requestId: requestIdValue,
          result: 'SUCCESS',
          reason: null,
          createdAt: now,
        });
      });
      return currentProfile(repository, identity.userId);
    },

    async setAvatar(identity: AuthIdentity, base64OrNull: string | null, requestIdValue: string | null = null): Promise<AccountProfile> {
      requireAuthConfig(config);
      const avatarBase64 = base64OrNull === null ? null : validateAvatarBase64(base64OrNull).base64;
      let nextVersion = 0;
      await repository.transaction(async (tx) => {
        const user = await tx.lockUser(identity.userId);
        if (!user) throw unauthenticatedProfile();
        const session = await tx.readSessionForUpdate(identity.sessionDigest);
        const now = runtime.now();
        if (!validProfileSession(identity, user, session, now)) throw unauthenticatedProfile();
        nextVersion = user.avatarVersion + 1;
        await tx.saveAvatar(user.id, avatarBase64, now);
        await tx.appendEvent({
          userId: user.id,
          event: avatarBase64 === null ? 'AVATAR_DELETED' : 'AVATAR_UPDATED',
          requestId: requestIdValue,
          result: 'SUCCESS',
          reason: 'avatar_version=' + nextVersion,
          createdAt: now,
        });
      });
      return currentProfile(repository, identity.userId);
    },
  };
}
