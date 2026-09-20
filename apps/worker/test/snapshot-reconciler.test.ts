import { describe, expect, it } from 'vitest';
import { createSnapshotReconciler } from '../src/services/snapshot-reconciler';
import type { MarketRepository } from '../src/db/repository';

const batch = (partIndex: number, partCount: number, mode: 'full' | 'delta' = 'full', status = 'accepted') => ({
  id: partIndex + 1,
  sourceId: 's1',
  batchId: `snap/${partIndex}`,
  snapshotId: 'snap',
  partIndex,
  partCount,
  snapshotMode: mode,
  payloadHash: `hash-${partIndex}`,
  status,
  responseJson: null,
});

function repo(parts: ReturnType<typeof batch>[]): MarketRepository {
  return {
    findSourceByApiKeyHash: async () => null,
    getOrCreateVendor: async () => { throw new Error('unused'); },
    getOrCreateShop: async () => { throw new Error('unused'); },
    getOrCreateSession: async () => { throw new Error('unused'); },
    getBatch: async () => null,
    getSnapshotParts: async () => parts,
    insertBatch: async () => { throw new Error('unused'); },
    completeBatch: async () => {},
    loadListingsByFingerprint: async () => [],
    applyListingChanges: async () => ({ updated: 0, conflicts: 0 }),
    markShopHeartbeats: async () => 0,
    finalizeSnapshot: async () => {},
    searchListings: async () => ({ items: [], nextCursor: null }),
    getListingHistory: async () => ({ items: [], nextCursor: null }),
    getOptionDefinitions: async () => ({ version: 'unpublished', items: [] }),
    getCatalogVersion: async () => 'unpublished',
  };
}

describe('snapshot reconciliation', () => {
  it('does not reconcile when a full snapshot part is missing', async () => {
    const calls: unknown[] = [];
    const repository = repo([batch(0, 2)]);
    (repository as any).reconcileSnapshot = async (input: unknown) => { calls.push(input); return { complete: true }; };
    const reconciler = createSnapshotReconciler(repository);

    const result = await reconciler.finalizeSnapshot('s1', 'snap', 1000);

    expect(result.complete).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reconciles only a complete full snapshot and leaves delta omission alone', async () => {
    const calls: any[] = [];
    const repository = repo([batch(0, 1, 'full')]);
    (repository as any).reconcileSnapshot = async (input: unknown) => { calls.push(input); return { complete: true, candidates: 0 }; };
    const reconciler = createSnapshotReconciler(repository);

    const result = await reconciler.finalizeSnapshot('s1', 'snap', 1000);

    expect(result.complete).toBe(true);
    expect(calls[0]).toMatchObject({ sourceId: 's1', snapshotId: 'snap', observedAt: 1000, batchIds: ['snap/0'] });
  });

  it('rejects mixed metadata and non-accepted parts', async () => {
    const repository = repo([batch(0, 2), batch(1, 2, 'delta')]);
    const reconciler = createSnapshotReconciler(repository);

    const result = await reconciler.finalizeSnapshot('s1', 'snap', 1000);

    expect(result.complete).toBe(false);
  });

  it('passes the exact completed snapshot participant sessions to reconciliation', async () => {
    const calls: any[] = [];
    const repository = repo([batch(0, 1)]);
    (repository as any).getSnapshotSessionIds = async () => [11, 12];
    (repository as any).reconcileSnapshot = async (input: unknown) => { calls.push(input); return { complete: true, candidates: 0 }; };
    const result = await createSnapshotReconciler(repository).finalizeSnapshot('s1', 'snap', 1000);
    expect(result.complete).toBe(true);
    expect(calls[0]).toMatchObject({ sessionIds: [11, 12] });
  });

  it('passes snapshot sessions to direct missing-list reconciliation', async () => {
    const calls: any[] = [];
    const repository = repo([batch(0, 1)]);
    (repository as any).getSnapshotSessionIds = async () => [42];
    (repository as any).reconcileSnapshot = async (input: unknown) => { calls.push(input); return { complete: true, candidates: 0 }; };
    await createSnapshotReconciler(repository).reconcileMissingListings('s1', 'snap', 1000);
    expect(calls[0]).toMatchObject({ sessionIds: [42] });
  });
});
