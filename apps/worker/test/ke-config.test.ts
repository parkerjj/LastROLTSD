import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '../src/auth/types';
import type { AppEnv } from '../src/env';
import { resolveKeConfig } from '../src/ke/config';
import { base64UrlDecode, buildLicense } from '../src/ke/crypto';
import type { LicensePayload } from '../src/ke/types';

interface KeSecrets {
  licensePrivateKey: string;
  licensePublicKeyBase64: string;
  licensePublicKeyHex: string;
  coreKey: string;
}

async function loadScripts() {
  const generator = await import(new URL('../../../scripts/generate-ke-secrets.mjs', import.meta.url).href) as {
    generateKeSecrets(): KeSecrets;
  };
  const preflight = await import(new URL('../../../scripts/preflight-auth-deployment.mjs', import.meta.url).href) as {
    resolveKeDeploymentPreflight(input: Record<string, string | undefined>): { ready: boolean; reasonCodes: string[] };
  };
  return { generateKeSecrets: generator.generateKeSecrets, resolveKeDeploymentPreflight: preflight.resolveKeDeploymentPreflight };
}

const enabledAuth = { enabled: true } as AuthConfig;
const disabledAuth = { enabled: false } as AuthConfig;
const SHA = 'a'.repeat(64);

function envFrom(secrets: KeSecrets, extra: Record<string, string> = {}): AppEnv {
  return { KE_LICENSE_PRIVATE_KEY_v1: secrets.licensePrivateKey, KE_CORE_KEY: secrets.coreKey, ...extra } as unknown as AppEnv;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

describe('generate-ke-secrets', () => {
  it('每次生成独立的密钥，且被 Worker 的 resolveKeConfig 接受', async () => {
    const { generateKeSecrets } = await loadScripts();
    const first = generateKeSecrets();
    const second = generateKeSecrets();
    expect(first.licensePrivateKey).not.toBe(second.licensePrivateKey);
    expect(first.coreKey).not.toBe(second.coreKey);

    const config = resolveKeConfig(envFrom(first), enabledAuth);
    expect(config.licensePrivateKey?.byteLength).toBe(48);
    expect(config.coreKey?.byteLength).toBe(32);
    expect(config.licenseKeyVersion).toBe('1');
    expect(config.coreKeyVersion).toBe('1');
  });

  it('用生成的私钥签发的 license 可被「公钥文件里的公钥」验签（KE 侧视角）', async () => {
    const { generateKeSecrets } = await loadScripts();
    const secrets = generateKeSecrets();
    const config = resolveKeConfig(envFrom(secrets), enabledAuth);
    const payload: LicensePayload = {
      v: 1, kid: 'ke-license-ed25519-v1', iid: '11111111-1111-4111-8111-111111111111', uid: '1',
      aid: 1, cid: 2, nid: 3, features: ['core'], key_versions: { core: 1 }, iat: 1000, exp: 2800,
    };
    const license = await buildLicense(payload, config.licensePrivateKey!);
    const [payloadText, signature] = license.split('.') as [string, string];

    const publicRaw = Uint8Array.from(Buffer.from(secrets.licensePublicKeyHex, 'hex'));
    expect(Buffer.from(publicRaw).toString('base64')).toBe(secrets.licensePublicKeyBase64);
    const verifyKey = await crypto.subtle.importKey('raw', toArrayBuffer(publicRaw), { name: 'Ed25519' }, false, ['verify']);
    // 约定：对 payload 的原文字节（base64url 解码后的 JSON）验签，与 KE 的 Rust 验签一致。
    const signed = toArrayBuffer(base64UrlDecode(payloadText));
    expect(await crypto.subtle.verify('Ed25519', verifyKey, toArrayBuffer(base64UrlDecode(signature)), signed)).toBe(true);

    const tampered = toArrayBuffer(new TextEncoder().encode(`${new TextDecoder().decode(base64UrlDecode(payloadText))} `));
    expect(await crypto.subtle.verify('Ed25519', verifyKey, toArrayBuffer(base64UrlDecode(signature)), tampered)).toBe(false);
  });
});

describe('resolveKeConfig', () => {
  it('账号体系未启用时 KE 整体禁用', () => {
    expect(resolveKeConfig({} as AppEnv, disabledAuth).enabled).toBe(false);
  });

  it('密钥缺失 / 长度或编码不对 / 版本号非法时拒绝（调用方据此返回 503）', async () => {
    const { generateKeSecrets } = await loadScripts();
    const good = generateKeSecrets();
    expect(() => resolveKeConfig({} as AppEnv, enabledAuth)).toThrow();
    expect(() => resolveKeConfig(envFrom(good, { KE_CORE_KEY: 'AAAA' }), enabledAuth)).toThrow();
    expect(() => resolveKeConfig(envFrom(good, { KE_LICENSE_PRIVATE_KEY_v1: good.coreKey }), enabledAuth)).toThrow();
    expect(() => resolveKeConfig(envFrom(good, { KE_CORE_KEY_VERSION: '0' }), enabledAuth)).toThrow();
    expect(() => resolveKeConfig(envFrom(good, { KE_LICENSE_KEY_VERSION: 'v2' }), enabledAuth)).toThrow();
  });

  it('数据库 enforced 模式完全不读取 legacy manifest，仍保持 disabled 语义', async () => {
    const { generateKeSecrets } = await loadScripts();
    const env = envFrom(generateKeSecrets());
    Object.defineProperty(env, 'KE_BUILD_MANIFEST', { get() { throw new Error('legacy secret must not be read'); } });
    expect(resolveKeConfig(env, enabledAuth, 'enforced').buildManifest).toBeNull();
    expect(resolveKeConfig(env, disabledAuth, 'enforced').enabled).toBe(false);
    expect(() => resolveKeConfig(env, enabledAuth, 'bootstrap')).toThrow();
  });

  it('构建清单：缺省 = 不校验；提供则必须完全有效（坏条目不得静默跳过而让指纹校验失效）', async () => {
    const { generateKeSecrets } = await loadScripts();
    const good = generateKeSecrets();
    expect(resolveKeConfig(envFrom(good), enabledAuth).buildManifest).toBeNull();
    expect(resolveKeConfig(envFrom(good, { KE_BUILD_MANIFEST: '  ' }), enabledAuth).buildManifest).toBeNull();

    const manifest = JSON.stringify({ 'core-1': { chunk: 'core', sha256: SHA } });
    expect(resolveKeConfig(envFrom(good, { KE_BUILD_MANIFEST: manifest }), enabledAuth).buildManifest?.get('core-1')?.sha256).toBe(SHA);

    for (const bad of [
      'not json',
      '[]',
      '{}',
      JSON.stringify({ 'core-1': { chunk: 'core', sha256: 'xyz' } }),
      JSON.stringify({ 'core-1': { chunk: 'core', sha256: SHA }, 'core-2': { chunk: 'core', sha256: 'short' } }),
      JSON.stringify({ 'core-1': 'oops' }),
    ]) {
      expect(() => resolveKeConfig(envFrom(good, { KE_BUILD_MANIFEST: bad }), enabledAuth)).toThrow();
    }
  });
});

describe('resolveKeDeploymentPreflight', () => {
  it('完整且有效的密钥 → ready；未配置 → 不就绪但只是提示（不影响 Profile 功能）', async () => {
    const { generateKeSecrets, resolveKeDeploymentPreflight } = await loadScripts();
    const secrets = generateKeSecrets();
    expect(resolveKeDeploymentPreflight({ licensePrivateKey: secrets.licensePrivateKey, coreKey: secrets.coreKey }))
      .toEqual({ ready: true, reasonCodes: [] });
    expect(resolveKeDeploymentPreflight({})).toEqual({ ready: false, reasonCodes: ['KE_SECRETS_NOT_CONFIGURED'] });
  });

  it('只配了一半 / 私钥不是 Ed25519 PKCS8 / K_core 长度不对 / 版本或清单非法 → 拒绝并给出脱敏原因码', async () => {
    const { generateKeSecrets, resolveKeDeploymentPreflight } = await loadScripts();
    const secrets = generateKeSecrets();
    expect(resolveKeDeploymentPreflight({ coreKey: secrets.coreKey }).reasonCodes).toContain('INCOMPLETE_KE_SECRETS');
    // 32 字节 K_core 当作私钥：长度不是 48
    expect(resolveKeDeploymentPreflight({ licensePrivateKey: secrets.coreKey, coreKey: secrets.coreKey }).reasonCodes)
      .toContain('INVALID_KE_LICENSE_PRIVATE_KEY');
    // 48 字节随机数：长度对但不是合法 PKCS8
    const randomDer = Buffer.alloc(48, 7).toString('base64');
    expect(resolveKeDeploymentPreflight({ licensePrivateKey: randomDer, coreKey: secrets.coreKey }).reasonCodes)
      .toContain('INVALID_KE_LICENSE_PRIVATE_KEY');
    expect(resolveKeDeploymentPreflight({ licensePrivateKey: secrets.licensePrivateKey, coreKey: 'AAAA' }).reasonCodes)
      .toContain('INVALID_KE_CORE_KEY');
    const result = resolveKeDeploymentPreflight({
      licensePrivateKey: secrets.licensePrivateKey, coreKey: secrets.coreKey,
      licenseKeyVersion: '0', coreKeyVersion: 'x', buildManifest: '{"a":{"chunk":"core","sha256":"zz"}}',
    });
    expect(result.ready).toBe(false);
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['INVALID_KE_LICENSE_KEY_VERSION', 'INVALID_KE_CORE_KEY_VERSION', 'INVALID_KE_BUILD_MANIFEST']));
    expect(JSON.stringify(result)).not.toContain(secrets.licensePrivateKey);
  });
});

describe('发布配置回归', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');

  it('workflow 在 auth-disabled barrier 之内、最终 deploy 之前推送 KE secrets，且只在 preflight 通过时执行', () => {
    const authSecrets = workflow.indexOf('name: Set Worker account auth secrets');
    const keSecrets = workflow.indexOf('name: Set Worker KoreEngine license secrets');
    const deploy = workflow.indexOf('name: Deploy production Worker and web assets');
    expect(authSecrets).toBeGreaterThanOrEqual(0);
    expect(keSecrets).toBeGreaterThan(authSecrets);
    expect(deploy).toBeGreaterThan(keSecrets);

    const step = workflow.slice(keSecrets, deploy);
    expect(step).toContain("if: steps.auth-preflight.outputs.ke_ready == 'true'");
    for (const name of ['KE_LICENSE_PRIVATE_KEY_v1', 'KE_CORE_KEY', 'KE_BUILD_MANIFEST']) {
      expect(step).toContain(`put_secret ${name} `);
    }
    expect(step).toContain('secrets.KE_LICENSE_PRIVATE_KEY_V1');
  });

  it('workflow 在最终 deploy 之后重跑一次幂等的权益回填，补上「迁移之后、新代码上线之前」才验证邮箱的账号', () => {
    const migrate = workflow.indexOf('name: Apply MySQL schema migrations');
    const deploy = workflow.indexOf('name: Deploy production Worker and web assets');
    const repair = workflow.indexOf('name: Repair signup entitlements');
    expect(migrate).toBeGreaterThanOrEqual(0);
    expect(repair).toBeGreaterThan(deploy);
    const step = workflow.slice(repair);
    expect(step).toContain('node scripts/backfill-signup-entitlements.mjs');
    expect(step).toContain('MYSQL_URL: ${{ secrets.MYSQL_URL }}');
  });

  it('.gitignore 明确忽略 KE 密钥目录与 env 文件', () => {
    const gitignore = readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8').split('\n').map((line) => line.trim());
    expect(gitignore).toContain('.ke-secrets.local/');
    expect(gitignore).toContain('ke-secrets.env');
  });
});
