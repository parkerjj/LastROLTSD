import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderHistory, renderSearchResults } from '../src/render';
import type { ListingSearchResult } from '../src/types';

const listing = (overrides: Partial<ListingSearchResult> = {}): ListingSearchResult => ({
  id: 1,
  itemId: 1234,
  itemName: '波利卡片',
  price: 50,
  quantity: 2,
  mapName: '普隆德拉',
  vendorName: '玩家甲',
  title: '收购店',
  options: [{ type: 12, value: 50, param: 0, display: 'SP恢复速度增加50%' }],
  lastChangedAt: 1,
  ...overrides,
});

const state = { filters: { limit: 20, sort: 'price_asc' as const }, loading: false, error: null, empty: false, cursor: null };

function getResults(): HTMLElement {
  const dom = new JSDOM('<div id="results"></div>');
  return dom.window.document.querySelector('#results') as HTMLElement;
}

describe('query UI rendering', () => {
  it('renders Chinese loading, empty, error, result, item IDs, option displays, and cursor pagination', () => {
    const element = getResults();
    renderSearchResults(element, { items: [], nextCursor: null }, { ...state, loading: true });
    expect(element.textContent).toContain('正在加载');
    renderSearchResults(element, { items: [], nextCursor: null }, { ...state, empty: true });
    expect(element.textContent).toContain('没有匹配的在售商品');
    renderSearchResults(element, { items: [], nextCursor: null }, { ...state, error: '查询失败' });
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('查询失败');
    renderSearchResults(element, { items: [listing()], nextCursor: 'next' }, { ...state, cursor: 'next' });
    expect(element.textContent).toContain('波利卡片');
    expect(element.textContent).toContain('物品 ID');
    expect(element.textContent).toContain('1234');
    expect(element.textContent).toContain('SP恢复速度增加50%');
    expect(element.querySelector('.history-button')).not.toBeNull();
    expect(element.querySelector('#next-page')).not.toBeNull();
    expect(element.querySelector('.item-icon img')?.getAttribute('src')).toBe('/api/v1/assets/items/small/1234.gif?lastroweb=v3');
    expect(element.querySelector('.map-button')?.getAttribute('data-map-image')).toBe('/api/v1/assets/maps_xl/prontera_re.gif?lastroweb=v3');
  });

  it('translates map codes and supplies the map marker position from listing coordinates', () => {
    const element = getResults();
    renderSearchResults(element, { items: [listing({ mapName: 'payon', x: 300, y: 360 })], nextCursor: null }, state);
    expect(element.querySelector('.item-location strong')?.textContent).toBe('斐扬');
    expect(element.querySelector('.map-button')?.getAttribute('data-map-marker-left')).toBe('100');
    expect(element.querySelector('.map-button')?.getAttribute('data-map-marker-top')).toBe('0');
  });

  it('renders deterministic fallbacks for unknown items and unknown option types', () => {
    const element = getResults();
    renderSearchResults(element, { items: [listing({ itemName: '', itemId: 9999, options: [{ type: 777, value: 3, param: 4, display: '' }] })], nextCursor: null }, state);
    expect(element.textContent).toContain('未知物品 #9999');
    expect(element.textContent).toContain('未知词条 type=777 value=3 param=4');
  });

  it('escapes API text before inserting HTML', () => {
    const element = getResults();
    renderSearchResults(element, { items: [listing({ itemName: '<img src=x onerror=alert(1)>', vendorName: '<b>恶意</b>' })], nextCursor: null }, state);
    expect(element.querySelector('img')).toBeNull();
    expect(element.querySelector('b')).toBeNull();
    expect(element.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('groups mixed matches by item, shop, and vendor with icon controls and sorting', () => {
    const element = getResults();
    renderSearchResults(element, {
      items: [
        listing({ id: 1, itemName: '利卡短剑', title: '普通商店', vendorName: '普通商人' }),
        listing({ id: 2, itemName: '普通短剑', title: '利卡特价店', vendorName: '普通商人' }),
        listing({ id: 3, itemName: '普通长剑', title: '普通商店', vendorName: '杰利卡' }),
      ],
      nextCursor: null,
    }, { ...state, filters: { q: '利卡', limit: 20, sort: 'changed_desc' } });

    expect(Array.from(element.querySelectorAll<HTMLElement>('.result-group')).map((group) => group.dataset.group)).toEqual(['name', 'shop', 'vendor']);
    expect(Array.from(element.querySelectorAll('.result-group')).map((group) => group.querySelectorAll('.item-row').length)).toEqual([1, 1, 1]);
    expect(element.querySelectorAll('.group-toggle .ph-caret-down')).toHaveLength(3);
    expect(element.querySelectorAll('.toggle-mark')).toHaveLength(0);
    expect(element.querySelector<HTMLSelectElement>('#result-sort')?.value).toBe('changed_desc');
    expect(Array.from(element.querySelectorAll<HTMLOptionElement>('#result-sort option')).map((option) => option.value)).toEqual(['price_asc', 'price_desc', 'changed_desc']);
  });

  it('renders history drawer pagination and inferred sales in Chinese', () => {
    const dom = new JSDOM('<aside></aside>');
    const drawer = dom.window.document.querySelector('aside') as HTMLElement;
    renderHistory(drawer, { items: [{ id: 1, observedAt: 1, price: 50, quantity: 1, eventType: 'observed' }], inferredSales: [{ observedAt: 2, soldQuantity: 1, fromQuantity: 2, toQuantity: 1, reason: 'quantity_decrease' }], nextCursor: 'history-next' }, 1);
    expect(drawer.textContent).toContain('价格历史');
    expect(drawer.textContent).toContain('售出：1（2 → 1）');
    expect(drawer.querySelector('#next-history')).not.toBeNull();
    expect(drawer.querySelector('#close-history')).not.toBeNull();
  });

  it('renders the item brief, chart explanation, current listings, and sales in an item-wide history drawer', () => {
    const dom = new JSDOM('<aside></aside>');
    const drawer = dom.window.document.querySelector('aside') as HTMLElement;
    renderHistory(drawer, {
      items: [], inferredSales: [], nextCursor: null,
      itemId: 1001,
      windowStart: 1,
      windowEnd: 2,
      currentListings: [{ listingId: 8, price: 1200, quantity: 3, vendorName: '商人甲', title: '长发特卖', mapName: 'prontera', lastChangedAt: 2 }],
      sales: [{ listingId: 6, observedAt: 2, price: 1100, soldQuantity: 1, vendorName: '商人乙', title: '旧店' }],
      events: [{ listingId: 6, observedAt: 2, price: 1100, quantity: 0, eventType: 'quantity_decrease' }],
    } as any, listing({ itemId: 1001, itemName: '长发' }));

    expect(drawer.querySelector('.history-item-summary')?.textContent).toContain('长发');
    expect(drawer.querySelector('.history-chart-explanation')?.textContent).toContain('横轴');
    expect(drawer.querySelector('[data-history-chart]')).not.toBeNull();
    expect(drawer.querySelector('.current-listings')?.textContent).toContain('长发特卖');
    expect(drawer.textContent).toContain('售出记录');
    expect(drawer.querySelector('.history-sales')?.textContent).toContain('以 1,100 Zeny 售出 1 个');
  });
});
