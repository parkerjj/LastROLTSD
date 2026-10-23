import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildRegistrationAudience, validateBuildRegistration, verifyGithubBuildPublisher } from '../src/ke/build-publisher';

const now = 1800000000;
const sha = 'a'.repeat(40);
const payload = {
  build_id: 'aaaaaaa-202610231230-123456-1', core_sha256: 'b'.repeat(64), commit_sha: sha,
  package_id: 'c'.repeat(64), engine_version: '1.2.3', release_tag: `ke-${sha}-123456-1`, core_key_version: 1,
};
let keys: CryptoKeyPair;
let jwk: JsonWebKey;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const audience = () => 'ltsd-ke-build-registration:' + createHash('sha256')
  .update(JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
async function token(patch: Record<string, unknown> = {}, headerPatch: Record<string, unknown> = {}) {
  const claims = {
    iss: 'https://token.actions.githubusercontent.com', aud: audience(),
    sub: 'repo:parkerjj/KoreEngine:environment:production', repository: 'parkerjj/KoreEngine',
    repository_id: '1421979322', repository_owner_id: '1243976', ref: 'refs/heads/main', environment: 'production',
    workflow_ref: 'parkerjj/KoreEngine/.github/workflows/ci-release.yml@refs/heads/main',
    workflow_sha: sha, sha, event_name: 'push', runner_environment: 'github-hosted',
    run_id: '123456', run_attempt: '1', jti: 'test-token-id', iat: now - 30, nbf: now - 30, exp: now + 270, ...patch,
  };
  const message = `${encode({ alg: 'RS256', kid: 'github-key', typ: 'JWT', ...headerPatch })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(message));
  return `${message}.${Buffer.from(signature).toString('base64url')}`;
}
function jwksFetch(response?: () => Response): typeof fetch {
  return (async (url, options) => {
    expect(url).toBe('https://token.actions.githubusercontent.com/.well-known/jwks');
    // workerd 不支持 redirect: 'error'（会抛 TypeError 并让所有登记返回 503），用 manual + 状态码检查。
    expect(options?.redirect).toBe('manual');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    return response ? response() : Response.json({ keys: [jwk] });
  }) as typeof fetch;
}
const unauthorized = { code: 'KE_BUILD_PUBLISHER_UNAUTHORIZED', status: 401 };

beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'github-key', alg: 'RS256', use: 'sig' } as JsonWebKey;
});

describe('构建登记输入', () => {
  it('接受固定字段并生成与字段顺序无关的完整内容 audience', async () => {
    expect(validateBuildRegistration(payload)).toEqual(payload);
    expect(await buildRegistrationAudience(payload)).toBe(audience());
    expect(await buildRegistrationAudience(Object.fromEntries(Object.entries(payload).reverse()) as typeof payload)).toBe(audience());
  });
  it.each([
    null, [], { ...payload, extra: true }, { ...payload, package_id: 'wrong' },
    { ...payload, engine_version: '1.2.3\n' }, { ...payload, engine_version: '1.2.3-beta' },
    { ...payload, core_key_version: 0 }, { ...payload, core_key_version: 4294967296 },
    { ...payload, commit_sha: sha.toUpperCase() }, { ...payload, build_id: '你' },
  ])('拒绝不合法 payload %#', (value) => {
    expect(() => validateBuildRegistration(value)).toThrow(expect.objectContaining({ code: 'KE_BAD_REQUEST', status: 400 }));
  });
});

describe('GitHub 构建发布者', () => {
  it.each(['repo:parkerjj/KoreEngine:environment:production', 'repo:parkerjj@1243976/KoreEngine@1421979322:environment:production'])(
    '验证真实RSA签名并兼容subject %s', async (sub) => {
      expect(await verifyGithubBuildPublisher(await token({ sub }), payload, { fetch: jwksFetch(), nowSeconds: now }))
        .toEqual({ runId: '123456', runAttempt: '1', jti: 'test-token-id' });
    });
  it.each([
    { iss: 'https://evil.example' }, { aud: 'wrong' }, { aud: [audience()] },
    { repository: 'evil/KoreEngine' }, { repository_id: '1' }, { repository_owner_id: '1' },
    { ref: 'refs/heads/dev' }, { environment: 'staging' },
    { sub: 'repo:parkerjj@1/KoreEngine@1421979322:environment:production' },
    { sub: 'repo:parkerjj/KoreEngine:ref:refs/heads/main' },
    { workflow_ref: 'parkerjj/KoreEngine/.github/workflows/evil.yml@refs/heads/main' },
    { workflow_sha: 'd'.repeat(40) }, { sha: 'd'.repeat(40) },
    { event_name: 'pull_request' }, { runner_environment: 'self-hosted' },
    { run_id: '123457' }, { run_attempt: '2' }, { run_id: '0' }, { run_attempt: '01' },
    { exp: now - 61 }, { iat: now + 61, nbf: now + 61 }, { nbf: now + 61 },
    { iat: now - 700 }, { exp: now + 1000 }, { exp: '1800000300' }, { jti: '' },
  ])('拒绝claim越权或失效 %#', async (patch) => {
    await expect(verifyGithubBuildPublisher(await token(patch), payload, { fetch: jwksFetch(), nowSeconds: now }))
      .rejects.toMatchObject(unauthorized);
  });
  it('接受 GitHub 真实形态的时间：nbf 比 iat 早 600 秒、exp 比 iat 晚 300 秒', async () => {
    await expect(verifyGithubBuildPublisher(await token({ iat: now - 30, nbf: now - 630, exp: now + 270 }), payload,
      { fetch: jwksFetch(), nowSeconds: now })).resolves.toMatchObject({ runId: '123456' });
  });
  it('拒绝 nbf 比 iat 早得离谱的令牌', async () => {
    await expect(verifyGithubBuildPublisher(await token({ iat: now - 30, nbf: now - 931, exp: now + 270 }), payload,
      { fetch: jwksFetch(), nowSeconds: now })).rejects.toMatchObject(unauthorized);
  });
  it('接受 workflow_dispatch', async () => {
    await expect(verifyGithubBuildPublisher(await token({ event_name: 'workflow_dispatch' }), payload,
      { fetch: jwksFetch(), nowSeconds: now })).resolves.toMatchObject({ runId: '123456' });
  });
  it('拒绝签名篡改、算法替换、未知kid和超大token', async () => {
    const signed = await token();
    const parts = signed.split('.');
    parts[1] = encode({ aud: audience() });
    for (const value of [parts.join('.'), `${signed.slice(0, -10)}AAAAAAAAAA`, await token({}, { alg: 'HS256' }),
      await token({}, { kid: 'missing' }), 'x'.repeat(17000)]) {
      await expect(verifyGithubBuildPublisher(value, payload, { fetch: jwksFetch(), nowSeconds: now })).rejects.toMatchObject(unauthorized);
    }
  });
  it('绑定每个请求字段以及run对应的build和tag', async () => {
    const signed = await token();
    for (const changed of [{ ...payload, core_sha256: 'd'.repeat(64) }, { ...payload, package_id: 'd'.repeat(64) },
      { ...payload, engine_version: '1.2.4' }, { ...payload, core_key_version: 2 },
      { ...payload, build_id: 'bbbbbbb-202610231230-123456-1' }, { ...payload, release_tag: `ke-${sha}-999-1` }]) {
      await expect(verifyGithubBuildPublisher(signed, changed, { fetch: jwksFetch(), nowSeconds: now })).rejects.toMatchObject(unauthorized);
    }
  });
  it('即使aud合法，也拒绝与签名run/commit不匹配的build/tag', async () => {
    for (const changed of [{ ...payload, build_id: 'bbbbbbb-202610231230-123456-1' },
      { ...payload, release_tag: `ke-${sha}-999-1` }]) {
      const aud = 'ltsd-ke-build-registration:' + createHash('sha256')
        .update(JSON.stringify(Object.fromEntries(Object.entries(changed).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
      await expect(verifyGithubBuildPublisher(await token({ aud }), changed, { fetch: jwksFetch(), nowSeconds: now }))
        .rejects.toMatchObject(unauthorized);
    }
  });
  it('拒绝直接调用时的非法payload', async () => {
    const changed = { ...payload, engine_version: 'bad' };
    const aud = 'ltsd-ke-build-registration:' + createHash('sha256')
      .update(JSON.stringify(Object.fromEntries(Object.entries(changed).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
    await expect(verifyGithubBuildPublisher(await token({ aud }), changed, { fetch: jwksFetch(), nowSeconds: now }))
      .rejects.toMatchObject(unauthorized);
  });
  it.each([
    () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
    () => new Response('x'.repeat(65537)), () => new Response('{'), () => Response.json({ keys: [] }),
    () => Response.json({ keys: [{ ...jwk, use: 'enc' }] }),
    () => Response.json({ keys: [{ ...jwk, kty: 'EC' }] }),
    () => new Response('{}', { headers: { 'content-length': '65537' } }),
  ])('JWKS不可用时封闭失败 %#', async (response) => {
    await expect(verifyGithubBuildPublisher(await token(), payload, { fetch: jwksFetch(response), nowSeconds: now }))
      .rejects.toMatchObject({ status: 503 });
  });
  it('JWKS网络失败或超时均返回通用503', async () => {
    const signed = await token();
    await expect(verifyGithubBuildPublisher(signed, payload, { nowSeconds: now,
      fetch: (async () => { throw new Error('network details'); }) as typeof fetch })).rejects.toMatchObject({ status: 503 });
    vi.useFakeTimers();
    try {
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const result = verifyGithubBuildPublisher(signed, payload, { nowSeconds: now,
        fetch: (() => { markStarted(); return new Promise(() => {}); }) as typeof fetch });
      const assertion = expect(result).rejects.toMatchObject({ status: 503 });
      await started;
      await vi.advanceTimersByTimeAsync(5001);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
});
