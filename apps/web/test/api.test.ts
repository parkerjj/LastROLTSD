import { describe, expect, it, vi } from 'vitest';
import { MarketApi } from '../src/api';

describe('market API', () => {
  it('loads the options endpoint and maps its Chinese metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 'options-lastro-71.0', options: [{ type: 12, handle: 'VAR_SPACCELERATION', label_zh: 'SP恢复速度增加数值%', description_template: 'SP恢复速度增加{value}%', value_kind: 'integer', value_policy: 'flag', selectable: false, unit: '', scale: 1, allowed_operators: ['gte'], param_policy: { mode: 'ignored', filterable: false }, repeat_policy: 'same', display_template: 'SP恢复速度增加{value}%', search_tokens: [] }] }), { status: 200, headers: { etag: '"options"' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MarketApi().getOptions();
    expect(result.options[0]).toMatchObject({ type: 12, labelZh: 'SP恢复速度增加数值%', allowedOperators: ['gte'], valuePolicy: 'flag', selectable: false });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/options', expect.objectContaining({ headers: expect.any(Headers) }));
  });

  it('serializes structured option filters and all/any mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new MarketApi().search({
      q: '波利',
      limit: 20,
      sort: 'price_asc',
      options: [{ type: 12, operator: 'gte', value: '50' }],
      option_mode: 'any',
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://example.test');
    expect(url.searchParams.get('q')).toBe('波利');
    expect(url.searchParams.getAll('option')).toEqual(['12:gte:50']);
    expect(url.searchParams.get('option_mode')).toBe('any');
  });

  it('loads item-wide history without allowing a client-side day range', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ itemId: 1001, currentListings: [], sales: [], events: [], windowStart: 1, windowEnd: 2 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await (new MarketApi() as any).getItemHistory(1001);

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/market/items/1001/history', {});
  });

  it('serializes guestbook filters and anonymous submissions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ item: {} }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MarketApi();
    await api.searchGuestbook({ category: 'sell', itemId: 100, q: '波利', limit: 20, cursor: 'next' });
    await api.createGuestbookEntry({ category: 'suggestion', content: '建议' });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'https://example.test');
    expect(url.pathname).toBe('/api/v1/guestbook');
    expect(url.searchParams.get('itemId')).toBe('100');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/guestbook');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ category: 'suggestion', content: '建议' });
  });
});
