import { describe, expect, it, vi } from 'vitest';
import { MarketApi } from '../src/api';

describe('market API', () => {
  it('loads the options endpoint and maps its Chinese metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 'options-lastro-70.83', options: [{ type: 12, handle: 'VAR_SPACCELERATION', label_zh: 'SP恢复速度增加数值%', description_template: 'SP恢复速度增加{value}%', value_kind: 'integer', unit: '', scale: 1, allowed_operators: ['gte'], param_policy: { mode: 'ignored', filterable: false }, repeat_policy: 'same', display_template: 'SP恢复速度增加{value}%', search_tokens: [] }] }), { status: 200, headers: { etag: '"options"' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MarketApi().getOptions();
    expect(result.options[0]).toMatchObject({ type: 12, labelZh: 'SP恢复速度增加数值%', allowedOperators: ['gte'] });
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
});
