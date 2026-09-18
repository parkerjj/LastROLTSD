import { describe, expect, it } from 'vitest';
import { parseUploadRequest, UploadValidationError } from '../src/index';

const valid = {
  protocol_version: 1,
  client_run_id: 'run-1',
  snapshot_id: 'snapshot-1',
  snapshot_mode: 'full',
  part_index: 0,
  part_count: 1,
  observed_at: '2026-09-18T12:00:00.000Z',
  shops_seen: ['shop-1'],
  shops: [{
    shop_key: 'shop-1', vendor_key: 'vendor-1', vendor_name: 'Vendor', title: 'Shop',
    shop_type: 'sell', map_name: 'prontera', x: 100, y: 120,
    items: [{ item_key: 'slot-0', item_id: 123, name: 'Sword', upgrade: 7, slots: 2,
      cards: [0], price: 100, quantity: 1, options: [{ type: 1, value: 5, param: 0 }] }],
  }],
};

describe('upload schema', () => {
  it('parses a valid full request without trusting a source id', () => {
    const parsed = parseUploadRequest({ ...valid, source_id: 'attacker' });
    expect(parsed.snapshot_mode).toBe('full');
    expect('source_id' in parsed).toBe(false);
  });

  it('rejects missing snapshot, invalid part and unsafe values', () => {
    expect(() => parseUploadRequest({ ...valid, snapshot_id: '' })).toThrow(UploadValidationError);
    expect(() => parseUploadRequest({ ...valid, part_index: 2 })).toThrow(UploadValidationError);
    expect(() => parseUploadRequest({ ...valid, shops: [{ ...valid.shops[0]!, items: [{ ...valid.shops[0]!.items[0]!, price: -1 }] }] })).toThrow(UploadValidationError);
    expect(() => parseUploadRequest({ ...valid, snapshot_mode: 'unknown' })).toThrow(UploadValidationError);
  });
});
