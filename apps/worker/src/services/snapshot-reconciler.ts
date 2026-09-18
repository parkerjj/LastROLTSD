import type { MarketRepository, ReconciliationResult, SnapshotReconciliationInput } from '../db/repository';
import type { BatchRow } from '../db/types';

export interface SnapshotFinalizeResult extends ReconciliationResult {
  complete: boolean;
}

function completeInput(sourceId: string, snapshotId: string, observedAt: number, parts: BatchRow[]): SnapshotReconciliationInput | null {
  if (parts.length === 0) return null;
  const first = parts[0];
  if (!first || first.snapshotMode !== 'full' || first.status !== 'accepted' || first.partCount !== parts.length) return null;
  const indexes = new Set<number>();
  for (const part of parts) {
    if (part.status !== 'accepted' || part.snapshotMode !== 'full' || part.partCount !== first.partCount || indexes.has(part.partIndex)) return null;
    indexes.add(part.partIndex);
  }
  for (let index = 0; index < first.partCount; index += 1) if (!indexes.has(index)) return null;
  return { sourceId, snapshotId, observedAt, batchIds: parts.map((part) => part.batchId) };
}

const emptyResult = (sourceId: string, snapshotId: string): SnapshotFinalizeResult => ({ sourceId, snapshotId, complete: false, baseline: false, shops: 0, candidates: 0, markedMissing: 0, inferredSold: 0, expired: 0 });

export function createSnapshotReconciler(repo: MarketRepository) {
  async function reconcile(input: SnapshotReconciliationInput): Promise<SnapshotFinalizeResult> {
    if (!repo.reconcileSnapshot) return { ...emptyResult(input.sourceId, input.snapshotId), complete: true };
    return { ...(await repo.reconcileSnapshot(input)), complete: true };
  }

  return {
    async finalizeSnapshot(sourceId: string, snapshotId: string, observedAt: number): Promise<SnapshotFinalizeResult> {
      const parts = await repo.getSnapshotParts(sourceId, snapshotId);
      const input = completeInput(sourceId, snapshotId, observedAt, parts);
      if (!input) return emptyResult(sourceId, snapshotId);
      const result = await reconcile(input);
      await repo.finalizeSnapshot(sourceId, snapshotId, observedAt);
      return result;
    },
    async reconcileMissingListings(sourceId: string, snapshotId: string, observedAt: number): Promise<SnapshotFinalizeResult> {
      const parts = await repo.getSnapshotParts(sourceId, snapshotId);
      const input = completeInput(sourceId, snapshotId, observedAt, parts);
      if (!input) return emptyResult(sourceId, snapshotId);
      return reconcile(input);
    },
  };
}

export type SnapshotReconciler = ReturnType<typeof createSnapshotReconciler>;

export async function finalizeSnapshot(repo: MarketRepository, sourceId: string, snapshotId: string, observedAt: number): Promise<SnapshotFinalizeResult> {
  return createSnapshotReconciler(repo).finalizeSnapshot(sourceId, snapshotId, observedAt);
}

export async function reconcileMissingListings(repo: MarketRepository, sourceId: string, snapshotId: string, observedAt: number): Promise<SnapshotFinalizeResult> {
  return createSnapshotReconciler(repo).reconcileMissingListings(sourceId, snapshotId, observedAt);
}
