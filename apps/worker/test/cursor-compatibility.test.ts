import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { decodeCursor, decodeHistoryCursor, encodeCursor, encodeHistoryCursor, searchCursorContext } from '../src/domain/search';

// Golden vectors for the cursor HMAC scheme. The search context binds the option
// definitions version, so it was re-captured when the bundle moved to
// options-lastro-71.0; the history cursor does not bind that version.
const context = 'LEYM4qdJxllVSdGx_4lf7fMEdjYPEB1mYLnJ3fMAdKA';
const cursor = 'eyJ2ZXJzaW9uIjoxLCJraW5kIjoic2VhcmNoIiwic29ydCI6ImNoYW5nZWRfZGVzYyIsInNvcnRWYWx1ZSI6MTAwMCwiaWQiOjQyLCJjb250ZXh0IjoiTEVZTTRxZEp4bGxWU2RHeF80bGY3Zk1FZGpZUEVCMW1ZTG5KM2ZNQWRLQSJ9.wyThPpNCsQY8XWqSHGCcUnEzkPLLmKzLAJ2ndibYM28';
const history = 'eyJ2ZXJzaW9uIjoxLCJraW5kIjoiaGlzdG9yeSIsImlkIjo0Mn0.MVMiPl9CCDNCstIzzdlFE1oAqXUAZY5E04WpybYTDX0';
const secret = 'test-cursor-secret-123';

describe('cursor crypto compatibility', () => {
  it('preserves previously issued search and history cursors byte for byte', () => {
    expect(searchCursorContext({ limit: 20, sort: 'changed_desc', catalogVersion: 'static', optionVersion: 'options-lastro-71.0', searchIndexVersion: 'active-shop-bounded-v1' })).toBe(context);
    const payload = { sort: 'changed_desc' as const, sortValue: 1000, id: 42, context };
    expect(encodeCursor(payload, secret)).toBe(cursor);
    expect(decodeCursor(cursor, { context }, secret)).toEqual(payload);
    expect(encodeHistoryCursor(42, secret)).toBe(history);
    expect(decodeHistoryCursor(history, secret)).toBe(42);
  });

  it('handles long UTF-8 keys and rejects signature, context and secret changes', () => {
    const longSecret = '\u6d4b\u8bd5'.repeat(40);
    const encoded = encodeCursor({ sort: 'price_asc', sortValue: 5, id: 1, context: '\u6d4b\u8bd5' }, longSecret);
    const [body, signature] = encoded.split('.');
    expect(signature).toBe(createHmac('sha256', longSecret).update(body!).digest('base64url'));
    expect(() => decodeCursor(encoded, { context: 'different' }, longSecret)).toThrow('Invalid cursor');
    expect(() => decodeCursor(encoded, undefined, secret)).toThrow('Invalid cursor');
    expect(() => decodeCursor(cursor.replace('wyTh', '0abc'), undefined, secret)).toThrow('Invalid cursor');
  });
});
