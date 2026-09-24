import { normalizeItem, type UploadShop } from '@lastroweb/protocol';
import type { MysqlDatabase } from '../db/mysql-client';
import { createMysqlRepository } from '../db/mysql-repository';
import type { ChunkProgress, SnapshotJob } from '../db/snapshot-repository';
import type { ShopSessionRow } from '../db/types';
import { computeItemFingerprint } from '../domain/fingerprint';
import { computeShopProfileHash } from '../domain/shop-state';
import { makeTransitionKey } from '../domain/transitions';
import { createListingStateService } from './state-transition';
import type { NormalizedObservation } from './ingestion';

export interface SnapshotChunkConfig { reconcileBatchSize: number; }
export const DEFAULT_SNAPSHOT_CHUNK_CONFIG: SnapshotChunkConfig = { reconcileBatchSize: 200 };

const scope = (job: SnapshotJob): [string, string] => [job.sourceId, job.snapshotId];
const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;

async function materialize(job: SnapshotJob, tx: MysqlDatabase): Promise<ChunkProgress> {
  if (job.cursor >= job.partCount) return { stage: 'reconcile_shops', cursor: 0, processed: 0 };
  // One client part is one invocation. The protocol permits at most 300 shops per
  // part; this stride is an address, not an additional server-side chunk limit.
  const firstOrdinal = job.cursor * 300;
  const rows = await tx.all(`SELECT ordinal, identity_hash, public_shop_id, CAST(shop_json AS CHAR) AS shop_json,
      content_hash, item_count, item_cursor, shop_id, baseline_complete, skip_items
    FROM market_snapshot_shops WHERE source_id = ? AND snapshot_id = ? AND ordinal > ?
      AND ordinal <= ? ORDER BY ordinal`, [...scope(job), firstOrdinal, firstOrdinal + 300]);
  if (rows.length === 0) return { stage: 'materialize_parts', cursor: job.cursor + 1, processed: 0 };
  const selected = rows;
  const ordinals = JSON.stringify(selected.map((row) => Number(row.ordinal)));
  const currentRows = await tx.all(`SELECT s.id, s.identity_hash, s.full_state_hash, s.full_snapshot_at, s.status,
      s.last_status_observed_at, s.last_inventory_observed_at, s.inventory_epoch_at
    FROM shops s JOIN market_snapshot_shops ss ON ss.source_id = s.source_id AND ss.identity_hash = s.identity_hash
    JOIN JSON_TABLE(?, '$[*]' COLUMNS(ordinal INT PATH '$')) AS chosen ON chosen.ordinal = ss.ordinal
    WHERE ss.source_id = ? AND ss.snapshot_id = ?`, [ordinals, ...scope(job)]);
  const current = new Map(currentRows.map((row) => [String(row.identity_hash), row]));
  const shops = selected.map((row) => json<UploadShop>(row.shop_json));
  // Full dismissals expire listings in the bounded reconciliation stage.
  const repo = createMysqlRepository(tx, undefined, { deferListingExpiry: true });
  const contexts = await Promise.all(selected.map(async (row, index) => {
    const shop = shops[index]!;
    return { sourceId: job.sourceId, identityHash: String(row.identity_hash), shopId: String(row.public_shop_id),
      shopStatus: shop.shop_status, batchId: job.snapshotId, clientRunId: job.clientRunId, observedAt: job.observedAt,
      vendorAccountId: shop.vendor_account_id, vendorName: shop.vendor_name, title: shop.title, shopType: shop.shop_type,
      mapName: shop.map_name, x: shop.x, y: shop.y, profileHash: await computeShopProfileHash(shop) };
  }));
  const resolutions = await repo.resolveShopObservations!(contexts);
  const sessions = new Map<number, ShopSessionRow>();
  const updates = selected.map((row, index) => {
    const existing = current.get(String(row.identity_hash));
    const result = resolutions[index]!;
    const baseline = row.shop_id == null ? existing?.status !== 'closed' && existing?.full_snapshot_at != null : Boolean(row.baseline_complete);
    // A heartbeat or partial delta may be newer than this full. Keep its live
    // metadata, but still initialize older full items that delta never mentioned.
    // Only a later complete inventory or a close/reopen boundary invalidates them.
    const inventoryAllowed = shops[index]!.shop_status === 'opening'
      && (result.applied || existing?.status !== 'closed')
      && (existing?.inventory_epoch_at == null || Number(existing.inventory_epoch_at) < job.observedAt)
      && (existing?.full_snapshot_at == null || Number(existing.full_snapshot_at) <= job.observedAt);
    const skip = Boolean(row.skip_items) || !inventoryAllowed
      || (row.shop_id == null && existing?.status !== 'closed' && existing?.full_state_hash === row.content_hash && baseline);
    if (inventoryAllowed) sessions.set(result.internalShopId, result.session ? { ...result.session, initialSyncComplete: baseline } : {
      id: result.internalShopId, shopId: result.internalShopId, clientRunId: job.clientRunId, startedAt: job.observedAt,
      lastSeenAt: Number(existing?.last_status_observed_at ?? job.observedAt), endedAt: null,
      initialSyncComplete: baseline, lastCompleteSnapshotId: null,
    });
    return { ordinal: Number(row.ordinal), shopId: result.internalShopId, baseline, skip,
      start: 0, count: skip ? 0 : Number(row.item_count), complete: true };
  });
  const allocation = JSON.stringify(updates);
  const items = await tx.all(`SELECT ss.ordinal, item_position.position - 1 AS item_index,
      CAST(JSON_EXTRACT(ss.items_json, CONCAT('$[', item_position.position - 1, ']')) AS CHAR) AS item_json
    FROM market_snapshot_shops ss
      JOIN JSON_TABLE(?, '$[*]' COLUMNS(ordinal INT PATH '$.ordinal', start_index INT PATH '$.start', item_count INT PATH '$.count')) AS chosen
        ON chosen.ordinal = ss.ordinal
      JOIN JSON_TABLE(ss.items_json, '$[*]' COLUMNS(position FOR ORDINALITY)) AS item_position
        ON item_position.position > chosen.start_index AND item_position.position <= chosen.start_index + chosen.item_count
      WHERE ss.source_id = ? AND ss.snapshot_id = ? ORDER BY ss.ordinal, item_index`,
  [allocation, ...scope(job)]);
  const updatesByOrdinal = new Map(updates.map((row) => [row.ordinal, row]));
  const processedByOrdinal = new Map<number, number>();
  const observations = await Promise.all(items.map(async (row): Promise<NormalizedObservation> => {
    const owner = updatesByOrdinal.get(Number(row.ordinal))!;
    processedByOrdinal.set(owner.ordinal, (processedByOrdinal.get(owner.ordinal) ?? 0) + 1);
    const item = normalizeItem(json<Record<string, unknown>>(row.item_json));
    const fingerprint = await computeItemFingerprint({ sourceId: job.sourceId, shopSessionId: owner.shopId,
      ...(item.item_key === undefined ? {} : { itemKey: item.item_key }), itemId: item.item_id, upgrade: item.upgrade, slots: item.slots, cards: item.cards, options: item.options });
    return { sessionId: owner.shopId, shopId: '', fingerprint, item };
  }));
  if (observations.length > 0) {
    const presence = observations.map((observation, index) => ({ ordinal: Number(items[index]!.ordinal), fingerprint: observation.fingerprint }));
    // A duplicate fingerprint is invalid full input.
    // The transaction rolls back before any market mutation can escape.
    await tx.run(`INSERT INTO market_snapshot_listings(source_id, snapshot_id, shop_ordinal, fingerprint)
      SELECT ?, ?, present.ordinal, present.fingerprint FROM JSON_TABLE(?, '$[*]' COLUMNS(
        ordinal INT PATH '$.ordinal', fingerprint CHAR(64) PATH '$.fingerprint')) AS present`, [...scope(job), JSON.stringify(presence)]);
    const source = { id: job.sourceId, name: '', apiKeyHash: '', tokenHash: '', status: 'active' as const };
    await createListingStateService(repo).applyBatchObservationsBulk!(source, sessions, observations, job.snapshotId, job.observedAt);
  }
  const progress = updates.map((row) => {
    const itemCursor = row.start + (processedByOrdinal.get(row.ordinal) ?? 0);
    return { ...row, itemCursor };
  });
  await tx.run(`UPDATE market_snapshot_shops ss JOIN JSON_TABLE(?, '$[*]' COLUMNS(
      ordinal INT PATH '$.ordinal', shop_id BIGINT PATH '$.shopId', baseline BOOLEAN PATH '$.baseline', skip_items BOOLEAN PATH '$.skip',
      item_cursor INT PATH '$.itemCursor', complete BOOLEAN PATH '$.complete')) AS progress ON progress.ordinal = ss.ordinal
    SET ss.shop_id = progress.shop_id, ss.baseline_complete = progress.baseline, ss.skip_items = progress.skip_items,
      ss.item_cursor = progress.item_cursor, ss.materialized = progress.complete
    WHERE ss.source_id = ? AND ss.snapshot_id = ?`, [JSON.stringify(progress), ...scope(job)]);
  await tx.run(`UPDATE shops s JOIN market_snapshot_shops ss ON ss.shop_id = s.id
    JOIN JSON_TABLE(?, '$[*]' COLUMNS(ordinal INT PATH '$')) AS chosen ON chosen.ordinal = ss.ordinal
    SET s.full_state_hash = NULL, s.last_inventory_observed_at = GREATEST(COALESCE(s.last_inventory_observed_at, 0), ?)
    WHERE ss.source_id = ? AND ss.snapshot_id = ? AND ss.skip_items = FALSE`, [ordinals, job.observedAt, ...scope(job)]);
  return { stage: 'materialize_parts', cursor: job.cursor + 1, processed: observations.length };
}

async function reconcileListings(job: SnapshotJob, tx: MysqlDatabase, config: SnapshotChunkConfig): Promise<ChunkProgress> {
  const rows = await tx.all(`SELECT l.id, l.price, l.quantity, l.state_version, l.missing_full_count, ss.baseline_complete,
      (s.status = 'closed' OR ss.ordinal IS NULL) AS expire
    FROM listings l JOIN shops s ON s.id = l.shop_id
    LEFT JOIN market_snapshot_shops ss ON ss.source_id = s.source_id AND ss.snapshot_id = ? AND ss.identity_hash = s.identity_hash
    WHERE s.source_id = ? AND l.id > ? AND l.status IN ('active', 'missing')
      AND l.last_changed_at <= ?
      AND (((s.status = 'closed' OR ss.ordinal IS NULL) AND s.last_status_observed_at <= ?)
        OR (ss.skip_items = FALSE AND s.status <> 'closed' AND COALESCE(s.last_inventory_observed_at, 0) <= ? AND l.missing_full_count < 2
        AND NOT EXISTS (SELECT 1 FROM market_snapshot_listings present WHERE present.source_id = ss.source_id
          AND present.snapshot_id = ss.snapshot_id AND present.shop_ordinal = ss.ordinal AND present.fingerprint = l.item_fingerprint)))
    ORDER BY l.id LIMIT ?`, [job.snapshotId, job.sourceId, job.cursor, job.observedAt, job.observedAt, job.observedAt, config.reconcileBatchSize]);
  if (rows.length === 0) return { stage: 'publish_hashes', cursor: 0, processed: 0 };
  const changes = await Promise.all(rows.map(async (row) => {
    const expire = Boolean(row.expire);
    const missing = expire ? 0 : Number(row.missing_full_count) + 1;
    const sold = !expire && Boolean(row.baseline_complete) && missing === 2 ? Number(row.quantity) : 0;
    return { id: Number(row.id), version: Number(row.state_version), price: Number(row.price), quantity: Number(row.quantity),
      missing, status: expire ? 'expired' : missing >= 2 ? 'missing' : 'active', event: expire ? 'expired' : 'missing',
      reason: expire ? 'shop_closed' : 'missing_full', sold,
      transitionKey: await makeTransitionKey(Number(row.id), Number(row.state_version), Number(row.quantity), sold > 0 ? 0 : Number(row.quantity), expire ? 'shop_closed' : 'missing_full') };
  }));
  const table = `JSON_TABLE(?, '$[*]' COLUMNS(id BIGINT PATH '$.id', version BIGINT PATH '$.version', price BIGINT PATH '$.price',
    quantity BIGINT PATH '$.quantity', missing INT PATH '$.missing', status VARCHAR(16) PATH '$.status',
    event_type VARCHAR(32) PATH '$.event', reason VARCHAR(32) PATH '$.reason', sold BIGINT PATH '$.sold', transition_key VARCHAR(255) PATH '$.transitionKey')) AS change_row`;
  const payload = JSON.stringify(changes);
  await tx.run(`INSERT INTO listing_events(listing_id, snapshot_id, observed_at, event_type, from_price, to_price,
      from_quantity, to_quantity, sold_quantity, reason, transition_key)
    SELECT l.id, ?, ?, change_row.event_type, l.price, l.price, l.quantity,
      CASE WHEN change_row.sold > 0 THEN 0 ELSE l.quantity END, change_row.sold, change_row.reason, change_row.transition_key
    FROM listings l JOIN ${table} ON change_row.id = l.id AND change_row.version = l.state_version
    ON DUPLICATE KEY UPDATE transition_key = listing_events.transition_key`, [job.snapshotId, job.observedAt, payload]);
  await tx.run(`UPDATE listings l JOIN ${table} ON change_row.id = l.id AND change_row.version = l.state_version
    SET l.status = change_row.status, l.missing_full_count = change_row.missing, l.last_missing_snapshot_id = ?,
      l.last_changed_at = ?, l.state_version = l.state_version + 1`, [payload, job.snapshotId, job.observedAt]);
  return { stage: 'reconcile_listings', cursor: Number(rows.at(-1)!.id), processed: rows.length };
}

async function reconcileShops(job: SnapshotJob, tx: MysqlDatabase, config: SnapshotChunkConfig): Promise<ChunkProgress> {
  const rows = await tx.all(`SELECT s.id FROM shops s WHERE s.source_id = ? AND s.id > ? AND s.status IN ('active', 'stale')
    AND s.last_status_observed_at <= ? AND NOT EXISTS (SELECT 1 FROM market_snapshot_shops ss
      WHERE ss.source_id = s.source_id AND ss.snapshot_id = ? AND ss.identity_hash = s.identity_hash)
    ORDER BY s.id LIMIT ?`, [job.sourceId, job.cursor, job.observedAt, job.snapshotId, config.reconcileBatchSize]);
  if (rows.length === 0) return { stage: 'reconcile_listings', cursor: 0, processed: 0 };
  await tx.run(`UPDATE shops s JOIN JSON_TABLE(?, '$[*]' COLUMNS(id BIGINT PATH '$')) AS chosen ON chosen.id = s.id
    SET s.status = 'closed', s.full_state_hash = NULL, s.full_snapshot_at = NULL, s.inventory_epoch_at = ?,
      s.missing_full_count = 0, s.last_missing_snapshot_id = ?,
      s.last_status_observed_at = ?, s.last_changed_at = ?, s.closed_at = ?, s.close_reason = 'missing_full', s.state_version = s.state_version + 1
    WHERE s.source_id = ? AND s.last_status_observed_at <= ?`,
  [JSON.stringify(rows.map((row) => Number(row.id))), job.observedAt, job.snapshotId, job.observedAt, job.observedAt, job.observedAt, job.sourceId, job.observedAt]);
  return { stage: 'reconcile_shops', cursor: Number(rows.at(-1)!.id), processed: rows.length };
}

async function publishHashes(job: SnapshotJob, tx: MysqlDatabase, config: SnapshotChunkConfig): Promise<ChunkProgress> {
  const rows = await tx.all(`SELECT ordinal FROM market_snapshot_shops WHERE source_id = ? AND snapshot_id = ?
    AND ordinal > ? ORDER BY ordinal LIMIT ?`, [...scope(job), job.cursor, config.reconcileBatchSize]);
  if (rows.length === 0) return { stage: 'finalize', cursor: 0, processed: 0 };
  const cursor = Number(rows.at(-1)!.ordinal);
  await tx.run(`UPDATE shops s JOIN market_snapshot_shops ss ON ss.shop_id = s.id
    SET s.full_state_hash = CASE WHEN COALESCE(s.last_inventory_observed_at, 0) > ? OR EXISTS (SELECT 1 FROM listings l WHERE l.shop_id = s.id
        AND l.missing_full_count = 1 AND l.status IN ('active', 'missing')) THEN NULL ELSE ss.content_hash END,
      s.full_snapshot_at = GREATEST(COALESCE(s.full_snapshot_at, 0), ?)
    WHERE ss.source_id = ? AND ss.snapshot_id = ? AND ss.ordinal > ? AND ss.ordinal <= ?
      AND ss.materialized = TRUE AND s.status <> 'closed'
      AND JSON_UNQUOTE(JSON_EXTRACT(ss.shop_json, '$.shop_status')) = 'opening'
      AND (s.inventory_epoch_at IS NULL OR s.inventory_epoch_at < ?)
      AND (s.full_snapshot_at IS NULL OR s.full_snapshot_at <= ?)`,
  [job.observedAt, job.observedAt, ...scope(job), job.cursor, cursor, job.observedAt, job.observedAt]);
  return { stage: 'publish_hashes', cursor, processed: rows.length };
}

export async function runSnapshotJobChunk(job: SnapshotJob, tx: MysqlDatabase, config = DEFAULT_SNAPSHOT_CHUNK_CONFIG): Promise<ChunkProgress> {
  switch (job.stage) {
    case 'materialize_parts': return materialize(job, tx);
    case 'reconcile_listings': return reconcileListings(job, tx, config);
    case 'reconcile_shops': return reconcileShops(job, tx, config);
    case 'publish_hashes': return publishHashes(job, tx, config);
    case 'finalize':
      await tx.run(`UPDATE market_sources SET last_full_snapshot_id = ?, last_full_snapshot_at = ?,
        last_upload_at = GREATEST(COALESCE(last_upload_at, 0), ?), updated_at = GREATEST(updated_at, ?)
        WHERE id = ? AND (last_full_snapshot_at IS NULL OR last_full_snapshot_at < ?)`,
      [job.snapshotId, job.observedAt, job.observedAt, job.observedAt, job.sourceId, job.observedAt]);
      return { stage: 'finalize', cursor: 0, complete: true, processed: 1 };
  }
}
