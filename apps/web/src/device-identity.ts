// 网页端设备标识：稳定的设备 ID（localStorage）与浏览器指纹（SHA-256），
// 随写请求以请求头发给服务端，仅用于账号操作日志；取不到时一律静默降级，绝不影响主流程。

export const DEVICE_ID_STORAGE_KEY = 'ltsd.device_id';
export const DEVICE_HEADER = 'x-ltsd-device';
export const FINGERPRINT_HEADER = 'x-ltsd-fp';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 存储不可用时本页会话内固定的临时 ID
let fallbackDeviceId: string | null = null;
let headersPromise: Promise<Record<string, string>> | null = null;

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window ? window.localStorage : null;
  } catch {
    return null;
  }
}

function sessionDeviceId(): string {
  fallbackDeviceId ??= crypto.randomUUID();
  return fallbackDeviceId;
}

export function readDeviceId(storage?: Storage | null): string | null {
  try {
    const target = storage === undefined ? defaultStorage() : storage;
    if (target) {
      try {
        const stored = target.getItem(DEVICE_ID_STORAGE_KEY);
        if (stored !== null && UUID_PATTERN.test(stored)) return stored;
        const created = crypto.randomUUID();
        target.setItem(DEVICE_ID_STORAGE_KEY, created);
        return created;
      } catch {
        // 读写失败：落到临时 ID
      }
    }
    return sessionDeviceId();
  } catch {
    return null;
  }
}

function attempt(read: () => unknown): string {
  try {
    const value = read();
    return value === undefined || value === null ? '' : String(value);
  } catch {
    return '';
  }
}

function canvasFeature(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 50;
  const context = canvas.getContext('2d');
  if (!context) return '';
  context.textBaseline = 'top';
  context.font = '14px Arial';
  context.fillStyle = '#f60';
  context.fillRect(10, 5, 80, 30);
  context.fillStyle = '#069';
  context.fillText('LastRO fingerprint 指纹', 4, 12);
  return canvas.toDataURL();
}

function webglFeature(): string {
  const canvas = document.createElement('canvas');
  const gl = (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
  if (!gl) return '';
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  if (!info) return '';
  return `${String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL))}|${String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))}`;
}

export async function computeFingerprint(): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const nav = (typeof navigator === 'undefined' ? undefined : navigator) as
      | (Navigator & { deviceMemory?: number })
      | undefined;
    // 固定顺序，每项单独容错，失败记空串
    const features = [
      attempt(() => screen.width),
      attempt(() => screen.height),
      attempt(() => screen.colorDepth),
      attempt(() => devicePixelRatio),
      attempt(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      attempt(() => nav?.language),
      attempt(() => nav?.languages.join(',')),
      attempt(() => nav?.platform),
      attempt(() => nav?.hardwareConcurrency),
      attempt(() => nav?.deviceMemory),
      attempt(canvasFeature),
      attempt(webglFeature),
    ];
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(features.join('|')));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function buildHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const deviceId = readDeviceId();
  if (deviceId) headers[DEVICE_HEADER] = deviceId;
  const fingerprint = await computeFingerprint();
  if (fingerprint) headers[FINGERPRINT_HEADER] = fingerprint;
  return headers;
}

/** 设备请求头；首次计算后缓存，任何异常都返回 {}。 */
export function readDeviceHeaders(): Promise<Record<string, string>> {
  headersPromise ??= buildHeaders().catch(() => ({}));
  return headersPromise;
}

export function resetDeviceIdentityForTests(): void {
  fallbackDeviceId = null;
  headersPromise = null;
}
