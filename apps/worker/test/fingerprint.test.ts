import { describe, expect, it } from 'vitest';
import { canonicalItemString, computeItemFingerprint } from '../src/domain/fingerprint';

describe('canonical item fingerprints', () => {
  const base = { sourceId: 's1', shopSessionId: 7, itemId: 100, upgrade: 5, slots: 1, cards: [0], options: [{ type: 2, value: 3, param: 1 }, { type: 1, value: 5, param: 0 }] };
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
