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

  it('renders history drawer pagination and inferred sales in Chinese', () => {
    const dom = new JSDOM('<aside></aside>');
    const drawer = dom.window.document.querySelector('aside') as HTMLElement;
    renderHistory(drawer, { items: [{ id: 1, observedAt: 1, price: 50, quantity: 1, eventType: 'observed' }], inferredSales: [{ observedAt: 2, soldQuantity: 1, fromQuantity: 2, toQuantity: 1, reason: 'quantity_decrease' }], nextCursor: 'history-next' }, 1);
    expect(drawer.textContent).toContain('价格历史');
    expect(drawer.textContent).toContain('推断售出');
    expect(drawer.querySelector('#next-history')).not.toBeNull();
    expect(drawer.querySelector('#close-history')).not.toBeNull();
  });
});
