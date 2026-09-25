export type OptionOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
export type OptionValueKind = 'integer' | 'scaled_integer';
export type OptionRepeatPolicy = 'same' | 'distinct';

export type OptionParamPolicy =
  | { mode: 'ignored'; filterable: false }
  | { mode: 'required_exact'; filterable: true; value?: number }
  | { mode: 'optional_exact'; filterable: true; value?: number };

export interface OptionDefinition {
  type: number;
  handle: string;
  labelZh: string;
  descriptionTemplate: string;
  valueKind: OptionValueKind;
  unit: string;
  scale: number;
  allowedOperators: OptionOperator[];
  paramPolicy: OptionParamPolicy;
  repeatPolicy: OptionRepeatPolicy;
  displayTemplate: string;
  searchTokens: string[];
}

export interface OptionDefinitionsResponse {
  version: string;
  options: OptionDefinition[];
}

export interface ItemAutocomplete {
  itemId: number;
  name: string;
  aliases: string[];
}

export interface ItemAutocompletePage {
  version: string;
  items: ItemAutocomplete[];
}

export interface ItemDescription {
  itemId: number;
  description: string;
}

export interface ItemDescriptionPage {
  version: string;
  descriptions: ItemDescription[];
}

export interface SearchOptionFilter {
  type: number;
  operator: OptionOperator;
  value: string;
  param?: number;
}

export type SearchScopeKey = 'name' | 'shop' | 'vendor';
export type SearchScopes = Record<SearchScopeKey, boolean>;

export interface SearchFilters {
  q?: string;
  item_id?: number;
  item_ids?: number[];
  price_min?: number;
  price_max?: number;
  map?: string;
  shop_type?: 'buy' | 'sell';
  options?: SearchOptionFilter[];
  option_mode?: 'all' | 'any';
  limit: number;
  cursor?: string;
  sort: 'price_asc' | 'price_desc' | 'changed_desc';
}

export interface ListingSearchOption {
  type: number;
  value: number;
  param: number;
  display: string;
}

export interface ListingSearchResult {
  id: number;
  itemId: number;
  itemName?: string;
  price: number;
  quantity: number;
  mapName: string;
  vendorName: string;
  title: string;
  options: ListingSearchOption[];
  lastChangedAt: number;
  description?: string;
  x?: number;
  y?: number;
  itemIcon?: string;
}

export interface SearchPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface HistoryPage {
  items: Array<{ id: number; observedAt: number; price: number; quantity: number; eventType: string }>;
  inferredSales?: Array<{ observedAt: number; soldQuantity: number; fromQuantity: number; toQuantity: number; reason: string }>;
  nextCursor: string | null;
}

export interface ItemMarketHistory {
  itemId: number;
  windowStart: number;
  windowEnd: number;
  currentListings: Array<{ listingId: number; price: number; quantity: number; vendorName: string; title: string; mapName: string; lastChangedAt: number }>;
  sales: Array<{ listingId: number; observedAt: number; price: number; soldQuantity: number; vendorName: string; title: string }>;
  events: Array<{ listingId: number; observedAt: number; price: number; quantity: number; eventType: string }>;
}

export interface MarketStatus {
  latestUpdatedAt: number | null;
}

export type GuestbookCategory = 'buy' | 'sell' | 'suggestion';
export interface GuestbookEntry {
  id: number;
  category: GuestbookCategory;
  itemId: number | null;
  isZeny: boolean;
  contact: string | null;
  content: string;
  createdAt: number;
  expiresAt: number | null;
  isExpired: boolean;
}
export interface GuestbookFilters {
  category?: GuestbookCategory;
  itemId?: number;
  q?: string;
  limit: number;
  cursor?: string;
}
export interface GuestbookSubmissionInput {
  category: GuestbookCategory;
  itemId?: number;
  isZeny?: boolean;
  contact?: string;
  content: string;
  duration?: '1d' | '3d' | '7d' | 'permanent';
}
export interface GuestbookPage {
  items: GuestbookEntry[];
  nextCursor: string | null;
}

export type LastroAccountState = 'online' | 'offline' | 'auth_failed';
export interface LastroAccountData {
  updatetime?: string;
  inminute?: string;
  name?: string;
  class?: number | string;
  base_level?: number | string;
  job_level?: number | string;
  hp?: number | string;
  max_hp?: number | string;
  sp?: number | string;
  max_sp?: number | string;
  last_map?: string;
  autoattack?: number | string;
  autoloot?: number | string;
  base_exp?: number | string;
  nextbaseexp?: number | string;
  weight?: number | string;
  maxweight?: number | string;
  job_exp?: number | string;
  nextjobexp?: number | string;
  changebexp?: number | string;
  changejexp?: number | string;
  changelv?: number | string;
  changejoblv?: number | string;
}
export interface LastroAccountStatusResponse {
  state: LastroAccountState;
  data?: LastroAccountData;
}
