import type { MysqlDatabase } from '../db/mysql-client';
import { createMysqlRepository } from '../db/mysql-repository';
import { createSnapshotRepository, lockMarketSource, transactionView } from '../db/snapshot-repository';
import type { AppEnv } from '../env';
import type { UploadHandler } from '../routes/upload';
import { receiveFullUpload } from './full-upload';
import { createSnapshotDispatcher } from './snapshot-dispatcher';
import { ingestUpload, IngestionError } from './ingestion';
import { createListingStateService } from './state-transition';

export function createUploadHandler(db: MysqlDatabase, env: AppEnv): UploadHandler {
  const snapshots = createSnapshotRepository(db);
  return async (source, request, key) => {
    if (request.snapshot_mode === 'full') return receiveFullUpload(source, request, key, snapshots, createSnapshotDispatcher(env, snapshots));
    return db.transaction(async (connection) => {
      const tx = transactionView(connection);
      await lockMarketSource(tx, source.id);
      if (await tx.first('SELECT snapshot_id FROM market_snapshots WHERE source_id = ? AND snapshot_id = ?', [source.id, request.snapshot_id])) {
        throw new IngestionError(422, 'idempotency_key_reused', 'Snapshot ID is already used by a full upload', { action: 'new_snapshot' });
      }
      const repo = createMysqlRepository(tx, env.CURSOR_SECRET);
      const result = await ingestUpload(source, request, key, repo, createListingStateService(repo));
      // An actual delta invalidates the unchanged-content shortcut. Heartbeats
      // retain it, and stale observations cannot invalidate a newer baseline.
      if (request.snapshot_mode === 'delta' && !result.duplicate) {
        const changedIds = result.shops.filter((shop, index) => shop.applied && (request.shops[index]!.items.length > 0 || shop.shop_status === 'dismissed')).map((shop) => shop.shop_id);
        if (changedIds.length) await tx.run(`UPDATE shops s JOIN JSON_TABLE(?, '$[*]' COLUMNS(public_id VARCHAR(191) PATH '$')) AS changed
          ON changed.public_id = s.public_shop_id SET s.full_state_hash = NULL,
            s.last_inventory_observed_at = GREATEST(COALESCE(s.last_inventory_observed_at, 0), ?)
          WHERE s.source_id = ? AND s.last_status_observed_at <= ?`,
        [JSON.stringify(changedIds), Date.parse(request.observed_at), source.id, Date.parse(request.observed_at)]);
      }
      return result;
    });
  };
}
