import { describe, expect, it } from 'vitest';
import { digestToken } from '../src/auth/crypto';
import { createTokenService, formatUserCode, normalizeUserCode } from '../src/ke/token-service';
import type { BearerRecord, DeviceCodeRow, NewDeviceCode, NewToken, TokenRepository, TokenRow, TokenTx, TokenUser } from '../src/ke/token-repository';
import { KE_TOKEN_MAX_PER_USER, KE_TOKEN_TTL_MS } from '../src/ke/types';

const SITE = 'https://lastro.example';
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

interface StoredDevice extends DeviceCodeRow { digest: string }
interface StoredToken extends TokenRow { digest: string; user_id: number; credentialVersion: number; authVersion: number; revoked_at: number | null }

interface FakeTokenRepository extends TokenRepository {
  devices: Map<number, StoredDevice>;
  tokens: StoredToken[];
  users: Map<number, TokenUser>;
  touches: number;
}

function makeFakeRepository(): FakeTokenRepository {
  const devices = new Map<number, StoredDevice>();
  const tokens: StoredToken[] = [];
  const users = new Map<number, TokenUser>([[10000, { credentialVersion: 1, authVersion: 1, usable: true }], [10001, { credentialVersion: 1, authVersion: 1, usable: true }]]);
  let nextDevice = 1;
  let nextToken = 1;
  const state = { touches: 0 };

  const tx: TokenTx = {
    async readUserForUpdate(userId) {
      return users.get(userId) ?? null;
    },
    async findDeviceByDigestForUpdate(digest) {
      return [...devices.values()].find((device) => device.digest === hex(digest)) ?? null;
    },
    async markPolled(id, now) {
      devices.get(id)!.last_polled_at = now;
    },
    async deleteDevice(id) {
      devices.delete(id);
    },
    async countActiveTokens(userId, now) {
      return tokens.filter((token) => token.user_id === userId && token.revoked_at === null && token.expires_at > now).length;
    },
    async revokeLeastRecentlyUsed(userId, now) {
      const active = tokens.filter((token) => token.user_id === userId && token.revoked_at === null && token.expires_at > now);
      active.sort((a, b) => a.last_used_at - b.last_used_at || a.id - b.id);
      if (active[0]) active[0].revoked_at = now;
    },
    async insertToken(token: NewToken) {
      const id = nextToken;
      nextToken += 1;
      tokens.push({
        id, digest: hex(token.digest), user_id: token.userId, label: token.label,
        credentialVersion: token.credentialVersion, authVersion: token.authVersion,
        created_at: token.now, last_used_at: token.now, expires_at: token.expiresAt, revoked_at: null,
      });
      return id;
    },
  };

  const repository: FakeTokenRepository = {
    devices,
    tokens,
    users,
    get touches() { return state.touches; },
    async insertDeviceCode(code: NewDeviceCode) {
      if ([...devices.values()].some((device) => device.user_code === code.userCode)) return false;
      const id = nextDevice;
      nextDevice += 1;
      devices.set(id, {
        id, digest: hex(code.digest), user_code: code.userCode, status: 'PENDING', user_id: null, label: code.label,
        last_polled_at: null, created_at: code.now, expires_at: code.expiresAt,
      });
      return true;
    },
    async findPendingByUserCode(userCode, now) {
      return [...devices.values()].find((device) => device.user_code === userCode && device.status === 'PENDING' && device.expires_at > now) ?? null;
    },
    async decide(userCode, userId, status, now) {
      const device = [...devices.values()].find((d) => d.user_code === userCode && d.status === 'PENDING' && d.expires_at > now);
      if (!device) return false;
      device.status = status;
      device.user_id = userId;
      return true;
    },
    async readBearer(digest, now): Promise<BearerRecord | null> {
      const token = tokens.find((t) => t.digest === hex(digest));
      if (!token || token.revoked_at !== null || token.expires_at <= now) return null;
      const user = users.get(token.user_id);
      if (!user || !user.usable || user.credentialVersion !== token.credentialVersion || user.authVersion !== token.authVersion) return null;
      return { id: token.id, user_id: token.user_id, last_used_at: token.last_used_at };
    },
    async touchToken(id, now, expiresAt) {
      const token = tokens.find((t) => t.id === id)!;
      token.last_used_at = now;
      token.expires_at = expiresAt;
      state.touches += 1;
    },
    async listTokens(userId, now) {
      return tokens.filter((t) => t.user_id === userId && t.revoked_at === null && t.expires_at > now)
        .map(({ id, label, created_at, last_used_at, expires_at }) => ({ id, label, created_at, last_used_at, expires_at }));
    },
    async revokeToken(userId, id, now) {
      const token = tokens.find((t) => t.id === id && t.user_id === userId && t.revoked_at === null);
      if (!token) return false;
      token.revoked_at = now;
      return true;
    },
    transaction: (work) => work(tx),
  };
  return repository;
}

function harness() {
  let nowMs = 1_700_000_000_000;
  const repository = makeFakeRepository();
  const service = createTokenService(repository, { siteUrl: SITE }, () => nowMs);
  const advance = (ms: number) => { nowMs += ms; };
  const attestation = { ipHash: null, uaHash: null };

  /** 走完设备授权流程，返回 access_token。 */
  async function login(userId = '10000', label = 'RoBrowser KE'): Promise<string> {
    const code = await service.createDeviceCode({ label, ...attestation });
    await service.decide(userId, code.user_code, true);
    advance(6_000);
    const result = await service.poll(code.device_code, attestation);
    if (result.status !== 'approved') throw new Error('expected approved');
    return result.access_token;
  }

  return { repository, service, advance, now: () => nowMs, attestation, login };
}

describe('user_code', () => {
  it('规范化：忽略大小写、连字符与空白；非法字符/长度返回 null', () => {
    expect(normalizeUserCode('bcdf-ghjk')).toBe('BCDFGHJK');
    expect(normalizeUserCode(' BCDF GHJK ')).toBe('BCDFGHJK');
    expect(normalizeUserCode('BCDFGHJ')).toBeNull();
    expect(normalizeUserCode('BCDFGHJA')).toBeNull(); // 元音不在字母表内
    expect(normalizeUserCode(undefined)).toBeNull();
    expect(formatUserCode('BCDFGHJK')).toBe('BCDF-GHJK');
  });
});

describe('ke device flow', () => {
  it('createDeviceCode：返回格式化的 user_code 与完整授权链接；库里只存 device_code 的摘要', async () => {
    const { repository, service, attestation } = harness();
    const response = await service.createDeviceCode({ label: 'RoBrowser KE', ...attestation });

    expect(response.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u);
    expect(response.verification_uri).toBe(`${SITE}/ke/device`);
    expect(response.verification_uri_complete).toBe(`${SITE}/ke/device?code=${response.user_code}`);
    expect(response.expires_in).toBe(600);
    expect(response.interval).toBe(5);
    expect(response.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const stored = [...repository.devices.values()][0]!;
    expect(stored.digest).toBe(hex(await digestToken(response.device_code)));
    expect(JSON.stringify(stored)).not.toContain(response.device_code);
    expect(stored.user_code).toBe(response.user_code.replace('-', ''));
  });

  it('label 清洗：去控制字符、限长、缺省为 KoreEngine', async () => {
    const { repository, service, attestation } = harness();
    await service.createDeviceCode({ label: '  RoBrowser\u0000\n KE ‮', ...attestation });
    await service.createDeviceCode({ label: 'x'.repeat(200), ...attestation });
    await service.createDeviceCode({ label: undefined, ...attestation });
    const labels = [...repository.devices.values()].map((device) => device.label);
    expect(labels[0]).toBe('RoBrowser KE');
    expect(labels[1]).toHaveLength(64);
    expect(labels[2]).toBe('KoreEngine');
  });

  it('完整流程：pending → 批准 → 兑换 token → 可用 Bearer 鉴权；设备码只能兑换一次', async () => {
    const { repository, service, advance, now, attestation } = harness();
    const code = await service.createDeviceCode({ label: 'RoBrowser KE', ...attestation });

    expect(await service.poll(code.device_code, attestation)).toEqual({ status: 'pending', interval: 5 });
    expect(await service.lookup(code.user_code)).toMatchObject({ label: 'RoBrowser KE' });

    await service.decide('10000', code.user_code, true);
    advance(6_000);
    const approved = await service.poll(code.device_code, attestation);
    expect(approved.status).toBe('approved');
    if (approved.status !== 'approved') return;
    expect(approved.access_token).toMatch(/^ke1_[A-Za-z0-9_-]{43}$/u);
    expect(approved.token_type).toBe('Bearer');
    expect(approved.expires_at).toBe(now() + KE_TOKEN_TTL_MS);

    expect(await service.authenticate(`Bearer ${approved.access_token}`)).toMatchObject({ userId: '10000' });
    expect(repository.devices.size).toBe(0);
    expect(JSON.stringify(repository.tokens)).not.toContain(approved.access_token);

    advance(6_000);
    await expect(service.poll(code.device_code, attestation)).rejects.toMatchObject({ code: 'KE_DEVICE_EXPIRED', status: 410 });
  });

  it('轮询过快返回 KE_RATE_LIMITED（slow_down），到间隔后恢复', async () => {
    const { service, advance, attestation } = harness();
    const code = await service.createDeviceCode({ label: 'KE', ...attestation });
    await service.poll(code.device_code, attestation);
    advance(1_000);
    await expect(service.poll(code.device_code, attestation)).rejects.toMatchObject({ code: 'KE_RATE_LIMITED', status: 429 });
    advance(4_000);
    expect(await service.poll(code.device_code, attestation)).toEqual({ status: 'pending', interval: 5 });
  });

  it('拒绝：轮询得到 KE_DEVICE_DENIED，设备码随即作废', async () => {
    const { repository, service, advance, attestation } = harness();
    const code = await service.createDeviceCode({ label: 'KE', ...attestation });
    await service.decide('10000', code.user_code, false);
    advance(6_000);
    await expect(service.poll(code.device_code, attestation)).rejects.toMatchObject({ code: 'KE_DEVICE_DENIED', status: 403 });
    expect(repository.devices.size).toBe(0);
    expect(repository.tokens).toHaveLength(0);
  });

  it('过期：轮询得到 KE_DEVICE_EXPIRED，批准/查询得到 KE_DEVICE_NOT_FOUND', async () => {
    const { service, advance, attestation } = harness();
    const code = await service.createDeviceCode({ label: 'KE', ...attestation });
    advance(10 * 60 * 1000 + 1);
    await expect(service.poll(code.device_code, attestation)).rejects.toMatchObject({ code: 'KE_DEVICE_EXPIRED' });
    await expect(service.decide('10000', code.user_code, true)).rejects.toMatchObject({ code: 'KE_DEVICE_NOT_FOUND', status: 404 });
    await expect(service.lookup(code.user_code)).rejects.toMatchObject({ code: 'KE_DEVICE_NOT_FOUND' });
  });

  it('同一验证码只能决定一次：批准后不能被另一账号改写或再批准', async () => {
    const { service, advance, attestation } = harness();
    const code = await service.createDeviceCode({ label: 'KE', ...attestation });
    await service.decide('10000', code.user_code, true);
    await expect(service.decide('10001', code.user_code, true)).rejects.toMatchObject({ code: 'KE_DEVICE_NOT_FOUND' });
    advance(6_000);
    const approved = await service.poll(code.device_code, attestation);
    if (approved.status !== 'approved') throw new Error('expected approved');
    expect(await service.authenticate(`Bearer ${approved.access_token}`)).toMatchObject({ userId: '10000' });
  });

  it('未知/格式错误的验证码与设备码', async () => {
    const { service, attestation } = harness();
    await expect(service.lookup('nonsense')).rejects.toMatchObject({ code: 'KE_DEVICE_NOT_FOUND' });
    await expect(service.decide('10000', 'BCDF-GHJK', true)).rejects.toMatchObject({ code: 'KE_DEVICE_NOT_FOUND' });
    await expect(service.poll('x'.repeat(43), attestation)).rejects.toMatchObject({ code: 'KE_DEVICE_EXPIRED' });
    await expect(service.poll('not a device code', attestation)).rejects.toMatchObject({ code: 'KE_DEVICE_EXPIRED' });
  });

  it('批准后账号被禁用 / 邮箱未验证：兑换时拒绝，不发 token', async () => {
    const { repository, service, advance, attestation } = harness();
    const code = await service.createDeviceCode({ label: 'KE', ...attestation });
    await service.decide('10000', code.user_code, true);
    repository.users.set(10000, { credentialVersion: 1, authVersion: 1, usable: false });
    advance(6_000);
    await expect(service.poll(code.device_code, attestation)).rejects.toMatchObject({ code: 'KE_DEVICE_DENIED' });
    expect(repository.tokens).toHaveLength(0);
  });
});

describe('ke bearer token', () => {
  it('缺失 / 非 Bearer / 非 ke1_ 前缀 / 格式不对 / 未知 token 一律 KE_AUTH_UNAUTHENTICATED', async () => {
    const { service } = harness();
    for (const header of [null, '', 'Basic abc', 'Bearer', 'Bearer ke1_short', `Bearer ${'a'.repeat(43)}`, `Bearer ke1_${'a'.repeat(43)}`, `Bearer ke1_${'a'.repeat(44)}`]) {
      await expect(service.authenticate(header)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED', status: 401 });
    }
  });

  it('撤销、过期、账号 authVersion 变化（改密码/登出全部）、账号被禁用后立即失效', async () => {
    const { repository, service, advance, login } = harness();
    const revoked = await login();
    const versionBumped = await login();
    const disabled = await login();
    const expiring = await login();

    await service.revoke('10000', repository.tokens[0]!.id);
    await expect(service.authenticate(`Bearer ${revoked}`)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });

    repository.users.set(10000, { credentialVersion: 1, authVersion: 2, usable: true });
    await expect(service.authenticate(`Bearer ${versionBumped}`)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });

    repository.users.set(10000, { credentialVersion: 1, authVersion: 1, usable: false });
    await expect(service.authenticate(`Bearer ${disabled}`)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });

    repository.users.set(10000, { credentialVersion: 1, authVersion: 1, usable: true });
    advance(KE_TOKEN_TTL_MS + 1);
    await expect(service.authenticate(`Bearer ${expiring}`)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });
  });

  it('滑动有效期：每次使用顺延 90 天，但至多每小时写一次库', async () => {
    const { repository, service, advance, now, login } = harness();
    const token = await login();
    const row = repository.tokens[0]!;
    const issuedExpiry = row.expires_at;

    advance(10 * 60 * 1000);
    await service.authenticate(`Bearer ${token}`);
    expect(repository.touches).toBe(0);
    expect(row.expires_at).toBe(issuedExpiry);

    advance(61 * 60 * 1000);
    await service.authenticate(`Bearer ${token}`);
    expect(repository.touches).toBe(1);
    expect(row.expires_at).toBe(now() + KE_TOKEN_TTL_MS);
    expect(row.last_used_at).toBe(now());
  });

  it(`每账号最多 ${KE_TOKEN_MAX_PER_USER} 个有效 token：超出时撤销最久未用的，授权不失败`, async () => {
    const { repository, service, advance, login } = harness();
    const first = await login();
    for (let i = 0; i < KE_TOKEN_MAX_PER_USER; i += 1) {
      advance(1_000);
      await login();
    }
    const active = repository.tokens.filter((token) => token.revoked_at === null);
    expect(active).toHaveLength(KE_TOKEN_MAX_PER_USER);
    await expect(service.authenticate(`Bearer ${first}`)).rejects.toMatchObject({ code: 'KE_AUTH_UNAUTHENTICATED' });
  });

  it('列表只含本账号未撤销未过期的 token；撤销仅限本人，重复撤销 404', async () => {
    const { service, login } = harness();
    await login('10000', '电脑 A');
    await login('10001', '别人的设备');
    const mine = await service.list('10000');
    expect(mine.map((token) => token.label)).toEqual(['电脑 A']);

    await expect(service.revoke('10001', mine[0]!.id)).rejects.toMatchObject({ code: 'KE_TOKEN_NOT_FOUND', status: 404 });
    await service.revoke('10000', mine[0]!.id);
    await expect(service.revoke('10000', mine[0]!.id)).rejects.toMatchObject({ code: 'KE_TOKEN_NOT_FOUND' });
    expect(await service.list('10000')).toHaveLength(0);
  });
});
