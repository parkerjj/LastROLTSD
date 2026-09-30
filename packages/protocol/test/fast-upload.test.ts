import { describe, expect, it } from 'vitest';
import { tryParseUploadRequest } from '../src/fast-upload';
import { parseUploadRequest, uploadRequestSchema, UploadValidationError } from '../src/schema';

function valid() {
  return { shops: [{ items: [{ quantity: 1, price: 10, item_id: 501 }], y: 2, x: 1, map_name: ' prontera ',
    shop_type: 'sell', title: ' 商店 ', vendor_name: ' Vendor ', vendor_account_id: ' account ',
    shop_status: 'opening', uuid: '00000000-0000-0000-0000-000000000001' }],
  observed_at: '2026-09-30T00:00:00Z', part_count: 1, part_index: 0, snapshot_mode: 'full',
  snapshot_id: ' snapshot ', client_run_id: ' run ', protocol_version: 2 };
}

describe('specialized upload parser', () => {
  it('preserves the canonical field order, defaults and trims without changing its input', () => {
    const input = valid();
    const before = JSON.stringify(input);
    const result = tryParseUploadRequest(input);
    expect(JSON.stringify(result)).toBe('{"protocol_version":2,"client_run_id":"run","snapshot_id":"snapshot","snapshot_mode":"full","part_index":0,"part_count":1,"observed_at":"2026-09-30T00:00:00Z","shops":[{"uuid":"00000000-0000-0000-0000-000000000001","shop_status":"opening","vendor_account_id":"account","vendor_name":"Vendor","title":"商店","shop_type":"sell","map_name":"prontera","x":1,"y":2,"items":[{"item_id":501,"upgrade":0,"slots":0,"cards":[],"price":10,"quantity":1,"options":[]}]}]}');
    expect(JSON.stringify(input)).toBe(before);
    expect(result?.shops[0]?.items[0]?.cards).not.toBe(result?.shops[0]?.items[0]?.options);
  });

  it('matches the reference schema for optional fields, Unicode, ranges and timestamp forms', () => {
    const cases: unknown[] = [];
    for (const date of ['2024-02-29T23:59:59.123456Z', '2026-09-30T00:00Z', '2026-09-30T12:00:00+0330', '2026-09-30T12:00:00-03:30']) {
      for (const mode of ['full', 'delta', 'heartbeat']) {
        const request = valid();
        Object.assign(request, { observed_at: date, snapshot_mode: mode, part_count: 64, part_index: 63 });
        Object.assign(request.shops[0]!, { shop_id: ' cached ', title: '\u3000ＡＢＣ\u00a0', vendor_name: '', shop_type: 'buy', x: 1000, y: 0 });
        Object.assign(request.shops[0]!.items[0]!, { item_key: ' \u3000slot\u00a0', item_id: 2147483647, upgrade: 20, slots: 4,
          cards: [0, 2147483647, 1, 2], price: Number.MAX_SAFE_INTEGER, quantity: 0,
          options: [{ param: -2147483648, value: 2147483647, type: 65535 }] });
        cases.push(request);
      }
    }
    const optional = valid();
    Object.assign(optional.shops[0]!, { shop_id: undefined });
    Object.assign(optional.shops[0]!.items[0]!, { item_key: undefined, cards: undefined, options: undefined });
    cases.push(optional, { ...valid(), shops: [] });
    const dismissed = valid();
    Object.assign(dismissed.shops[0]!, { shop_status: 'dismissed', items: [] });
    cases.push(dismissed);
    for (const input of cases) {
      const reference = uploadRequestSchema.parse(input);
      const actual = tryParseUploadRequest(input);
      expect(actual).toStrictEqual(reference);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(reference));
    }
  });

  it('rejects invalid nested fields, sparse arrays, dates, ranges and lifecycle values', () => {
    const invalid: unknown[] = [null, [], true, {}, { ...valid(), unexpected: 1 },
      { ...valid(), shops: new Array(1) }, { ...valid(), part_index: 1 }, { ...valid(), part_count: 65 },
      { ...valid(), observed_at: '2025-02-29T00:00:00Z' }, { ...valid(), observed_at: '2026-09-30T24:00:00Z' }];
    for (const changes of [{ uuid: 'bad' }, { vendor_name: null }, { shop_status: 'dismissed' }, { x: NaN },
      { x: 1001 }, { map_name: '' }, { unexpected: true }, { items: new Array(1) }, { items: new Array(257).fill({}) }]) {
      const request = valid(); Object.assign(request.shops[0]!, changes); invalid.push(request);
    }
    for (const changes of [{ price: Number.MAX_SAFE_INTEGER + 1 }, { quantity: Infinity }, { upgrade: 21 }, { slots: 5 },
      { item_id: -1 }, { cards: [0, 0, 0, 0, 0] }, { cards: [0.5] }, { options: new Array(1) },
      { options: [{ type: 1, value: 0, param: 0, extra: 1 }] }, { options: [{ type: 65536, value: 0, param: 0 }] },
      { options: [{ type: 1, value: -2147483649, param: 0 }] }, { options: [{ type: 1, value: 0, param: 2147483648 }] },
      { item_key: ' ' }, { name: 'untrusted client name' }]) {
      const request = valid(); Object.assign(request.shops[0]!.items[0]!, changes); invalid.push(request);
    }
    const duplicated = valid(); duplicated.shops.push(structuredClone(duplicated.shops[0]!)); invalid.push(duplicated);
    const inherited = valid(); inherited.shops[0] = Object.assign(Object.create({ extra: 1 }), inherited.shops[0]); invalid.push(inherited);
    const pollution = JSON.parse(JSON.stringify(valid())); pollution.shops[0].items[0] = JSON.parse('{"item_id":501,"price":10,"quantity":1,"__proto__":{"admin":true}}'); invalid.push(pollution);
    for (const input of invalid) {
      const candidate = input && typeof input === 'object' ? { ...input } : input;
      const reference = uploadRequestSchema.safeParse(candidate);
      expect(reference.success).toBe(false);
      expect(tryParseUploadRequest(input)).toBeUndefined();
      try { parseUploadRequest(input); throw new Error('Accepted invalid upload'); }
      catch (error) {
        expect(error).toBeInstanceOf(UploadValidationError);
        if (!reference.success) expect((error as UploadValidationError).issues).toStrictEqual(reference.error.issues);
      }
    }
  });

  it('ignores a supplied root source ID and retains schema fallback acceptance for unusual objects', () => {
    expect(parseUploadRequest({ ...valid(), source_id: 'attacker' })).not.toHaveProperty('source_id');
    const request = valid();
    request.shops[0] = Object.assign(Object.create({}), request.shops[0]);
    expect(parseUploadRequest(request)).toStrictEqual(uploadRequestSchema.parse(request));
  });

  it('uses the reference parser for accessor fields and custom array iterators', () => {
    const accessor = () => {
      const request = valid();
      let reads = 0;
      Object.defineProperty(request.shops[0]!.items[0]!, 'price', { enumerable: true, get: () => ++reads === 1 ? 10 : NaN });
      return request;
    };
    expect(tryParseUploadRequest(accessor())).toBeUndefined();
    expect(parseUploadRequest(accessor())).toStrictEqual(uploadRequestSchema.parse(accessor()));
    const request = valid();
    const cards = [1];
    cards[Symbol.iterator] = () => [2][Symbol.iterator]();
    Object.assign(request.shops[0]!.items[0]!, { cards });
    expect(tryParseUploadRequest(request)).toBeUndefined();
    expect(parseUploadRequest(request)).toStrictEqual(uploadRequestSchema.parse(request));
  });

  it('agrees with the schema across deterministically generated field mutations', () => {
    const values: unknown[] = [undefined, null, false, true, '', ' ', '123', -1, -0, 0, 1, 0.5, 20, 32, 64,
      256, 1000, 65535, 2147483647, 2147483648, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, [], {}, new Date(0)];
    const paths = [[], ['shops', 0], ['shops', 0, 'items', 0], ['shops', 0, 'items', 0, 'options', 0]];
    for (const path of paths) {
      const seed = valid();
      Object.assign(seed.shops[0]!.items[0]!, { cards: [0], options: [{ type: 1, value: 2, param: 0 }], item_key: 'slot' });
      let target: any = seed;
      for (const key of path) target = target[key];
      for (const field of Object.keys(target)) for (const value of values) {
        const candidate = structuredClone(seed);
        let node: any = candidate;
        for (const key of path) node = node[key];
        node[field] = value;
        const reference = uploadRequestSchema.safeParse(candidate);
        const fast = tryParseUploadRequest(candidate);
        if (reference.success) {
          expect(fast, `${path.join('.')}.${field}=${String(value)}`).toStrictEqual(reference.data);
          expect(JSON.stringify(fast)).toBe(JSON.stringify(reference.data));
        } else expect(fast).toBeUndefined();
      }
    }
  });
});
