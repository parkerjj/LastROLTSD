import { buildLicense, wrapChunkKey } from './crypto';
import type { KeConfig } from './config';
import { KE_CORE_MODULE, KE_STANDALONE_MODULE, type HostingEntitlementView, type KeEntitlements } from './entitlements';
import { cappedLicenseExpiry, hostingEligible, planConvergence } from './hosted/policy';
import type { InstanceRow, KeRepository, KeTx } from './repository';
import {
  KE_BINDING_EXCLUSIVE_MS,
  KE_CLOCK_SKEW_SECONDS,
  KE_LICENSE_LEASE_MS,
  KE_LIVENESS_WINDOW_MS,
  KeFailure,
  type CharacterReport,
  type HostedPrincipal,
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
  /** 托管 token 携带的身份；非托管（用户设备 token）为 undefined。 */
  hosted?: HostedPrincipal | undefined;
  report: CharacterReport;
  needWasmKey: boolean;
  /** 需要额外下发的模块（`network`）；缺省/空数组表示只下发 core（保持旧调用方兼容）。 */
  needModules?: readonly string[];
  kePublicKey: Uint8Array | null;
}

export interface StartInput extends BindInput {
  kickInstanceId: string | null;
  /** 兼容旧客户端：无论填 auto 还是 manual，服务端一律按 auto 处理并占额度（I14）。 */
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

export interface HeartbeatExtra {
  hosted?: HostedPrincipal | undefined;
  /** core 随 heartbeat 上报的状态快照（仅展示；非对象或超过 16KB 的被忽略）。 */
  status?: unknown;
}

export const KE_STATUS_MAX_BYTES = 16 * 1024;

export interface KeService {
  bind(userId: string, input: BindInput): Promise<BindResponse>;
  moduleKeys(userId: string, input: ModuleKeyInput): Promise<ModuleKeyResponse>;
  start(userId: string, input: StartInput): Promise<LicenseResponse>;
  heartbeat(userId: string, instanceId: string, report: CharacterReport, ts: number, attestation: Attestation, extra?: HeartbeatExtra): Promise<LicenseResponse>;
  stop(userId: string, instanceId: string, hosted?: HostedPrincipal): Promise<void>;
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

function buildLicenseFor(config: KeConfig, instance: InstanceRow, features: string[], now: number, expiryCapMs: number | null = null): Promise<string> {
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
    // 托管实例的 license 到期时间封顶为资格到期时间：即使所有通道失灵，core 本地 license-expired 也会在资格到期时停止。
    exp: Math.max(iat, Math.floor(cappedLicenseExpiry(now, KE_LICENSE_LEASE_MS, expiryCapMs) / 1000)),
  };
  if (config.licensePrivateKey === null) {
    throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
  }
  return buildLicense(payload, config.licensePrivateKey);
}


type Denied = { denied: KeFailure };

function isDenied(value: unknown): value is Denied {
  return typeof value === 'object' && value !== null && 'denied' in value;
}

/** 近期仍有效的同角色会话：ACTIVE 且心跳在窗口内，或 IDLE 且近期 bind 过（托管不得顶掉它们）。 */
function isLiveSameCharacter(row: { state: string; last_heartbeat_at: number | null; updated_at: number }, threshold: number): boolean {
  return row.state === 'ACTIVE' ? (row.last_heartbeat_at ?? 0) > threshold : row.updated_at > threshold;
}

/**
 * 托管 token 的统一校验（设计稿 6A 的 I1/I9/I12/I13）：实例一致、epoch 与登记一致、上报的角色与登记一致、
 * 仍有托管资格。资格丢失时在同一事务里停止托管实例，并以 Denied 返回——调用方必须在提交事务**之后**再抛出，
 * 否则回滚会把这次停止一并撤销。
 */
async function checkHostedPrincipal(
  tx: KeTx,
  principal: HostedPrincipal,
  instanceId: string,
  ownerId: number,
  report: CharacterReport,
  now: number,
): Promise<Denied | { entitlement: HostingEntitlementView }> {
  if (principal.instanceId !== instanceId) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, '实例不属于当前授权');
  const row = await tx.findHostedRow(instanceId);
  if (row === null || row.user_id !== ownerId) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, '实例不属于当前账号');
  if (row.epoch !== principal.epoch) return { denied: new KeFailure('KE_EPOCH_STALE', 409, '该托管实例已被改派，当前进程已过期') };
  if (row.desired !== 'running') return { denied: new KeFailure('KE_INSTANCE_NOT_ACTIVE', 409, '托管实例未处于运行状态') };
  if (row.aid !== report.aid || row.cid !== report.cid || row.nid !== report.nid) {
    return { denied: new KeFailure('KE_CHARACTER_MISMATCH', 403, '上报的角色与托管登记不一致') };
  }
  const entitlement = await tx.readHostingEntitlement(ownerId, now);
  if (!hostingEligible(entitlement)) {
    await tx.stopHostedByPolicy(instanceId, 'no-hosting-entitlement', now);
    return { denied: new KeFailure('KE_HOSTING_ENTITLEMENT_REQUIRED', 403, '账号没有离线挂机资格') };
  }
  return { entitlement };
}

function parseStatusSnapshot(status: unknown): string | null {
  if (typeof status !== 'object' || status === null || Array.isArray(status)) return null;
  const text = JSON.stringify(status);
  return new TextEncoder().encode(text).byteLength <= KE_STATUS_MAX_BYTES ? text : null;
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
      const outcome = await repository.transaction(async (tx): Promise<Denied | { entitlements: KeEntitlements | null }> => {
        await tx.lockUser(ownerId);
        if (input.hosted) {
          const check = await checkHostedPrincipal(tx, input.hosted, input.instanceId, ownerId, input.report, timestamp);
          if (isDenied(check)) return check;
        }
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
        return { entitlements };
      });
      if (isDenied(outcome)) throw outcome.denied;
      const entitlements = outcome.entitlements;
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
      // I14：半自动与自动一样占额度。无论请求里写 auto 还是 manual，一律按 auto 处理、持久化和计数。
      const mode: KeLicenseMode = 'auto';
      const outcome = await repository.transaction(async (tx): Promise<Denied | { instance: InstanceRow; features: string[]; expiryCapMs: number | null }> => {
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
        let expiryCapMs: number | null = null;
        if (input.hosted) {
          const check = await checkHostedPrincipal(tx, input.hosted, found.instance_id, ownerId, input.report, timestamp);
          if (isDenied(check)) return check;
          expiryCapMs = check.entitlement.hostingExpiresAt;
          // 托管永不踢人（I4）：带 kick 的请求直接拒绝。
          if (input.kickInstanceId !== null) throw new KeFailure('KE_BAD_REQUEST', 400, '托管实例不能踢人');
        }
        const threshold = timestamp - KE_LIVENESS_WINDOW_MS;
        const sameCharacter = await tx.listSameCharacter(ownerId, found.aid, found.cid, found.nid, found.instance_id);
        if (input.hosted) {
          // I15 单向接管：托管永不接管；同角色存在存活的非托管会话就等待。
          if (sameCharacter.some((row) => !row.hosted && isLiveSameCharacter(row, threshold))) {
            throw new KeFailure('KE_CHARACTER_IN_USE', 409, '该角色正在被其他会话使用');
          }
        } else {
          // 续连：同一用户同一角色重新开启时直接接管旧会话（含托管会话），不占额外名额，也不提示“实例超额”。
          for (const row of sameCharacter) {
            if (row.state === 'ACTIVE') await tx.markKicked(row.instance_id, found.instance_id, timestamp, 'character_takeover');
          }
        }
        // 仅踢掉「近期心跳」的 ACTIVE 实例（真正占用额度的）；陈旧 ACTIVE 不占额度，无需踢。
        if (input.kickInstanceId !== null && input.kickInstanceId !== found.instance_id) {
          const victim = await tx.findInstance(input.kickInstanceId);
          if (victim !== null && victim.user_id === ownerId && victim.state === 'ACTIVE' && (victim.last_heartbeat_at ?? 0) > threshold) {
            await tx.markKicked(victim.instance_id, found.instance_id, timestamp, 'quota_kick');
          }
        }
        // KICKED/STOPPED 也允许重新 start（同账号在角色间切换/重启），与 IDLE、心跳超时的 ACTIVE 走同一额度判定。
        const activeCount = await tx.countActive(ownerId, found.instance_id, threshold);
        if (!holdsSlot(found, threshold) && activeCount >= entitlements.slots) {
          const active = await tx.listActive(ownerId, threshold);
          throw new KeFailure('KE_QUOTA_EXCEEDED', 409, '已达实例额度，请先停用一名正在运行的角色', { active_instances: active });
        }
        const licenseExpiresAt = cappedLicenseExpiry(timestamp, KE_LICENSE_LEASE_MS, expiryCapMs);
        const features = featuresOf(entitlements);
        await tx.activateInstance(found.instance_id, mode, JSON.stringify(features), input.buildId, input.ipHash, input.uaHash, licenseExpiresAt, timestamp);
        return { instance: { ...found, state: 'ACTIVE', mode, build_id: input.buildId, license_expires_at: licenseExpiresAt, last_heartbeat_at: timestamp }, features, expiryCapMs };
      });
      if (isDenied(outcome)) throw outcome.denied;
      const { instance, features, expiryCapMs } = outcome;
      const license = await buildLicenseFor(config, instance, features, timestamp, expiryCapMs);
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

    async heartbeat(userId, instanceId, report, ts, attestation, extra) {
      const timestamp = now();
      assertClockSkew(timestamp, ts);
      await assertAllowedBuild(attestation.buildId, attestation.buildHash);
      const ownerId = Number(userId);
      const statusJson = parseStatusSnapshot(extra?.status);
      const outcome = await repository.transaction(async (tx): Promise<Denied | { instance: InstanceRow; features: string[]; expiryCapMs: number | null }> => {
        await tx.lockUser(ownerId);
        const found = await tx.findInstance(instanceId);
        if (found === null) throw new KeFailure('KE_INSTANCE_NOT_FOUND', 404, '实例不存在');
        if (found.user_id !== ownerId) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, '实例不属于当前账号');
        if (found.state === 'KICKED') {
          return { denied: new KeFailure('KE_INSTANCE_KICKED', 409, '该实例已被顶替', { reason: found.kick_reason ?? 'character_takeover' }) };
        }
        if (found.state !== 'ACTIVE') throw new KeFailure('KE_INSTANCE_NOT_ACTIVE', 409, '实例未处于运行状态');
        assertSameCharacter(found, report);
        const entitlements = await requireCoreEntitlement(tx, ownerId, timestamp);
        let hostingEntitlement: HostingEntitlementView | null = null;
        if (extra?.hosted) {
          const check = await checkHostedPrincipal(tx, extra.hosted, instanceId, ownerId, report, timestamp);
          if (isDenied(check)) return check;
          hostingEntitlement = check.entitlement;
        }
        // 心跳已超时的 ACTIVE 实例名额可能已被顶替：额度已被他人占满时不得凭心跳「复活」，按被顶替处理。
        const threshold = timestamp - KE_LIVENESS_WINDOW_MS;
        if (!holdsSlot(found, threshold) && await tx.countActive(ownerId, instanceId, threshold) >= entitlements.slots) {
          return { denied: new KeFailure('KE_INSTANCE_KICKED', 409, '该实例已被顶替', { reason: 'quota_shrunk' }) };
        }
        // I6：到期/缩水收敛。先算资格再算额度，被淘汰者持久化（托管：desired=stopped；非托管：KICKED），
        // 下一次心跳（或本次）拿到明确的拒绝；结果确定，不会来回踢。
        const hosting = hostingEntitlement ?? await tx.readHostingEntitlement(ownerId, timestamp);
        const active = await tx.listActiveForConvergence(ownerId, threshold);
        const verdicts = planConvergence({
          eligible: hostingEligible(hosting),
          slots: hosting.slots,
          instances: active.map((row) => ({ instanceId: row.instance_id, hosted: row.hosted, startedAt: row.started_at })),
        });
        let selfDenied: KeFailure | null = null;
        for (const verdict of verdicts) {
          const isSelf = verdict.instanceId === instanceId;
          if (verdict.action === 'kick_quota_shrunk') {
            await tx.markKicked(verdict.instanceId, verdict.instanceId, timestamp, 'quota_shrunk');
            if (isSelf) selfDenied = new KeFailure('KE_INSTANCE_KICKED', 409, '该实例已被顶替', { reason: 'quota_shrunk' });
          } else {
            await tx.stopHostedByPolicy(verdict.instanceId, verdict.action === 'stop_over_cap' ? 'over-hosting-cap' : 'no-hosting-entitlement', timestamp);
            if (isSelf) selfDenied = new KeFailure('KE_HOSTING_ENTITLEMENT_REQUIRED', 403, '账号没有离线挂机资格');
          }
        }
        if (selfDenied !== null) return { denied: selfDenied };
        const expiryCapMs = extra?.hosted ? hosting.hostingExpiresAt : null;
        const licenseExpiresAt = cappedLicenseExpiry(timestamp, KE_LICENSE_LEASE_MS, expiryCapMs);
        await tx.updateInstanceReport(instanceId, report, licenseExpiresAt, attestation.buildId, attestation.ipHash, attestation.uaHash, timestamp);
        await tx.updateCharacterReport(ownerId, report, timestamp);
        if (statusJson !== null) await tx.saveStatus(instanceId, statusJson, timestamp);
        return { instance: { ...found, license_expires_at: licenseExpiresAt, last_heartbeat_at: timestamp }, features: featuresOf(entitlements), expiryCapMs };
      });
      if (isDenied(outcome)) throw outcome.denied;
      return { license: await buildLicenseFor(config, outcome.instance, outcome.features, timestamp, outcome.expiryCapMs) };
    },

    async stop(userId, instanceId, hosted) {
      const ownerId = Number(userId);
      const timestamp = now();
      if (hosted && hosted.instanceId !== instanceId) throw new KeFailure('KE_AUTH_FORBIDDEN', 403, '实例不属于当前授权');
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
