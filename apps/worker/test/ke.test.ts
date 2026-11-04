import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { base64UrlDecode, buildLicense, wrapChunkKey } from '../src/ke/crypto';
import { createKeService, type Attestation } from '../src/ke/service';
import type { KeConfig, BuildEntry } from '../src/ke/config';
import { makeFakeRepository, type FakeRepository } from './helpers/ke-fake';
import { KeFailure, type CharacterReport, type WrappedKeyBundle } from '../src/ke/types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const INST_A = '11111111-1111-4111-8111-111111111111';
const INST_B = '22222222-2222-4222-8222-222222222222';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function testKeConfig(
  manifest: ReadonlyMap<string, BuildEntry> | null = null,
  networkKey: Uint8Array | null = null,
): KeConfig {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    enabled: true,
    licensePrivateKey: new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' })),
    licenseKeyVersion: '1',
    coreKey: new Uint8Array(32).fill(9),
    coreKeyVersion: '3',
    networkKey,
    networkKeyVersion: '2',
    buildManifest: manifest,
    hostedCredentialKey: new Uint8Array(32).fill(5),
    hostedCredentialKeyVersion: 1,
  };
}

async function unwrapBundle(
  bundle: WrappedKeyBundle,
  privateKey: CryptoKey,
  instanceId: string,
  chunk: string,
): Promise<Uint8Array> {
  const ephemeralPublic = await crypto.subtle.importKey(
    'raw', toArrayBuffer(base64UrlDecode(bundle.ephemeral_public)), { name: 'X25519' }, false, [],
  );
  const algorithm: { name: string; public: CryptoKey } = { name: 'X25519', public: ephemeralPublic };
  const shared = new Uint8Array(await crypto.subtle.deriveBits(algorithm, privateKey, 256));
  const ikm = await crypto.subtle.importKey('raw', toArrayBuffer(shared), { name: 'HKDF' }, false, ['deriveKey']);
  const kek = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(encoder.encode(instanceId)), info: toArrayBuffer(encoder.encode(`ltsd-ke-${chunk}-v1`)) },
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
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(base64UrlDecode(bundle.nonce)), additionalData: toArrayBuffer(encoder.encode(instanceId)) },
    kek,
    toArrayBuffer(combined),
  ));
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
    expect(await unwrapBundle(bundle, kePair.privateKey, '11111111-1111-4111-8111-111111111111', 'core')).toEqual(chunkKey);
  });
});

describe('ke service', () => {
  function serviceAndClock(
    manifest: ReadonlyMap<string, BuildEntry> | null = null,
    networkKey: Uint8Array | null = null,
  ) {
    let nowMs = 1_700_000_000_000;
    const repository = makeFakeRepository();
    const service = createKeService(repository, testKeConfig(manifest, networkKey), () => nowMs);
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

  describe('权益（额度与模块）', () => {
    const grant = (repository: FakeRepository, userId: number, slots: number, modules: string[]) => {
      repository.entitlements.set(userId, { slots, modules: new Set(modules) });
    };
    const startInput = (instanceId: string, extra: Record<string, unknown> = {}) => ({ ...bindInput(instanceId), kickInstanceId: null, ...extra });

    it('没有 core 模块的账号不能 start（auto 与 manual 都不行）', async () => {
      const { repository, service } = serviceAndClock();
      grant(repository, 10000, 1, []);
      await service.bind('10000', bindInput(INST_A));
      await expect(service.start('10000', startInput(INST_A))).rejects.toMatchObject({ code: 'KE_NOT_ENTITLED', status: 403 });
      await expect(service.start('10000', startInput(INST_A, { mode: 'manual' }))).rejects.toMatchObject({ code: 'KE_NOT_ENTITLED' });
      expect(repository.instances.get(INST_A)?.state).toBe('IDLE');
    });

    it('额度为 0 时 auto 与 manual 都被额度拦下（半自动同样占额度）', async () => {
      const { repository, service } = serviceAndClock();
      grant(repository, 10000, 0, ['core']);
      await service.bind('10000', bindInput(INST_A));
      await expect(service.start('10000', startInput(INST_A))).rejects.toMatchObject({ code: 'KE_QUOTA_EXCEEDED' });
      await expect(service.start('10000', startInput(INST_A, { mode: 'manual' }))).rejects.toMatchObject({ code: 'KE_QUOTA_EXCEEDED' });
    });

    it('auto 实例上限取自账号当前额度，而不是固定常量', async () => {
      const { repository, service, advance } = serviceAndClock();
      grant(repository, 10000, 2, ['core']);
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.bind('10000', bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null });
      advance(1000);
      await service.start('10000', { ...bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }), kickInstanceId: null });
      expect(repository.instances.get(INST_A)?.state).toBe('ACTIVE');
      expect(repository.instances.get(INST_B)?.state).toBe('ACTIVE');
    });

    it('心跳续租同样要求 core 模块，失效后拒绝签发新 license', async () => {
      const { repository, service, advance, now } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A));
      await service.start('10000', startInput(INST_A));
      advance(60_000);
      grant(repository, 10000, 1, []);
      await expect(service.heartbeat('10000', INST_A, report(), Math.floor(now() / 1000), noAttestation()))
        .rejects.toMatchObject({ code: 'KE_NOT_ENTITLED' });
    });

    it('心跳不改变既有额度判定：额度缩水后仍在心跳的实例继续续租（已知并接受）', async () => {
      const { repository, service, advance, now } = serviceAndClock();
      grant(repository, 10000, 2, ['core']);
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.bind('10000', bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null });
      await service.start('10000', { ...bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }), kickInstanceId: null });
      advance(60_000);
      grant(repository, 10000, 1, ['core']);
      const renewed = await service.heartbeat('10000', INST_A, report({ char_name: 'Alice' }), Math.floor(now() / 1000), noAttestation());
      expect(typeof renewed.license).toBe('string');
    });

    it('下发分块密钥的 bind 要求 core 模块；不要密钥的 bind 照常登记角色', async () => {
      const { repository, service } = serviceAndClock();
      grant(repository, 10000, 0, []);
      const publicKey = new Uint8Array(32).fill(7);
      await expect(service.bind('10000', { ...bindInput(INST_A), needWasmKey: true, kePublicKey: publicKey }))
        .rejects.toMatchObject({ code: 'KE_NOT_ENTITLED' });
      expect(repository.instances.has(INST_A)).toBe(false);
      await service.bind('10000', bindInput(INST_A));
      expect(repository.instances.get(INST_A)?.state).toBe('IDLE');
    });

    it('license 的 features 与实例记录的 features 反映账号当前生效的模块', async () => {
      const { repository, service } = serviceAndClock();
      grant(repository, 10000, 1, ['core', 'alpha']);
      await service.bind('10000', bindInput(INST_A));
      const started = await service.start('10000', startInput(INST_A));
      const payload = JSON.parse(decoder.decode(base64UrlDecode(started.license.split('.')[0]!)));
      expect(payload.features).toEqual(['alpha', 'core']);
      expect(JSON.parse(repository.instances.get(INST_A)!.features!)).toEqual(['alpha', 'core']);
    });
  });

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
    await service.bind('10000', bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }));
    await expect(service.start('10000', { ...bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }), kickInstanceId: null }))
      .rejects.toMatchObject({ code: 'KE_QUOTA_EXCEEDED' });

    const resumed = await service.start('10000', { ...bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }), kickInstanceId: INST_A });
    expect(typeof resumed.license).toBe('string');
    expect(repository.instances.get(INST_A)?.state).toBe('KICKED');
    expect(repository.instances.get(INST_B)?.state).toBe('ACTIVE');
  });

  it('被踢实例心跳返回 KE_INSTANCE_KICKED；stop 后为 STOPPED', async () => {
    const { repository, service, advance, now } = serviceAndClock();
    await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
    await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null });
    advance(60_000);
    await service.bind('10000', bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }));
    await service.start('10000', { ...bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }), kickInstanceId: INST_A });

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

  describe('manual 与 auto 一视同仁（I14）：半自动同样占额度', () => {
    const second = { aid: 5, cid: 5, nid: 5, char_name: 'Bob' };

    it('manual 的 start 也要过额度判定，并以 auto 持久化', async () => {
      const { repository, service } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null, mode: 'auto' });
      await service.bind('10000', bindInput(INST_B, second));
      await expect(service.start('10000', { ...bindInput(INST_B, second), kickInstanceId: null, mode: 'manual' }))
        .rejects.toMatchObject({ code: 'KE_QUOTA_EXCEEDED' });
      expect(repository.instances.get(INST_A)).toMatchObject({ state: 'ACTIVE', mode: 'auto' });
    });

    it('manual 请求即使不占名额也不能绕过：被接受时存的就是 auto，并且会占住额度', async () => {
      const { repository, service } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null, mode: 'manual' });
      expect(repository.instances.get(INST_A)).toMatchObject({ state: 'ACTIVE', mode: 'auto' });
      await service.bind('10000', bindInput(INST_B, second));
      await expect(service.start('10000', { ...bindInput(INST_B, second), kickInstanceId: null, mode: 'auto' }))
        .rejects.toMatchObject({
          code: 'KE_QUOTA_EXCEEDED',
          details: { active_instances: [expect.objectContaining({ instance_id: INST_A })] },
        });
    });

    it('manual 请求带 kick_instance_id 同样会踢人（与 auto 相同）', async () => {
      const { repository, service } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null, mode: 'auto' });
      await service.bind('10000', bindInput(INST_B, second));
      await service.start('10000', { ...bindInput(INST_B, second), kickInstanceId: INST_A, mode: 'manual' });
      expect(repository.instances.get(INST_A)?.state).toBe('KICKED');
      expect(repository.instances.get(INST_B)).toMatchObject({ state: 'ACTIVE', mode: 'auto' });
    });

    it('缺省 mode 按 auto 处理（旧客户端）', async () => {
      const { repository, service } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A));
      await service.start('10000', { ...bindInput(INST_A), kickInstanceId: null });
      expect(repository.instances.get(INST_A)?.mode).toBe('auto');
    });

    it('心跳超时的实例额度被他人占满后不能凭心跳复活（不再因为 manual 例外而放行）', async () => {
      const { service, advance, now } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null, mode: 'manual' });
      advance(11 * 60 * 1000);
      await service.bind('10000', bindInput(INST_B, second));
      await service.start('10000', { ...bindInput(INST_B, second), kickInstanceId: null, mode: 'auto' });
      await expect(service.heartbeat('10000', INST_A, report({ char_name: 'Alice' }), Math.floor(now() / 1000), noAttestation()))
        .rejects.toMatchObject({ code: 'KE_INSTANCE_KICKED' });
    });
  });

  describe('同角色续连接管与被踢原因', () => {
    it('同一用户用新 instance_id 重新开启同一角色：直接接管旧会话，不提示实例超额', async () => {
      const { repository, service, advance } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A));
      await service.start('10000', { ...bindInput(INST_A), kickInstanceId: null });
      advance(1000);
      await service.bind('10000', bindInput(INST_B));
      const started = await service.start('10000', { ...bindInput(INST_B), kickInstanceId: null });
      expect(typeof started.license).toBe('string');
      expect(repository.instances.get(INST_A)).toMatchObject({ state: 'KICKED', kick_reason: 'character_takeover', kicked_by_instance_id: INST_B });
      expect(repository.instances.get(INST_B)?.state).toBe('ACTIVE');
    });

    it('被接管的实例心跳返回 KE_INSTANCE_KICKED，并带上 reason', async () => {
      const { service, advance, now } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A));
      await service.start('10000', { ...bindInput(INST_A), kickInstanceId: null });
      advance(1000);
      await service.bind('10000', bindInput(INST_B));
      await service.start('10000', { ...bindInput(INST_B), kickInstanceId: null });
      await expect(service.heartbeat('10000', INST_A, report(), Math.floor(now() / 1000), noAttestation()))
        .rejects.toMatchObject({ code: 'KE_INSTANCE_KICKED', details: { reason: 'character_takeover' } });
    });

    it('为腾名额主动踢人的 reason 是 quota_kick', async () => {
      const { service, advance, now } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null });
      advance(1000);
      await service.bind('10000', bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }));
      await service.start('10000', { ...bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }), kickInstanceId: INST_A });
      await expect(service.heartbeat('10000', INST_A, report({ char_name: 'Alice' }), Math.floor(now() / 1000), noAttestation()))
        .rejects.toMatchObject({ code: 'KE_INSTANCE_KICKED', details: { reason: 'quota_kick' } });
    });

    it('started_at 是首次进入 ACTIVE 的时间：幂等续期不改变它', async () => {
      const { repository, service, advance } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A));
      await service.start('10000', { ...bindInput(INST_A), kickInstanceId: null });
      const first = repository.instances.get(INST_A)?.started_at;
      advance(60_000);
      await service.start('10000', { ...bindInput(INST_A), kickInstanceId: null });
      expect(repository.instances.get(INST_A)?.started_at).toBe(first);
    });
  });

  describe('额度缩水收敛（I6）：非托管实例', () => {
    it('额度 2 → 1：保留最早启动的，最新的在下一次心跳被踢，且结果持久化', async () => {
      const { repository, service, advance, now } = serviceAndClock();
      repository.entitlements.set(10000, { slots: 2, modules: new Set(['core']) });
      await service.bind('10000', bindInput(INST_A, { char_name: 'Alice' }));
      await service.start('10000', { ...bindInput(INST_A, { char_name: 'Alice' }), kickInstanceId: null });
      advance(1000);
      await service.bind('10000', bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }));
      await service.start('10000', { ...bindInput(INST_B, { aid: 1000009, char_name: 'Bob' }), kickInstanceId: null });
      repository.entitlements.set(10000, { slots: 1, modules: new Set(['core']) });
      advance(60_000);

      await expect(service.heartbeat('10000', INST_B, report({ aid: 1000009, char_name: 'Bob' }), Math.floor(now() / 1000), noAttestation()))
        .rejects.toMatchObject({ code: 'KE_INSTANCE_KICKED', details: { reason: 'quota_shrunk' } });
      expect(repository.instances.get(INST_B)).toMatchObject({ state: 'KICKED', kick_reason: 'quota_shrunk' });
      const renewed = await service.heartbeat('10000', INST_A, report({ char_name: 'Alice' }), Math.floor(now() / 1000), noAttestation());
      expect(typeof renewed.license).toBe('string');
    });
  });

  describe('托管主体（离线挂机）', () => {
    const INST_H = '55555555-5555-4555-8555-555555555555';
    const principal = (epoch = 3) => ({ instanceId: INST_H, epoch, launchSeq: 1 });
    const hostedBind = (extra: Record<string, unknown> = {}) => ({ ...bindInput(INST_H), hosted: principal(), ...extra });
    const hostedStart = (extra: Record<string, unknown> = {}) => ({ ...bindInput(INST_H), hosted: principal(), kickInstanceId: null, ...extra });
    const setupHosted = (repository: FakeRepository, options: { extra?: number; slots?: number; expiry?: number } = {}) => {
      repository.entitlements.set(10000, { slots: options.slots ?? 2, modules: new Set(['core']) });
      repository.hostingModule.set(10000, options.extra ?? 1);
      if (options.expiry !== undefined) repository.hostingExpiry.set(10000, options.expiry);
      repository.hostedIds.add(INST_H);
      repository.hostedRows.set(INST_H, { instance_id: INST_H, user_id: 10000, nid: 3000003, aid: 1000001, cid: 2000002, desired: 'running', assigned_agent: 'agt_000000000000000000000001', epoch: 3 });
    };

    it('旧 epoch 的进程在 bind/start/heartbeat 都被拒绝（KE_EPOCH_STALE）', async () => {
      const { repository, service, now } = serviceAndClock();
      setupHosted(repository);
      await service.bind('10000', hostedBind());
      await service.start('10000', hostedStart());
      repository.hostedRows.get(INST_H)!.epoch = 4; // 实例被改派
      await expect(service.bind('10000', hostedBind())).rejects.toMatchObject({ code: 'KE_EPOCH_STALE', status: 409 });
      await expect(service.start('10000', hostedStart())).rejects.toMatchObject({ code: 'KE_EPOCH_STALE' });
      await expect(service.heartbeat('10000', INST_H, report(), Math.floor(now() / 1000), noAttestation(), { hosted: principal() }))
        .rejects.toMatchObject({ code: 'KE_EPOCH_STALE' });
    });

    it('上报的角色必须与托管登记一致（防止登记假 id 躲开唯一键）', async () => {
      const { repository, service } = serviceAndClock();
      setupHosted(repository);
      await expect(service.bind('10000', hostedBind({ report: report({ cid: 99 }) }))).rejects.toMatchObject({ code: 'KE_CHARACTER_MISMATCH' });
    });

    it('没有托管资格：bind 被拒，并且停止托管实例的动作被持久化（拒绝在事务提交之后才抛出）', async () => {
      const { repository, service } = serviceAndClock();
      setupHosted(repository, { extra: 0, slots: 1 });
      await expect(service.bind('10000', hostedBind())).rejects.toMatchObject({ code: 'KE_HOSTING_ENTITLEMENT_REQUIRED', status: 403 });
      expect(repository.policyStops).toEqual([INST_H]);
      expect(repository.hostedRows.get(INST_H)?.desired).toBe('stopped');
    });

    it('desired 已是 stopped 的托管实例不能继续 start', async () => {
      const { repository, service } = serviceAndClock();
      setupHosted(repository);
      await service.bind('10000', hostedBind());
      repository.hostedRows.get(INST_H)!.desired = 'stopped';
      await expect(service.start('10000', hostedStart())).rejects.toMatchObject({ code: 'KE_INSTANCE_NOT_ACTIVE' });
      await expect(service.bind('10000', hostedBind())).rejects.toMatchObject({ code: 'KE_INSTANCE_NOT_ACTIVE' });
    });

    it('托管 start 永不踢人，带 kick_instance_id 直接拒绝', async () => {
      const { repository, service } = serviceAndClock();
      setupHosted(repository);
      await service.bind('10000', hostedBind());
      await expect(service.start('10000', hostedStart({ kickInstanceId: INST_A }))).rejects.toMatchObject({ code: 'KE_BAD_REQUEST' });
    });

    it('I15：同角色有存活的非托管会话时，托管 start 返回 KE_CHARACTER_IN_USE，且不接管对方', async () => {
      const { repository, service, advance } = serviceAndClock();
      setupHosted(repository, { slots: 3 });
      await service.bind('10000', bindInput(INST_A));
      await service.start('10000', { ...bindInput(INST_A), kickInstanceId: null });
      advance(1000);
      await service.bind('10000', hostedBind());
      await expect(service.start('10000', hostedStart())).rejects.toMatchObject({ code: 'KE_CHARACTER_IN_USE', status: 409 });
      expect(repository.instances.get(INST_A)?.state).toBe('ACTIVE');
    });

    it('I15：非托管会话已经 10 分钟没有心跳，托管可以启动', async () => {
      const { repository, service, advance } = serviceAndClock();
      setupHosted(repository, { slots: 3 });
      await service.bind('10000', bindInput(INST_A));
      await service.start('10000', { ...bindInput(INST_A), kickInstanceId: null });
      advance(11 * 60 * 1000);
      await service.bind('10000', hostedBind());
      const started = await service.start('10000', hostedStart());
      expect(typeof started.license).toBe('string');
    });

    it('非托管用户重新开启同一角色会接管托管实例（reason=character_takeover）', async () => {
      const { repository, service, advance } = serviceAndClock();
      setupHosted(repository, { slots: 3 });
      await service.bind('10000', hostedBind());
      await service.start('10000', hostedStart());
      advance(1000);
      await service.bind('10000', bindInput(INST_A));
      await service.start('10000', { ...bindInput(INST_A), kickInstanceId: null });
      expect(repository.instances.get(INST_H)).toMatchObject({ state: 'KICKED', kick_reason: 'character_takeover' });
    });

    it('托管 start 同样占额度：额度被非托管实例占满时返回 KE_QUOTA_EXCEEDED，不踢人', async () => {
      const { repository, service } = serviceAndClock();
      setupHosted(repository, { slots: 1 });
      await service.bind('10000', bindInput(INST_A, { aid: 1000009, char_name: 'Other' }));
      await service.start('10000', { ...bindInput(INST_A, { aid: 1000009, char_name: 'Other' }), kickInstanceId: null });
      await service.bind('10000', hostedBind());
      await expect(service.start('10000', hostedStart())).rejects.toMatchObject({ code: 'KE_QUOTA_EXCEEDED' });
      expect(repository.instances.get(INST_A)?.state).toBe('ACTIVE');
    });

    it('托管 license 到期封顶为资格到期时间', async () => {
      const { repository, service, now } = serviceAndClock();
      const expiry = now() + 5 * 60 * 1000;
      setupHosted(repository, { expiry });
      await service.bind('10000', hostedBind());
      const started = await service.start('10000', hostedStart());
      const payload = JSON.parse(decoder.decode(base64UrlDecode(started.license.split('.')[0]!))) as { exp: number };
      expect(payload.exp).toBe(Math.floor(expiry / 1000));
      expect(repository.instances.get(INST_H)?.license_expires_at).toBe(expiry);
    });

    it('托管 heartbeat 保存状态快照；超过 16KB 或非对象的快照被忽略', async () => {
      const { repository, service, advance, now } = serviceAndClock();
      setupHosted(repository);
      await service.bind('10000', hostedBind());
      await service.start('10000', hostedStart());
      advance(1000);
      await service.heartbeat('10000', INST_H, report(), Math.floor(now() / 1000), noAttestation(), { hosted: principal(), status: { v: 1, ai: 'auto' } });
      expect(JSON.parse(repository.statuses.get(INST_H)!)).toEqual({ v: 1, ai: 'auto' });
      repository.statuses.clear();
      await service.heartbeat('10000', INST_H, report(), Math.floor(now() / 1000), noAttestation(), { hosted: principal(), status: { blob: 'x'.repeat(20_000) } });
      await service.heartbeat('10000', INST_H, report(), Math.floor(now() / 1000), noAttestation(), { hosted: principal(), status: 'nope' });
      expect(repository.statuses.size).toBe(0);
    });

    it('资格在运行中丢失：托管 heartbeat 被拒（KE_HOSTING_ENTITLEMENT_REQUIRED），同用户的非托管实例不被误杀', async () => {
      const { repository, service, advance, now } = serviceAndClock();
      setupHosted(repository, { slots: 2 });
      await service.bind('10000', hostedBind());
      await service.start('10000', hostedStart());
      advance(1000);
      await service.bind('10000', bindInput(INST_A, { aid: 1000009, char_name: 'Other' }));
      await service.start('10000', { ...bindInput(INST_A, { aid: 1000009, char_name: 'Other' }), kickInstanceId: null });
      // 额外额度到期：回到只有免费 1 个。
      repository.entitlements.set(10000, { slots: 1, modules: new Set(['core']) });
      repository.hostingModule.set(10000, 0);
      advance(60_000);

      await expect(service.heartbeat('10000', INST_H, report(), Math.floor(now() / 1000), noAttestation(), { hosted: principal() }))
        .rejects.toMatchObject({ code: 'KE_HOSTING_ENTITLEMENT_REQUIRED' });
      expect(repository.policyStops).toContain(INST_H);
      const renewed = await service.heartbeat('10000', INST_A, report({ aid: 1000009, char_name: 'Other' }), Math.floor(now() / 1000), noAttestation());
      expect(typeof renewed.license).toBe('string');
      expect(repository.instances.get(INST_A)?.state).toBe('ACTIVE');
    });

    it('买了 1 个额外额度、托管 2 个，额度到期：两个托管实例的 heartbeat 都被拒，一个都不保留', async () => {
      const { repository, service, advance, now } = serviceAndClock();
      const INST_H2 = '66666666-6666-4666-8666-666666666666';
      setupHosted(repository, { slots: 2 });
      repository.hostedIds.add(INST_H2);
      repository.hostedRows.set(INST_H2, { instance_id: INST_H2, user_id: 10000, nid: 3000003, aid: 1000002, cid: 2000002, desired: 'running', assigned_agent: 'agt_000000000000000000000001', epoch: 3 });
      const second = { aid: 1000002 };
      await service.bind('10000', hostedBind());
      await service.start('10000', hostedStart());
      advance(1000);
      await service.bind('10000', { ...bindInput(INST_H2, second), hosted: { instanceId: INST_H2, epoch: 3, launchSeq: 1 } });
      await service.start('10000', { ...bindInput(INST_H2, second), hosted: { instanceId: INST_H2, epoch: 3, launchSeq: 1 }, kickInstanceId: null });
      repository.entitlements.set(10000, { slots: 1, modules: new Set(['core']) });
      repository.hostingModule.set(10000, 0);
      advance(60_000);

      await expect(service.heartbeat('10000', INST_H, report(), Math.floor(now() / 1000), noAttestation(), { hosted: principal() }))
        .rejects.toMatchObject({ code: 'KE_HOSTING_ENTITLEMENT_REQUIRED' });
      await expect(service.heartbeat('10000', INST_H2, report(second), Math.floor(now() / 1000), noAttestation(), { hosted: { instanceId: INST_H2, epoch: 3, launchSeq: 1 } }))
        .rejects.toMatchObject({ code: 'KE_HOSTING_ENTITLEMENT_REQUIRED' });
      expect(repository.hostedRows.get(INST_H)?.desired).toBe('stopped');
      expect(repository.hostedRows.get(INST_H2)?.desired).toBe('stopped');
    });

    it('额度满的踢人列表里，托管实例带“[托管]”前缀和 hosted 标志（旧客户端也能认出来）', async () => {
      const { repository, service } = serviceAndClock();
      setupHosted(repository, { slots: 1 });
      await service.bind('10000', hostedBind());
      repository.entitlements.set(10000, { slots: 2, modules: new Set(['core']) });
      await service.start('10000', hostedStart());
      repository.entitlements.set(10000, { slots: 1, modules: new Set(['core']) });
      await service.bind('10000', bindInput(INST_A, { aid: 1000009, char_name: 'Other' }));
      const error = await service.start('10000', { ...bindInput(INST_A, { aid: 1000009, char_name: 'Other' }), kickInstanceId: null }).catch((e: unknown) => e) as KeFailure;
      expect(error.code).toBe('KE_QUOTA_EXCEEDED');
      expect((error.details as { active_instances: { hosted: boolean; char_name: string }[] }).active_instances)
        .toEqual([expect.objectContaining({ hosted: true, char_name: expect.stringMatching(/^\[托管\] /u) })]);
    });

    it('托管 token 不能操作别的实例', async () => {
      const { repository, service } = serviceAndClock();
      setupHosted(repository);
      await expect(service.stop('10000', INST_A, principal())).rejects.toMatchObject({ code: 'KE_AUTH_FORBIDDEN' });
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

  describe('standalone 模块（network 密钥下发）', () => {
    const networkKey = new Uint8Array(32).fill(0x42);
    const keyPair = async () => {
      const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
      return { pair, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
    };
    const keyedBind = (instanceId: string, publicKey: Uint8Array, modules: string[] = []) => ({
      ...bindInput(instanceId),
      needWasmKey: true,
      needModules: modules,
      kePublicKey: publicKey,
    });

    it('有 standalone 权益时同时下发 core 与 network 密钥', async () => {
      const { repository, service } = serviceAndClock(null, networkKey);
      repository.entitlements.set(10000, { slots: 1, modules: new Set(['core', 'standalone']) });
      const { pair, publicKey } = await keyPair();
      const result = await service.bind('10000', keyedBind(INST_A, publicKey, ['network']));
      expect(Object.keys(result.key_bundles ?? {}).sort()).toEqual(['core', 'network']);
      expect(await unwrapBundle(result.key_bundles!.network!, pair.privateKey, INST_A, 'network')).toEqual(networkKey);
      expect(await unwrapBundle(result.key_bundles!.core!, pair.privateKey, INST_A, 'core')).toEqual(new Uint8Array(32).fill(9));
    });

    it('未开通 standalone 时拒绝，且不写角色/实例', async () => {
      const { repository, service } = serviceAndClock(null, networkKey);
      const { publicKey } = await keyPair();
      await expect(service.bind('10000', keyedBind(INST_A, publicKey, ['network'])))
        .rejects.toMatchObject({ code: 'KE_NOT_ENTITLED', status: 403 });
      expect(repository.instances.size).toBe(0);
      expect(repository.characters.size).toBe(0);
    });

    it('请求 network 但服务端未配置密钥时返回 503', async () => {
      const { repository, service } = serviceAndClock();
      repository.entitlements.set(10000, { slots: 1, modules: new Set(['core', 'standalone']) });
      const { publicKey } = await keyPair();
      await expect(service.bind('10000', keyedBind(INST_A, publicKey, ['network'])))
        .rejects.toMatchObject({ code: 'KE_UNAVAILABLE', status: 503 });
      expect(repository.instances.size).toBe(0);
    });

    it('旧客户端不请求模块时仍然只下发 core', async () => {
      const { service } = serviceAndClock(null, networkKey);
      const { publicKey } = await keyPair();
      const result = await service.bind('10000', keyedBind(INST_A, publicKey));
      expect(Object.keys(result.key_bundles ?? {})).toEqual(['core']);
    });

    it('standalone 权益的 license 带 network 版本，core-only 不带', async () => {
      const { repository, service } = serviceAndClock(null, networkKey);
      repository.entitlements.set(10000, { slots: 1, modules: new Set(['core', 'standalone']) });
      await service.bind('10000', bindInput(INST_A));
      const started = await service.start('10000', { ...bindInput(INST_A), kickInstanceId: null });
      const payload = JSON.parse(decoder.decode(base64UrlDecode(started.license.split('.')[0]!)));
      expect(payload.features).toEqual(['core', 'standalone']);
      expect(payload.key_versions).toEqual({ core: 3, network: 2 });

      const coreOnly = serviceAndClock(null, networkKey);
      await coreOnly.service.bind('10000', bindInput(INST_B));
      const startedCore = await coreOnly.service.start('10000', { ...bindInput(INST_B), kickInstanceId: null });
      const corePayload = JSON.parse(decoder.decode(base64UrlDecode(startedCore.license.split('.')[0]!)));
      expect(corePayload.features).toEqual(['core']);
      expect(corePayload.key_versions).toEqual({ core: 3 });
    });

    it('登录前的 moduleKeys 下发 core/network，且不创建实例', async () => {
      const { repository, service } = serviceAndClock(null, networkKey);
      repository.entitlements.set(10000, { slots: 1, modules: new Set(['core', 'standalone']) });
      const { pair, publicKey } = await keyPair();
      const result = await service.moduleKeys('10000', {
        instanceId: INST_A, modules: ['core', 'network'], kePublicKey: publicKey,
      });
      expect(Object.keys(result.key_bundles).sort()).toEqual(['core', 'network']);
      expect(await unwrapBundle(result.key_bundles.network!, pair.privateKey, INST_A, 'network')).toEqual(networkKey);
      expect(repository.instances.size).toBe(0);
      expect(repository.characters.size).toBe(0);
    });

    it('moduleKeys 没有 standalone 权益时只允许 core', async () => {
      const { service } = serviceAndClock(null, networkKey);
      const { publicKey } = await keyPair();
      const core = await service.moduleKeys('10000', {
        instanceId: INST_A, modules: ['core'], kePublicKey: publicKey,
      });
      expect(Object.keys(core.key_bundles)).toEqual(['core']);
      await expect(service.moduleKeys('10000', {
        instanceId: INST_A, modules: ['network'], kePublicKey: publicKey,
      })).rejects.toMatchObject({ code: 'KE_NOT_ENTITLED', status: 403 });
    });

    it('moduleKeys 校验模块白名单与公钥；network 未配置时 503', async () => {
      const { repository, service } = serviceAndClock();
      repository.entitlements.set(10000, { slots: 1, modules: new Set(['core', 'standalone']) });
      const { publicKey } = await keyPair();
      await expect(service.moduleKeys('10000', {
        instanceId: INST_A, modules: ['unknown'], kePublicKey: publicKey,
      })).rejects.toMatchObject({ code: 'KE_BAD_REQUEST', status: 400 });
      await expect(service.moduleKeys('10000', {
        instanceId: INST_A, modules: ['core'], kePublicKey: null,
      })).rejects.toMatchObject({ code: 'KE_BAD_REQUEST', status: 400 });
      await expect(service.moduleKeys('10000', {
        instanceId: INST_A, modules: ['network'], kePublicKey: publicKey,
      })).rejects.toMatchObject({ code: 'KE_UNAVAILABLE', status: 503 });
    });
  });

  describe('start 的角色归属检查', () => {
    const startInput = (instanceId: string) => ({ ...bindInput(instanceId), kickInstanceId: null });
    const characterKey = `${report().aid}:${report().cid}:${report().nid}`;

    it('start rejects a character now owned by another account', async () => {
      const { repository, service, now } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A));
      await service.start('10000', startInput(INST_A));
      await service.stop('10000', INST_A);
      const boundAt = now();
      Object.assign(repository.characters.get(characterKey)!, { user_id: 10001, bound_at: boundAt });
      const failure = await service.start('10000', startInput(INST_A)).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'KE_CHARACTER_BOUND', status: 409, publicMessage: '该角色 30 天内已被其他账号绑定', details: { bound_at: boundAt } });
      expect(repository.instances.get(INST_A)?.state).toBe('STOPPED');
    });

    it('start still works for an ownerless character', async () => {
      const { repository, service } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A));
      Object.assign(repository.characters.get(characterKey)!, { user_id: null });
      const started = await service.start('10000', startInput(INST_A));
      expect(typeof started.license).toBe('string');
    });

    it('heartbeat is not blocked by the ownership check', async () => {
      const { repository, service, advance, now } = serviceAndClock();
      await service.bind('10000', bindInput(INST_A));
      await service.start('10000', startInput(INST_A));
      advance(60_000);
      Object.assign(repository.characters.get(characterKey)!, { user_id: 10001, bound_at: now() });
      const renewed = await service.heartbeat('10000', INST_A, report(), Math.floor(now() / 1000), noAttestation());
      expect(typeof renewed.license).toBe('string');
    });
  });
});
