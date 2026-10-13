import { MysqlDatabaseError } from '../db/mysql-client';
import { requireAuthConfig } from './config';
import { createOpaqueToken, createPasswordMaterial, digestToken } from './crypto';
import { normalizeEmail, parseDisplayName, validatePasswordConfirmation } from './input';
import { prepareActionMail } from './mail';
import type { AuthRepository } from './repository';
import type { AuthAcceptedResponse, AuthConfig, AuthRuntime } from './types';
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

function unsupportedRegistrationAvatar(): AuthFailure {
  return new AuthFailure('AUTH_AVATAR_UNSUPPORTED', 415, '注册暂不支持上传头像，请稍后在账号设置中添加');
}

export function createAccountService(repository: AuthRepository, config: AuthConfig, runtime: AuthRuntime) {
  return {
    async register(input: RegisterInput): Promise<AuthAcceptedResponse> {
      requireAuthConfig(config);
      if (input.avatar_base64 !== undefined) throw unsupportedRegistrationAvatar();

      const email = normalizeEmail(input.email);
      const password = validatePasswordConfirmation(input.password, input.password_confirmation);
      const displayName = parseDisplayName(input.display_name);
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
        await tx.insertMailJob({ ...mailDraft, userId: user.id });
        await tx.appendEvent({
          userId: user.id,
          event: 'REGISTER',
          requestId: input.requestId ?? null,
          result: 'SUCCESS',
          reason: null,
          createdAt,
        });
      });

      return { accepted: true, mail_availability: mailAvailability };
    },
  };
}
