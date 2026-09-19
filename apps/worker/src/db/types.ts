export interface SourceRow { id: string; name: string; apiKeyHash: string; status: 'active' | 'disabled'; }
export interface VendorInput { vendorKey: string; name: string; mapName: string; x: number; y: number; updatedAt: number; }
export interface VendorRow extends VendorInput { id: number; sourceId: string; }
export interface ShopInput { shopKey: string; vendorId: number; title: string; shopType: 'buy' | 'sell'; mapName: string; x: number; y: number; lastSeenAt: number; updatedAt: number; }
export interface ShopRow extends ShopInput { id: number; sourceId: string; status: 'active' | 'stale' | 'closed'; closedAt: number | null; }
export interface SessionInput { shopId: number; clientRunId: string; observedAt: number; }
export interface ShopSessionRow { id: number; shopId: number; clientRunId: string; startedAt: number; lastSeenAt: number; endedAt: number | null; initialSyncComplete: boolean; lastCompleteSnapshotId: string | null; }
export interface BatchRow { id: number; sourceId: string; batchId: string; snapshotId: string; partIndex: number; partCount: number; snapshotMode: 'full' | 'delta' | 'heartbeat'; payloadHash: string; status: string; responseJson: string | null; }
export interface ListingRow { id: number; shopSessionId: number; itemFingerprint: string; itemKey: string | null; itemId: number; itemName: string; itemNameNormalized: string; upgrade: number; slots: number; cards: number[]; price: number; quantity: number; lastQuantity: number; status: string; stateVersion: number; missingStreak: number; lastSeenAt: number; }
export interface ListingChange { listingId: number; expectedVersion: number; price: number; quantity: number; status: string; observedAt: number; batchId: string; }
export interface ListingSearchRow extends ListingRow { shopKey: string; title: string; vendorName: string; mapName: string; shopType: 'buy' | 'sell'; options: ListingOption[]; }
export interface HistoryRow { id: number; listingId: number; observedAt: number; price: number; quantity: number; eventType: string; batchId: string; }
export interface InferredSaleRow { observedAt: number; soldQuantity: number; fromQuantity: number; toQuantity: number; reason: string; }
export interface OptionDictionaryRow { version: string; optionType: number; optionValue: number; optionParam: number; name: string; description: string; searchTokens: string; }
export interface ListingOption {
  type: number;
  value: number;
  param: number;
  displayValue?: string;
}

export interface CatalogItemRow {
  itemId: number;
  name: string;
  aliases: string[];
}
