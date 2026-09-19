import { describe, expect, it } from 'vitest';
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
