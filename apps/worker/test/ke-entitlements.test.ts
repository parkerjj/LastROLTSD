import { describe, expect, it } from 'vitest';
import { foldEntitlements, foldHostingEntitlement, KE_PERMANENT_MS } from '../src/ke/entitlements';

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

  it('离线挂机包含脱机版：有 hosting 就同时具备 standalone，没有则不会凭空出现', () => {
    const withHosting = foldEntitlements([{ resource: 'module:core', total: 1 }, { resource: 'module:hosting', total: 1 }]);
    expect([...withHosting.modules].sort()).toEqual(['core', 'hosting', 'standalone']);
    const standaloneOnly = foldEntitlements([{ resource: 'module:standalone', total: 1 }]);
    expect([...standaloneOnly.modules]).toEqual(['standalone']);
    expect(foldEntitlements([{ resource: 'module:hosting', total: 0 }]).modules.size).toBe(0);
  });

  it('托管资格只看 module:hosting 与核心模块，实例额度只决定上限', () => {
    const rows = (resource: string, total: number, maxExpiresAt = 0) => ({ resource, total, maxExpiresAt });
    const eligible = foldHostingEntitlement([rows('slots', 3), rows('module:core', 1), rows('module:hosting', 1, 5000)]);
    expect(eligible).toEqual({ slots: 3, hasHosting: true, hasCore: true, hostingExpiresAt: 5000 });
    const noHosting = foldHostingEntitlement([rows('slots', 11), rows('module:core', 1)]);
    expect(noHosting.hasHosting).toBe(false);
    expect(noHosting.hostingExpiresAt).toBeNull();
    // 被管理员扣减到 0 的流水不算拥有。
    expect(foldHostingEntitlement([rows('module:hosting', 0, 9000)]).hasHosting).toBe(false);
  });

  it('永久有效期是 99 年（按 365 天计）', () => {
    expect(KE_PERMANENT_MS).toBe(99 * 365 * 24 * 60 * 60 * 1000);
  });
});
