import { DEFAULT_CURSOR_SECRET } from '../domain/search';
import { chunkRows, type MysqlDatabase, type MysqlRow } from './mysql-client';
import type { BatchRow, ShopRow, ShopSessionRow, SourceRow, VendorInput, VendorRow } from './types';
import type { MarketRepository, ShopResolution, ShopSessionContextInput, UploadResultLike } from './repository';

type Row = MysqlRow;

// A JSON parameter keeps a large upload set-based. It is deliberately not expanded
// into one query per shop, which would make a 1,000-shop snapshot pathological.
const SHOP_JSON_TABLE = `JSON_TABLE(?, '$[*]' COLUMNS(
  source_id VARCHAR(191) PATH '$.sourceId',
  identity_hash CHAR(64) PATH '$.identityHash',
  public_shop_id VARCHAR(191) PATH '$.shopId',
  shop_status VARCHAR(16) PATH '$.shopStatus',
  vendor_account_id VARCHAR(191) PATH '$.vendorAccountId',
  vendor_name VARCHAR(191) PATH '$.vendorName',
  vendor_name_normalized VARCHAR(128) PATH '$.vendorNameNormalized',
  title VARCHAR(191) PATH '$.title',
  title_normalized VARCHAR(128) PATH '$.titleNormalized',
  shop_type VARCHAR(4) PATH '$.shopType',
  map_name VARCHAR(64) PATH '$.mapName',
  x INT UNSIGNED PATH '$.x',
  y INT UNSIGNED PATH '$.y',
  profile_hash CHAR(64) PATH '$.profileHash',
  full_state_hash CHAR(64) PATH '$.fullStateHash' NULL ON EMPTY,
  observed_at BIGINT UNSIGNED PATH '$.observedAt'
)) AS observation`;

const shopResolutionKey = (sourceId: string, identityHash: string): string => JSON.stringify([sourceId, identityHash]);

function normalizeCatalogQuery(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function shopResolutionPayload(inputs: readonly ShopSessionContextInput[]): string {
  return JSON.stringify(inputs.map((input) => ({
    sourceId: input.sourceId,
    identityHash: input.identityHash,
    shopId: input.shopId,
    shopStatus: input.shopStatus,
    vendorAccountId: input.vendorAccountId,
    vendorName: input.vendorName,
    vendorNameNormalized: normalizeCatalogQuery(input.vendorName),
    title: input.title,
    titleNormalized: normalizeCatalogQuery(input.title),
    shopType: input.shopType,
    mapName: input.mapName,
    x: input.x,
    y: input.y,
    profileHash: input.profileHash ?? input.identityHash,
    fullStateHash: input.fullStateHash ?? null,
    observedAt: input.observedAt,
  })));
}

function isStaleShopObservation(existing: Row | undefined, input: ShopSessionContextInput): boolean {
  return existing !== undefined && (
    input.observedAt < Number(existing.last_status_observed_at)
    || (input.observedAt === Number(existing.last_status_observed_at) && input.shopStatus === 'opening' && String(existing.status) === 'closed')
  );
}

function sessionFromShopRow(row: Row, clientRunId: string, observedAt: number): ShopSessionRow {
  const lastSeenAt = Math.max(Number(row.last_status_observed_at ?? 0), observedAt);
  return {
    id: Number(row.id),
    shopId: Number(row.id),
    clientRunId,
    startedAt: Number(row.last_changed_at ?? observedAt),
    lastSeenAt,
    endedAt: row.status === 'closed' && row.closed_at != null ? Number(row.closed_at) : null,
    initialSyncComplete: row.full_state_hash != null,
    lastCompleteSnapshotId: row.full_state_hash == null ? null : String(row.full_state_hash),
  };
}

function batchFromRow(row: Row): BatchRow {
  return {
    id: Number(row.id ?? 0),
    sourceId: String(row.source_id),
    batchId: String(row.batch_id),
    snapshotId: String(row.snapshot_id),
    partIndex: Number(row.part_index),
    partCount: Number(row.part_count),
    snapshotMode: String(row.snapshot_mode) as BatchRow['snapshotMode'],
    payloadHash: String(row.payload_hash),
    status: String(row.status),
    responseJson: row.response_json == null ? null : String(row.response_json),
  };
}

function shopFromRow(row: Row, sourceId: string, vendorId: number): ShopRow {
  return {
    id: Number(row.id),
    sourceId,
    shopKey: String(row.identity_hash),
    vendorId,
    title: String(row.title),
    shopType: String(row.shop_type) as ShopRow['shopType'],
    mapName: String(row.map_name),
    x: Number(row.x),
    y: Number(row.y),
    status: String(row.status) as ShopRow['status'],
    lastSeenAt: Number(row.last_status_observed_at),
    closedAt: row.closed_at == null ? null : Number(row.closed_at),
    updatedAt: Number(row.last_changed_at),
  };
}

export function createMysqlRepository(db: MysqlDatabase, cursorSecret = DEFAULT_CURSOR_SECRET): MarketRepository {
  // The search implementation added in the later repository task consumes this
  // value. Keeping it part of the factory avoids a second production factory.
  void cursorSecret;

  const resolveShopObservations = async (inputs: ShopSessionContextInput[]): Promise<ShopResolution[]> => {
    if (inputs.length === 0) return [];
    const payload = shopResolutionPayload(inputs);

    return db.transaction(async (tx) => {
      const existingRows = await tx.all<Row>(`SELECT shops.* FROM shops
        JOIN ${SHOP_JSON_TABLE}
          ON shops.source_id = observation.source_id AND shops.identity_hash = observation.identity_hash`, [payload]);
      const existingByKey = new Map(existingRows.map((row) => [shopResolutionKey(String(row.source_id), String(row.identity_hash)), row]));

      await tx.run(`INSERT INTO shops(
          source_id, identity_hash, public_shop_id, vendor_account_id, vendor_name, vendor_name_normalized,
          title, title_normalized, shop_type, map_name, x, y, status, profile_hash, full_state_hash,
          last_status_observed_at, last_changed_at, closed_at, close_reason
        ) SELECT
          source_id, identity_hash, public_shop_id, vendor_account_id, vendor_name, vendor_name_normalized,
          title, title_normalized, shop_type, map_name, x, y, 'closed', profile_hash, NULL,
          observed_at, observed_at, observed_at, 'explicit_dismissed'
        FROM ${SHOP_JSON_TABLE}
        WHERE shop_status = 'dismissed'
        ON DUPLICATE KEY UPDATE id = id`, [payload]);

      await tx.run(`INSERT INTO shops(
          source_id, identity_hash, public_shop_id, vendor_account_id, vendor_name, vendor_name_normalized,
          title, title_normalized, shop_type, map_name, x, y, status, profile_hash, full_state_hash,
          last_status_observed_at, last_changed_at, closed_at, close_reason
        ) SELECT
          source_id, identity_hash, public_shop_id, vendor_account_id, vendor_name, vendor_name_normalized,
          title, title_normalized, shop_type, map_name, x, y, 'active', profile_hash, full_state_hash,
          observed_at, observed_at, NULL, NULL
        FROM ${SHOP_JSON_TABLE}
        WHERE shop_status = 'opening'
        ON DUPLICATE KEY UPDATE
          public_shop_id = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(public_shop_id), public_shop_id),
          vendor_account_id = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(vendor_account_id), vendor_account_id),
          vendor_name = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(vendor_name), vendor_name),
          vendor_name_normalized = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(vendor_name_normalized), vendor_name_normalized),
          title = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(title), title),
          title_normalized = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(title_normalized), title_normalized),
          shop_type = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(shop_type), shop_type),
          map_name = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(map_name), map_name),
          x = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(x), x),
          y = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(y), y),
          profile_hash = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(profile_hash), profile_hash),
          full_state_hash = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), IF(status = 'closed', NULL, full_state_hash), full_state_hash),
          missing_full_count = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), IF(status = 'closed', 0, missing_full_count), missing_full_count),
          last_changed_at = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(last_changed_at), last_changed_at),
          closed_at = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), NULL, closed_at),
          close_reason = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), NULL, close_reason),
          status = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), 'active', status),
          last_status_observed_at = IF(VALUES(last_status_observed_at) > last_status_observed_at OR (VALUES(last_status_observed_at) = last_status_observed_at AND status <> 'closed'), VALUES(last_status_observed_at), last_status_observed_at)`, [payload]);

      await tx.run(`UPDATE shops
        JOIN ${SHOP_JSON_TABLE}
          ON shops.source_id = observation.source_id AND shops.identity_hash = observation.identity_hash
        SET shops.status = 'closed',
          shops.last_status_observed_at = observation.observed_at,
          shops.last_changed_at = observation.observed_at,
          shops.closed_at = observation.observed_at,
          shops.close_reason = 'explicit_dismissed'
        WHERE observation.shop_status = 'dismissed'
          AND shops.last_status_observed_at <= observation.observed_at`, [payload]);

      await tx.run(`UPDATE listings
        JOIN shops ON shops.id = listings.shop_id
        JOIN ${SHOP_JSON_TABLE}
          ON shops.source_id = observation.source_id AND shops.identity_hash = observation.identity_hash
        SET listings.status = 'expired',
          listings.last_changed_at = observation.observed_at,
          listings.state_version = listings.state_version + 1,
          listings.missing_full_count = 0
        WHERE observation.shop_status = 'dismissed'
          AND shops.status = 'closed'
          AND shops.last_status_observed_at <= observation.observed_at
          AND listings.status IN ('active', 'missing')`, [payload]);

      const resolvedRows = await tx.all<Row>(`SELECT shops.* FROM shops
        JOIN ${SHOP_JSON_TABLE}
          ON shops.source_id = observation.source_id AND shops.identity_hash = observation.identity_hash`, [payload]);
      const resolvedByKey = new Map(resolvedRows.map((row) => [shopResolutionKey(String(row.source_id), String(row.identity_hash)), row]));

      return inputs.map((input) => {
        const key = shopResolutionKey(input.sourceId, input.identityHash);
        const existing = existingByKey.get(key);
        const row = resolvedByKey.get(key);
        if (!row) throw new Error('shop resolution failed');
        if (isStaleShopObservation(existing, input)) {
          return {
            internalShopId: Number(row.id),
            shopId: String(row.public_shop_id),
            identityHash: input.identityHash,
            resolution: 'stale_event_ignored' as const,
            status: String(row.status) === 'closed' ? 'dismissed' as const : 'opening' as const,
            applied: false,
            session: null,
          };
        }
        if (input.shopStatus === 'dismissed') {
          return {
            internalShopId: Number(row.id),
            shopId: String(row.public_shop_id),
            identityHash: input.identityHash,
            resolution: 'dismissed' as const,
            status: 'dismissed' as const,
            applied: true,
            session: null,
          };
        }
        const unchangedFull = input.fullStateHash !== undefined && existing?.full_state_hash === input.fullStateHash && existing?.status !== 'closed';
        return {
          internalShopId: Number(row.id),
          shopId: String(row.public_shop_id),
          identityHash: input.identityHash,
          resolution: existing?.status === 'closed' ? 'created' as const : existing ? 'matched' as const : 'created' as const,
          status: 'opening' as const,
          applied: true,
          readListings: !unchangedFull,
          session: sessionFromShopRow(row, input.clientRunId, input.observedAt),
        };
      });
    });
  };

  return {
    async getLatestMarketUpdateAt() {
      const row = await db.first<Row>("SELECT MAX(completed_at) AS latest_updated_at FROM upload_batches WHERE status = 'accepted'");
      const value = row?.latest_updated_at;
      return value == null || !Number.isSafeInteger(Number(value)) ? null : Number(value);
    },
    async findSourceByApiKeyHash(hash) {
      const row = await db.first<Row>('SELECT id, name, api_key_hash, status FROM market_sources WHERE api_key_hash = ? LIMIT 1', [hash]);
      return row ? { id: String(row.id), name: String(row.name), apiKeyHash: String(row.api_key_hash), status: String(row.status) as SourceRow['status'] } : null;
    },
    async getOrCreateVendor(sourceId, input: VendorInput): Promise<VendorRow> {
      return { id: 0, sourceId, vendorKey: input.vendorKey, name: input.name, mapName: input.mapName, x: input.x, y: input.y, updatedAt: input.updatedAt };
    },
    async getOrCreateShop(sourceId, input) {
      await db.run(`INSERT INTO shops(
          source_id, identity_hash, public_shop_id, vendor_account_id, vendor_name, vendor_name_normalized,
          title, title_normalized, shop_type, map_name, x, y, status, profile_hash, last_status_observed_at, last_changed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          vendor_account_id = VALUES(vendor_account_id), vendor_name = VALUES(vendor_name), vendor_name_normalized = VALUES(vendor_name_normalized),
          title = VALUES(title), title_normalized = VALUES(title_normalized), shop_type = VALUES(shop_type), map_name = VALUES(map_name),
          x = VALUES(x), y = VALUES(y), status = 'active', last_status_observed_at = VALUES(last_status_observed_at),
          last_changed_at = VALUES(last_changed_at), closed_at = NULL, close_reason = NULL`, [
        sourceId, input.shopKey, input.shopKey, String(input.vendorId), String(input.vendorId), normalizeCatalogQuery(String(input.vendorId)),
        input.title, normalizeCatalogQuery(input.title), input.shopType, input.mapName, input.x, input.y, input.shopKey, input.lastSeenAt, input.lastSeenAt,
      ]);
      const row = await db.first<Row>('SELECT * FROM shops WHERE source_id = ? AND identity_hash = ? LIMIT 1', [sourceId, input.shopKey]);
      if (!row) throw new Error('shop upsert returned no row');
      return shopFromRow(row, sourceId, input.vendorId);
    },
    async getOrCreateSession(input) {
      const row = await db.first<Row>('SELECT * FROM shops WHERE id = ? LIMIT 1', [input.shopId]);
      if (!row) throw new Error('shop not found');
      return sessionFromShopRow(row, input.clientRunId, input.observedAt);
    },
    async getOrCreateSessions(inputs) {
      const resolutions = await resolveShopObservations(inputs);
      return resolutions.flatMap((resolution) => resolution.session ? [resolution.session] : []);
    },
    async resolveShopObservation(input) {
      const [resolution] = await resolveShopObservations([input]);
      if (!resolution) throw new Error('shop resolution failed');
      return resolution;
    },
    resolveShopObservations,
    async getBatch(sourceId, batchId) {
      const row = await db.first<Row>('SELECT * FROM upload_batches WHERE source_id = ? AND batch_id = ? LIMIT 1', [sourceId, batchId]);
      return row ? batchFromRow(row) : null;
    },
    async getSnapshotParts(sourceId, snapshotId) {
      const rows = await db.all<Row>('SELECT * FROM upload_batches WHERE source_id = ? AND snapshot_id = ? ORDER BY part_index', [sourceId, snapshotId]);
      return rows.map(batchFromRow);
    },
    async insertBatch(input) {
      const result = await db.run(`INSERT INTO upload_batches(
          source_id, batch_id, snapshot_id, part_index, part_count, snapshot_mode, payload_hash, status, shop_ids_json, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)
        ON DUPLICATE KEY UPDATE batch_id = VALUES(batch_id)`, [
        input.sourceId, input.batchId, input.snapshotId, input.partIndex, input.partCount,
        input.snapshotMode, input.payloadHash, input.status ?? 'processing', input.receivedAt,
      ]);
      const row = await db.first<Row>('SELECT * FROM upload_batches WHERE source_id = ? AND batch_id = ? LIMIT 1', [input.sourceId, input.batchId]);
      if (!row) throw new Error('batch insert returned no row');
      return { ...batchFromRow(row), inserted: result.affectedRows === 1 };
    },
    async completeBatch(sourceId, batchId, response: UploadResultLike) {
      await db.run("UPDATE upload_batches SET status = 'accepted', response_json = ?, completed_at = ? WHERE source_id = ? AND batch_id = ?", [JSON.stringify(response), Date.now(), sourceId, batchId]);
    },
    async retryBatch(sourceId, batchId) {
      const result = await db.run("UPDATE upload_batches SET status = 'processing', response_json = NULL WHERE source_id = ? AND batch_id = ? AND status = 'rejected'", [sourceId, batchId]);
      return result.affectedRows === 1;
    },
    async failBatch(sourceId, batchId) {
      await db.run("UPDATE upload_batches SET status = 'rejected', response_json = NULL WHERE source_id = ? AND batch_id = ? AND status = 'processing'", [sourceId, batchId]);
    },
  } as MarketRepository;
}

export const mysqlRepositoryBatchReadChunks = <T>(rows: readonly T[]): T[][] => chunkRows(rows, 2, 400);
