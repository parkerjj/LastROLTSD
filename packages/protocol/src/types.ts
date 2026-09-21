export type SnapshotMode = 'full' | 'delta' | 'heartbeat';
export interface ItemOption { type: number; value: number; param: number }
export interface UploadItem {
  item_key?: string; item_id: number; upgrade: number; slots: number;
  cards: number[]; price: number; quantity: number; options: ItemOption[];
}
export interface UploadShop {
  shop_id?: string; uuid: string; shop_status: 'opening' | 'dismissed'; vendor_account_id: string;
  vendor_name: string; title: string; shop_type: 'buy' | 'sell'; map_name: string; x: number; y: number; items: UploadItem[];
}
export interface UploadRequest {
  protocol_version: 2; client_run_id: string; snapshot_id: string; snapshot_mode: SnapshotMode;
  part_index: number; part_count: number; observed_at: string; shops: UploadShop[];
}
export interface SearchFilters {
  q?: string; item_id?: number; item_ids?: number[]; option_type?: number; option_value?: number; option_param?: number;
  catalogVersion?: string; optionVersion?: string; searchIndexVersion?: string;
  options?: Array<{ type: number; operator: string; value: string; param?: number }>;
  option_mode?: 'all' | 'any';
  price_min?: number; price_max?: number; map?: string; shop_type?: 'buy' | 'sell';
  include_stale?: boolean; limit: number; cursor?: string; sort: 'price_asc' | 'price_desc' | 'changed_desc';
}
export interface SearchPage<T> { items: T[]; nextCursor: string | null }
