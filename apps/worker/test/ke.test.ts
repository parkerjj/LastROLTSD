import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { base64UrlDecode, buildLicense, wrapChunkKey } from '../src/ke/crypto';
import { createKeService, type Attestation } from '../src/ke/service';
import type { KeConfig, BuildEntry } from '../src/ke/config';
import type { CharacterRow, InstanceRow, KeRepository, KeTx } from '../src/ke/repository';
import { KeFailure, type CharacterReport } from '../src/ke/types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const INST_A = '11111111-1111-4111-8111-111111111111';
const INST_B = '22222222-2222-4222-8222-222222222222';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function testKeConfig(manifest: ReadonlyMap<string, BuildEntry> | null = null): KeConfig {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    enabled: true,
    licensePrivateKey: new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' })),
    licenseKeyVersion: '1',
    coreKey: new Uint8Array(32).fill(9),
    coreKeyVersion: '3',
    buildManifest: manifest,
    instanceLimit: 1,
  };
}

function report(overrides: Partial<CharacterReport> = {}): CharacterReport {
  return {
    aid: 1000001,
    cid: 2000002,
    nid: 3000003,
    char_name: 'Poring',
    base_level: 99,
    job_level: 50,
    job_id: 4008,
    map_name: 'prt_fild08',
    ...overrides,
  };
}

interface FakeRepository extends KeRepository {
  characters: Map<string, CharacterRow>;
  instances: Map<string, InstanceRow>;
}

function makeFakeRepository(): FakeRepository {
  const characters = new Map<string, CharacterRow>();
  const instances = new Map<string, InstanceRow>();
  const key = (aid: number, cid: number, nid: number): string => `${aid}:${cid}:${nid}`;

  const tx: KeTx = {
    async lockUser() {
      // 无真实行锁；测试只验证串行化后的业务分支。
    },
    async findCharacter(aid, cid, nid) {
      return characters.get(key(aid, cid, nid)) ?? null;
    },
    async insertCharacter(userId, r, now) {
      characters.set(key(r.aid, r.cid, r.nid), {
        aid: r.aid, cid: r.cid, nid: r.nid, user_id: userId,
        char_name: r.char_name, base_level: r.base_level, job_level: r.job_level, job_id: r.job_id,
        map_name: r.map_name, bound_at: now, last_seen_at: now,
      });
    },
    async updateCharacterReport(userId, r, now) {
      const character = characters.get(key(r.aid, r.cid, r.nid));
      if (character && character.user_id === userId) Object.assign(character, {
        char_name: r.char_name, base_level: r.base_level, job_level: r.job_level, job_id: r.job_id, map_name: r.map_name, last_seen_at: now,
      });
    },
    async transferCharacter(userId, r, now) {
      const character = characters.get(key(r.aid, r.cid, r.nid));
      if (character) Object.assign(character, {
        user_id: userId, bound_at: now, char_name: r.char_name, base_level: r.base_level, job_level: r.job_level, job_id: r.job_id, map_name: r.map_name, last_seen_at: now,
      });
    },
    async insertInstance(instanceId, userId, r, buildId, _ipHash, _uaHash, now) {
      instances.set(instanceId, {
        instance_id: instanceId, user_id: userId, aid: r.aid, cid: r.cid, nid: r.nid,
        char_name: r.char_name, map_name: r.map_name, state: 'IDLE', mode: 'auto', features: null, build_id: buildId,
        license_expires_at: null, last_heartbeat_at: null, started_at: null,
        kicked_at: null, kicked_by_instance_id: null, stopped_at: null,
      });
    },
    async findInstance(instanceId) {
      return instances.get(instanceId) ?? null;
    },
    async rebindInstance(instanceId, r, buildId, _ipHash, _uaHash, now) {
      const instance = instances.get(instanceId);
      if (!instance) return;
      const wasActive = instance.state === 'ACTIVE';
      Object.assign(instance, {
        aid: r.aid, cid: r.cid, nid: r.nid, char_name: r.char_name, map_name: r.map_name, build_id: buildId,
        ...(wasActive ? { state: 'STOPPED', stopped_at: now } : {}),
      });
    },
    async updateInstanceReport(instanceId, r, licenseExpiresAt, _buildId, _ipHash, _uaHash, now) {
      const instance = instances.get(instanceId);
      if (instance) Object.assign(instance, {
        char_name: r.char_name, map_name: r.map_name, last_heartbeat_at: now, license_expires_at: licenseExpiresAt,
      });
    },
    async activateInstance(instanceId, mode, featuresJson, buildId, _ipHash, _uaHash, licenseExpiresAt, now) {
      const instance = instances.get(instanceId);
      if (instance) Object.assign(instance, {
        state: 'ACTIVE', mode, features: featuresJson, build_id: buildId,
        license_expires_at: licenseExpiresAt, started_at: now, last_heartbeat_at: now,
        kicked_at: null, kicked_by_instance_id: null, stopped_at: null,
      });
    },
    async markKicked(instanceId, kickedBy, now) {
      const instance = instances.get(instanceId);
      if (instance) Object.assign(instance, { state: 'KICKED', kicked_at: now, kicked_by_instance_id: kickedBy });
    },
    async markStopped(instanceId, now) {
      const instance = instances.get(instanceId);
      if (instance) Object.assign(instance, { state: 'STOPPED', stopped_at: now });
    },
    async countActive(userId, excludeInstanceId, threshold) {
      let count = 0;
      for (const instance of instances.values()) {
        if (instance.user_id === userId && instance.state === 'ACTIVE' && instance.mode === 'auto' && instance.instance_id !== excludeInstanceId && (instance.last_heartbeat_at ?? 0) > threshold) count += 1;
      }
      return count;
    },
    async listActive(userId, threshold) {
      const active: { instance_id: string; char_name: string | null; map_name: string | null; last_heartbeat_at: number | null }[] = [];
      for (const instance of instances.values()) {
        if (instance.user_id === userId && instance.state === 'ACTIVE' && instance.mode === 'auto' && (instance.last_heartbeat_at ?? 0) > threshold) {
          active.push({ instance_id: instance.instance_id, char_name: instance.char_name, map_name: instance.map_name, last_heartbeat_at: instance.last_heartbeat_at });
        }
      }
      return active;
    },
  };

  return {
    characters,
    instances,
    findCharacter: (aid, cid, nid) => tx.findCharacter(aid, cid, nid),
    findInstance: (instanceId) => tx.findInstance(instanceId),
    listCharacters: async (userId) => [...characters.values()].filter((character) => character.user_id === userId),
    transaction: (work) => work(tx),
    cleanup: async () => {},
  };
}

describe('ke crypto', () => {
  it('buildLicense 产出可验签的 license', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pkcs8 = new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' }));
    const rawPublic = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })).slice(-32);
    const payload = {
      v: 1 as const,
      kid: 'ke-license-ed25519-v1',
      iid: '11111111-1111-4111-8111-111111111111',
      uid: '10000',
      aid: 1,
      cid: 2,
      nid: 3,
      features: ['core'],
      key_versions: { core: 3 },
      iat: 1000,
      exp: 2800,
    };
    const license = await buildLicense(payload, pkcs8);
    const parts = license.split('.');
    const payloadText = parts[0]!;
    const signature = parts[1]!;
    expect(JSON.parse(decoder.decode(base64UrlDecode(payloadText)))).toEqual(payload);
    const verifyKey = await crypto.subtle.importKey('raw', toArrayBuffer(rawPublic), { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify('Ed25519', verifyKey, toArrayBuffer(base64UrlDecode(signature)), toArrayBuffer(base64UrlDecode(payloadText)))).toBe(true);
    // 对 base64url 文本签名是过去的错误约定（KE 永远验不过），必须保持为 false。
    expect(await crypto.subtle.verify('Ed25519', verifyKey, toArrayBuffer(base64UrlDecode(signature)), toArrayBuffer(encoder.encode(payloadText)))).toBe(false);
  });

  it('金标准：固定密钥签出的 license 与 KE（Rust 验签）侧测试里的常量逐字一致', async () => {
    // 同一个常量在 KoreEngine 的 crates/kore-license/tests/license_contract.rs 里被 Rust 验签；任一侧改了签名约定都会失败。
    const pkcs8 = new Uint8Array(Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]));
    const license = await buildLicense({
      v: 1, kid: 'ke-license-ed25519-v1', iid: '11111111-1111-4111-8111-111111111111', uid: '10000',
      aid: 1, cid: 2, nid: 3, features: ['core'], key_versions: { core: 1 }, iat: 1768700000, exp: 1768701800,
    }, pkcs8);
    expect(license).toBe('eyJ2IjoxLCJraWQiOiJrZS1saWNlbnNlLWVkMjU1MTktdjEiLCJpaWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJ1aWQiOiIxMDAwMCIsImFpZCI6MSwiY2lkIjoyLCJuaWQiOjMsImZlYXR1cmVzIjpbImNvcmUiXSwia2V5X3ZlcnNpb25zIjp7ImNvcmUiOjF9LCJpYXQiOjE3Njg3MDAwMDAsImV4cCI6MTc2ODcwMTgwMH0.8AfVOOQMdzc6UidZoxhQho5O-jhdnXRKIaD8uMG03hoK6xZfSixR1mJJtDiHkyCSfBgq443EQH5zqqcZdMGaAg');
  });

  it('wrapChunkKey 可用 KE 私钥解包还原', async () => {
    const kePair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
    const kePublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kePair.publicKey));
    const chunkKey = new Uint8Array(32).fill(7);
    const bundle = await wrapChunkKey(chunkKey, kePublicRaw, '11111111-1111-4111-8111-111111111111', 'core');

    const ephemeralPublic = await crypto.subtle.importKey('raw', toArrayBuffer(base64UrlDecode(bundle.ephemeral_public)), { name: 'X25519' }, false, []);
    const algorithm: { name: string; public: CryptoKey } = { name: 'X25519', public: ephemeralPublic };
    const shared = new Uint8Array(await crypto.subtle.deriveBits(algorithm, kePair.privateKey, 256));
    const ikm = await crypto.subtle.importKey('raw', toArrayBuffer(shared), { name: 'HKDF' }, false, ['deriveKey']);
    const kek = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(encoder.encode('11111111-1111-4111-8111-111111111111')), info: toArrayBuffer(encoder.encode('ltsd-ke-core-v1')) },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const ciphertext = base64UrlDecode(bundle.ciphertext);
    const tag = base64UrlDecode(bundle.tag);
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(base64UrlDecode(bundle.nonce)), additionalData: toArrayBuffer(encoder.encode('11111111-1111-4111-8111-111111111111')) },
      kek,
      toArrayBuffer(combined),
    ));
    expect(plain).toEqual(chunkKey);
  });
});

describe('ke service', () => {
  function serviceAndClock(manifest: ReadonlyMap<string, BuildEntry> | null = null) {
    let nowMs = 1_700_000_000_000;
    const repository = makeFakeRepository();
    const service = createKeService(repository, testKeConfig(manifest), () => nowMs);
    return { repository, service, advance: (ms: number) => { nowMs += ms; }, now: () => nowMs };
  }

  const bindInput = (instanceId: string, overrides: Partial<CharacterReport> = {}, extra: Partial<Attestation> = {}) => ({
    instanceId,
    report: report(overrides),
    needWasmKey: false,
    kePublicKey: null,
    buildId: null,
    buildHash: null,
    ipHash: null,
    uaHash: null,
    ...extra,
  });

  const noAttestation = (): Attestation => ({ buildId: null, buildHash: null, ipHash: null, uaHash: null });

  it('bind 建角色与实例（IDLE），同角色异账号 30 天内拒绝', async () => {
    const { repository, service, advance } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A));
    expect(repository.characters.get('1000001:2000002:3000003')?.user_id).toBe(10000);
    expect(repository.instances.get(INST_A)?.state).toBe('IDLE');

    advance(5 * 60 * 1000);
    await expect(service.bind('10001', bindInput(INST_B))).rejects.toMatchObject({ code: 'KE_CHARACTER_BOUND' });
  });

  it('bind 幂等：同 instance_id 重复 bind 不报错', async () => {
    const { repository, service } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A));
    await service.bind('10000', bindInput(INST_A));
    expect(repository.instances.size).toBe(1);
  });

  it('start 签发 license 并占用额度；满额返回活跃列表；踢人后放行', async () => {
    const { repository, service, advance } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
    const started = await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null });
    expect(typeof started.license).toBe('string');
    expect(repository.instances.get(INST_A)?.state).toBe('ACTIVE');

    advance(60_000);
    await service.bind('10000', bindInput(INST_B, { char_name: 'Bob' }));
    await expect(service.start('10000', { ...bindInput(INST_B, { char_name: 'Bob' }), kickInstanceId: null }))
      .rejects.toMatchObject({ code: 'KE_QUOTA_EXCEEDED' });

    const resumed = await service.start('10000', { ...bindInput(INST_B, { char_name: 'Bob' }), kickInstanceId: INST_A });
    expect(typeof resumed.license).toBe('string');
    expect(repository.instances.get(INST_A)?.state).toBe('KICKED');
    expect(repository.instances.get(INST_B)?.state).toBe('ACTIVE');
  });

  it('被踢实例心跳返回 KE_INSTANCE_KICKED；stop 后为 STOPPED', async () => {
    const { repository, service, advance, now } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
    await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null });
    advance(60_000);
    await service.bind('10000', bindInput(INST_B, { char_name: 'Bob' }));
    await service.start('10000', { ...bindInput(INST_B, { char_name: 'Bob' }), kickInstanceId: INST_A });

    await expect(service.heartbeat('10000', INST_A, report({ char_name: 'Alice' }), Math.floor(now() / 1000), noAttestation()))
      .rejects.toMatchObject({ code: 'KE_INSTANCE_KICKED' });

    await service.stop('10000', INST_B);
    expect(repository.instances.get(INST_B)?.state).toBe('STOPPED');
  });

  it('构建指纹校验失败返回 KE_BUILD_REJECTED', async () => {
    const manifest = new Map<string, BuildEntry>([['build-1', { chunk: 'core', sha256: 'a'.repeat(64) }]]);
    const { service } = serviceAndClock(manifest);
    await expect(service.bind('10000', bindInput(INST_A, {}, { buildId: 'build-1', buildHash: 'b'.repeat(64) })))
      .rejects.toMatchObject({ code: 'KE_BUILD_REJECTED' });
  });

  it('stop 作用于非 ACTIVE 实例返回 KE_INSTANCE_NOT_ACTIVE', async () => {
    const { service } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A));
    await expect(service.stop('10000', INST_A)).rejects.toMatchObject({ code: 'KE_INSTANCE_NOT_ACTIVE' });
  });
  it('heartbeat 上报与实例不同的角色被拒绝，且不改写他人角色记录', async () => {
    const { repository, service, now } = serviceAndClock();
    await service.bind('10001', bindInput(INST_B, { aid: 9, cid: 9, nid: 9, char_name: 'Victim' }));
    await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
    await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null });

    const spoofed = report({ aid: 9, cid: 9, nid: 9, char_name: '<img src=x onerror=alert(1)>' });
    await expect(service.heartbeat('10000', INST_A, spoofed, Math.floor(now() / 1000), noAttestation()))
      .rejects.toMatchObject({ code: 'KE_BAD_REQUEST' });
    expect(repository.characters.get('9:9:9')).toMatchObject({ user_id: 10001, char_name: 'Victim' });
    expect(repository.instances.get(INST_A)).toMatchObject({ aid: 1000001, cid: 2000002, nid: 3000003 });
  });

  it('start 携带与实例不同的角色仍被拒绝（须先 bind 换绑）', async () => {
    const { service } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
    await expect(service.start('10000', { ...bindInput(INST_A, { aid: 9, cid: 9, nid: 9 }), kickInstanceId: null }))
      .rejects.toMatchObject({ code: 'KE_BAD_REQUEST' });
  });

  it('bind 允许同账号把已有实例换绑到另一个角色（同窗口切换角色），且仍占同一个实例名额', async () => {
    const { repository, service, advance } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
    advance(1000);

    const second = { aid: 1000001, cid: 2000009, nid: 3000003, char_name: 'Bob' };
    await service.bind('10000', bindInput(INST_A, second));

    expect(repository.instances.size).toBe(1);
    expect(repository.instances.get(INST_A)).toMatchObject({ cid: 2000009, char_name: 'Bob', state: 'IDLE' });
    expect(repository.characters.get('1000001:2000009:3000003')?.user_id).toBe(10000);
    const started = await service.start('10000', { ...bindInput(INST_A, second), kickInstanceId: null });
    expect(typeof started.license).toBe('string');
  });

  it('换绑也适用于换账号 / 换服务器（aid、cid、nid 全部不同）', async () => {
    const { repository, service } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
    await service.bind('10000', bindInput(INST_A, { aid: 7, cid: 8, nid: 9, char_name: 'Other' }));
    expect(repository.instances.get(INST_A)).toMatchObject({ aid: 7, cid: 8, nid: 9, char_name: 'Other' });
  });

  it('换绑运行中的实例会让旧角色的授权失效，新角色须重新 start', async () => {
    const { repository, service, now } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
    await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null });
    const second = { cid: 2000009, char_name: 'Bob' };

    await service.bind('10000', bindInput(INST_A, second));

    expect(repository.instances.get(INST_A)).toMatchObject({ cid: 2000009, state: 'STOPPED' });
    await expect(service.heartbeat('10000', INST_A, report(second), Math.floor(now() / 1000), noAttestation()))
      .rejects.toMatchObject({ code: 'KE_INSTANCE_NOT_ACTIVE' });
    const started = await service.start('10000', { ...bindInput(INST_A, second), kickInstanceId: null });
    expect(typeof started.license).toBe('string');
  });

  it('换绑不能绕过角色归属：目标角色 30 天内属于其他账号时被拒绝且实例保持原角色', async () => {
    const { repository, service } = serviceAndClock();
    await service.bind('10001', bindInput(INST_B, { aid: 9, cid: 9, nid: 9, char_name: 'Victim' }));
    await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));

    await expect(service.bind('10000', bindInput(INST_A, { aid: 9, cid: 9, nid: 9 })))
      .rejects.toMatchObject({ code: 'KE_CHARACTER_BOUND' });
    expect(repository.instances.get(INST_A)).toMatchObject({ aid: 1000001, cid: 2000002, nid: 3000003 });
  });

  it('换绑不能夺取其他账号的实例', async () => {
    const { repository, service } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
    await expect(service.bind('10001', bindInput(INST_A, { aid: 9, cid: 9, nid: 9 })))
      .rejects.toMatchObject({ code: 'KE_AUTH_FORBIDDEN' });
    expect(repository.instances.get(INST_A)).toMatchObject({ user_id: 10000, aid: 1000001 });
  });

  it('心跳超时的 ACTIVE 实例不占额度，被他人顶位后复活（heartbeat/start）须重新过额度判定', async () => {
    const { repository, service, advance, now } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
    await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null });

    advance(11 * 60 * 1000);
    await service.bind('10000', bindInput(INST_B, { aid: 5, cid: 5, nid: 5, char_name: 'Bob' }));
    await service.start('10000', { ...bindInput(INST_B, { aid: 5, cid: 5, nid: 5, char_name: 'Bob' }), kickInstanceId: null });

    await expect(service.heartbeat('10000', INST_A, report({ char_name: 'Alice' }), Math.floor(now() / 1000), noAttestation()))
      .rejects.toMatchObject({ code: 'KE_INSTANCE_KICKED' });
    await expect(service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null }))
      .rejects.toMatchObject({ code: 'KE_QUOTA_EXCEEDED' });
    expect(repository.instances.get(INST_B)?.state).toBe('ACTIVE');
  });

  it('心跳超时的 ACTIVE 实例在无人顶位时仍可凭心跳续期', async () => {
    const { service, advance, now } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A));
    await service.start('10000', { ...bindInput(INST_A), kickInstanceId: null });
    advance(11 * 60 * 1000);
    const renewed = await service.heartbeat('10000', INST_A, report(), Math.floor(now() / 1000), noAttestation());
    expect(typeof renewed.license).toBe('string');
  });

  describe('manual（半自动）模式：需要授权但不占额度', () => {
    const second = { aid: 5, cid: 5, nid: 5, char_name: 'Bob' };

    it('manual 的 start 签发 license，但不占额度：auto 额度满时仍可启动，且 auto 实例不受影响', async () => {
      const { repository, service } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null, mode: 'auto' });
      await service.bind('10000', bindInput(INST_B, second));

      const started = await service.start('10000', { ...bindInput(INST_B, second), kickInstanceId: null, mode: 'manual' });
      expect(typeof started.license).toBe('string');
      expect(repository.instances.get(INST_B)).toMatchObject({ state: 'ACTIVE', mode: 'manual' });
      expect(repository.instances.get(INST_A)).toMatchObject({ state: 'ACTIVE', mode: 'auto' });
    });

    it('manual 实例不占额度：它运行时，另一个实例仍可 auto，满额列表里也不会出现 manual 实例', async () => {
      const { service } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null, mode: 'manual' });
      await service.bind('10000', bindInput(INST_B, second));
      await service.start('10000', { ...bindInput(INST_B, second), kickInstanceId: null, mode: 'auto' });

      await service.bind('10000', bindInput('33333333-3333-4333-8333-333333333333', { aid: 6, cid: 6, nid: 6, char_name: 'Carol' }));
      await expect(service.start('10000', { ...bindInput('33333333-3333-4333-8333-333333333333', { aid: 6, cid: 6, nid: 6, char_name: 'Carol' }), kickInstanceId: null, mode: 'auto' }))
        .rejects.toMatchObject({
          code: 'KE_QUOTA_EXCEEDED',
          details: { active_instances: [expect.objectContaining({ instance_id: INST_B })] },
        });
    });

    it('auto 切到 manual 会释放额度（同一实例再次 start），manual 切回 auto 要重新过额度判定', async () => {
      const { repository, service } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null, mode: 'auto' });
      await service.bind('10000', bindInput(INST_B, second));

      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null, mode: 'manual' });
      await service.start('10000', { ...bindInput(INST_B, second), kickInstanceId: null, mode: 'auto' });

      await expect(service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null, mode: 'auto' }))
        .rejects.toMatchObject({ code: 'KE_QUOTA_EXCEEDED' });
      expect(repository.instances.get(INST_A)).toMatchObject({ state: 'ACTIVE', mode: 'manual' });
    });

    it('manual 的 start 不会踢人，即使带了 kick_instance_id', async () => {
      const { repository, service } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null, mode: 'auto' });
      await service.bind('10000', bindInput(INST_B, second));
      await service.start('10000', { ...bindInput(INST_B, second), kickInstanceId: INST_A, mode: 'manual' });
      expect(repository.instances.get(INST_A)?.state).toBe('ACTIVE');
    });

    it('缺省 mode 按 auto 处理（旧客户端）', async () => {
      const { repository, service } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A));
      await service.start('10000', { ...bindInput(INST_A), kickInstanceId: null });
      expect(repository.instances.get(INST_A)?.mode).toBe('auto');
    });

    it('心跳超时的 manual 实例不会因 auto 额度被占满而被判为被顶替', async () => {
      const { service, advance, now } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null, mode: 'manual' });
      advance(11 * 60 * 1000);
      await service.bind('10000', bindInput(INST_B, second));
      await service.start('10000', { ...bindInput(INST_B, second), kickInstanceId: null, mode: 'auto' });

      const renewed = await service.heartbeat('10000', INST_A, report({ char_name: 'Alice' }), Math.floor(now() / 1000), noAttestation());
      expect(typeof renewed.license).toBe('string');
    });
  });

  it('无主角色（账号已删除，user_id 为空）30 天内也可被重新绑定', async () => {
    const { repository, service } = serviceAndClock();
    repository.characters.set('1000001:2000002:3000003', {
      aid: 1000001, cid: 2000002, nid: 3000003, user_id: null, char_name: 'Ghost',
      base_level: null, job_level: null, job_id: null, map_name: null, bound_at: 1_700_000_000_000 - 1000, last_seen_at: 1_700_000_000_000 - 1000,
    });
    await service.bind('10001', bindInput(INST_B, { char_name: 'Reborn' }));
    expect(repository.characters.get('1000001:2000002:3000003')).toMatchObject({ user_id: 10001, char_name: 'Reborn' });
  });
});
