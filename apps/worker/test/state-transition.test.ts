import { describe, expect, it } from 'vitest';
import { applyListingObservation, createListingStateService } from '../src/services/state-transition';
import type { ListingRow } from '../src/db/types';

const listing: ListingRow = { id: 1, shopSessionId: 1, itemFingerprint: 'fp', itemKey: null, itemId: 1, upgrade: 0, slots: 0, cards: [0,0,0,0], price: 10, quantity: 5, lastQuantity: 5, status: 'active', stateVersion: 2, missingStreak: 0, lastSeenAt: 1 };
const repo = () => ({ applyListingChanges: async () => ({ updated: 1, conflicts: 0 }), insertHistory: async () => {}, insertSoldEvent: async () => true }) as any;

describe('listing state transition', () => {
  it('writes price-only and quantity changes with one version update', async () => {
    const result = await applyListingObservation({ listing, item: { item_id: 1, upgrade: 0, slots: 0, cards: [], price: 12, quantity: 5, options: [] }, observedAt: 2, batchId: 'b', baselineComplete: true }, repo());
    expect(result.updated).toBe(true); expect(result.historyWritten).toBe(true); expect(result.soldEvent).toBeNull();
  });
  it('emits one sold candidate for a quantity decrease only after baseline', async () => {
    const result = await applyListingObservation({ listing, item: { item_id: 1, upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] }, observedAt: 2, batchId: 'b', baselineComplete: true }, repo());
    expect(result.soldEvent?.soldQuantity).toBe(3);
    const baseline = await applyListingObservation({ listing, item: { item_id: 1, upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] }, observedAt: 2, batchId: 'b', baselineComplete: false }, repo());
    expect(baseline.soldEvent).toBeNull();
  });

  it('uses one bounded transition operation for update, history, and sold event', async () => {
    const transitions: unknown[] = [];
    const repository = { applyListingTransitions: async (changes: unknown[]) => { transitions.push(changes); return { updated: changes.length, conflicts: 0, soldEvents: 1 }; } } as any;
    const result = await applyListingObservation({ listing, item: { item_id: 1, upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] }, observedAt: 2, batchId: 'b', baselineComplete: true }, repository);
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
    const result = await applyListingObservation({ listing, item: { item_id: 1, upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] }, observedAt: 2, batchId: 'b', baselineComplete: true }, repository);
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
    await service.applyBatchObservations({ id: 's1' } as any, { id: 1, initialSyncComplete: false } as any, [{ fingerprint: 'fp', sessionId: 1, shopId: 'shop', item: { item_id: 1, upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [{ type: 2, value: 4, param: 1 }] } }], 'b', 2);
    expect(optionCalls).toHaveLength(1);
    expect(optionCalls[0]).toMatchObject({ listingId: 7, options: [{ type: 2, value: 4, param: 1 }] });
  });

  it('chunks fingerprint lookups and uses bounded bulk listing writes', async () => {
    const lookupSizes: number[] = [];
    const bulkCalls: unknown[] = [];
    const observations = Array.from({ length: 41 }, (_, index) => ({
      fingerprint: `fp-${index}`, sessionId: 1, shopId: 'shop',
      item: { item_id: index + 1, upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] },
    }));
    const repository = {
      loadListingsByFingerprint: async (_sessionId: number, fingerprints: string[]) => { lookupSizes.push(fingerprints.length); return []; },
      createListingsBatch: async (inputs: unknown[]) => { bulkCalls.push(inputs); return inputs.map((_, index) => ({ ...listing, id: index + 1 })); },
      insertHistoriesBatch: async () => {},
      insertListingOptionsBatch: async () => {},
    } as any;
    await createListingStateService(repository).applyBatchObservations({ id: 's1' } as any, { id: 1, initialSyncComplete: false } as any, observations, 'b', 2);
    expect(lookupSizes).toEqual([40, 1]);
    expect((bulkCalls as unknown[][]).map((call) => call.length)).toEqual([20, 20, 1]);
  });

  it('surfaces a 409-compatible error when the optimistic retry also conflicts', async () => {
    const repository = {
      loadListingsByFingerprint: async () => [listing],
      loadListingById: async () => ({ ...listing, stateVersion: 3, quantity: 4 }),
      applyListingTransitions: async () => ({ updated: 0, conflicts: 1, soldEvents: 0, conflictIds: [1] }),
    } as any;
    await expect(createListingStateService(repository).applyBatchObservations(
      { id: 's1' } as any,
      { id: 1, initialSyncComplete: true } as any,
      [{ fingerprint: 'fp', sessionId: 1, shopId: 'shop', item: { item_id: 1, upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] } }],
      'b', 2,
    )).rejects.toMatchObject({ status: 409 });
  });

  it('uses one bulk lookup and insert pass across sessions', async () => {
    const observations = [
      { fingerprint: 'a', sessionId: 1, item: { item_id: 1, upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] } },
      { fingerprint: 'b', sessionId: 2, item: { item_id: 2, upgrade: 0, slots: 0, cards: [], price: 20, quantity: 1, options: [{ type: 2, value: 3, param: 0 }] } },
    ];
    const calls: string[] = [];
    const repository = {
      loadListingsByObservations: async (input: unknown[]) => { calls.push('load:' + input.length); return []; },
      insertNewListingsBulk: async (input: unknown[]) => { calls.push('insert:' + input.length); },
    } as any;
    const sessions = new Map([[1, { id: 1, initialSyncComplete: false }], [2, { id: 2, initialSyncComplete: true }]]);
    const result = await createListingStateService(repository).applyBatchObservationsBulk!({ id: 's1' } as any, sessions as any, observations as any, 'b', 2);
    expect(result.processedListings).toBe(2);
    expect(calls).toEqual(['load:2', 'insert:2']);
  });

  it('reloads and retries a bulk optimistic conflict once', async () => {
    const existing = { ...listing, shopSessionId: 1, itemFingerprint: 'a', quantity: 5, stateVersion: 2 };
    let attempts = 0;
    const repository = {
      loadListingsByObservations: async () => [existing],
      insertNewListingsBulk: async () => {},
      applyListingTransitionsBulk: async () => { attempts += 1; return attempts === 1 ? { updated: 0, conflicts: 1, soldEvents: 0, conflictIds: [1] } : { updated: 1, conflicts: 0, soldEvents: 1, conflictIds: [] }; },
      loadListingById: async () => ({ ...existing, quantity: 4, stateVersion: 3 }),
    } as any;
    const sessions = new Map([[1, { id: 1, initialSyncComplete: true }]]);
    const result = await createListingStateService(repository).applyBatchObservationsBulk!({ id: 's1' } as any, sessions as any, [{ fingerprint: 'a', sessionId: 1, item: { item_id: 1, upgrade: 0, slots: 0, cards: [], price: 10, quantity: 2, options: [] } }] as any, 'b', 2);
    expect(attempts).toBe(2);
    expect(result.changedListings).toBe(1);
  });

  it('does not drop existing changes when bulk transition support is unavailable', async () => {
    const existing = { ...listing, shopSessionId: 1, itemFingerprint: 'a', quantity: 5, stateVersion: 2 };
    const transitions: unknown[] = [];
    const repository = {
      loadListingsByObservations: async () => [existing],
      insertNewListingsBulk: async () => {},
      applyListingTransitions: async (changes: unknown[]) => { transitions.push(changes); return { updated: 1, conflicts: 0, soldEvents: 0, conflictIds: [] }; },
    } as any;
    const sessions = new Map([[1, { id: 1, initialSyncComplete: true }]]);
    const result = await createListingStateService(repository).applyBatchObservationsBulk!({ id: 's1' } as any, sessions as any, [{ fingerprint: 'a', sessionId: 1, item: { item_id: 1, upgrade: 0, slots: 0, cards: [], price: 11, quantity: 5, options: [] } }] as any, 'b', 2);
    expect(result.changedListings).toBe(1);
    expect(transitions).toHaveLength(1);
  });
});
