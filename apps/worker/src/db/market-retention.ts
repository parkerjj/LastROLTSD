import type { MysqlDatabase } from './mysql-client';
import { lockMarketSource } from './snapshot-repository';
import { MARKET_RETENTION_MS } from '../domain/retention';

export interface MarketRetentionResult {
  cutoff: number;
  sources: number;
  snapshotListingsDeleted: number;
  snapshotShopsDeleted: number;
  snapshotsDeleted: number;
  uploadBatchesDeleted: number;
  listingOptionsDeleted: number;
  listingsDeleted: number;
  shopsDeleted: number;
}

/** Source locks are shared with upload/processing. Child-first deletes bound FK cascade work. */
export async function runMarketRetention(
  now: number, db: MysqlDatabase, policy: { chunkSize?: number; sourceLimit?: number; maxChunks?: number } = {},
): Promise<MarketRetentionResult> {
  const cutoff = Math.max(0, now - MARKET_RETENTION_MS);
  const limit = Math.min(500, Math.max(1, policy.chunkSize ?? 500));
  const sourceLimit = Math.min(20, Math.max(1, policy.sourceLimit ?? 5));
  const maxChunks = Math.min(20, Math.max(1, policy.maxChunks ?? 20));
  const result: MarketRetentionResult = { cutoff, sources: 0, snapshotListingsDeleted: 0, snapshotShopsDeleted: 0,
    snapshotsDeleted: 0, uploadBatchesDeleted: 0, listingOptionsDeleted: 0, listingsDeleted: 0, shopsDeleted: 0 };
  const sources = await db.all(`SELECT id FROM market_sources s
    WHERE active_full_snapshot_id IS NULL AND NOT EXISTS (SELECT 1 FROM market_snapshots ms
      WHERE ms.source_id = s.id AND ms.status IN ('receiving','queued','running'))
    ORDER BY retention_cutoff_at, id LIMIT ?`, [sourceLimit]);
  for (const candidate of sources) {
    for (let index = 0; index < maxChunks; index++) {
      const removed = await db.transaction(async (tx) => {
        const sourceId = String(candidate.id);
        const source = await lockMarketSource(tx, sourceId);
        if (source.active_full_snapshot_id != null || await tx.first(`SELECT snapshot_id FROM market_snapshots
          WHERE source_id = ? AND status IN ('receiving','queued','running') LIMIT 1`, [sourceId])) return null;
        const before = Math.max(cutoff, Number(source.retention_cutoff_at ?? 0));
        await tx.run('UPDATE market_sources SET retention_cutoff_at = ? WHERE id = ?', [before, sourceId]);
        const counts = { snapshotListingsDeleted: 0, snapshotShopsDeleted: 0, snapshotsDeleted: 0,
          uploadBatchesDeleted: 0, listingOptionsDeleted: 0, listingsDeleted: 0, shopsDeleted: 0 };
        const snapshots = await tx.all(`SELECT snapshot_id FROM market_snapshots WHERE source_id = ?
          AND snapshot_id <> ? AND status IN ('complete','failed') AND created_at < ?
          AND (completed_at IS NULL OR completed_at < ?) ORDER BY created_at, snapshot_id LIMIT ?`,
        [sourceId, source.last_full_snapshot_id ?? '', before, before, limit]);
        const snapshotIds = snapshots.map((row) => row.snapshot_id);
        const placeholders = snapshotIds.map(() => '?').join(',');
        if (snapshotIds.length) {
          counts.snapshotListingsDeleted = (await tx.run(`DELETE FROM market_snapshot_listings
            WHERE source_id = ? AND snapshot_id IN (${placeholders}) LIMIT ?`, [sourceId, ...snapshotIds, limit])).affectedRows;
          counts.snapshotShopsDeleted = (await tx.run(`DELETE FROM market_snapshot_shops
            WHERE source_id = ? AND snapshot_id IN (${placeholders}) AND NOT EXISTS (
              SELECT 1 FROM market_snapshot_listings child WHERE child.source_id = market_snapshot_shops.source_id
                AND child.snapshot_id = market_snapshot_shops.snapshot_id AND child.shop_ordinal = market_snapshot_shops.ordinal)
            LIMIT ?`, [sourceId, ...snapshotIds, limit])).affectedRows;
        }
        counts.uploadBatchesDeleted = (await tx.run(`DELETE FROM upload_batches
          WHERE source_id = ? AND snapshot_id <> ? AND status IN ('accepted','rejected')
            AND received_at < ? AND (completed_at IS NULL OR completed_at < ?)
            AND (snapshot_mode <> 'full' OR NOT EXISTS (SELECT 1 FROM market_snapshots ms
              WHERE ms.source_id = upload_batches.source_id AND ms.snapshot_id = upload_batches.snapshot_id
                AND (ms.status NOT IN ('complete','failed') OR ms.created_at >= ? OR ms.completed_at >= ?)))
          ORDER BY received_at, batch_id LIMIT ?`,
        [sourceId, source.last_full_snapshot_id ?? '', before, before, before, before, limit])).affectedRows;
        if (snapshotIds.length) {
          counts.snapshotsDeleted = (await tx.run(`DELETE FROM market_snapshots
            WHERE source_id = ? AND snapshot_id IN (${placeholders})
              AND NOT EXISTS (SELECT 1 FROM market_snapshot_shops child WHERE child.source_id = market_snapshots.source_id AND child.snapshot_id = market_snapshots.snapshot_id)
              AND NOT EXISTS (SELECT 1 FROM upload_batches batch WHERE batch.source_id = market_snapshots.source_id AND batch.snapshot_id = market_snapshots.snapshot_id)
            LIMIT ?`, [sourceId, ...snapshotIds, limit])).affectedRows;
        }
        // Keep recent history and snapshot references, even if the entity itself looks old.
        const listings = await tx.all(`SELECT l.id FROM listings l JOIN shops s ON s.id = l.shop_id
          WHERE s.source_id = ? AND l.status <> 'active' AND l.last_changed_at < ?
            AND NOT EXISTS (SELECT 1 FROM listing_events e WHERE e.listing_id = l.id)
            AND NOT EXISTS (SELECT 1 FROM market_snapshot_shops ss JOIN market_snapshots ms
              ON ms.source_id = ss.source_id AND ms.snapshot_id = ss.snapshot_id
              WHERE ss.source_id = s.source_id AND ss.identity_hash = s.identity_hash AND ms.status <> 'complete')
          ORDER BY l.last_changed_at, l.id LIMIT ?`, [sourceId, before, limit]);
        if (listings.length) {
          const ids = listings.map((row) => row.id);
          const keys = ids.map(() => '?').join(',');
          // At most 32 option tuples per listing, enforced by the upload protocol.
          counts.listingOptionsDeleted = (await tx.run(`DELETE FROM listing_options WHERE listing_id IN (${keys})`, ids)).affectedRows;
          counts.listingsDeleted = (await tx.run(`DELETE FROM listings WHERE id IN (${keys})`, ids)).affectedRows;
        }
        const shops = await tx.all(`SELECT s.id FROM shops s WHERE s.source_id = ? AND s.status <> 'active'
          AND s.last_status_observed_at < ? AND s.last_changed_at < ?
          AND (s.last_inventory_observed_at IS NULL OR s.last_inventory_observed_at < ?)
          AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.shop_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM market_snapshot_shops ss JOIN market_snapshots ms
            ON ms.source_id = ss.source_id AND ms.snapshot_id = ss.snapshot_id
            WHERE ss.source_id = s.source_id AND ss.identity_hash = s.identity_hash AND ms.status <> 'complete')
          ORDER BY s.last_status_observed_at, s.id LIMIT ?`, [sourceId, before, before, before, limit]);
        if (shops.length) counts.shopsDeleted = (await tx.run(`DELETE FROM shops WHERE id IN (${shops.map(() => '?').join(',')})`, shops.map((row) => row.id))).affectedRows;
        return counts;
      });
      if (!removed) break;
      if (index === 0) result.sources++;
      for (const key of Object.keys(removed) as Array<keyof typeof removed>) result[key] += removed[key];
      if (Object.entries(removed).every(([key, count]) => key === 'listingOptionsDeleted' || count < limit)) break;
      }
  }
  return result;
}
