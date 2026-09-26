import type { GuestbookFilters, GuestbookPage, GuestbookSubmissionInput, HistoryPage, ItemMarketHistory, LastroAccountStatusResponse, ListingSearchResult, MarketStatus, OptionDefinition, OptionDefinitionsResponse, SearchFilters, SearchPage } from './types';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiResponse<T> {
  body: T;
  etag?: string;
}

export interface MarketApiClient {
  search(filters: SearchFilters, signal?: AbortSignal): Promise<SearchPage<ListingSearchResult>>;
  getHistory(listingId: number, cursor?: string, signal?: AbortSignal): Promise<HistoryPage>;
  getItemHistory(itemId: number, signal?: AbortSignal): Promise<ItemMarketHistory>;
  getOptions(signal?: AbortSignal): Promise<OptionDefinitionsResponse>;
  getStatus(signal?: AbortSignal): Promise<MarketStatus>;
  searchGuestbook(filters: GuestbookFilters, signal?: AbortSignal): Promise<GuestbookPage>;
  createGuestbookEntry(input: GuestbookSubmissionInput, signal?: AbortSignal): Promise<{ item: GuestbookPage['items'][number] }>;
  getAccountStatus(userid: string, userPass: string, signal?: AbortSignal): Promise<LastroAccountStatusResponse>;
}

export class MarketApi implements MarketApiClient {
  private readonly etags = new Map<string, string>();
  private readonly cached = new Map<string, unknown>();

  async search(filters: SearchFilters, signal?: AbortSignal): Promise<SearchPage<ListingSearchResult>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (key === 'options' && Array.isArray(value)) {
        for (const option of value) params.append('option', `${option.type}:${option.operator}:${option.value}${option.param === undefined ? '' : `:${option.param}`}`);
        continue;
      }
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    return this.request(`/api/v1/market/search?${params.toString()}`, signal);
  }

  async getHistory(listingId: number, cursor?: string, signal?: AbortSignal): Promise<HistoryPage> {
    const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request(`/api/v1/market/listings/${listingId}/history${params}`, signal);
  }

  async getItemHistory(itemId: number, signal?: AbortSignal): Promise<ItemMarketHistory> {
    return this.request(`/api/v1/market/items/${itemId}/history`, signal);
  }

  async getOptions(signal?: AbortSignal): Promise<OptionDefinitionsResponse> {
    const response = await this.requestCached<OptionDefinitionsResponse>('/api/v1/options', signal);
    return mapOptionDefinitions(response.body);
  }

  async getStatus(signal?: AbortSignal): Promise<MarketStatus> {
    return this.request('/api/v1/status', signal);
  }

  async searchGuestbook(filters: GuestbookFilters, signal?: AbortSignal): Promise<GuestbookPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value));
    return this.request(`/api/v1/guestbook?${params.toString()}`, signal);
  }

  async createGuestbookEntry(input: GuestbookSubmissionInput, signal?: AbortSignal): Promise<{ item: GuestbookPage['items'][number] }> {
    const response = await fetch('/api/v1/guestbook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
    return this.readResponse(response);
  }

  async getAccountStatus(userid: string, userPass: string, signal?: AbortSignal): Promise<LastroAccountStatusResponse> {
    const response = await fetch('/api/v1/lastro/account-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userid, user_pass: userPass }),
      ...(signal ? { signal } : {}),
    });
    return this.readResponse(response);
  }

  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, signal ? { signal } : {});
    return this.readResponse(response);
  }

  private async requestCached<T>(path: string, signal?: AbortSignal): Promise<ApiResponse<T>> {
    const headers = new Headers();
    const etag = this.etags.get(path);
    if (etag) headers.set('if-none-match', etag);
    const response = await fetch(path, signal ? { signal, headers } : { headers });
    if (response.status === 304) {
      const cached = this.cached.get(path);
      if (cached !== undefined) return { body: cached as T, ...(etag ? { etag } : {}) };
      throw new ApiError(304, '缓存内容不可用，请重试');
    }
    const body = await this.readResponse<T>(response);
    const nextEtag = response.headers.get('etag');
    if (nextEtag) this.etags.set(path, nextEtag);
    this.cached.set(path, body);
    return { body, ...(nextEtag ? { etag: nextEtag } : {}) };
  }

  private async readResponse<T>(response: Response): Promise<T> {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | T | null;
    if (!response.ok) {
      const message = body && typeof body === 'object' && 'error' in body && body.error?.message ? body.error.message : '请求失败';
      throw new ApiError(response.status, message);
    }
    return body as T;
  }
}

function mapOptionDefinitions(payload: OptionDefinitionsResponse & { options: Array<OptionDefinition | Record<string, unknown>> }): OptionDefinitionsResponse {
  return {
    version: payload.version,
    options: payload.options.map((raw) => {
      if ('labelZh' in raw) return raw as OptionDefinition;
      const data = raw as Record<string, unknown>;
      return {
        type: Number(data.type),
        handle: String(data.handle ?? ''),
        labelZh: String(data.label_zh ?? ''),
        descriptionTemplate: String(data.description_template ?? ''),
        valueKind: data.value_kind === 'scaled_integer' ? 'scaled_integer' : 'integer',
        valuePolicy: data.value_policy === 'flag' ? 'flag' : 'numeric',
        selectable: data.selectable !== false,
        unit: String(data.unit ?? ''),
        scale: Number(data.scale ?? 1),
        allowedOperators: Array.isArray(data.allowed_operators) ? data.allowed_operators.map(String) as OptionDefinition['allowedOperators'] : [],
        paramPolicy: data.param_policy as OptionDefinition['paramPolicy'],
        repeatPolicy: data.repeat_policy === 'distinct' ? 'distinct' : 'same',
        displayTemplate: String(data.display_template ?? ''),
        searchTokens: Array.isArray(data.search_tokens) ? data.search_tokens.map(String) : [],
      };
    }),
  };
}
