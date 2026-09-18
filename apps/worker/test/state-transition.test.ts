import { describe, expect, it } from 'vitest';
import { applyListingObservation } from '../src/services/state-transition';
import type { ListingRow } from '../src/db/types';

const listing: ListingRow = { id: 1, shopSessionId: 1, itemFingerprint: 'fp', itemKey: null, itemId: 1, itemName: 'Item', itemNameNormalized: 'item', upgrade: 0, slots: 0, cards: [0,0,0,0], price: 10, quantity: 5, lastQuantity: 5, status: 'active', stateVersion: 2, missingStreak: 0, lastSeenAt: 1 };
const repo = () => ({ applyListingChanges: async () => ({ updated: 1, conflicts: 0 }), insertHistory: async () => {}, insertSoldEvent: async () => true }) as any;

describe('listing state transition', () => {
  it('writes price-only and quantity changes with one version update', async () => {
    const result = await applyListingObservation({ listing, item: { item_id: 1, name: 'Item', upgrade: 0, slots: 0, cards: [], price: 12, quantity: 5, options: [] }, observedAt: 2, batchId: 'b', baselineComplete: true }, repo());
    expect(result.updated).toBe(true); expect(result.historyWritten).toBe(true); expect(result.soldEvent).toBeNull();
  });
  it('emits one sold candidate for a quantity decrease only after baseline', async () => {
    const result = await applyListingObservation({ listing, item: { item_id: 1, name: 'Item', upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] }, observedAt: 2, batchId: 'b', baselineComplete: true }, repo());
    expect(result.soldEvent?.soldQuantity).toBe(3);
    const baseline = await applyListingObservation({ listing, item: { item_id: 1, name: 'Item', upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] }, observedAt: 2, batchId: 'b', baselineComplete: false }, repo());
    expect(baseline.soldEvent).toBeNull();
  });
});
