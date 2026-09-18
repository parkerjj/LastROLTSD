import { describe, expect, it } from 'vitest';
import { normalizeItem, normalizeOption } from '../src/index';

describe('normalization', () => {
  it('sorts options and fills cards without mutating input', () => {
    const input = { item_id: '42', name: '  Sword  ', cards: [2], options: [
      { type: 2, value: 1, param: 0 }, { type: 1, value: 5, param: 0 },
    ], price: '100', quantity: '2' };
    const normalized = normalizeItem(input);
    expect(normalized.cards).toEqual([2, 0, 0, 0]);
    expect(normalized.options.map((o) => o.type)).toEqual([1, 2]);
    expect(normalized.name).toBe('Sword');
    expect(input.cards).toEqual([2]);
  });

  it('coerces safe integer option fields only', () => {
    expect(normalizeOption({ type: '1', value: 2, param: '3' })).toEqual({ type: 1, value: 2, param: 3 });
    expect(() => normalizeOption({ type: 1.2, value: 2, param: 0 })).toThrow();
  });
});
