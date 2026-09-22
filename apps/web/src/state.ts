import type { SearchFilters } from './types';
export interface UiState { filters: SearchFilters; loading: boolean; error: string | null; empty: boolean; cursor: string | null; }
export const initialState: UiState = { filters: { limit: 20, sort: 'changed_desc' }, loading: false, error: null, empty: false, cursor: null };
