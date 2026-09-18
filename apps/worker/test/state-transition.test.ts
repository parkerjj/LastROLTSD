import { describe, expect, it } from 'vitest';
import { applyListingObservation, createListingStateService } from '../src/services/state-transition';
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

  it('uses one bounded transition operation for update, history, and sold event', async () => {
    const transitions: unknown[] = [];
    const repository = { applyListingTransitions: async (changes: unknown[]) => { transitions.push(changes); return { updated: changes.length, conflicts: 0, soldEvents: 1 }; } } as any;
    const result = await applyListingObservation({ listing, item: { item_id: 1, name: 'Item', upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] }, observedAt: 2, batchId: 'b', baselineComplete: true }, repository);
    expect(result.updated).toBe(true);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toHaveLength(1);
  });

  it('reloads and retries one optimistic conflict', async () => {
    let attempts = 0;
    const refreshed = { ...listing, quantity: 4, stateVersion: 3 };
    const repository = {
      applyListingTransitions: async () => { attempts += 1; return attempts === 1 ? { updated: 0, conflicts: 1, soldEvents: 0 } : { updated: 1, conflicts: 0, soldEvents: 1 }; },
      loadListingById: async () => refreshed,
    } as any;
    const result = await applyListingObservation({ listing, item: { item_id: 1, name: 'Item', upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] }, observedAt: 2, batchId: 'b', baselineComplete: true }, repository);
    expect(attempts).toBe(2);
    expect(result.conflict).toBe(false);
    expect(result.soldEvent?.soldQuantity).toBe(2);
  });

  it('persists normalized option tuples when creating a listing', async () => {
    const optionCalls: unknown[] = [];
    const repository = {
      loadListingsByFingerprint: async () => [],
      createListing: async () => ({ ...listing, id: 7 }),
      insertListingOptions: async (input: unknown) => { optionCalls.push(input); },
    } as any;
    const service = createListingStateService(repository);
    await service.applyBatchObservations({ id: 's1' } as any, { id: 1, initialSyncComplete: false } as any, [{ fingerprint: 'fp', sessionId: 1, shopKey: 'shop', item: { item_id: 1, name: 'Item', upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [{ type: 2, value: 4, param: 1 }] } }], 'b', 2);
    expect(optionCalls).toHaveLength(1);
    expect(optionCalls[0]).toMatchObject({ listingId: 7, options: [{ type: 2, value: 4, param: 1 }] });
  });
});
