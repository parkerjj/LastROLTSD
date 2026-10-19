import { createOpaqueToken, digestToken } from '../auth/crypto';
import type { TokenRepository, TokenRow } from './token-repository';
import {
  KE_DEVICE_CODE_TTL_MS,
  KE_DEVICE_POLL_INTERVAL_SECONDS,
  KE_TOKEN_MAX_PER_USER,
  KE_TOKEN_PREFIX,
  KE_TOKEN_TOUCH_INTERVAL_MS,
  KE_TOKEN_TTL_MS,
  KeFailure,
} from './types';

/** 全是辅音、去掉易混字符，避免拼出单词，也便于口头/肉眼核对。20^8 ≈ 2.6e10。 */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;
const USER_CODE_ATTEMPTS = 5;
const DEFAULT_LABEL = 'KoreEngine';
const MAX_LABEL_CHARS = 64;
/** 允许比 interval 略早一点的轮询，容忍网络抖动。 */
const SLOW_DOWN_TOLERANCE_MS = 1000;

export interface Attestation {
  ipHash: Uint8Array | null;
  uaHash: Uint8Array | null;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export type PollResponse =
  | { status: 'pending'; interval: number }
  | { status: 'approved'; access_token: string; token_type: 'Bearer'; expires_at: number };

export interface DeviceLookup {
  user_code: string;
  label: string;
  created_at: number;
  expires_at: number;
}

export interface BearerIdentity {
  tokenId: number;
  userId: string;
}

export interface TokenService {
  createDeviceCode(input: { label: unknown } & Attestation): Promise<DeviceCodeResponse>;
  lookup(userCode: unknown): Promise<DeviceLookup>;
  decide(userId: string, userCode: unknown, approve: boolean): Promise<void>;
  poll(deviceCode: unknown, attestation: Attestation): Promise<PollResponse>;
  authenticate(authorization: string | null): Promise<BearerIdentity>;
  list(userId: string): Promise<TokenRow[]>;
  revoke(userId: string, tokenId: number): Promise<void>;
}

/** 去掉大小写、连字符与空白后校验字母表与长度；非法返回 null。 */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/gu, '');
  return code.length === USER_CODE_LENGTH && [...code].every((char) => USER_CODE_ALPHABET.includes(char)) ? code : null;
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function randomUserCode(): string {
  let code = '';
  // 拒绝采样：只取 < 240（20 的整数倍），避免取模偏置。
  while (code.length < USER_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 240 && code.length < USER_CODE_LENGTH) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    }
  }
  return code;
}

/** label 由客户端自报，属于不可信文本：去掉控制/格式字符（含双向控制符）并限长，按码点截断以免产生孤立代理项。 */
function sanitizeLabel(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_LABEL;
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const limited = Array.from(cleaned).slice(0, MAX_LABEL_CHARS).join('');
  return limited === '' ? DEFAULT_LABEL : limited;
}

function unauthenticated(): KeFailure {
  return new KeFailure('KE_AUTH_UNAUTHENTICATED', 401, '请先登录');
}

function deviceExpired(): KeFailure {
  return new KeFailure('KE_DEVICE_EXPIRED', 410, '设备码无效或已过期，请重新发起登录');
}

function deviceNotFound(): KeFailure {
  return new KeFailure('KE_DEVICE_NOT_FOUND', 404, '验证码无效或已过期');
}

function parseBearer(authorization: string | null): string | null {
  if (authorization === null) return null;
  const match = /^Bearer\s+(\S+)$/iu.exec(authorization.trim());
  const token = match?.[1];
  if (!token || !token.startsWith(KE_TOKEN_PREFIX)) return null;
  const opaque = token.slice(KE_TOKEN_PREFIX.length);
  return /^[A-Za-z0-9_-]{43}$/u.test(opaque) ? opaque : null;
}

type PollOutcome =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'approved'; token: string; expiresAt: number };

export function createTokenService(
  repository: TokenRepository,
  options: { siteUrl: string },
  now: () => number = () => Date.now(),
): TokenService {
  return {
    async createDeviceCode(input) {
      const timestamp = now();
      const deviceCode = createOpaqueToken();
      const digest = await digestToken(deviceCode);
      const label = sanitizeLabel(input.label);
      for (let attempt = 0; attempt < USER_CODE_ATTEMPTS; attempt += 1) {
        const userCode = randomUserCode();
        const inserted = await repository.insertDeviceCode({
          digest, userCode, label, ipHash: input.ipHash, uaHash: input.uaHash, now: timestamp, expiresAt: timestamp + KE_DEVICE_CODE_TTL_MS,
        });
        if (inserted) {
          const display = formatUserCode(userCode);
          return {
            device_code: deviceCode,
            user_code: display,
            verification_uri: `${options.siteUrl}/ke/device`,
            verification_uri_complete: `${options.siteUrl}/ke/device?code=${display}`,
            expires_in: KE_DEVICE_CODE_TTL_MS / 1000,
            interval: KE_DEVICE_POLL_INTERVAL_SECONDS,
          };
        }
      }
      throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
    },

    async lookup(userCode) {
      const code = normalizeUserCode(userCode);
      const row = code === null ? null : await repository.findPendingByUserCode(code, now());
      if (row === null) throw deviceNotFound();
      return { user_code: formatUserCode(row.user_code), label: row.label, created_at: row.created_at, expires_at: row.expires_at };
    },

    async decide(userId, userCode, approve) {
      const code = normalizeUserCode(userCode);
      const decided = code !== null && await repository.decide(code, Number(userId), approve ? 'APPROVED' : 'DENIED', now());
      if (!decided) throw deviceNotFound();
    },

    async poll(deviceCode, attestation) {
      let digest: Uint8Array;
      try {
        digest = await digestToken(deviceCode as string);
      } catch {
        throw deviceExpired();
      }
      const timestamp = now();
      // 事务内不能 throw（会回滚删除）；统一返回结果，事务提交后再映射成错误。
      const outcome = await repository.transaction(async (tx): Promise<PollOutcome> => {
        const row = await tx.findDeviceByDigestForUpdate(digest);
        if (row === null) return { kind: 'expired' };
        if (row.expires_at <= timestamp) {
          await tx.deleteDevice(row.id);
          return { kind: 'expired' };
        }
        if (row.status === 'DENIED') {
          await tx.deleteDevice(row.id);
          return { kind: 'denied' };
        }
        if (row.status === 'PENDING') {
          const tooFast = row.last_polled_at !== null
            && timestamp - row.last_polled_at < KE_DEVICE_POLL_INTERVAL_SECONDS * 1000 - SLOW_DOWN_TOLERANCE_MS;
          if (tooFast) return { kind: 'slow_down' };
          await tx.markPolled(row.id, timestamp);
          return { kind: 'pending' };
        }

        // APPROVED：设备码一次性，无论兑换是否成功都删除；账号状态以兑换时刻为准。
        const userId = row.user_id;
        const user = userId === null ? null : await tx.readUserForUpdate(userId);
        await tx.deleteDevice(row.id);
        if (userId === null || user === null || !user.usable) return { kind: 'denied' };
        if (await tx.countActiveTokens(userId, timestamp) >= KE_TOKEN_MAX_PER_USER) {
          await tx.revokeLeastRecentlyUsed(userId, timestamp);
        }
        const opaque = createOpaqueToken();
        const expiresAt = timestamp + KE_TOKEN_TTL_MS;
        await tx.insertToken({
          userId, digest: await digestToken(opaque), label: row.label,
          credentialVersion: user.credentialVersion, authVersion: user.authVersion,
          ipHash: attestation.ipHash, uaHash: attestation.uaHash, now: timestamp, expiresAt,
        });
        return { kind: 'approved', token: `${KE_TOKEN_PREFIX}${opaque}`, expiresAt };
      });

      switch (outcome.kind) {
        case 'pending':
          return { status: 'pending', interval: KE_DEVICE_POLL_INTERVAL_SECONDS };
        case 'slow_down':
          throw new KeFailure('KE_RATE_LIMITED', 429, '轮询过于频繁，请放慢', { retry_after: KE_DEVICE_POLL_INTERVAL_SECONDS });
        case 'expired':
          throw deviceExpired();
        case 'denied':
          throw new KeFailure('KE_DEVICE_DENIED', 403, '授权已被拒绝');
        case 'approved':
          return { status: 'approved', access_token: outcome.token, token_type: 'Bearer', expires_at: outcome.expiresAt };
      }
    },

    async authenticate(authorization) {
      const opaque = parseBearer(authorization);
      if (opaque === null) throw unauthenticated();
      let digest: Uint8Array;
      try {
        digest = await digestToken(opaque);
      } catch {
        // 长度对但不是规范 base64url（如全 a）：digestToken 会拒绝，对外一律按未登录处理。
        throw unauthenticated();
      }
      const record = await repository.readBearer(digest, now());
      if (record === null) throw unauthenticated();
      const timestamp = now();
      if (timestamp - record.last_used_at > KE_TOKEN_TOUCH_INTERVAL_MS) {
        await repository.touchToken(record.id, timestamp, timestamp + KE_TOKEN_TTL_MS);
      }
      return { tokenId: record.id, userId: String(record.user_id) };
    },

    list(userId) {
      return repository.listTokens(Number(userId), now());
    },

    async revoke(userId, tokenId) {
      if (!await repository.revokeToken(Number(userId), tokenId, now())) {
        throw new KeFailure('KE_TOKEN_NOT_FOUND', 404, '授权设备不存在或已撤销');
      }
    },
  };
}
