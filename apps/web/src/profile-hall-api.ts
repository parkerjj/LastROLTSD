import type { SharedProfileCopyInput, SharedProfileCopyResult, SharedProfileDetail, SharedProfilePage, SharedProfileQuery } from '../../worker/src/ke/shared-profile-types';

export type { SharedProfileDetail, SharedProfilePage, SharedProfileQuery, SharedProfileCopyResult };

export class HallApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/ke${path}`, { credentials: 'same-origin', cache: 'no-store', ...init });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new HallApiError(response.status, body?.error?.code ?? 'REQUEST_FAILED', body?.error?.message ?? '请求失败，请重试');
  return body as T;
}

export const profileHallApi = {
  list(query: SharedProfileQuery, signal?: AbortSignal): Promise<SharedProfilePage> {
    const params = new URLSearchParams({ sort: query.sort, page: String(query.page) });
    if (query.job_ids !== undefined) params.set('job_ids', query.job_ids.join(','));
    else if (query.job_id !== undefined) params.set('job_id', String(query.job_id));
    return request(`/shared-profiles?${params}`, signal ? { signal } : undefined);
  },
  byId(id: number, signal?: AbortSignal): Promise<SharedProfileDetail> { return request(`/shared-profiles/${id}`, signal ? { signal } : undefined); },
  byCode(code: string, signal?: AbortSignal): Promise<SharedProfileDetail> { return request(`/shared-profiles/code/${encodeURIComponent(code)}`, signal ? { signal } : undefined); },
  like(id: number, liked: boolean): Promise<{ liked: boolean; like_count: number }> {
    return request(`/shared-profiles/${id}/like`, { method: liked ? 'PUT' : 'DELETE' });
  },
  copy(id: number, input: SharedProfileCopyInput): Promise<SharedProfileCopyResult> {
    return request(`/shared-profiles/${id}/copy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  },
  withdraw(id: number): Promise<void> { return request(`/shared-profiles/${id}/withdraw`, { method: 'DELETE' }); },
  characters(): Promise<{ characters: Array<{ aid: number; cid: number; nid: number; char_name: string; job_id: number | null }> }> {
    return request('/characters');
  },
};

export function normalizeShareCode(raw: string): string | null {
  const compact = raw.trim().replace('-', '').toUpperCase();
  return /^[A-Z]{3}[0-9]{4}$/.test(compact) ? `${compact.slice(0, 3)}-${compact.slice(3)}` : null;
}
