import type { AuthConfig } from '../auth/types';
import type { AppEnv } from '../env';
import { KeFailure, type KeBindings } from './types';

export interface BuildEntry {
  chunk: string;
  sha256: string;
  network_sha256?: string;
  network_key_version?: number;
  standalone_package_id?: string;
}

export interface KeConfig {
  enabled: boolean;
  licensePrivateKey: Uint8Array | null;
  licenseKeyVersion: string;
  coreKey: Uint8Array | null;
  coreKeyVersion: string;
  /** 脱机版 network 模块密钥；未配置时旧客户端完全不受影响，只有请求 network 的 bind 返回 503。 */
  networkKey: Uint8Array | null;
  networkKeyVersion: string;
  buildManifest: ReadonlyMap<string, BuildEntry> | null;
}

function disabled(): KeConfig {
  return {
    enabled: false,
    licensePrivateKey: null,
    licenseKeyVersion: '1',
    coreKey: null,
    coreKeyVersion: '1',
    networkKey: null,
    networkKeyVersion: '1',
    buildManifest: null,
  };
}

function decodeSecret(value: string | undefined, expectedLength: number): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
  }
  if (binary.length !== expectedLength || btoa(binary) !== value) {
    throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** 可选密钥：未配置返回 null；一旦配置就必须完全合法（fail closed），避免静默降级。 */
function decodeOptionalSecret(value: string | undefined, expectedLength: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return decodeSecret(value, expectedLength);
}

function keyVersion(value: string | undefined, fallback: string): string {
  const version = value ?? fallback;
  // 版本必须是纯正整数：license 的 key_versions 会 Number() 转换，非数字版本会变成 null。
  if (!/^[1-9]\d*$/u.test(version)) {
    throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
  }
  return version;
}

function buildManifest(value: string | undefined): ReadonlyMap<string, BuildEntry> | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
  }
  const entries = new Map<string, BuildEntry>();
  for (const [buildId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    // 清单一旦提供就必须完全有效：静默跳过坏条目会让构建指纹校验在无人察觉时失效（fail-open）。
    const candidate = (typeof entry === 'object' && entry !== null ? entry : {}) as {
      chunk?: unknown;
      sha256?: unknown;
      network_sha256?: unknown;
      network_key_version?: unknown;
      standalone_package_id?: unknown;
    };
    if (typeof candidate.chunk !== 'string' || typeof candidate.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate.sha256)) {
      throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
    }
    if ((candidate.network_sha256 !== undefined && (typeof candidate.network_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate.network_sha256)))
      || (candidate.standalone_package_id !== undefined && (typeof candidate.standalone_package_id !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate.standalone_package_id)))
      || (candidate.network_key_version !== undefined && (typeof candidate.network_key_version !== 'number'
        || !Number.isSafeInteger(candidate.network_key_version) || candidate.network_key_version < 1))) {
      throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
    }
    entries.set(buildId, {
      chunk: candidate.chunk,
      sha256: candidate.sha256,
      ...(candidate.network_sha256 === undefined ? {} : { network_sha256: candidate.network_sha256 }),
      ...(candidate.network_key_version === undefined ? {} : { network_key_version: candidate.network_key_version }),
      ...(candidate.standalone_package_id === undefined ? {} : { standalone_package_id: candidate.standalone_package_id }),
    });
  }
  if (entries.size === 0) throw new KeFailure('KE_UNAVAILABLE', 503, '授权服务暂不可用');
  return entries;
}

export function resolveKeConfig(env: AppEnv & KeBindings, authConfig: AuthConfig, buildPolicy: 'bootstrap' | 'enforced' = 'bootstrap'): KeConfig {
  if (!authConfig.enabled) return disabled();
  const networkKey = decodeOptionalSecret(env.KE_NETWORK_KEY, 32);
  return {
    enabled: true,
    licensePrivateKey: decodeSecret(env.KE_LICENSE_PRIVATE_KEY_v1, 48),
    licenseKeyVersion: keyVersion(env.KE_LICENSE_KEY_VERSION, '1'),
    coreKey: decodeSecret(env.KE_CORE_KEY, 32),
    coreKeyVersion: keyVersion(env.KE_CORE_KEY_VERSION, '1'),
    networkKey,
    // 未配置 network 密钥时不校验其版本，避免影响只使用 core 的旧客户端。
    networkKeyVersion: networkKey === null ? '1' : keyVersion(env.KE_NETWORK_KEY_VERSION, '1'),
    buildManifest: buildPolicy === 'bootstrap' ? buildManifest(env.KE_BUILD_MANIFEST) : null,
  };
}
