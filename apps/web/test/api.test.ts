import { describe, expect, it, vi } from 'vitest';
import { MarketApi } from '../src/api';

describe('market API', () => {
  it('loads the options endpoint and maps its Chinese metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 'options-v1', options: [{ type: 12, handle: 'atk_plus', label_zh: 'ATK +', description_template: '攻击力增加 {value}', value_kind: 'integer', unit: 'points', scale: 1, allowed_operators: ['gte'], param_policy: { mode: 'ignored', filterable: false }, repeat_policy: 'same', display_template: 'ATK + {value}', search_tokens: [] }] }), { status: 200, headers: { etag: '"options"' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MarketApi().getOptions();
    expect(result.options[0]).toMatchObject({ type: 12, labelZh: 'ATK +', allowedOperators: ['gte'] });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/options', expect.objectContaining({ headers: expect.any(Headers) }));
  });

  it('loads catalog autocomplete matches for a Chinese query', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 'catalog-v1', items: [{ itemId: 1, name: '波利卡片', aliases: ['波利牌'] }, { itemId: 2, name: '波利帽', aliases: [] }] }), { status: 200 })));
    const result = await new MarketApi().getItems('波利');
    expect(result.items.map((item) => item.name)).toEqual(['波利卡片', '波利帽']);
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
