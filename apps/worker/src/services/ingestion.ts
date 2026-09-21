import type { UploadItem, UploadRequest, UploadShop } from '@lastroweb/protocol';
import { normalizeItem } from '@lastroweb/protocol';
import { computeItemFingerprint } from '../domain/fingerprint';
import { computeShopIdentity } from '../domain/shop-identity';
import type { MarketRepository, ShopResolution, UploadResultLike } from '../db/repository';
import type { ShopSessionRow } from '../db/types';
import type { AuthenticatedSource } from '../middleware/auth';
import { createSnapshotReconciler } from './snapshot-reconciler';

export interface NormalizedObservation { fingerprint: string; item: UploadItem; sessionId: number; shopId: string; }
export interface StateBatchResult { processedListings: number; changedListings: number; soldEvents: number; }
export interface ListingStateService { applyBatchObservations(source: AuthenticatedSource, session: ShopSessionRow, observations: NormalizedObservation[], batchId: string, observedAt: number): Promise<StateBatchResult>; applyBatchObservationsBulk?(source: AuthenticatedSource, sessions: Map<number, ShopSessionRow>, observations: NormalizedObservation[], batchId: string, observedAt: number): Promise<StateBatchResult>; }
export interface UploadResult extends UploadResultLike {}
export class IngestionError extends Error { constructor(public readonly status: 400 | 409 | 503, message: string) { super(message); this.name = 'IngestionError'; } }

export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const SHOP_RESOLUTION_CONCURRENCY = 16;
const ITEM_FINGERPRINT_CONCURRENCY = 32;

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  };
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function canonicalBatchId(request: Pick<UploadRequest, 'snapshot_id' | 'part_index'>): string {
  return `${request.snapshot_id}/${request.part_index}`;
}

export function isValidIdempotencyKey(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= MAX_IDEMPOTENCY_KEY_LENGTH && value.trim() === value && /^[\x21-\x7e]+$/.test(value);
}

function normalizeUploadRequest(request: UploadRequest): UploadRequest {
  return { ...request, shops: request.shops.map((shop) => ({ ...shop, items: shop.items.map((item) => normalizeItem(item as unknown as Record<string, unknown>)) })) };
}

async function payloadHash(request: UploadRequest): Promise<string> {
  const canonical = JSON.stringify(normalizeUploadRequest(request));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function resolveShop(sourceId: string, clientRunId: string, batchId: string, observedAt: number, shop: UploadShop, repo: MarketRepository, resolvedIdentity?: { identityHash: string; shopId: string }): Promise<ShopResolution> {
  if (!repo.resolveShopObservation) throw new IngestionError(503, 'Repository cannot resolve protocol 2 shop identity');
  const identity = resolvedIdentity ?? await computeShopIdentity({ sourceId, vendorAccountId: shop.vendor_account_id, shopType: shop.shop_type, mapName: shop.map_name, x: shop.x, y: shop.y, title: shop.title });
  return repo.resolveShopObservation({ sourceId, identityHash: identity.identityHash, shopId: identity.shopId, shopStatus: shop.shop_status, batchId, vendorAccountId: shop.vendor_account_id, clientRunId, observedAt, vendorName: shop.vendor_name, title: shop.title, shopType: shop.shop_type, mapName: shop.map_name, x: shop.x, y: shop.y });
}

export async function ingestUpload(source: AuthenticatedSource, request: UploadRequest, idempotencyKey: string, repo: MarketRepository, state: ListingStateService): Promise<UploadResult> {
  const batchId = canonicalBatchId(request);
  if (!isValidIdempotencyKey(idempotencyKey) || idempotencyKey !== batchId) throw new IngestionError(400, 'Idempotency-Key must match the canonical snapshot part');
  const hash = await payloadHash(request);
  const duplicate = await repo.getBatch(source.id, batchId);
  let batch: Awaited<ReturnType<MarketRepository['insertBatch']>> | undefined;
  let retryingRejected = false;
  if (duplicate) {
    if (duplicate.payloadHash !== hash) throw new IngestionError(409, 'Idempotency key was reused with a different payload');
    if (duplicate.responseJson) return { ...(JSON.parse(duplicate.responseJson) as UploadResult), duplicate: true };
    if (duplicate.status === 'rejected' && repo.retryBatch) {
      if (await repo.retryBatch(source.id, batchId) === false) throw new IngestionError(409, 'Batch retry was claimed by another request');
      batch = { ...duplicate, status: 'processing' };
      retryingRejected = true;
    } else throw new IngestionError(409, 'Batch is already processing');
  }
  if (!retryingRejected) {
    batch = await repo.insertBatch({ sourceId: source.id, batchId, snapshotId: request.snapshot_id, partIndex: request.part_index, partCount: request.part_count, snapshotMode: request.snapshot_mode, payloadHash: hash, responseJson: null, receivedAt: Date.parse(request.observed_at) });
    if (!batch) throw new IngestionError(503, 'Batch claim failed');
    if (batch.inserted === false) {
      if (batch.payloadHash !== hash) throw new IngestionError(409, 'Idempotency key was reused with a different payload');
      if (batch.responseJson) return { ...(JSON.parse(batch.responseJson) as UploadResult), duplicate: true };
      if (batch.status === 'rejected' && repo.retryBatch) {
        if (await repo.retryBatch(source.id, batchId) === false) throw new IngestionError(409, 'Batch retry was claimed by another request');
        batch = { ...batch, status: 'processing' };
      } else throw new IngestionError(409, 'Batch is already processing');
    }
  }
  if (!batch) throw new IngestionError(503, 'Batch claim failed');

  try {
    const observedAt = Date.parse(request.observed_at);
    const identityHashes = new Set<string>();
    const resolved = await mapConcurrent(request.shops, SHOP_RESOLUTION_CONCURRENCY, async (input) => {
      const identity = await computeShopIdentity({ sourceId: source.id, vendorAccountId: input.vendor_account_id, shopType: input.shop_type, mapName: input.map_name, x: input.x, y: input.y, title: input.title });
      if (identityHashes.has(identity.identityHash)) throw new IngestionError(400, 'Shop canonical identity must be unique within a batch');
      identityHashes.add(identity.identityHash);
      return { input, resolution: await resolveShop(source.id, request.client_run_id, batchId, observedAt, input, repo, identity) };
    });

    const opening = resolved.filter((entry) => entry.input.shop_status === 'opening' && entry.resolution.applied && entry.resolution.session);
    const sessions = opening.map((entry) => entry.resolution.session!);
    if (request.snapshot_mode !== 'full' && sessions.some((session) => !session.initialSyncComplete)) throw new IngestionError(409, 'The first upload for a shop session must be a full snapshot');

    const observationGroups = await mapConcurrent(opening, SHOP_RESOLUTION_CONCURRENCY, async ({ input, resolution }) => {
      const session = resolution.session!;
      if (request.snapshot_mode === 'heartbeat') return [];
      return mapConcurrent(input.items, ITEM_FINGERPRINT_CONCURRENCY, async (rawItem) => {
        const item = normalizeItem(rawItem as unknown as Record<string, unknown>);
        return { fingerprint: await computeItemFingerprint({ sourceId: source.id, shopSessionId: session.id, ...(item.item_key === undefined ? {} : { itemKey: item.item_key }), itemId: item.item_id, upgrade: item.upgrade, slots: item.slots, cards: item.cards, options: item.options }), item, sessionId: session.id, shopId: resolution.shopId };
      });
    });
    const observations = observationGroups.flat();

    if (request.snapshot_mode === 'full' && repo.recordSnapshotSessions) await repo.recordSnapshotSessions(source.id, request.snapshot_id, [...new Set(sessions.map((session) => session.id))], observedAt);
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const stateResult = request.snapshot_mode === 'heartbeat'
      ? { processedListings: 0, changedListings: 0, soldEvents: 0 }
      : state.applyBatchObservationsBulk
        ? await state.applyBatchObservationsBulk(source, sessionsById, observations, batch.batchId, observedAt)
        : await applyBySession(source, state, observations, sessionsById, batch.batchId, observedAt);

    if (request.snapshot_mode !== 'heartbeat' && repo.markListingsObservedBulk) await repo.markListingsObservedBulk(observations.map((observation) => ({ sessionId: observation.sessionId, fingerprint: observation.fingerprint })), batch.batchId, observedAt);
    else if (request.snapshot_mode !== 'heartbeat' && repo.markListingsObserved) {
      const bySession = new Map<number, string[]>();
      for (const observation of observations) bySession.set(observation.sessionId, [...(bySession.get(observation.sessionId) ?? []), observation.fingerprint]);
      for (const [sessionId, fingerprints] of bySession) for (let index = 0; index < fingerprints.length; index += 40) await repo.markListingsObserved(sessionId, fingerprints.slice(index, index + 40), batch.batchId, observedAt);
    }

    const response: UploadResult = { accepted: true, batch_id: batchId, duplicate: false, processed_shops: request.shops.length, processed_listings: stateResult.processedListings, changed_listings: stateResult.changedListings, sold_events: stateResult.soldEvents, shops: resolved.map(({ input, resolution }) => ({ uuid: input.uuid, shop_id: resolution.shopId, shop_status: input.shop_status, applied: resolution.applied, resolution: resolution.resolution })), next: null };
    await repo.completeBatch(source.id, batch.batchId, response);
    if (request.snapshot_mode === 'full') await createSnapshotReconciler(repo).finalizeSnapshot(source.id, request.snapshot_id, observedAt);
    return response;
  } catch (error) {
    if (repo.failBatch) await repo.failBatch(source.id, batch.batchId);
    throw error;
  }
}

async function applyBySession(source: AuthenticatedSource, state: ListingStateService, observations: NormalizedObservation[], sessions: Map<number, ShopSessionRow>, batchId: string, observedAt: number): Promise<StateBatchResult> {
  const groups = new Map<number, NormalizedObservation[]>();
  for (const observation of observations) groups.set(observation.sessionId, [...(groups.get(observation.sessionId) ?? []), observation]);
  let result: StateBatchResult = { processedListings: 0, changedListings: 0, soldEvents: 0 };
  for (const [sessionId, group] of groups) {
    const session = sessions.get(sessionId);
    if (!session) throw new IngestionError(503, 'Session disappeared during upload');
    const next = await state.applyBatchObservations(source, session, group, batchId, observedAt);
    result = { processedListings: result.processedListings + next.processedListings, changedListings: result.changedListings + next.changedListings, soldEvents: result.soldEvents + next.soldEvents };
  }
  return result;
}
