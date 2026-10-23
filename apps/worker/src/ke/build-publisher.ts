import { KeFailure } from './types';

export interface BuildRegistration {
  build_id: string;
  core_sha256: string;
  commit_sha: string;
  package_id: string;
  engine_version: string;
  release_tag: string;
  core_key_version: number;
}

const FIELDS = ['build_id', 'commit_sha', 'core_key_version', 'core_sha256', 'engine_version', 'package_id', 'release_tag'] as const;
const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const MAX_TOKEN_BYTES = 16384;
const MAX_JWKS_BYTES = 65536;
const CLOCK_SKEW = 60;
const MAX_TOKEN_LIFETIME = 600;
// GitHub OIDC 令牌的 nbf 比 iat 早约 600 秒（官方示例），只拒绝明显异常的更早值。
const MAX_NBF_LEAD = 900;

function unauthorized(): KeFailure {
  return new KeFailure('KE_BUILD_PUBLISHER_UNAUTHORIZED', 401, '构建登记身份无效');
}

function unavailable(): KeFailure {
  return new KeFailure('KE_BUILD_PUBLISHER_UNAVAILABLE', 503, '构建登记身份验证暂不可用');
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matches(value: unknown, pattern: RegExp, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && pattern.exec(value)?.[0] === value;
}

export function validateBuildRegistration(value: unknown): BuildRegistration {
  if (!object(value) || Object.keys(value).length !== FIELDS.length
    || !FIELDS.every((key) => Object.hasOwn(value, key))
    || !matches(value.build_id, /^[a-f0-9]{7}-[0-9]{12}-[1-9][0-9]*-[1-9][0-9]*$/, 64)
    || !matches(value.commit_sha, /^[a-f0-9]{40}$/, 40)
    || !matches(value.core_sha256, /^[a-f0-9]{64}$/, 64)
    || !matches(value.package_id, /^[a-f0-9]{64}$/, 64)
    || !matches(value.engine_version, /^[0-9]+\.[0-9]+\.[0-9]+$/, 32)
    || !matches(value.release_tag, /^ke-[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*$/, 128)
    || typeof value.core_key_version !== 'number' || !Number.isSafeInteger(value.core_key_version)
    || value.core_key_version < 1 || value.core_key_version > 4294967295) {
    throw new KeFailure('KE_BAD_REQUEST', 400, '构建登记内容无效');
  }
  return Object.fromEntries(FIELDS.map((key) => [key, value[key]])) as unknown as BuildRegistration;
}

export async function buildRegistrationAudience(payload: BuildRegistration): Promise<string> {
  const canonical = JSON.stringify(Object.fromEntries(FIELDS.map((key) => [key, payload[key]])));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return 'ltsd-ke-build-registration:' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!matches(value, /^[A-Za-z0-9_-]+$/, MAX_TOKEN_BYTES) || value.length % 4 === 1) throw unauthorized();
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  // 拒绝同一字节内容的非规范 base64url 别名。
  if (btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== value) throw unauthorized();
  return bytes;
}

function decodeObject(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64url(value)));
  if (!object(decoded)) throw unauthorized();
  return decoded;
}

async function readJwks(fetcher: typeof fetch): Promise<Record<string, unknown>[]> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(unavailable()); }, 5000);
  });
  try {
    return await Promise.race([timedOut, (async () => {
      const response = await fetcher(JWKS_URL, { redirect: 'manual', signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok || response.redirected || !response.body
        || Number(response.headers.get('content-length') ?? 0) > MAX_JWKS_BYTES) throw unavailable();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_JWKS_BYTES) throw unavailable();
          chunks.push(chunk.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const document: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!object(document) || !Array.isArray(document.keys) || document.keys.length > 32) throw unavailable();
      const keys = document.keys.filter((key): key is Record<string, unknown> => object(key)
        && key.kty === 'RSA' && key.use === 'sig' && key.alg === 'RS256'
        && typeof key.kid === 'string' && typeof key.n === 'string' && typeof key.e === 'string'
        && key.d === undefined && (key.key_ops === undefined
          || (Array.isArray(key.key_ops) && key.key_ops.length === 1 && key.key_ops[0] === 'verify')));
      if (keys.length === 0) throw unavailable();
      return keys;
    })()]);
  } catch {
    throw unavailable();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    controller.abort();
  }
}

export async function verifyGithubBuildPublisher(
  token: string,
  payload: BuildRegistration,
  options: { fetch?: typeof fetch; nowSeconds?: number } = {},
): Promise<{ runId: string; runAttempt: string; jti: string }> {
  try {
    payload = validateBuildRegistration(payload);
    if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) throw unauthorized();
    const parts = token.split('.');
    if (parts.length !== 3) throw unauthorized();
    const header = decodeObject(parts[0]!);
    if (header.alg !== 'RS256' || header.typ !== 'JWT' || !matches(header.kid, /^[A-Za-z0-9_-]+$/, 256)
      || header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) throw unauthorized();
    const claims = decodeObject(parts[1]!);
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const { iat, nbf, exp } = claims;
    if (typeof iat !== 'number' || !Number.isSafeInteger(iat) || typeof nbf !== 'number' || !Number.isSafeInteger(nbf)
      || typeof exp !== 'number' || !Number.isSafeInteger(exp) || !Number.isFinite(now)
      || iat > now + CLOCK_SKEW || nbf > now + CLOCK_SKEW || exp <= now - CLOCK_SKEW
      || exp <= iat || exp - iat > MAX_TOKEN_LIFETIME || nbf > exp || nbf < iat - MAX_NBF_LEAD
      || iat < now - MAX_TOKEN_LIFETIME - CLOCK_SKEW) throw unauthorized();
    if (claims.iss !== ISSUER || claims.aud !== await buildRegistrationAudience(payload)
      || claims.repository !== 'parkerjj/KoreEngine' || claims.repository_id !== '1421979322'
      || claims.repository_owner_id !== '1243976' || claims.ref !== 'refs/heads/main' || claims.environment !== 'production'
      || claims.workflow_ref !== 'parkerjj/KoreEngine/.github/workflows/ci-release.yml@refs/heads/main'
      || claims.workflow_sha !== payload.commit_sha || claims.sha !== payload.commit_sha
      || (claims.event_name !== 'push' && claims.event_name !== 'workflow_dispatch') || claims.runner_environment !== 'github-hosted'
      || (claims.sub !== 'repo:parkerjj/KoreEngine:environment:production'
        && claims.sub !== 'repo:parkerjj@1243976/KoreEngine@1421979322:environment:production')
      || !matches(claims.run_id, /^[1-9][0-9]*$/, 20) || !matches(claims.run_attempt, /^[1-9][0-9]*$/, 10)
      || !matches(claims.jti, /^[A-Za-z0-9._-]+$/, 256)) throw unauthorized();
    const { run_id: runId, run_attempt: runAttempt, jti } = claims;
    if (payload.release_tag !== `ke-${payload.commit_sha}-${runId}-${runAttempt}`
      || !matches(payload.build_id, new RegExp(`^${payload.commit_sha.slice(0, 7)}-[0-9]{12}-${runId}-${runAttempt}$`), 64)) throw unauthorized();
    const signature = decodeBase64url(parts[2]!);
    const keys = await readJwks(options.fetch ?? fetch);
    const matchingKeys = keys.filter((key) => key.kid === header.kid);
    if (matchingKeys.length !== 1) throw unauthorized();
    const key = await crypto.subtle.importKey('jwk', matchingKeys[0] as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (key.algorithm.name !== 'RSASSA-PKCS1-v1_5' || (key.algorithm as RsaKeyAlgorithm).modulusLength < 2048
      || !await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw unauthorized();
    return { runId, runAttempt, jti };
  } catch (error) {
    if (error instanceof KeFailure && error.status === 503) throw error;
    throw unauthorized();
  }
}
