import { buildLicense, wrapChunkKey } from './crypto';
import type { KeConfig } from './config';
import { KE_CORE_MODULE, KE_STANDALONE_MODULE, type KeEntitlements } from './entitlements';
import type { InstanceRow, KeRepository, KeTx } from './repository';
import {
  KE_BINDING_EXCLUSIVE_MS,
  KE_CLOCK_SKEW_SECONDS,
  KE_LICENSE_LEASE_MS,
  KE_LIVENESS_WINDOW_MS,
  KeFailure,
  type CharacterReport,
  type KeLicenseMode,
  type LicensePayload,
  type WrappedKeyBundle,
} from './types';

export interface Attestation {
  buildId: string | null;
  buildHash: string | null;
  ipHash: Uint8Array | null;
  uaHash: Uint8Array | null;
}

export interface BindInput extends Attestation {
  instanceId: string;
  report: CharacterReport;
  needWasmKey: boolean;
  /** 需要额外下发的模块（`network`）；缺省/空数组表示只下发 core（保持旧调用方兼容）。 */
  needModules?: readonly string[];
  kePublicKey: Uint8Array | null;
}

export interface StartInput extends BindInput {
  kickInstanceId: string | null;
  /** 缺省按 auto 处理（向后兼容）；manual 需要授权但不占额度，也不踢人。 */
  mode?: KeLicenseMode;
}

export interface BindResponse {
  instance_id: string;
  key_bundles?: Record<string, WrappedKeyBundle>;
}

/** 登录前领取模块密钥：只依赖 Bearer + instance_id + ke_pub，不需要角色身份。 */
export interface ModuleKeyInput {
  instanceId: string;
  modules: readonly string[];
  kePublicKey: Uint8Array | null;
}

export interface ModuleKeyResponse {
  key_bundles: Record<string, WrappedKeyBundle>;
}

export interface LicenseResponse {
  license: string;
  key_bundles?: Record<string, WrappedKeyBundle>;
}

export interface KeService {
  bind(userId: string, input: BindInput): Promise<BindResponse>;
  moduleKeys(userId: string, input: ModuleKeyInput): Promise<ModuleKeyResponse>;
  start(userId: string, input: StartInput): Promise<LicenseResponse>;
  heartbeat(userId: string, instanceId: string, report: CharacterReport, ts: number, attestation: Attestation): Promise<LicenseResponse>;
  stop(userId: string, instanceId: string): Promise<void>;
}

function assertBuildFingerprint(config: KeConfig, buildId: string | null, buildHash: string | null): void {
  if (!config.buildManifest) return;
  if (buildId === null || buildHash === null) {
    throw new KeFailure('KE_BUILD_REJECTED', 403, '构建指纹缺失');
  }
  const entry = config.buildManifest.get(buildId);
  if (!entry || entry.sha256 !== buildHash.toLowerCase()) {
    throw new KeFailure('KE_BUILD_REJECTED', 403, '构建指纹校验失败');
  }
}

function assertClockSkew(now: number, ts: number): void {
  if (!Number.isSafeInteger(ts) || Math.abs(Math.floor(now / 1000) - ts) > KE_CLOCK_SKEW_SECONDS) {
    throw new KeFailure('KE_BAD_REQUEST', 400, '请求时间戳无效');
  }
}

/**
 * start/heartbeat 必须与实例当前绑定的角色一致。同一浏览器窗口（同一 instance_id）切换角色时，
 * 由 bind 显式换绑（见 `bind`），之后 start/heartbeat 才会携带新角色；两者不能越过 bind 悄悄换角色。
 */
function assertSameCharacter(instance: InstanceRow, report: CharacterReport): void {
  if (instance.aid !== report.aid || instance.cid !== report.cid || instance.nid !== report.nid) {
    throw new KeFailure('KE_BAD_REQUEST', 400, '角色与实例不匹配');
  }
}

/** 仅「ACTIVE、auto 模式且近期有心跳」的实例占用额度；心跳超时的 ACTIVE 视同让出名额，再次运行前须重新过额度判定。manual 从不占额度。 */
function holdsSlot(instance: InstanceRow, threshold: number): boolean {
  return instance.state === 'ACTIVE' && instance.mode === 'auto' && (instance.last_heartbeat_at ?? 0) > threshold;
}

function assertKeyRequest(needWasmKey: boolean, kePublicKey: Uint8Array | null): void {
  if (needWasmKey && (kePublicKey === null || kePublicKey.byteLength !== 32)) {
    throw new KeFailure('KE_BAD_REQUEST', 400, '请求字段无效');
  }
}

/** need_modules 只能和 need_wasm_key 一起使用；未知模块按坏请求拒绝，避免静默漏发密钥。 */
function assertModuleRequest(input: BindInput): void {
  const modules = input.needModules ?? [];
  if (modules.length === 0) return;
  if (!input.needWasmKey || modules.some(module => module !== 'network')) {
    throw new KeFailure('KE_BAD_REQUEST', 400, '请求字段无效');
  }
}

/** 读取账号当前权益；没有核心模块就不能签发任何授权（start / heartbeat / 下发密钥的 bind）。 */
async function requireCoreEntitlement(tx: KeTx, userId: number, now: number): Promise<KeEntitlements> {
  const entitlements = await tx.readEntitlements(userId, now);
  if (!entitlements.modules.has(KE_CORE_MODULE)) {
    throw new KeFailure('KE_NOT_ENTITLED', 403, '账号未开通核心模块');
  }
  return entitlements;
}

function featuresOf(entitlements: KeEntitlements): string[] {
  return [...entitlements.modules].sort();
}

function buildLicenseFor(config: KeConfig, instance: InstanceRow, features: string[], now: number): Promise<string> {
  const iat = Math.floor(now / 1000);
  const keyVersions: Record<string, number> = { core: Number(config.coreKeyVersion) };
  // 只有账号真的拥有 standalone 模块时才写入 network 版本；旧客户端会忽略这个额外条目。
  if (features.includes(KE_STANDALONE_MODULE) && config.networkKey !== null) {
    keyVersions.network = Number(config.networkKeyVersion);
  }
  const payload: LicensePayload = {
    v: 1,
    kid: `ke-license-ed25519-v${config.licenseKeyVersion}`,
    iid: instance.instance_id,
    uid: String(instance.user_id),
    aid: instance.aid,
    cid: instance.cid,
    nid: instance.nid,
    features,
    key_versions: keyVersions,
    iat,
    exp: iat + Math.floor(KE_LICENSE_LEASE_MS / 1000),
  };
  if (config.licensePrivateKey === null) {
    throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
  }
  return buildLicense(payload, config.licensePrivateKey);
}

export function createKeService(repository: KeRepository, config: KeConfig, now: () => number = () => Date.now(),
  databaseBuildGuard?: (buildId: string | null, buildHash: string | null) => Promise<boolean>): KeService {
  const assertAllowedBuild = async (buildId: string | null, buildHash: string | null) => {
    // 数据库策略一旦开启即成为权威；旧secret清单不能覆盖新登记结果。
    if (databaseBuildGuard && await databaseBuildGuard(buildId, buildHash)) return;
    assertBuildFingerprint(config, buildId, buildHash);
  };
  async function keyBundles(
    instanceId: string,
    kePublicKey: Uint8Array,
    requested: readonly string[],
    entitledModules: ReadonlySet<string>,
  ): Promise<Record<string, WrappedKeyBundle>> {
    const bundles: Record<string, WrappedKeyBundle> = {};
    if (requested.includes('core')) {
      if (config.coreKey === null) throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
      bundles.core = await wrapChunkKey(config.coreKey, kePublicKey, instanceId, 'core');
    }
    if (requested.includes('network')) {
      if (!entitledModules.has(KE_STANDALONE_MODULE)) throw new KeFailure('KE_NOT_ENTITLED', 403, '账号未开通脱机版模块');
      if (config.networkKey === null) throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
      bundles.network = await wrapChunkKey(config.networkKey, kePublicKey, instanceId, 'network');
    }
    return bundles;
  }

  return {
    async bind(userId, input) {
      await assertAllowedBuild(input.buildId, input.buildHash);
      assertKeyRequest(input.needWasmKey, input.kePublicKey);
      assertModuleRequest(input);
      const wantsNetwork = (input.needModules ?? []).includes('network');
      // 配置缺失必须在任何写库动作之前拒绝，避免“绑定已成功、密钥却没下发”。
      if (wantsNetwork && config.networkKey === null) throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
      const ownerId = Number(userId);
      const timestamp = now();
      const entitlements = await repository.transaction(async (tx) => {
        await tx.lockUser(ownerId);
        // bind 在 need_wasm_key 时会下发分块密钥，等同于授权，同样要求核心模块。
        let entitlements: KeEntitlements | null = null;
        if (input.needWasmKey) {
          entitlements = await requireCoreEntitlement(tx, ownerId, timestamp);
          if (wantsNetwork && !entitlements.modules.has(KE_STANDALONE_MODULE)) {
            throw new KeFailure('KE_NOT_ENTITLED', 403, '账号未开通脱机版模块');
          }
        }
        const existing = await tx.findCharacter(input.report.aid, input.report.cid, input.report.nid);
        if (existing === null) {
          await tx.insertCharacter(ownerId, input.report, timestamp);
        } else if (existing.user_id === ownerId) {
          await tx.updateCharacterReport(ownerId, input.report, timestamp);
        } else if (existing.user_id !== null && existing.bound_at !== null && timestamp - existing.bound_at < KE_BINDING_EXCLUSIVE_MS) {
          throw new KeFailure('KE_CHARACTER_BOUND', 409, '该角色 30 天内已被其他账号绑定', { bound_at: existing.bound_at });
        } else {
          await tx.transferCharacter(ownerId, input.report, timestamp);
        }
        // 幂等：响应丢失后 KE 会用同一 instance_id 重试 bind，已存在则视为成功。
        const instance = await tx.findInstance(input.instanceId);
        if (instance === null) {
          await tx.insertInstance(input.instanceId, ownerId, input.report, input.buildId, input.ipHash, input.uaHash, timestamp);
        } else if (instance.user_id !== ownerId) {
          throw new KeFailure('KE_AUTH_FORBIDDEN', 403, '实例已绑定到其他账号');
        } else if (instance.aid !== input.report.aid || instance.cid !== input.report.cid || instance.nid !== input.report.nid) {
          // 同一窗口切换角色（换角色、换账号、换服务器）：实例沿用，额度仍按实例计，不会多占名额。
          // 目标角色的归属/30 天独占已在上方校验；运行中的实例会被置为 STOPPED，新角色须重新 start。
          await tx.rebindInstance(input.instanceId, input.report, input.buildId, input.ipHash, input.uaHash, timestamp);
        }
        return entitlements;
      });
      const bundles = input.needWasmKey
        ? await keyBundles(
          input.instanceId,
          input.kePublicKey!,
          ['core', ...(input.needModules ?? [])],
          entitlements?.modules ?? new Set(),
        )
        : undefined;
      return { instance_id: input.instanceId, ...(bundles ? { key_bundles: bundles } : {}) };
    },

    async moduleKeys(userId, input) {
      const requested = [...new Set(input.modules)];
      if (requested.length === 0 || requested.some(module => !['core', 'network'].includes(module))
        || input.kePublicKey === null || input.kePublicKey.byteLength !== 32) {
        throw new KeFailure('KE_BAD_REQUEST', 400, '请求字段无效');
      }
      const ownerId = Number(userId);
      const timestamp = now();
      const entitlements = await repository.transaction(tx => requireCoreEntitlement(tx, ownerId, timestamp));
      if (requested.includes('network') && !entitlements.modules.has(KE_STANDALONE_MODULE)) {
        throw new KeFailure('KE_NOT_ENTITLED', 403, '账号未开通脱机版模块');
      }
      if (requested.includes('network') && config.networkKey === null) {
        throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
      }
      return {
        key_bundles: await keyBundles(input.instanceId, input.kePublicKey, requested, entitlements.modules),
      };
    },

    async start(userId, input) {
      await assertAllowedBuild(input.buildId, input.buildHash);
      assertKeyRequest(input.needWasmKey, input.kePublicKey);
      assertModuleRequest(input);
      const wantsNetwork = (input.needModules ?? []).includes('network');
      if (wantsNetwork && config.networkKey === null) throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
      const ownerId = Number(userId);
      const timestamp = now();
      const mode = input.mode ?? 'auto';
      const { instance, features } = await repository.transaction(async (tx) => {
        await tx.lockUser(ownerId);
        const found = await tx.findInstance(input.instanceId);
        if (found === null) throw new KeFailure('KE_INSTANCE_NOT_FOUND', 404, '实例不存在');
        if (found.user_id !== ownerId) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, '实例不属于当前账号');
        assertSameCharacter(found, input.report);
        // 角色可能已被后台转移或他人重新绑定：归属变更后旧实例不能继续启动（心跳不检查，沿用原租约）。
        const character = await tx.findCharacter(found.aid, found.cid, found.nid);
        if (character?.user_id != null && character.user_id !== ownerId) {
          throw new KeFailure('KE_CHARACTER_BOUND', 409, '该角色 30 天内已被其他账号绑定', { bound_at: character.bound_at });
        }
        const entitlements = await requireCoreEntitlement(tx, ownerId, timestamp);
        if (wantsNetwork && !entitlements.modules.has(KE_STANDALONE_MODULE)) {
          throw new KeFailure('KE_NOT_ENTITLED', 403, '账号未开通脱机版模块');
        }
        const threshold = timestamp - KE_LIVENESS_WINDOW_MS;
        // manual（半自动）需要授权但不占额度：不做额度判定，也不踢人。
        if (mode === 'auto') {
          // 仅踢掉「近期心跳」的 ACTIVE auto 实例（真正占用额度的）；陈旧 ACTIVE 与 manual 不占额度，无需踢。
          if (input.kickInstanceId !== null && input.kickInstanceId !== found.instance_id) {
            const victim = await tx.findInstance(input.kickInstanceId);
            if (victim !== null && victim.user_id === ownerId && victim.state === 'ACTIVE' && victim.mode === 'auto' && (victim.last_heartbeat_at ?? 0) > threshold) {
              await tx.markKicked(victim.instance_id, found.instance_id, timestamp);
            }
          }
          // KICKED/STOPPED 也允许重新 start（同账号在角色间切换/重启），与 IDLE、心跳超时的 ACTIVE 走同一额度判定。
          const activeCount = await tx.countActive(ownerId, found.instance_id, threshold);
          if (!holdsSlot(found, threshold) && activeCount >= entitlements.slots) {
            const active = await tx.listActive(ownerId, threshold);
            throw new KeFailure('KE_QUOTA_EXCEEDED', 409, '已达实例额度，请先停用一名正在运行的角色', { active_instances: active });
          }
        }
        const licenseExpiresAt = timestamp + KE_LICENSE_LEASE_MS;
        const features = featuresOf(entitlements);
        await tx.activateInstance(found.instance_id, mode, JSON.stringify(features), input.buildId, input.ipHash, input.uaHash, licenseExpiresAt, timestamp);
        return { instance: { ...found, state: 'ACTIVE', mode, build_id: input.buildId, license_expires_at: licenseExpiresAt, last_heartbeat_at: timestamp }, features };
      });
      const license = await buildLicenseFor(config, instance, features, timestamp);
      const bundles = input.needWasmKey
        ? await keyBundles(
          input.instanceId,
          input.kePublicKey!,
          ['core', ...(input.needModules ?? [])],
          new Set(features),
        )
        : undefined;
      return { license, ...(bundles ? { key_bundles: bundles } : {}) };
    },

    async heartbeat(userId, instanceId, report, ts, attestation) {
      const timestamp = now();
      assertClockSkew(timestamp, ts);
      await assertAllowedBuild(attestation.buildId, attestation.buildHash);
      const ownerId = Number(userId);
      const { instance, features } = await repository.transaction(async (tx) => {
        await tx.lockUser(ownerId);
        const found = await tx.findInstance(instanceId);
        if (found === null) throw new KeFailure('KE_INSTANCE_NOT_FOUND', 404, '实例不存在');
        if (found.user_id !== ownerId) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, '实例不属于当前账号');
        if (found.state === 'KICKED') throw new KeFailure('KE_INSTANCE_KICKED', 409, '该实例已被顶替');
        if (found.state !== 'ACTIVE') throw new KeFailure('KE_INSTANCE_NOT_ACTIVE', 409, '实例未处于运行状态');
        assertSameCharacter(found, report);
        const entitlements = await requireCoreEntitlement(tx, ownerId, timestamp);
        // 心跳已超时的 ACTIVE 实例名额可能已被顶替：额度已被他人占满时不得凭心跳「复活」，按被顶替处理。
        const threshold = timestamp - KE_LIVENESS_WINDOW_MS;
        if (found.mode === 'auto' && !holdsSlot(found, threshold) && await tx.countActive(ownerId, instanceId, threshold) >= entitlements.slots) {
          throw new KeFailure('KE_INSTANCE_KICKED', 409, '该实例已被顶替');
        }
        const licenseExpiresAt = timestamp + KE_LICENSE_LEASE_MS;
        await tx.updateInstanceReport(instanceId, report, licenseExpiresAt, attestation.buildId, attestation.ipHash, attestation.uaHash, timestamp);
        await tx.updateCharacterReport(ownerId, report, timestamp);
        return { instance: { ...found, license_expires_at: licenseExpiresAt, last_heartbeat_at: timestamp }, features: featuresOf(entitlements) };
      });
      return { license: await buildLicenseFor(config, instance, features, timestamp) };
    },

    async stop(userId, instanceId) {
      const ownerId = Number(userId);
      const timestamp = now();
      await repository.transaction(async (tx) => {
        await tx.lockUser(ownerId);
        const found = await tx.findInstance(instanceId);
        if (found === null) throw new KeFailure('KE_INSTANCE_NOT_FOUND', 404, '实例不存在');
        if (found.user_id !== ownerId) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, '实例不属于当前账号');
        if (found.state !== 'ACTIVE') throw new KeFailure('KE_INSTANCE_NOT_ACTIVE', 409, '实例未处于运行状态');
        await tx.markStopped(instanceId, timestamp);
      });
    },
  };
}
