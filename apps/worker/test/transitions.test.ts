import { describe, expect, it } from 'vitest';
import { calculateQuantityTransition, makeTransitionKey } from '../src/domain/transitions';

describe('quantity transitions', () => {
  it('reports exact decrease and sold out delta', () => {
    expect(calculateQuantityTransition(5, 2)).toMatchObject({ kind: 'decreased', soldQuantity: 3 });
    expect(calculateQuantityTransition(5, 0)).toMatchObject({ kind: 'sold_out', soldQuantity: 5 });
    expect(calculateQuantityTransition(2, 4)).toMatchObject({ kind: 'increased', soldQuantity: 0 });
  });
  it('rejects negative quantities and creates stable transition keys', async () => {
    expect(() => calculateQuantityTransition(-1, 0)).toThrow();
    expect(await makeTransitionKey(1, 2, 5, 2, 'quantity_decrease')).toBe(await makeTransitionKey(1, 2, 5, 2, 'quantity_decrease'));
  });
});
