import type { ListingSearchResult, SearchFilters, SearchPage } from './types';

export interface SearchApi {
  search(filters: SearchFilters, signal?: AbortSignal): Promise<SearchPage<ListingSearchResult>>;
}

export interface SearchControllerState {
  filters: SearchFilters;
  loading: boolean;
  error: string | null;
  empty: boolean;
  cursor: string | null;
  page: SearchPage<ListingSearchResult> | null;
}

export class SearchController {
  private requestId = 0;
  private controller: AbortController | undefined;
  private state: SearchControllerState = {
    filters: { limit: 20, sort: 'price_asc' },
    loading: false,
    error: null,
    empty: false,
    cursor: null,
    page: null,
  };

  constructor(private readonly api: SearchApi) {}

  getState(): SearchControllerState {
    return this.state;
  }

  async search(filters: SearchFilters): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const requestId = ++this.requestId;
    this.state = { ...this.state, filters, loading: true, error: null, empty: false, cursor: filters.cursor ?? null };
    try {
      const page = await this.api.search(filters, controller.signal);
      if (requestId !== this.requestId) return;
      this.state = { ...this.state, loading: false, page, empty: page.items.length === 0, cursor: page.nextCursor };
    } catch (error) {
      if (controller.signal.aborted || requestId !== this.requestId) return;
      this.state = { ...this.state, loading: false, error: error instanceof Error ? error.message : '查询失败', page: null };
    }
  }

  async nextPage(): Promise<void> {
    if (!this.state.cursor || this.state.loading) return;
    await this.search({ ...this.state.filters, cursor: this.state.cursor });
  }
}
