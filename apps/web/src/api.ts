import type { HistoryPage, ListingSearchResult, SearchFilters, SearchPage } from './types';

export class ApiError extends Error { constructor(public readonly status: number, message: string) { super(message); } }
export class MarketApi {
  async search(filters: SearchFilters, signal?: AbortSignal): Promise<SearchPage<ListingSearchResult>> {
    const params = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value));
    return this.request(`/api/v1/market/search?${params.toString()}`, signal);
  }
  async getHistory(listingId: number, cursor?: string, signal?: AbortSignal): Promise<HistoryPage> { const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''; return this.request(`/api/v1/market/listings/${listingId}/history${params}`, signal); }
  private async request<T>(path: string, signal?: AbortSignal): Promise<T> { const response = await fetch(path, signal ? { signal } : {}); const body = await response.json().catch(() => null); if (!response.ok) throw new ApiError(response.status, body?.error?.message ?? 'Request failed'); return body as T; }
}
