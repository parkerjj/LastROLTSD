import type { UploadItem, UploadRequest } from '@lastroweb/protocol';
import { normalizeItem } from '@lastroweb/protocol';
import { computeItemFingerprint } from '../domain/fingerprint';
import type { MarketRepository, UploadResultLike } from '../db/repository';
import type { ShopSessionRow } from '../db/types';
import type { AuthenticatedSource } from '../middleware/auth';
import { getOrStartShopSession } from './session-manager';
import { createSnapshotReconciler } from './snapshot-reconciler';

export interface NormalizedObservation { fingerprint: string; item: UploadItem; sessionId: number; shopKey: string; }
export interface StateBatchResult { processedListings: number; changedListings: number; soldEvents: number; }
export interface ListingStateService { applyBatchObservations(source: AuthenticatedSource, session: ShopSessionRow, observations: NormalizedObservation[], batchId: string, observedAt: number): Promise<StateBatchResult>; }
export interface UploadResult extends UploadResultLike {}
export class IngestionError extends Error { constructor(public readonly status: 400 | 409 | 503, message: string) { super(message); this.name = 'IngestionError'; } }

export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export function canonicalBatchId(request: Pick<UploadRequest, 'snapshot_id' | 'part_index'>): string {
  return `${request.snapshot_id}/${request.part_index}`;
}

export function isValidIdempotencyKey(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= MAX_IDEMPOTENCY_KEY_LENGTH && value.trim() === value && /^[\x21-\x7e]+$/.test(value);
}

function normalizeUploadRequest(request: UploadRequest): UploadRequest {
  return {
    ...request,
    shops: request.shops.map((shop) => ({
      ...shop,
      items: shop.items.map((item) => normalizeItem(item as unknown as Record<string, unknown>)),
    })),
  };
}

async function payloadHash(request: UploadRequest): Promise<string> {
  const canonical = JSON.stringify(normalizeUploadRequest(request));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function ingestUpload(source: AuthenticatedSource, request: UploadRequest, idempotencyKey: string, repo: MarketRepository, state: ListingStateService): Promise<UploadResult> {
  const batchId = canonicalBatchId(request);
  if (!isValidIdempotencyKey(idempotencyKey) || idempotencyKey !== batchId) throw new IngestionError(400, 'Idempotency-Key must match the canonical snapshot part');
  const hash = await payloadHash(request);
  const duplicate = await repo.getBatch(source.id, batchId);
  if (duplicate) {
    if (duplicate.payloadHash !== hash) throw new IngestionError(409, 'Idempotency key was reused with a different payload');
    if (duplicate.responseJson) return { ...(JSON.parse(duplicate.responseJson) as UploadResult), duplicate: true };
    throw new IngestionError(409, 'Batch is already processing');
  }
  const batch = await repo.insertBatch({ sourceId: source.id, batchId, snapshotId: request.snapshot_id, partIndex: request.part_index, partCount: request.part_count, snapshotMode: request.snapshot_mode, payloadHash: hash, responseJson: null, receivedAt: Date.parse(request.observed_at) });
  if (batch.inserted === false) {
    if (batch.payloadHash !== hash) throw new IngestionError(409, 'Idempotency key was reused with a different payload');
    if (batch.responseJson) return { ...(JSON.parse(batch.responseJson) as UploadResult), duplicate: true };
    throw new IngestionError(409, 'Batch is already processing');
  }
  const observations: NormalizedObservation[] = [];
  const sessionByShop = new Map<string, ShopSessionRow>();
  for (const shopInput of request.shops) {
    const session = await getOrStartShopSession(source.id, shopInput.shop_key, request.client_run_id, Date.parse(request.observed_at), repo, { vendorKey: shopInput.vendor_key, vendorName: shopInput.vendor_name, title: shopInput.title, shopType: shopInput.shop_type, mapName: shopInput.map_name, x: shopInput.x, y: shopInput.y });
    sessionByShop.set(shopInput.shop_key, session);
    for (const rawItem of shopInput.items) {
      const item = normalizeItem(rawItem as unknown as Record<string, unknown>);
      observations.push({ fingerprint: await computeItemFingerprint({ sourceId: source.id, shopSessionId: session.id, ...(item.item_key === undefined ? {} : { itemKey: item.item_key }), itemId: item.item_id, upgrade: item.upgrade, slots: item.slots, cards: item.cards, options: item.options }), item, sessionId: session.id, shopKey: shopInput.shop_key });
    }
  }
  if (request.snapshot_mode === 'heartbeat') {
    for (let index = 0; index < request.shops_seen.length; index += 40) {
      await repo.markShopHeartbeats(source.id, request.shops_seen.slice(index, index + 40), Date.parse(request.observed_at));
    }
  }
  const result = request.snapshot_mode === 'heartbeat' ? { processedListings: 0, changedListings: 0, soldEvents: 0 } : await applyBySession(source, state, observations, sessionByShop, batch.batchId, Date.parse(request.observed_at));
  if (request.snapshot_mode !== 'heartbeat' && repo.markListingsObserved) {
    const bySession = new Map<number, string[]>();
    for (const observation of observations) bySession.set(observation.sessionId, [...(bySession.get(observation.sessionId) ?? []), observation.fingerprint]);
    for (const [sessionId, fingerprints] of bySession) {
      for (let index = 0; index < fingerprints.length; index += 40) await repo.markListingsObserved(sessionId, fingerprints.slice(index, index + 40), batch.batchId, Date.parse(request.observed_at));
    }
  }
  const response: UploadResult = { accepted: true, batchId, duplicate: false, processedShops: request.shops.length, processedListings: result.processedListings, changedListings: result.changedListings, soldEvents: result.soldEvents, next: null };
  await repo.completeBatch(source.id, batch.batchId, response);
  if (request.snapshot_mode === 'full') await createSnapshotReconciler(repo).finalizeSnapshot(source.id, request.snapshot_id, Date.parse(request.observed_at));
  return response;
}

async function applyBySession(source: AuthenticatedSource, state: ListingStateService, observations: NormalizedObservation[], sessions: Map<string, ShopSessionRow>, batchId: string, observedAt: number): Promise<StateBatchResult> {
  const groups = new Map<number, NormalizedObservation[]>();
  for (const observation of observations) groups.set(observation.sessionId, [...(groups.get(observation.sessionId) ?? []), observation]);
  let result: StateBatchResult = { processedListings: 0, changedListings: 0, soldEvents: 0 };
  for (const [sessionId, group] of groups) {
    const session = [...sessions.values()].find((candidate) => candidate.id === sessionId);
    if (!session) throw new IngestionError(503, 'Session disappeared during upload');
    const next = await state.applyBatchObservations(source, session, group, batchId, observedAt);
    result = { processedListings: result.processedListings + next.processedListings, changedListings: result.changedListings + next.changedListings, soldEvents: result.soldEvents + next.soldEvents };
  }
  return result;
}
