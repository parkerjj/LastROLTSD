import type { SearchFilters, UploadItem } from '@lastroweb/protocol';
import type { BatchRow, HistoryRow, ListingChange, ListingRow, ListingSearchRow, OptionDictionaryRow, SessionInput, ShopRow, ShopSessionRow, SourceRow, VendorInput, VendorRow, ShopInput } from './types';

export interface MarketRepository {
  findSourceByApiKeyHash(hash: string): Promise<SourceRow | null>;
  getOrCreateVendor(sourceId: string, input: VendorInput): Promise<VendorRow>;
  getOrCreateShop(sourceId: string, input: ShopInput): Promise<ShopRow>;
  getOrCreateSession(input: SessionInput): Promise<ShopSessionRow>;
  getBatch(sourceId: string, batchId: string): Promise<BatchRow | null>;
  getSnapshotParts(sourceId: string, snapshotId: string): Promise<BatchRow[]>;
  insertBatch(input: Omit<BatchRow, 'id' | 'status'> & { status?: string; receivedAt: number }): Promise<BatchRow>;
  completeBatch(sourceId: string, batchId: string, response: UploadResultLike): Promise<void>;
  loadListingsByFingerprint(sessionId: number, fingerprints: string[]): Promise<ListingRow[]>;
  applyListingChanges(changes: ListingChange[]): Promise<{ updated: number; conflicts: number }>;
  markShopHeartbeats(sourceId: string, shopKeys: string[], observedAt: number): Promise<number>;
  finalizeSnapshot(sourceId: string, snapshotId: string, observedAt: number): Promise<void>;
  searchListings(filters: SearchFilters): Promise<{ items: ListingSearchRow[]; nextCursor: string | null }>;
  getListingHistory(listingId: number, limit: number, cursor?: string): Promise<{ items: HistoryRow[]; nextCursor: string | null }>;
  getOptionDictionary(version?: string): Promise<OptionDictionaryRow[]>;
}

export interface UploadResultLike { accepted: boolean; batchId: string; duplicate: boolean; processedShops: number; processedListings: number; changedListings: number; soldEvents: number; next: string | null; }

export function assertBatchBounds(statementCount: number, boundValues: number): void {
  if (statementCount > 45) throw new Error('D1 batch statement limit exceeded');
  if (boundValues > 100) throw new Error('D1 bound parameter limit exceeded');
}

export function normalizeEpoch(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type { UploadItem };
