import type { SearchFilters, UploadItem } from '@lastroweb/protocol';
import type { BatchRow, HistoryRow, InferredSaleRow, ListingChange, ListingOption, ListingRow, ListingSearchRow, OptionDictionaryRow, SessionInput, ShopRow, ShopSessionRow, SourceRow, VendorInput, VendorRow, ShopInput } from './types';

export interface ListingTransitionChange {
  listingId: number;
  shopSessionId: number;
  expectedVersion: number;
  price: number;
  quantity: number;
  status: string;
  observedAt: number;
  batchId: string;
  history?: { eventType: string };
  soldEvent?: { soldQuantity: number; fromQuantity: number; toQuantity: number; reason: string; transitionKey: string };
}

export interface ReconciliationResult {
  sourceId: string;
  snapshotId: string;
  complete: boolean;
  baseline: boolean;
  shops: number;
  candidates: number;
  markedMissing: number;
  inferredSold: number;
  expired: number;
}

export interface SnapshotReconciliationInput {
  sourceId: string;
  snapshotId: string;
  observedAt: number;
  batchIds: string[];
  sessionIds?: number[];
}

export interface ShopSessionContextInput {
  sourceId: string;
  shopKey: string;
  clientRunId: string;
  observedAt: number;
  vendorKey: string;
  vendorName: string;
  title: string;
  shopType: 'buy' | 'sell';
  mapName: string;
  x: number;
  y: number;
}

export interface MarketRepository {
  findSourceByApiKeyHash(hash: string): Promise<SourceRow | null>;
  getOrCreateVendor(sourceId: string, input: VendorInput): Promise<VendorRow>;
  getOrCreateShop(sourceId: string, input: ShopInput): Promise<ShopRow>;
  getOrCreateSession(input: SessionInput): Promise<ShopSessionRow>;
  getOrCreateSessions?(inputs: ShopSessionContextInput[]): Promise<ShopSessionRow[]>;
  getBatch(sourceId: string, batchId: string): Promise<BatchRow | null>;
  getSnapshotParts(sourceId: string, snapshotId: string): Promise<BatchRow[]>;
  insertBatch(input: Omit<BatchRow, 'id' | 'status'> & { status?: string; receivedAt: number }): Promise<BatchRow & { inserted?: boolean }>;
  retryBatch?(sourceId: string, batchId: string): Promise<boolean>;
  failBatch?(sourceId: string, batchId: string): Promise<void>;
  completeBatch(sourceId: string, batchId: string, response: UploadResultLike): Promise<void>;
  loadListingsByFingerprint(sessionId: number, fingerprints: string[]): Promise<ListingRow[]>;
  loadListingsByObservations?(observations: Array<{ sessionId: number; fingerprint: string }>): Promise<ListingRow[]>;
  loadListingById?(listingId: number, sessionId?: number): Promise<ListingRow | null>;
  applyListingTransitions?(changes: ListingTransitionChange[]): Promise<{ updated: number; conflicts: number; soldEvents: number; conflictIds?: number[] }>;
  insertListingOptions?(input: { listingId: number; options: ListingOption[] }): Promise<void>;
  markListingsObserved?(sessionId: number, fingerprints: string[], batchId: string, observedAt: number): Promise<number>;
  createListing?(input: { sessionId: number; fingerprint: string; itemKey?: string; itemId: number; itemName: string; itemNameNormalized: string; upgrade: number; slots: number; cards: number[]; price: number; quantity: number; observedAt: number; batchId: string }): Promise<ListingRow>;
  createListingsBatch?(inputs: Array<{ sessionId: number; fingerprint: string; itemKey?: string; itemId: number; itemName: string; itemNameNormalized: string; upgrade: number; slots: number; cards: number[]; price: number; quantity: number; observedAt: number; batchId: string }>): Promise<ListingRow[]>;
  createListingsBundleBatch?(inputs: Array<{ sessionId: number; fingerprint: string; itemKey?: string; itemId: number; itemName: string; itemNameNormalized: string; upgrade: number; slots: number; cards: number[]; price: number; quantity: number; observedAt: number; batchId: string; options: ListingOption[] }>): Promise<ListingRow[]>;
  insertNewListingsBulk?(inputs: Array<{ sessionId: number; fingerprint: string; itemKey?: string; itemId: number; itemName: string; itemNameNormalized: string; upgrade: number; slots: number; cards: number[]; price: number; quantity: number; observedAt: number; batchId: string; options: ListingOption[] }>): Promise<void>;
  insertHistory?(input: { listingId: number; observedAt: number; price: number; quantity: number; eventType: string; batchId: string }): Promise<void>;
  insertHistoriesBatch?(inputs: Array<{ listingId: number; observedAt: number; price: number; quantity: number; eventType: string; batchId: string }>): Promise<void>;
  insertListingOptionsBatch?(inputs: Array<{ listingId: number; options: ListingOption[] }>): Promise<void>;
  insertSoldEvent?(input: { listingId: number; soldQuantity: number; fromQuantity: number; toQuantity: number; reason: string; observedAt: number; transitionKey: string }): Promise<boolean>;
  applyListingChanges(changes: ListingChange[]): Promise<{ updated: number; conflicts: number }>;
  applyListingTransitionsBulk?(changes: ListingTransitionChange[]): Promise<{ updated: number; conflicts: number; soldEvents: number; conflictIds?: number[] }>;
  markListingsObservedBulk?(observations: Array<{ sessionId: number; fingerprint: string }>, batchId: string, observedAt: number): Promise<number>;
  markShopHeartbeats(sourceId: string, shopKeys: string[], observedAt: number): Promise<number>;
  getUninitializedShopKeys?(sourceId: string, shopKeys: string[]): Promise<string[]>;
  finalizeSnapshot(sourceId: string, snapshotId: string, observedAt: number): Promise<void>;
  recordSnapshotSessions?(sourceId: string, snapshotId: string, sessionIds: number[], observedAt: number): Promise<void>;
  getSnapshotSessionIds?(sourceId: string, snapshotId: string): Promise<number[]>;
  reconcileSnapshot?(input: SnapshotReconciliationInput): Promise<ReconciliationResult>;
  searchListings(filters: SearchFilters): Promise<{ items: ListingSearchRow[]; nextCursor: string | null }>;
  getListingHistory(listingId: number, limit: number, cursor?: string): Promise<{ items: HistoryRow[]; inferredSales?: InferredSaleRow[]; nextCursor: string | null } | null>;
  getOptionDictionary(version?: string): Promise<OptionDictionaryRow[]>;
  deleteExpiredHistory?(before: number, limit: number): Promise<number>;
  deleteExpiredSoldEvents?(before: number, limit: number): Promise<number>;
  countExpiredHistory?(before: number): Promise<number>;
  countExpiredSoldEvents?(before: number): Promise<number>;
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
