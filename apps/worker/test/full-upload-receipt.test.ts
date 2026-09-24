import { describe, expect, it, vi } from 'vitest';
import type { UploadRequest } from '@lastroweb/protocol';
import { receiveFullUpload, type FullReceiptStore } from '../src/services/full-upload';
import { computeShopIdentity } from '../src/domain/shop-identity';

export function fullRequest(overrides: Partial<UploadRequest> = {}): UploadRequest {
  return { protocol_version: 2, client_run_id: 'run', snapshot_id: 'full-1', snapshot_mode: 'full', part_index: 0, part_count: 1,
    observed_at: '2026-09-24T00:00:00Z', shops: [{ uuid: '00000000-0000-4000-8000-000000000001', shop_status: 'opening', vendor_account_id: '123', vendor_name: 'Vendor', title: 'Shop', shop_type: 'sell', map_name: 'prontera', x: 1, y: 2,
      items: [{ item_id: 501, price: 100, quantity: 10, upgrade: 0, slots: 0, cards: [], options: [] }] }], ...overrides };
}

describe('full upload receipt', () => {
  it('returns ordered stable identities without applying listings and dispatches only a ready snapshot', async () => {
    const request = fullRequest();
    const receive = vi.fn<FullReceiptStore['receive']>(async (input) => ({ response: input.response, wakeup: { sourceId: 'source', snapshotId: 'full-1', generation: 0 } }));
    const dispatch = vi.fn();
    const result = await receiveFullUpload({ id: 'source' }, request, 'full-1/0', { receive }, dispatch);
    const identity = await computeShopIdentity({ sourceId: 'source', vendorAccountId: '123', shopType: 'sell', mapName: 'prontera', x: 1, y: 2, title: 'Shop' });
    expect(result).toMatchObject({ accepted: true, processed_listings: 0, changed_listings: 0, sold_events: 0, reconciliation: { status: 'pending', snapshot_id: 'full-1' }, shops: [{ uuid: request.shops[0]!.uuid, shop_id: identity.shopId, applied: false, resolution: 'pending' }] });
    expect(receive).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ sourceId: 'source', snapshotId: 'full-1', generation: 0 });
  });

  it('rejects a wrong idempotency key and duplicate canonical shops before storage', async () => {
    const receive = vi.fn();
    await expect(receiveFullUpload({ id: 'source' }, fullRequest(), 'wrong', { receive })).rejects.toMatchObject({ code: 'idempotency_key_mismatch' });
    const request = fullRequest();
    request.shops.push({ ...request.shops[0]!, uuid: '00000000-0000-4000-8000-000000000002' });
    await expect(receiveFullUpload({ id: 'source' }, request, 'full-1/0', { receive })).rejects.toMatchObject({ code: 'duplicate_shop_identity' });
    expect(receive).not.toHaveBeenCalled();
  });

  it('does not enqueue incomplete parts and still accepts when the queue is unavailable', async () => {
    const request = fullRequest({ part_count: 2 });
    const dispatch = vi.fn(async () => { throw new Error('queue unavailable'); });
    const receive = vi.fn<FullReceiptStore['receive']>(async (input) => ({ response: input.response, wakeup: null }));
    await receiveFullUpload({ id: 'source' }, request, 'full-1/0', { receive }, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    receive.mockImplementation(async (input) => ({ response: input.response, wakeup: { sourceId: 'source', snapshotId: 'full-1', generation: 0 } }));
    await expect(receiveFullUpload({ id: 'source' }, request, 'full-1/0', { receive }, dispatch)).resolves.toMatchObject({ accepted: true });
  });
});
