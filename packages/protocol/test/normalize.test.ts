import { describe, expect, it } from 'vitest';
import { normalizeItem, normalizeOption } from '../src/index';

describe('normalization', () => {
  it('sorts options and fills cards without mutating input', () => {
    const input = { item_id: '42', cards: [2], options: [
      { type: 2, value: 1, param: 0 }, { type: 1, value: 5, param: 0 },
    ], price: '100', quantity: '2' };
    const normalized = normalizeItem(input);
    expect(normalized.cards).toEqual([2, 0, 0, 0]);
    expect(normalized.options.map((o) => o.type)).toEqual([1, 2]);
    expect(normalized).not.toHaveProperty('name');
    expect(input.cards).toEqual([2]);
  });

  it('coerces safe integer option fields only', () => {
    expect(normalizeOption({ type: '1', value: 2, param: '3' })).toEqual({ type: 1, value: 2, param: 3 });
    expect(() => normalizeOption({ type: 1.2, value: 2, param: 0 })).toThrow();
  });

  it('preserves repeated identical option tuples as separate occurrences', () => {
    const normalized = normalizeItem({ item_id: 42, price: 100, quantity: 1, options: [
      { type: 2, value: 1, param: 0 },
      { type: 1, value: 5, param: 0 },
      { type: 2, value: 1, param: 0 },
    ] });
    expect(normalized.options).toEqual([
      { type: 1, value: 5, param: 0 },
      { type: 2, value: 1, param: 0 },
      { type: 2, value: 1, param: 0 },
    ]);
  });

  it('preserves identical tuples after sorting without client display text', () => {
    const normalized = normalizeItem({
      item_id: 42,
      price: 10,
      quantity: 1,
      options: [
        { type: 2, value: 4, param: 1 },
        { type: 1, value: 8, param: 0 },
        { type: 2, value: 4, param: 1 },
      ],
    });
    expect(normalized.options).toEqual([
      { type: 1, value: 8, param: 0 },
      { type: 2, value: 4, param: 1 },
      { type: 2, value: 4, param: 1 },
    ]);
  });

  it('normalizes items without a name', () => {
    const normalized = normalizeItem({ item_id: 42, price: 10, quantity: 1 });
    expect(normalized).toEqual({ item_id: 42, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 10, quantity: 1, options: [] });
  });
});
