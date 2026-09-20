import { describe, expect, it } from 'vitest';
import { resolveItemDisplay } from '../src/domain/item-display';

describe('catalog-owned item display', () => {
  it('uses the catalog name when available', () => {
    expect(resolveItemDisplay(1234, { itemId: 1234, name: '测试剑' })).toEqual({ itemId: 1234, name: '测试剑' });
  });

  it('uses one fallback for unknown item IDs', () => {
    expect(resolveItemDisplay(1234, null)).toEqual({ itemId: 1234, name: '未知物品 #1234' });
  });
});
