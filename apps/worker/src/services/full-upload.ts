import { Buffer } from 'node:buffer';
import type { UploadRequest } from '@lastroweb/protocol';
import { computeShopIdentity } from '../domain/shop-identity';
import type { UploadResultLike } from '../db/repository';
import { canonicalBatchId, IngestionError, isValidIdempotencyKey } from './ingestion';

export interface SnapshotMessage { sourceId: string; snapshotId: string; generation: number; }
export interface FullPartReceipt {
  sourceId: string;
  request: UploadRequest;
  payloadJson: string;
  payloadHash: string;
  identities: Array<{ identityHash: string; shopId: string }>;
  response: UploadResultLike;
}
export interface FullReceiptStore {
  receive(input: FullPartReceipt): Promise<{ response: UploadResultLike; wakeup: SnapshotMessage | null }>;
}

export async function receiveFullUpload(
  source: { id: string }, request: UploadRequest, idempotencyKey: string, store: FullReceiptStore,
  dispatch?: (message: SnapshotMessage) => Promise<unknown>,
): Promise<UploadResultLike> {
  const batchId = canonicalBatchId(request);
  if (request.snapshot_mode !== 'full' || !isValidIdempotencyKey(idempotencyKey) || batchId !== idempotencyKey) {
    throw new IngestionError(400, 'idempotency_key_mismatch', 'Idempotency-Key must match a full snapshot part');
  }
  const identities = await Promise.all(request.shops.map((shop) => computeShopIdentity({ sourceId: source.id,
    vendorAccountId: shop.vendor_account_id, shopType: shop.shop_type, mapName: shop.map_name, x: shop.x, y: shop.y, title: shop.title })));
  if (new Set(identities.map((identity) => identity.identityHash)).size !== identities.length) {
    throw new IngestionError(422, 'duplicate_shop_identity', 'Shop canonical identity must be unique within a snapshot', { action: 'new_snapshot' });
  }
  // Validation has supplied defaults. Item normalization belongs to a background chunk.
  const payloadJson = JSON.stringify(request);
  const payloadHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payloadJson))).toString('hex');
  const response: UploadResultLike = { accepted: true, batch_id: batchId, duplicate: false, processed_shops: 0,
    processed_listings: 0, changed_listings: 0, sold_events: 0, next: null,
    shops: request.shops.map((shop, index) => ({ uuid: shop.uuid, shop_id: identities[index]!.shopId,
      shop_status: shop.shop_status, applied: false, resolution: 'pending' })),
    reconciliation: { status: 'pending', snapshot_id: request.snapshot_id, stage: 'materialize_parts' } };
  const stored = await store.receive({ sourceId: source.id, request, payloadJson, payloadHash, identities, response });
  if (stored.wakeup && dispatch) {
    try { await dispatch(stored.wakeup); } catch { console.warn(JSON.stringify({ event: 'snapshot_dispatch_fallback', sourceId: source.id, snapshotId: request.snapshot_id })); }
  }
  return stored.response;
}
