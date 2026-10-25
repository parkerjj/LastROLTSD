import { describe, expect, it } from 'vitest';
import { resolveAppEnv } from '../src/env';

describe('resolveAppEnv KE bindings', () => {
  it('把 network 模块密钥与版本透传给 resolveKeConfig', () => {
    const coreKey = `${'A'.repeat(43)}=`;
    const networkKey = `${'B'.repeat(43)}=`;
    const env = resolveAppEnv({
      ENVIRONMENT: 'local',
      KE_LICENSE_PRIVATE_KEY_v1: 'a'.repeat(64),
      KE_LICENSE_KEY_VERSION: '1',
      KE_CORE_KEY: coreKey,
      KE_CORE_KEY_VERSION: '1',
      KE_NETWORK_KEY: networkKey,
      KE_NETWORK_KEY_VERSION: '2',
      KE_BUILD_MANIFEST: '{}',
    });

    expect(env.KE_CORE_KEY).toBe(coreKey);
    expect(env.KE_CORE_KEY_VERSION).toBe('1');
    expect(env.KE_NETWORK_KEY).toBe(networkKey);
    expect(env.KE_NETWORK_KEY_VERSION).toBe('2');
    expect(env.KE_BUILD_MANIFEST).toBe('{}');
  });
});
