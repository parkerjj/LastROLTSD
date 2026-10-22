import { describe, expect, it } from 'vitest';
import { foldEntitlements, KE_PERMANENT_MS } from '../src/ke/entitlements';

describe('ke entitlements', () => {
  it('没有任何流水时额度为 0、没有模块', () => {
    const result = foldEntitlements([]);
    expect(result.slots).toBe(0);
    expect(result.modules.size).toBe(0);
  });

  it('额度取 slots 流水之和；负数流水把总和压到 0 以下时钳到 0', () => {
    expect(foldEntitlements([{ resource: 'slots', total: 11 }]).slots).toBe(11);
    expect(foldEntitlements([{ resource: 'slots', total: -3 }]).slots).toBe(0);
  });

  it('模块只有在流水之和大于 0 时才生效，并去掉 module: 前缀', () => {
    const result = foldEntitlements([
      { resource: 'module:core', total: 1 },
      { resource: 'module:alpha', total: 0 },
      { resource: 'module:beta', total: -1 },
      { resource: 'unknown', total: 5 },
    ]);
    expect([...result.modules]).toEqual(['core']);
    expect(result.slots).toBe(0);
  });

  it('永久有效期是 99 年（按 365 天计）', () => {
    expect(KE_PERMANENT_MS).toBe(99 * 365 * 24 * 60 * 60 * 1000);
  });
});
