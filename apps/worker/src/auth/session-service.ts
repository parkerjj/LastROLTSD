import { createOpaqueToken, digestToken, verifyPassword } from './crypto';
import { issueCsrf } from './csrf';
import { normalizeEmail } from './input';
import type { AuthRepository, AuthSessionRecord, LiveAuthIdentity, UserRecord } from './repository';
import { AuthFailure, type AccountStatus, type AuthConfig, type AuthSessionResponse, type AuthRuntime, type CredentialSnapshot } from './types';

const SESSION_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_DUMMY_SALT = new Uint8Array(16);
const SESSION_DUMMY_DIGEST = new Uint8Array(32);

export interface AuthenticatedSessionIdentity extends LiveAuthIdentity {
  readonly sessionToken: string;
}

export interface SessionService {
  login(email: string, password: string): Promise<{ response: AuthSessionResponse; cookie: string }>;
  authenticate(request: Request): Promise<AuthenticatedSessionIdentity>;
  me(identity: LiveAuthIdentity): Promise<AuthSessionResponse>;
  refresh(identity: AuthenticatedSessionIdentity): Promise<{ expires_at: number; csrf_token: string; cookie: string }>;
  logout(identityOrNull: AuthenticatedSessionIdentity | null): Promise<void>;
  logoutAll(identity: AuthenticatedSessionIdentity): Promise<void>;
}

interface SessionCookiePolicy {
  name: string;
  secure: boolean;
}

function unauthorized(): AuthFailure {
  return new AuthFailure('AUTH_UNAUTHENTICATED', 401, '请先登录');
}

function invalidCredentials(): AuthFailure {
  return new AuthFailure('AUTH_INVALID_CREDENTIALS', 401, '邮箱或密码不正确，或账号暂不可用');
}

function sessionUnavailable(): AuthFailure {
  return new AuthFailure('AUTH_UNAVAILABLE', 503, '账号服务暂不可用');
}

function validStatus(status: string): status is AccountStatus {
  return status === 'ACTIVE' || status === 'PENDING_EMAIL' || status === 'DISABLED';
}

function mayUseSession(user: UserRecord, session: AuthSessionRecord, identity: LiveAuthIdentity, now: number): boolean {
  return user.id === identity.userId
    && session.userId === user.id
    && session.revokedAt === null
    && session.expiresAt > now
    && user.status !== 'DISABLED'
    && validStatus(user.status)
    && (user.status !== 'ACTIVE' || user.emailVerifiedAt !== null)
    && session.credentialVersion === user.credentialVersion
    && session.authVersion === user.authVersion
    && identity.credentialVersion === user.credentialVersion
    && identity.authVersion === user.authVersion
    && sameBytes(session.tokenDigest, identity.sessionDigest);
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

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function cookiePolicy(config: AuthConfig): SessionCookiePolicy {
  if (!config.enabled) throw sessionUnavailable();
  try {
    const url = new URL(config.authSiteUrl);
    if (url.protocol === 'https:') return { name: '__Host-ltsd-session', secure: true };
    if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')) {
      return { name: 'lastroweb-session-local', secure: false };
    }
  } catch {
    throw sessionUnavailable();
  }
  throw sessionUnavailable();
}

function readSessionToken(request: Request, config: AuthConfig): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const name = cookiePolicy(config).name;
  const cookies = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (cookies.length !== 1) return null;
  const token = cookies[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

export function sessionCookie(config: AuthConfig, token: string): string {
  const policy = cookiePolicy(config);
  return `${policy.name}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly;${policy.secure ? ' Secure;' : ''} SameSite=Lax`;
}

export function clearSessionCookie(config: AuthConfig): string {
  const policy = cookiePolicy(config);
  return `${policy.name}=; Max-Age=0; Path=/; HttpOnly;${policy.secure ? ' Secure;' : ''} SameSite=Lax`;
}

function sessionCsrfRequest(config: AuthConfig): Request {
  if (!config.enabled) throw sessionUnavailable();
  return new Request(config.authSiteUrl);
}

export function createSessionService(repository: AuthRepository, config: AuthConfig, runtime: AuthRuntime): SessionService {
  if (!config.enabled) throw sessionUnavailable();

  const dummyCredential: CredentialSnapshot = {
    userId: '0', status: 'DISABLED', credentialVersion: 1, authVersion: 1,
    scheme: 'hmac-sha256-v1', salt: SESSION_DUMMY_SALT, digest: SESSION_DUMMY_DIGEST,
    keyVersion: config.currentPasswordKeyVersion,
  };

  async function responseFor(identity: LiveAuthIdentity): Promise<AuthSessionResponse> {
    const profile = await repository.readProfile(identity.userId);
    if (!profile || profile.status === 'DISABLED' || !validStatus(profile.status)
      || (profile.status === 'ACTIVE' && profile.email_verified_at === null)) throw unauthorized();
    const csrf = await issueCsrf(sessionCsrfRequest(config), config, 'session', identity, () => runtime.now());
    return {
      user: profile,
      expires_at: identity.expiresAt,
      csrf_token: csrf.token,
      mail_availability: profile.status === 'PENDING_EMAIL' ? await repository.readMailAvailability(runtime.now()) : null,
    };
  }

  function authenticated(identity: LiveAuthIdentity, sessionToken: string): AuthenticatedSessionIdentity {
    return { ...identity, sessionToken };
  }

  return {
    async login(email, password) {
      const emailNormalized = normalizeEmail(email).normalized;
      const snapshot = await repository.readCredentialByEmail(emailNormalized);
      const passwordMatches = await verifyPassword(password, snapshot ?? dummyCredential, config);
      if (!snapshot || !passwordMatches || snapshot.status === 'DISABLED') throw invalidCredentials();

      const sessionToken = createOpaqueToken();
      const sessionDigest = await digestToken(sessionToken);
      let identity: AuthenticatedSessionIdentity | null = null;
      await repository.transaction(async (tx) => {
        const user = await tx.lockUser(snapshot.userId);
        if (!user) throw invalidCredentials();
        const credential = await tx.readCredential(snapshot.userId);
        if (!sameCredential(snapshot, credential)
          || user.status !== snapshot.status
          || user.credentialVersion !== snapshot.credentialVersion
          || user.authVersion !== snapshot.authVersion
          || user.status === 'DISABLED'
          || !validStatus(user.status)
          || (user.status === 'ACTIVE' && user.emailVerifiedAt === null)) throw invalidCredentials();

        const createdAt = runtime.now();
        const expiresAt = createdAt + SESSION_TTL_MILLISECONDS;
        await tx.insertSession({
          tokenDigest: sessionDigest,
          userId: user.id,
          credentialVersion: user.credentialVersion,
          authVersion: user.authVersion,
          createdAt,
          lastSeenAt: createdAt,
          expiresAt,
        });
        await tx.appendEvent({
          userId: user.id,
          event: 'LOGIN',
          requestId: null,
          result: 'SUCCESS',
          reason: null,
          createdAt,
        });
        identity = authenticated({
          userId: user.id,
          status: user.status,
          credentialVersion: user.credentialVersion,
          authVersion: user.authVersion,
          sessionDigest,
          expiresAt,
        }, sessionToken);
      });
      if (!identity) throw sessionUnavailable();
      return { response: await responseFor(identity), cookie: sessionCookie(config, sessionToken) };
    },

    async authenticate(request) {
      const sessionToken = readSessionToken(request, config);
      if (!sessionToken) throw unauthorized();
      let sessionDigest: Uint8Array;
      try {
        sessionDigest = await digestToken(sessionToken);
      } catch (error) {
        if (error instanceof AuthFailure && error.code === 'INVALID_TOKEN') throw unauthorized();
        throw error;
      }
      const identity = await repository.readIdentity(sessionDigest, runtime.now());
      if (!identity) throw unauthorized();
      return authenticated(identity, sessionToken);
    },

    me(identity) {
      return responseFor(identity);
    },

    async refresh(identity) {
      const expiresAt = await repository.transaction(async (tx) => {
        const user = await tx.lockUser(identity.userId);
        if (!user) throw unauthorized();
        const session = await tx.readSessionForUpdate(identity.sessionDigest);
        const now = runtime.now();
        if (!session || !mayUseSession(user, session, identity, now)) throw unauthorized();
        const nextExpiry = Math.max(session.expiresAt, now + SESSION_TTL_MILLISECONDS);
        // The locked row may match the new expiry exactly; a no-op UPDATE is still a valid refresh.
        await tx.renewSession(identity.sessionDigest, nextExpiry, now);
        return nextExpiry;
      });
      const csrf = await issueCsrf(sessionCsrfRequest(config), config, 'session', identity, () => runtime.now());
      return { expires_at: expiresAt, csrf_token: csrf.token, cookie: sessionCookie(config, identity.sessionToken) };
    },

    async logout(identityOrNull) {
      if (!identityOrNull) return;
      await repository.transaction(async (tx) => {
        const user = await tx.lockUser(identityOrNull.userId);
        if (!user) return;
        const session = await tx.readSessionForUpdate(identityOrNull.sessionDigest);
        if (!session || session.userId !== identityOrNull.userId) return;
        const now = runtime.now();
        const revoked = await tx.revokeSession(identityOrNull.sessionDigest, now);
        if (revoked) {
          await tx.appendEvent({
            userId: user.id,
            event: 'LOGOUT',
            requestId: null,
            result: 'SUCCESS',
            reason: null,
            createdAt: now,
          });
        }
      });
    },

    async logoutAll(identity) {
      await repository.transaction(async (tx) => {
        const user = await tx.lockUser(identity.userId);
        if (!user) throw unauthorized();
        const session = await tx.readSessionForUpdate(identity.sessionDigest);
        const now = runtime.now();
        if (!session || !mayUseSession(user, session, identity, now)) throw unauthorized();
        await tx.bumpAuthVersion(user.id, now);
        await tx.appendEvent({
          userId: user.id,
          event: 'LOGOUT_ALL',
          requestId: null,
          result: 'SUCCESS',
          reason: null,
          createdAt: now,
        });
      });
    },
  };
}
