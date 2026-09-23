import { describe, expect, it } from 'vitest';
import { decodeGuestbookCursor, encodeGuestbookCursor, guestbookCursorContext, parseGuestbookFilters, parseGuestbookSubmission } from '../src/domain/guestbook';

describe('guestbook domain', () => {
  it('accepts anonymous suggestions and normalizes content', () => {
    expect(parseGuestbookSubmission({ category: 'suggestion', content: '  改进搜索  ' }, new Set())).toEqual({
      category: 'suggestion', itemId: null, isZeny: false, contact: null, content: '改进搜索', expiresAt: null,
    });
  });

  it('requires transaction fields and a real catalog item unless the entry is Zeny', () => {
    expect(() => parseGuestbookSubmission({ category: 'buy', content: '收购', contact: 'QQ 123', duration: '7d', isZeny: false, itemId: 100 }, new Set([99]))).toThrow(/item/i);
    expect(parseGuestbookSubmission({ category: 'sell', content: '卖游戏币', contact: 'Alice', duration: 'permanent', isZeny: true }, new Set()))
      .toMatchObject({ category: 'sell', itemId: null, isZeny: true, expiresAt: null });
  });

  it('rejects trade fields on suggestions and conflicting item/zeny values', () => {
    expect(() => parseGuestbookSubmission({ category: 'suggestion', content: '建议', contact: 'QQ' }, new Set())).toThrow(/suggestion/i);
    expect(() => parseGuestbookSubmission({ category: 'buy', itemId: 1, isZeny: true, contact: 'QQ', content: 'x', duration: '1d' }, new Set([1]))).toThrow(/zeny|item/i);
  });

  it('strictly parses bounded filters and signs cursors to their filter context', () => {
    const filters = parseGuestbookFilters(new URLSearchParams('category=buy&item_id=100&q=%25_%5C&limit=999'));
    expect(filters).toMatchObject({ category: 'buy', itemId: 100, q: '%_\\', limit: 50 });
    const context = guestbookCursorContext(filters);
    const token = encodeGuestbookCursor({ createdAt: 1000, id: 5, context }, '0123456789abcdef0123456789abcdef');
    expect(decodeGuestbookCursor(token, context, '0123456789abcdef0123456789abcdef')).toMatchObject({ createdAt: 1000, id: 5 });
    expect(() => decodeGuestbookCursor(token, 'other', '0123456789abcdef0123456789abcdef')).toThrow(/cursor/i);
  });
});
