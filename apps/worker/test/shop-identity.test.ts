import { describe, expect, it, vi } from 'vitest';
import { computeShopIdentity, normalizeShopIdentity } from '../src/domain/shop-identity';

const base = {
  sourceId: 'source-a',
  vendorAccountId: 'account-1',
  shopType: 'sell' as const,
  mapName: '  PRONTERA  ',
  x: 100.9,
  y: 120.1,
  title: '  Ｓynthetic   Shop ',
};

describe('source-scoped shop identity', () => {
  it('reuses immutable calculations while keeping sources and returned objects isolated', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const input = { sourceId: 'cache-test-source', vendorAccountId: 'cache-vendor', shopType: 'sell' as const,
      mapName: 'prontera', x: 1, y: 2, title: 'Cache shop' };
    try {
      const first = await computeShopIdentity(input);
      const expected = { ...first };
      first.identityHash = 'caller mutation';
      expect(await computeShopIdentity(input)).toEqual(expected);
      expect(digest).toHaveBeenCalledTimes(1);
      const other = await computeShopIdentity({ ...input, sourceId: 'other-cache-test-source' });
      expect(other.identityHash).not.toBe(expected.identityHash);
      expect(digest).toHaveBeenCalledTimes(2);
    } finally { digest.mockRestore(); }
  });

  it('bounds the identity cache and recalculates an evicted entry', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const input = { sourceId: 'cache-eviction-source', vendorAccountId: 'first', shopType: 'sell' as const,
      mapName: 'prontera', x: 1, y: 2, title: 'Shop' };
    try {
      const first = await computeShopIdentity(input);
      for (let index = 0; index < 1024; index++) await computeShopIdentity({ ...input, vendorAccountId: String(index) });
      expect(await computeShopIdentity(input)).toEqual(first);
      expect(digest).toHaveBeenCalledTimes(1026);
    } finally { digest.mockRestore(); }
  });
  it('normalizes stable identity fields and excludes vendor display name', () => {
    const normalized = normalizeShopIdentity(base);
    expect(normalized.mapNameNormalized).toBe('prontera');
    expect(normalized.titleNormalized).toBe('synthetic shop');
    expect(normalized.x).toBe(100);
    expect(normalized.y).toBe(120);
    expect(normalized.canonical).not.toContain('vendor_name');
  });

  it('isolates equal shop observations by authenticated source', async () => {
    const first = await computeShopIdentity(base);
    const second = await computeShopIdentity({ ...base, sourceId: 'source-b' });
    expect(first.identityHash).not.toBe(second.identityHash);
    expect(first.shopId).toMatch(/^shop_v1_[0-9a-f]{64}$/u);
    expect(second.shopId).toMatch(/^shop_v1_[0-9a-f]{64}$/u);
  });

  it('changes identity when a canonical shop field changes', async () => {
    const first = await computeShopIdentity(base);
    const renamed = await computeShopIdentity({ ...base, title: 'Another shop' });
    expect(first.identityHash).not.toBe(renamed.identityHash);
  });
});
