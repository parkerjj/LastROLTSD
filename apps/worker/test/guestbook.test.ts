import { describe, expect, it } from 'vitest';
import {
  decodeGuestbookCursor,
  encodeGuestbookCursor,
  guestbookCursorContext,
  parseGuestbookContentEdit,
  parseGuestbookFilters,
  parseGuestbookIdParam,
  parseGuestbookReplySubmission,
  parseGuestbookSubmission,
} from '../src/domain/guestbook';

describe('guestbook domain', () => {
  it('accepts suggestions and normalizes content without any contact field', () => {
    expect(parseGuestbookSubmission({ category: 'suggestion', content: '  改进搜索  ' }, new Set())).toEqual({
      category: 'suggestion', itemId: null, isZeny: false, content: '改进搜索', expiresAt: null,
    });
  });

  it('requires transaction fields and a real catalog item unless the entry is Zeny', () => {
    expect(() => parseGuestbookSubmission({ category: 'buy', content: '收购', duration: '7d', isZeny: false, itemId: 100 }, new Set([99]))).toThrow(/item/i);
    expect(parseGuestbookSubmission({ category: 'sell', content: '卖游戏币', duration: 'permanent', isZeny: true }, new Set()))
      .toMatchObject({ category: 'sell', itemId: null, isZeny: true, expiresAt: null });
  });

  it('rejects the removed contact field on every category', () => {
    expect(() => parseGuestbookSubmission({ category: 'suggestion', content: '建议', contact: 'QQ' }, new Set())).toThrow(/contact/i);
    expect(() => parseGuestbookSubmission({ category: 'buy', content: '收购', contact: 'QQ', duration: '1d', isZeny: true }, new Set())).toThrow(/contact/i);
  });

  it('rejects trade fields on suggestions and conflicting item/zeny values', () => {
    expect(() => parseGuestbookSubmission({ category: 'suggestion', content: '建议', itemId: 100 }, new Set([100]))).toThrow(/suggestion/i);
    expect(() => parseGuestbookSubmission({ category: 'buy', itemId: 1, isZeny: true, content: 'x', duration: '1d' }, new Set([1]))).toThrow(/zeny|item/i);
  });

  it('parses content edits and reply submissions with their own length limits', () => {
    expect(parseGuestbookContentEdit({ content: '  改后的文本  ' })).toBe('改后的文本');
    expect(() => parseGuestbookContentEdit({ content: 'x'.repeat(2_001) })).toThrow(/content/i);
    expect(() => parseGuestbookContentEdit('not-an-object')).toThrow(/object/i);
    expect(parseGuestbookReplySubmission({ content: '回复内容' })).toBe('回复内容');
    expect(() => parseGuestbookReplySubmission({ content: 'x'.repeat(1_001) })).toThrow(/1_?000|1000/);
    expect(() => parseGuestbookReplySubmission({ content: '   ' })).toThrow(/content/i);
  });

  it('parses positive integer id params and rejects everything else', () => {
    expect(parseGuestbookIdParam('42', 'id')).toBe(42);
    expect(() => parseGuestbookIdParam('0', 'id')).toThrow(/id/i);
    expect(() => parseGuestbookIdParam('abc', 'id')).toThrow(/id/i);
    expect(() => parseGuestbookIdParam('-3', 'id')).toThrow(/id/i);
    expect(() => parseGuestbookIdParam('1.5', 'id')).toThrow(/id/i);
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
