import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalItemString, computeItemFingerprint } from '../src/domain/fingerprint';
import { computeFullShopStateHash } from '../src/domain/shop-state';

describe('canonical item fingerprints', () => {
  const base = { sourceId: 's1', shopSessionId: 7, itemId: 100, upgrade: 5, slots: 1, cards: [0], options: [{ type: 2, value: 3, param: 1 }, { type: 1, value: 5, param: 0 }] };
  it('preserves persisted canonical bytes and fingerprints for both identity scopes', async () => {
    for (const scope of [7, 'identity-hash']) {
      const expected = `{"source_id":"s1","shop_session_id":"${scope}","item_key":null,"item_id":100,"upgrade":5,"slots":1,"cards":[0,0,0,0],"options":[[1,5,0],[2,3,1]]}`;
      expect(canonicalItemString({ ...base, shopSessionId: scope })).toBe(expected);
      expect(await computeItemFingerprint({ ...base, shopSessionId: scope })).toBe(createHash('sha256').update(expected).digest('hex'));
    }
  });

  it('preserves full-shop hashes independent of item and option ordering', async () => {
    const item = { item_id: 100, upgrade: 5, slots: 1, cards: [0], options: base.options, price: 10, quantity: 2 };
    const canonical = '{"source_id":"s1","shop_session_id":"identity-hash","item_key":null,"item_id":100,"upgrade":5,"slots":1,"cards":[0,0,0,0],"options":[[1,5,0],[2,3,1]]}';
    const fingerprint = createHash('sha256').update(canonical).digest('hex');
    const expected = createHash('sha256').update(JSON.stringify([{ fingerprint, price: 10, quantity: 2 }, { fingerprint, price: 11, quantity: 1 }])).digest('hex');
    expect(await computeFullShopStateHash('s1', 'identity-hash', [{ ...item, price: 11, quantity: 1 }, item])).toBe(expected);
    expect(await computeFullShopStateHash('s1', 'identity-hash', [{ ...item, options: [...base.options].reverse() }, { ...item, price: 11, quantity: 1 }])).toBe(expected);
  });
  it('is invariant to option order and missing cards', async () => {
    const first = await computeItemFingerprint(base);
    const second = await computeItemFingerprint({ ...base, cards: [0, 0, 0, 0], options: [...base.options].reverse() });
    expect(first).toBe(second);
    expect(canonicalItemString(base)).toContain('"cards":[0,0,0,0]');
  });
  it('changes for tuple, gear, and item key changes', async () => {
    const first = await computeItemFingerprint(base);
    expect(await computeItemFingerprint({ ...base, options: [{ type: 2, value: 4, param: 1 }] })).not.toBe(first);
    expect(await computeItemFingerprint({ ...base, upgrade: 6 })).not.toBe(first);
    expect(await computeItemFingerprint({ ...base, itemKey: 'other' })).not.toBe(first);
  });
  it('ignores legacy client names completely', async () => {
    const first = await computeItemFingerprint({ ...base, name: '客户端名称 A' } as typeof base & { name: string });
    const second = await computeItemFingerprint({ ...base, name: '客户端名称 B' } as typeof base & { name: string });
    expect(first).toBe(second);
  });
});
