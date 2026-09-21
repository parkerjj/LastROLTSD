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

export interface SearchOptionFilter {
  type: number;
  operator: OptionOperator;
  value: string;
  param?: number;
}

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
