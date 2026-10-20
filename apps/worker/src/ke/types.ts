export type UserId = string;
export type KeInstanceState = 'IDLE' | 'ACTIVE' | 'KICKED' | 'STOPPED';
/** 授权模式：auto 占实例额度；manual（半自动）需要授权但不占额度。 */
export type KeLicenseMode = 'auto' | 'manual';

export const KE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
export const KE_LICENSE_LEASE_MS = 30 * 60 * 1000;
/** 额度存活窗口：2×心跳。last_heartbeat_at 距今超过即视为「无近期心跳」，不占额度。 */
export const KE_LIVENESS_WINDOW_MS = 10 * 60 * 1000;
/** 角色绑定独占期：同一角色 30 天内只能被一个账号绑定。 */
export const KE_BINDING_EXCLUSIVE_MS = 30 * 24 * 60 * 60 * 1000;
export const KE_BASE_INSTANCE_LIMIT = 1;
/** 反重放时钟容忍（秒）。 */
export const KE_CLOCK_SKEW_SECONDS = 300;

/** 设备码有效期：用户须在此时间内于网页完成授权。 */
export const KE_DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
/** 轮询间隔（秒）：KE 轮询 /device/token 的最小间隔，过快返回 429。 */
export const KE_DEVICE_POLL_INTERVAL_SECONDS = 5;
/** KE token 滑动有效期：每次使用（最多每小时刷新一次）顺延 90 天。 */
export const KE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const KE_TOKEN_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/** 每账号同时有效的 token 上限；超出时自动撤销最久未用的一个，避免设备授权在上限处失败。 */
export const KE_TOKEN_MAX_PER_USER = 20;
/** token 前缀，便于日志/密钥扫描识别；摘要只对前缀之后的 43 位随机串计算。 */
export const KE_TOKEN_PREFIX = 'ke1_';

/** Worker 绑定（Secret）。值来自 wrangler secret / 本地 .dev.vars。 */
export interface KeBindings {
  /** Ed25519 私钥（base64，PKCS8 DER，48 字节），用于签发 license。 */
  KE_LICENSE_PRIVATE_KEY_v1?: string | undefined;
  KE_LICENSE_KEY_VERSION?: string | undefined;
  /** 加密 core.wasm 的 AES-256 密钥 K_core（base64，32 字节）。 */
  KE_CORE_KEY?: string | undefined;
  KE_CORE_KEY_VERSION?: string | undefined;
  /** 构建清单（JSON：{ "<build_id>": { "chunk": "core", "sha256": "<hex>" } }），可选；缺省时跳过 A 指纹校验。 */
  KE_BUILD_MANIFEST?: string | undefined;
}

/** KE 上报的角色基础信息。 */
export interface CharacterReport {
  aid: number;
  cid: number;
  nid: number;
  char_name: string;
  base_level: number | null;
  job_level: number | null;
  job_id: number | null;
  map_name: string | null;
}

/** license 签名前的 payload（JSON 字段）。 */
export interface LicensePayload {
  v: 1;
  kid: string;
  iid: string;
  uid: string;
  aid: number;
  cid: number;
  nid: number;
  features: string[];
  key_versions: Record<string, number>;
  iat: number;
  exp: number;
}

/** X25519 + HKDF + AES-GCM 包裹后的分块密钥。 */
export interface WrappedKeyBundle {
  ephemeral_public: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

/** 被踢实例 / 正在运行角色的展示信息（KE_QUOTA_EXCEEDED 响应里返回）。 */
export interface ActiveInstanceInfo {
  instance_id: string;
  char_name: string | null;
  map_name: string | null;
  last_heartbeat_at: number | null;
}

export class KeFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly publicMessage: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(publicMessage);
    this.name = 'KeFailure';
  }
}
