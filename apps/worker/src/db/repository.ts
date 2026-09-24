import type { SearchFilters, UploadItem, UploadShop } from '@lastroweb/protocol';
import type { OptionDefinition } from '../domain/option-conditions';
import type { BatchRow, CatalogItemRow, HistoryRow, InferredSaleRow, ListingChange, ListingOption, ListingRow, ListingSearchRow, SessionInput, ShopRow, ShopSessionRow, SourceRow, VendorInput, VendorRow, ShopInput } from './types';

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
  profileHashes?: string[];
}

export interface ShopSessionContextInput {
  sourceId: string;
  identityHash: string;
  shopId: string;
  shopStatus: UploadShop['shop_status'];
  batchId: string;
  vendorAccountId: string;
  clientRunId: string;
  observedAt: number;
  vendorName: string;
  title: string;
  shopType: 'buy' | 'sell';
  mapName: string;
  x: number;
  y: number;
  profileHash?: string;
  fullStateHash?: string;
}

export interface ShopResolution {
  internalShopId: number;
  shopId: string;
  identityHash: string;
  resolution: 'created' | 'matched' | 'dismissed' | 'stale_event_ignored';
  status: 'opening' | 'dismissed';
  applied: boolean;
  session: ShopSessionRow | null;
  readListings?: boolean;
}

export interface MarketRepository {
  getLatestMarketUpdateAt?(): Promise<number | null>;
  findSourceByApiKeyHash(hash: string): Promise<SourceRow | null>;
  getOrCreateVendor(sourceId: string, input: VendorInput): Promise<VendorRow>;
  getOrCreateShop(sourceId: string, input: ShopInput): Promise<ShopRow>;
  getOrCreateSession(input: SessionInput): Promise<ShopSessionRow>;
  getOrCreateSessions?(inputs: ShopSessionContextInput[]): Promise<ShopSessionRow[]>;
  resolveShopObservation?(input: ShopSessionContextInput): Promise<ShopResolution>;
  resolveShopObservations?(inputs: ShopSessionContextInput[]): Promise<ShopResolution[]>;
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
  createListing?(input: { sessionId: number; fingerprint: string; itemKey?: string; itemId: number; upgrade: number; slots: number; cards: number[]; price: number; quantity: number; observedAt: number; batchId: string }): Promise<ListingRow>;
  createListingsBatch?(inputs: Array<{ sessionId: number; fingerprint: string; itemKey?: string; itemId: number; upgrade: number; slots: number; cards: number[]; price: number; quantity: number; observedAt: number; batchId: string }>): Promise<ListingRow[]>;
  createListingsBundleBatch?(inputs: Array<{ sessionId: number; fingerprint: string; itemKey?: string; itemId: number; upgrade: number; slots: number; cards: number[]; price: number; quantity: number; observedAt: number; batchId: string; options: ListingOption[] }>): Promise<ListingRow[]>;
  insertNewListingsBulk?(inputs: Array<{ sessionId: number; fingerprint: string; itemKey?: string; itemId: number; upgrade: number; slots: number; cards: number[]; price: number; quantity: number; observedAt: number; batchId: string; options: ListingOption[] }>): Promise<void>;
  insertHistory?(input: { listingId: number; observedAt: number; price: number; quantity: number; eventType: string; batchId: string }): Promise<void>;
  insertHistoriesBatch?(inputs: Array<{ listingId: number; observedAt: number; price: number; quantity: number; eventType: string; batchId: string }>): Promise<void>;
  insertListingOptionsBatch?(inputs: Array<{ listingId: number; options: ListingOption[] }>): Promise<void>;
  insertSoldEvent?(input: { listingId: number; soldQuantity: number; fromQuantity: number; toQuantity: number; reason: string; observedAt: number; transitionKey: string; snapshotId?: string; price?: number }): Promise<boolean>;
  applyListingChanges(changes: ListingChange[]): Promise<{ updated: number; conflicts: number }>;
  applyListingTransitionsBulk?(changes: ListingTransitionChange[]): Promise<{ updated: number; conflicts: number; soldEvents: number; conflictIds?: number[] }>;
  markListingsObservedBulk?(observations: Array<{ sessionId: number; fingerprint: string }>, batchId: string, observedAt: number): Promise<number>;
  markShopHeartbeats?(sourceId: string, identityHashes: string[], observedAt: number): Promise<number>;
  getUninitializedShopKeys?(sourceId: string, identityHashes: string[]): Promise<string[]>;
  finalizeSnapshot(sourceId: string, snapshotId: string, observedAt: number): Promise<void>;
  recordSnapshotSessions?(sourceId: string, snapshotId: string, sessionIds: number[], observedAt: number): Promise<void>;
  getSnapshotSessionIds?(sourceId: string, snapshotId: string): Promise<number[]>;
  recordSnapshotProfileHashes?(sourceId: string, snapshotId: string, profileHashes: string[], observedAt: number): Promise<void>;
  getSnapshotProfileHashes?(sourceId: string, snapshotId: string): Promise<string[]>;
  updateShopFullStateHashes?(updates: Array<{ shopId: number; fullStateHash: string }>, observedAt: number): Promise<void>;
  reconcileSnapshot?(input: SnapshotReconciliationInput): Promise<ReconciliationResult>;
  searchListings(filters: SearchFilters): Promise<{ items: ListingSearchRow[]; nextCursor: string | null }>;
  getListingHistory(listingId: number, limit: number, cursor?: string): Promise<{ items: HistoryRow[]; inferredSales?: InferredSaleRow[]; nextCursor: string | null } | null>;
  getItemMarketHistory?(itemId: number, windowStart: number, windowEnd: number): Promise<ItemMarketHistory | null>;
  getOptionDefinitions(version?: string): Promise<{ version: string; items: OptionDefinition[] }>;
  getCatalogVersion(): Promise<string>;
  searchItems(query: string, limit: number): Promise<CatalogItemRow[]>;
  deleteExpiredHistory?(before: number, limit: number): Promise<number>;
  deleteExpiredSoldEvents?(before: number, limit: number): Promise<number>;
  countExpiredHistory?(before: number, limit: number): Promise<number>;
  countExpiredSoldEvents?(before: number, limit: number): Promise<number>;
  deleteGuestbookRateBuckets?(before: number, limit: number): Promise<number>;
}

export interface ItemMarketHistory {
  itemId: number;
  windowStart: number;
  windowEnd: number;
  currentListings: Array<{ listingId: number; price: number; quantity: number; vendorName: string; title: string; mapName: string; lastChangedAt: number }>;
  sales: Array<{ listingId: number; observedAt: number; price: number; soldQuantity: number; vendorName: string; title: string }>;
  events: Array<{ listingId: number; observedAt: number; price: number; quantity: number; eventType: string }>;
}

export interface UploadShopResult { uuid: string; shop_id: string; shop_status: 'opening' | 'dismissed'; applied: boolean; resolution: 'created' | 'matched' | 'dismissed' | 'stale_event_ignored' | 'pending'; }
export interface UploadResultLike { accepted: boolean; batch_id: string; duplicate: boolean; processed_shops: number; processed_listings: number; changed_listings: number; sold_events: number; shops: UploadShopResult[]; next: string | null; reconciliation?: { status: 'pending' | 'complete' | 'failed'; snapshot_id: string; stage?: string }; }

export function normalizeEpoch(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type { UploadItem };
