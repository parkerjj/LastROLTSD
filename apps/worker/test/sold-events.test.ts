import { describe, expect, it } from 'vitest';
import { buildSoldEvent } from '../src/services/sold-events';
import { calculateQuantityTransition } from '../src/domain/transitions';
import type { ListingRow } from '../src/db/types';

describe('sold events', () => {
  it('does not emit for incomplete baseline and has a stable transition key', async () => {
    const listing = { id: 9, stateVersion: 3, quantity: 4 } as ListingRow;
    const transition = calculateQuantityTransition(4, 1);
    expect(await buildSoldEvent(listing, transition, 'quantity_decrease', 1, false)).toBeNull();
    const event = await buildSoldEvent(listing, transition, 'quantity_decrease', 1, true);
    expect(event?.soldQuantity).toBe(3); expect(event?.transitionKey).toHaveLength(64);
  });
});
