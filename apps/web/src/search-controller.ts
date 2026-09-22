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
  pageIndex: number;
  canGoPrev: boolean;
}

export class SearchController {
  private requestId = 0;
  private controller: AbortController | undefined;
  // 每一页请求时使用的游标：第 1 页恒为 null，后续页为上一页响应中的 nextCursor。
  private pageCursors: Array<string | null> = [null];
  private state: SearchControllerState = {
    filters: { limit: 20, sort: 'price_asc' },
    loading: false,
    error: null,
    empty: false,
    cursor: null,
    page: null,
    pageIndex: 0,
    canGoPrev: false,
  };

  constructor(private readonly api: SearchApi) {}

  getState(): SearchControllerState {
    return this.state;
  }

  async search(filters: SearchFilters): Promise<void> {
    this.pageCursors = [null];
    await this.runSearch(filters, 0);
  }

  async nextPage(): Promise<void> {
    if (!this.state.cursor || this.state.loading) return;
    const pageIndex = this.state.pageIndex + 1;
    this.pageCursors[pageIndex] = this.state.cursor;
    await this.runSearch({ ...this.state.filters, cursor: this.state.cursor }, pageIndex);
  }

  async prevPage(): Promise<void> {
    if (this.state.pageIndex === 0 || this.state.loading) return;
    const pageIndex = this.state.pageIndex - 1;
    const cursor = this.pageCursors[pageIndex] ?? null;
    const filters: SearchFilters = { ...this.state.filters };
    delete filters.cursor;
    if (cursor) filters.cursor = cursor;
    await this.runSearch(filters, pageIndex);
  }

  private async runSearch(filters: SearchFilters, pageIndex: number): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const requestId = ++this.requestId;
    this.state = {
      ...this.state,
      filters,
      loading: true,
      error: null,
      empty: false,
      cursor: filters.cursor ?? null,
      pageIndex,
      canGoPrev: pageIndex > 0,
    };
    try {
      const page = await this.api.search(filters, controller.signal);
      if (requestId !== this.requestId) return;
      this.state = {
        ...this.state,
        loading: false,
        page,
        empty: page.items.length === 0,
        cursor: page.nextCursor,
        pageIndex,
        canGoPrev: pageIndex > 0,
      };
    } catch (error) {
      if (controller.signal.aborted || requestId !== this.requestId) return;
      this.state = { ...this.state, loading: false, error: error instanceof Error ? error.message : '查询失败', page: null, pageIndex, canGoPrev: pageIndex > 0 };
    }
  }
}
