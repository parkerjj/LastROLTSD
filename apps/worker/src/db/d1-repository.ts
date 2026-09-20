import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { assertBatchBounds } from './repository';
import { decodeCursor, decodeHistoryCursor, encodeCursor, encodeHistoryCursor, searchCursorContext, DEFAULT_CURSOR_SECRET } from '../domain/search';
import { makeTransitionKey } from '../domain/transitions';
import type { BatchRow, CatalogItemRow, InferredSaleRow, ListingRow, ListingOption, ListingSearchRow, SessionInput, ShopInput, ShopRow, SourceRow, VendorInput } from './types';
import type { ListingTransitionChange, MarketRepository, ReconciliationResult, SnapshotReconciliationInput, UploadResultLike, ShopSessionContextInput } from './repository';

type Row = Record<string, unknown>;
const BULK_BATCH_SIZE = 12;
const one = async <T extends Row>(statement: D1PreparedStatement): Promise<T | null> => ((await statement.first<T>()) ?? null);
const many = async <T extends Row>(statement: D1PreparedStatement): Promise<T[]> => (await statement.all<T>()).results ?? [];
const bool = (value: unknown): boolean => Number(value) === 1;
const cards = (row: Row): number[] => [row.card0, row.card1, row.card2, row.card3].map((v) => Number(v ?? 0));

export function createD1Repository(db: D1Database, cursorSecret = DEFAULT_CURSOR_SECRET): MarketRepository {
  return {
    async findSourceByApiKeyHash(hash) {
      const row = await one<Row>(db.prepare('SELECT id,name,api_key_hash,status FROM market_sources WHERE api_key_hash = ?1 LIMIT 1').bind(hash));
      return row ? { id: String(row.id), name: String(row.name), apiKeyHash: String(row.api_key_hash), status: String(row.status) as SourceRow['status'] } : null;
    },
    async getOrCreateVendor(sourceId, input: VendorInput) {
      const sql = `INSERT INTO vendors(source_id,vendor_key,name,name_normalized,map_name,x,y,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
        ON CONFLICT(source_id,vendor_key) DO UPDATE SET name=excluded.name,map_name=excluded.map_name,x=excluded.x,y=excluded.y,updated_at=excluded.updated_at
        RETURNING id,source_id,vendor_key,name,map_name,x,y,updated_at`;
      const row = await one<Row>(db.prepare(sql).bind(sourceId, input.vendorKey, input.name, input.name.normalize('NFKC').toLowerCase(), input.mapName, input.x, input.y, input.updatedAt));
      if (!row) throw new Error('vendor upsert returned no row');
      return { id: Number(row.id), sourceId: String(row.source_id), vendorKey: String(row.vendor_key), name: String(row.name), mapName: String(row.map_name), x: Number(row.x), y: Number(row.y), updatedAt: Number(row.updated_at) };
    },
    async getOrCreateShop(sourceId, input: ShopInput) {
      const sql = `INSERT INTO shops(source_id,vendor_id,shop_key,title,title_normalized,shop_type,map_name,x,y,last_seen_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
        ON CONFLICT(source_id,shop_key) DO UPDATE SET vendor_id=excluded.vendor_id,title=excluded.title,title_normalized=excluded.title_normalized,shop_type=excluded.shop_type,map_name=excluded.map_name,x=excluded.x,y=excluded.y,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at,status='active',closed_at=NULL
        RETURNING id,source_id,vendor_id,shop_key,title,shop_type,map_name,x,y,status,last_seen_at,closed_at,updated_at`;
      const row = await one<Row>(db.prepare(sql).bind(sourceId, input.vendorId, input.shopKey, input.title, input.title.normalize('NFKC').toLowerCase(), input.shopType, input.mapName, input.x, input.y, input.lastSeenAt, input.updatedAt));
      if (!row) throw new Error('shop upsert returned no row');
      return { id: Number(row.id), sourceId: String(row.source_id), vendorId: Number(row.vendor_id), shopKey: String(row.shop_key), title: String(row.title), shopType: String(row.shop_type) as ShopRow['shopType'], mapName: String(row.map_name), x: Number(row.x), y: Number(row.y), status: String(row.status) as ShopRow['status'], lastSeenAt: Number(row.last_seen_at), closedAt: row.closed_at === null ? null : Number(row.closed_at), updatedAt: Number(row.updated_at) };
    },
    async getOrCreateSession(input: SessionInput) {
      const current = await one<Row>(db.prepare('SELECT * FROM shop_sessions WHERE shop_id=?1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1').bind(input.shopId));
      const ttl = 30 * 60 * 1000;
      if (current && String(current.client_run_id) === input.clientRunId && input.observedAt - Number(current.last_seen_at) <= ttl) {
        await db.prepare('UPDATE shop_sessions SET last_seen_at=?1 WHERE id=?2').bind(input.observedAt, current.id).run();
        return { id: Number(current.id), shopId: Number(current.shop_id), clientRunId: String(current.client_run_id), startedAt: Number(current.started_at), lastSeenAt: input.observedAt, endedAt: null, initialSyncComplete: bool(current.initial_sync_complete), lastCompleteSnapshotId: current.last_complete_snapshot_id ? String(current.last_complete_snapshot_id) : null };
      }
      if (current) {
        await db.prepare('UPDATE shop_sessions SET ended_at=?1 WHERE id=?2').bind(input.observedAt, current.id).run();
        await db.prepare("UPDATE listings SET status='expired',last_changed_at=?1 WHERE shop_session_id=?2 AND status IN ('active','missing')").bind(input.observedAt, current.id).run();
      }
      const row = await one<Row>(db.prepare('INSERT INTO shop_sessions(shop_id,client_run_id,started_at,last_seen_at) VALUES(?1,?2,?3,?3) RETURNING *').bind(input.shopId, input.clientRunId, input.observedAt));
      if (!row) throw new Error('session insert returned no row');
      return { id: Number(row.id), shopId: Number(row.shop_id), clientRunId: String(row.client_run_id), startedAt: Number(row.started_at), lastSeenAt: Number(row.last_seen_at), endedAt: null, initialSyncComplete: false, lastCompleteSnapshotId: null };
    },
    async resolveShopObservation(input) {
      const existing = await one<Row>(db.prepare('SELECT * FROM shops WHERE source_id=?1 AND identity_hash=?2 LIMIT 1').bind(input.sourceId, input.identityHash));
      const status = input.shopStatus === 'dismissed' ? 'closed' : 'active';
      if (existing) {
        const previousObservedAt = existing.last_status_observed_at === null || existing.last_status_observed_at === undefined ? null : Number(existing.last_status_observed_at);
        const stale = previousObservedAt !== null && (input.observedAt < previousObservedAt || (input.observedAt === previousObservedAt && input.shopStatus === 'opening' && String(existing.status) === 'closed'));
        const currentShopId = existing.shop_id ? String(existing.shop_id) : input.shopId;
        if (stale) return { internalShopId: Number(existing.id), shopId: currentShopId, identityHash: input.identityHash, resolution: 'stale_event_ignored' as const, status: String(existing.status) === 'closed' ? 'dismissed' as const : 'opening' as const, applied: false, session: null };
        const currentSession = input.shopStatus === 'dismissed'
          ? await one<Row>(db.prepare('SELECT id FROM shop_sessions WHERE shop_id=?1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1').bind(existing.id))
          : null;
        const update = db.prepare(`UPDATE shops SET vendor_id=(SELECT id FROM vendors WHERE source_id=?1 AND vendor_key=?2),vendor_account_id=?2,title=?3,title_normalized=?4,shop_type=?5,map_name=?6,x=?7,y=?8,last_seen_at=?9,updated_at=?9,status=?10,closed_at=CASE WHEN ?10='active' THEN NULL ELSE ?9 END,close_reason=CASE WHEN ?10='active' THEN NULL ELSE 'explicit_dismissed' END,identity_version=1,identity_hash=?11,shop_id=?12,last_status_observed_at=?9,last_status_batch_id=?13 WHERE id=?14`);
        const vendor = db.prepare(`INSERT INTO vendors(source_id,vendor_key,name,name_normalized,map_name,x,y,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(source_id,vendor_key) DO UPDATE SET name=excluded.name,name_normalized=excluded.name_normalized,map_name=excluded.map_name,x=excluded.x,y=excluded.y,updated_at=excluded.updated_at`);
        const writes = [
          vendor.bind(input.sourceId, input.vendorAccountId, input.vendorName, input.vendorName.normalize('NFKC').toLowerCase(), input.mapName, input.x, input.y, input.observedAt),
          update.bind(input.sourceId, input.vendorAccountId, input.title, input.title.normalize('NFKC').toLowerCase(), input.shopType, input.mapName, input.x, input.y, input.observedAt, status, input.identityHash, currentShopId, input.batchId, existing.id),
        ];
        if (input.shopStatus === 'dismissed') {
          if (currentSession) {
            writes.push(
              db.prepare('UPDATE shop_sessions SET ended_at=?1 WHERE id=?2 AND ended_at IS NULL').bind(input.observedAt, currentSession.id),
              db.prepare("UPDATE listings SET status='expired',last_changed_at=?1 WHERE shop_session_id=?2 AND status IN ('active','missing')").bind(input.observedAt, currentSession.id),
            );
          }
          await db.batch(writes);
          return { internalShopId: Number(existing.id), shopId: currentShopId, identityHash: input.identityHash, resolution: 'dismissed' as const, status: 'dismissed' as const, applied: true, session: null };
        }
        await db.batch(writes);
        const session = await getOrCreateD1Session(db, { shopId: Number(existing.id), clientRunId: input.clientRunId, observedAt: input.observedAt });
        return { internalShopId: Number(existing.id), shopId: currentShopId, identityHash: input.identityHash, resolution: String(existing.status) === 'closed' ? 'created' as const : 'matched' as const, status: 'opening' as const, applied: true, session };
      }
      const vendor = await one<Row>(db.prepare(`INSERT INTO vendors(source_id,vendor_key,name,name_normalized,map_name,x,y,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(source_id,vendor_key) DO UPDATE SET name=excluded.name,name_normalized=excluded.name_normalized,map_name=excluded.map_name,x=excluded.x,y=excluded.y,updated_at=excluded.updated_at RETURNING id`).bind(input.sourceId, input.vendorAccountId, input.vendorName, input.vendorName.normalize('NFKC').toLowerCase(), input.mapName, input.x, input.y, input.observedAt));
      if (!vendor) throw new Error('vendor upsert returned no row');
      const created = await one<Row>(db.prepare(`INSERT INTO shops(source_id,vendor_id,shop_key,title,title_normalized,shop_type,map_name,x,y,status,last_seen_at,closed_at,updated_at,identity_version,identity_hash,shop_id,vendor_account_id,last_status_observed_at,last_status_batch_id,close_reason) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?11,1,?13,?14,?15,?11,?16,?17) RETURNING id,shop_id,status`).bind(input.sourceId, vendor.id, input.identityHash, input.title, input.title.normalize('NFKC').toLowerCase(), input.shopType, input.mapName, input.x, input.y, status, input.observedAt, input.shopStatus === 'dismissed' ? input.observedAt : null, input.identityHash, input.shopId, input.vendorAccountId, input.batchId, input.shopStatus === 'dismissed' ? 'explicit_dismissed' : null));
      if (!created) throw new Error('shop insert returned no row');
      if (input.shopStatus === 'dismissed') return { internalShopId: Number(created.id), shopId: String(created.shop_id), identityHash: input.identityHash, resolution: 'dismissed' as const, status: 'dismissed' as const, applied: true, session: null };
      const session = await getOrCreateD1Session(db, { shopId: Number(created.id), clientRunId: input.clientRunId, observedAt: input.observedAt });
      return { internalShopId: Number(created.id), shopId: String(created.shop_id), identityHash: input.identityHash, resolution: 'created' as const, status: 'opening' as const, applied: true, session };
    },
    async getBatch(sourceId, batchId) {
      const row = await one<Row>(db.prepare('SELECT * FROM upload_batches WHERE source_id=?1 AND batch_id=?2 LIMIT 1').bind(sourceId, batchId));
      return row ? batchFromRow(row) : null;
    },
    async getSnapshotParts(sourceId, snapshotId) {
      const rows = await many<Row>(db.prepare('SELECT * FROM upload_batches WHERE source_id=?1 AND snapshot_id=?2 ORDER BY part_index').bind(sourceId, snapshotId));
      return rows.map(batchFromRow);
    },
    async insertBatch(input) {
      try {
        const row = await one<Row>(db.prepare(`INSERT INTO upload_batches(source_id,batch_id,snapshot_id,part_index,part_count,snapshot_mode,payload_hash,status,received_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) RETURNING *`).bind(input.sourceId, input.batchId, input.snapshotId, input.partIndex, input.partCount, input.snapshotMode, input.payloadHash, input.status ?? 'processing', input.receivedAt));
        if (!row) throw new Error('batch insert returned no row');
        return { ...batchFromRow(row), inserted: true };
      } catch (error) {
        if (!(error instanceof Error) || !/unique|constraint/i.test(error.message)) throw error;
        const existing = await one<Row>(db.prepare('SELECT * FROM upload_batches WHERE source_id=?1 AND batch_id=?2 LIMIT 1').bind(input.sourceId, input.batchId));
        if (!existing) throw error;
        return { ...batchFromRow(existing), inserted: false };
      }
    },
    async completeBatch(sourceId, batchId, response: UploadResultLike) {
      await db.prepare('UPDATE upload_batches SET status=\'accepted\',processed_shops=?1,processed_listings=?2,changed_listings=?3,sold_events=?4,response_json=?5 WHERE source_id=?6 AND batch_id=?7').bind(response.processed_shops, response.processed_listings, response.changed_listings, response.sold_events, JSON.stringify(response), sourceId, batchId).run();
    },
    async retryBatch(sourceId, batchId) {
      const result = await db.prepare("UPDATE upload_batches SET status='processing',response_json=NULL WHERE source_id=?1 AND batch_id=?2 AND status='rejected'").bind(sourceId, batchId).run();
      return Number(result.meta?.changes ?? 0) === 1;
    },
    async failBatch(sourceId, batchId) {
      await db.prepare("UPDATE upload_batches SET status='rejected',response_json=NULL WHERE source_id=?1 AND batch_id=?2 AND status='processing'").bind(sourceId, batchId).run();
    },
    async loadListingsByFingerprint(sessionId, fingerprints) {
      if (fingerprints.length === 0) return [];
      if (fingerprints.length > 40) throw new Error('listing lookup exceeds bounded batch size');
      const placeholders = fingerprints.map((_, index) => `?${index + 2}`).join(',');
      const rows = await many<Row>(db.prepare(`SELECT * FROM listings WHERE shop_session_id=?1 AND item_fingerprint IN (${placeholders})`).bind(sessionId, ...fingerprints));
      return rows.map(listingFromRow);
    },
    async loadListingsByObservations(observations) {
      if (observations.length === 0) return [];
      const payload = JSON.stringify(observations);
      const rows = await many<Row>(db.prepare(`SELECT l.* FROM listings l JOIN json_each(?1) input ON l.shop_session_id=CAST(json_extract(input.value,'$.sessionId') AS INTEGER) AND l.item_fingerprint=json_extract(input.value,'$.fingerprint')`).bind(payload));
      return rows.map(listingFromRow);
    },
    async markListingsObservedBulk(observations, batchId, observedAt) {
      if (observations.length === 0) return 0;
      const payload = JSON.stringify(observations);
      assertBatchBounds(1, 3);
      const result = await db.prepare(`UPDATE listings SET last_seen_at=?3,last_batch_id=?2,missing_streak=0,status=CASE WHEN quantity=0 THEN 'sold_out' ELSE 'active' END WHERE id IN (SELECT l.id FROM json_each(?1) input JOIN listings l ON l.shop_session_id=CAST(json_extract(input.value,'$.sessionId') AS INTEGER) AND l.item_fingerprint=json_extract(input.value,'$.fingerprint'))`).bind(payload, batchId, observedAt).run();
      return Number(result.meta?.changes ?? 0);
    },
    async loadListingById(listingId, sessionId) {
      const statement = sessionId === undefined
        ? db.prepare('SELECT * FROM listings WHERE id=?1 LIMIT 1').bind(listingId)
        : db.prepare('SELECT * FROM listings WHERE id=?1 AND shop_session_id=?2 LIMIT 1').bind(listingId, sessionId);
      const row = await one<Row>(statement);
      return row ? listingFromRow(row) : null;
    },
    async markListingsObserved(sessionId, fingerprints, batchId, observedAt) {
      if (fingerprints.length === 0) return 0;
      if (fingerprints.length > 40) throw new Error('listing observation exceeds bounded batch size');
      const placeholders = fingerprints.map((_, index) => `?${index + 4}`).join(',');
      const result = await db.prepare(`UPDATE listings SET last_seen_at=?1,last_batch_id=?2,missing_streak=0,status=CASE WHEN quantity=0 THEN 'sold_out' ELSE 'active' END WHERE shop_session_id=?3 AND item_fingerprint IN (${placeholders})`).bind(observedAt, batchId, sessionId, ...fingerprints).run();
      return Number(result.meta?.changes ?? 0);
    },
    async createListing(input) {
      const row = await one<Row>(db.prepare(`INSERT INTO listings(shop_session_id,item_fingerprint,item_key,item_id,upgrade,slots,card0,card1,card2,card3,price,quantity,last_quantity,status,first_seen_at,last_seen_at,last_changed_at,last_batch_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,'active',?13,?13,?13,?14) RETURNING *`).bind(input.sessionId, input.fingerprint, input.itemKey ?? null, input.itemId, input.upgrade, input.slots, input.cards[0] ?? 0, input.cards[1] ?? 0, input.cards[2] ?? 0, input.cards[3] ?? 0, input.price, input.quantity, input.observedAt, input.batchId));
      if (!row) throw new Error('listing insert returned no row');
      return listingFromRow(row);
    },
    async createListingsBatch(inputs) {
      if (inputs.length === 0) return [];
      assertBatchBounds(1, 1);
      const payload = JSON.stringify(inputs.map((input) => ({ sessionId: input.sessionId, fingerprint: input.fingerprint, itemKey: input.itemKey ?? null, itemId: input.itemId, upgrade: input.upgrade, slots: input.slots, cards: [input.cards[0] ?? 0, input.cards[1] ?? 0, input.cards[2] ?? 0, input.cards[3] ?? 0], price: input.price, quantity: input.quantity, observedAt: input.observedAt, batchId: input.batchId })));
      const rows = await many<Row>(db.prepare(`INSERT OR IGNORE INTO listings(shop_session_id,item_fingerprint,item_key,item_id,upgrade,slots,card0,card1,card2,card3,price,quantity,last_quantity,status,first_seen_at,last_seen_at,last_changed_at,last_batch_id)
        SELECT json_extract(value,'$.sessionId'),json_extract(value,'$.fingerprint'),json_extract(value,'$.itemKey'),json_extract(value,'$.itemId'),json_extract(value,'$.upgrade'),json_extract(value,'$.slots'),json_extract(value,'$.cards[0]'),json_extract(value,'$.cards[1]'),json_extract(value,'$.cards[2]'),json_extract(value,'$.cards[3]'),json_extract(value,'$.price'),json_extract(value,'$.quantity'),json_extract(value,'$.quantity'),'active',json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),json_extract(value,'$.batchId') FROM json_each(?1) RETURNING *`).bind(payload));
      return rows.map(listingFromRow);
    },
    async createListingsBundleBatch(inputs) {
      if (inputs.length === 0) return [];
      const payload = JSON.stringify(inputs.map((input) => ({ sessionId: input.sessionId, fingerprint: input.fingerprint, itemKey: input.itemKey ?? null, itemId: input.itemId, upgrade: input.upgrade, slots: input.slots, cards: [input.cards[0] ?? 0, input.cards[1] ?? 0, input.cards[2] ?? 0, input.cards[3] ?? 0], price: input.price, quantity: input.quantity, observedAt: input.observedAt, batchId: input.batchId, options: input.options.map((option) => ({ type: option.type, value: option.value, param: option.param })) })));
      const insert = db.prepare(`INSERT OR IGNORE INTO listings(shop_session_id,item_fingerprint,item_key,item_id,upgrade,slots,card0,card1,card2,card3,price,quantity,last_quantity,status,first_seen_at,last_seen_at,last_changed_at,last_batch_id)
        SELECT json_extract(value,'$.sessionId'),json_extract(value,'$.fingerprint'),json_extract(value,'$.itemKey'),json_extract(value,'$.itemId'),json_extract(value,'$.upgrade'),json_extract(value,'$.slots'),json_extract(value,'$.cards[0]'),json_extract(value,'$.cards[1]'),json_extract(value,'$.cards[2]'),json_extract(value,'$.cards[3]'),json_extract(value,'$.price'),json_extract(value,'$.quantity'),json_extract(value,'$.quantity'),'active',json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),json_extract(value,'$.batchId') FROM json_each(?1)`);
      const history = db.prepare(`INSERT OR IGNORE INTO listing_price_history(listing_id,observed_at,price,quantity,event_type,batch_id)
        SELECT l.id,json_extract(item.value,'$.observedAt'),json_extract(item.value,'$.price'),json_extract(item.value,'$.quantity'),'first_seen',json_extract(item.value,'$.batchId')
        FROM json_each(?1) item JOIN listings l ON l.shop_session_id=json_extract(item.value,'$.sessionId') AND l.item_fingerprint=json_extract(item.value,'$.fingerprint') AND l.last_batch_id=json_extract(item.value,'$.batchId')`);
      const options = db.prepare(`INSERT OR REPLACE INTO listing_options(listing_id,option_index,option_type,option_value,option_param)
        SELECT l.id,CAST(option.key AS INTEGER),json_extract(option.value,'$.type'),json_extract(option.value,'$.value'),json_extract(option.value,'$.param')
        FROM json_each(?1) item JOIN listings l ON l.shop_session_id=json_extract(item.value,'$.sessionId') AND l.item_fingerprint=json_extract(item.value,'$.fingerprint') AND l.last_batch_id=json_extract(item.value,'$.batchId')
        JOIN json_each(json_extract(item.value,'$.options')) option`);
      await db.batch([insert.bind(payload), history.bind(payload), options.bind(payload)]);
      const first = inputs[0]!;
      return (await this.loadListingsByFingerprint(first.sessionId, inputs.map((input) => input.fingerprint))).filter((listing) => inputs.some((input) => input.fingerprint === listing.itemFingerprint));
    },
    async insertNewListingsBulk(inputs) {
      if (inputs.length === 0) return;
      const payload = JSON.stringify(inputs.map((input) => ({ sessionId: input.sessionId, fingerprint: input.fingerprint, itemKey: input.itemKey ?? null, itemId: input.itemId, upgrade: input.upgrade, slots: input.slots, cards: [input.cards[0] ?? 0, input.cards[1] ?? 0, input.cards[2] ?? 0, input.cards[3] ?? 0], price: input.price, quantity: input.quantity, observedAt: input.observedAt, batchId: input.batchId, options: [...input.options].sort((a, b) => a.type - b.type || a.value - b.value || a.param - b.param).map((option) => ({ type: option.type, value: option.value, param: option.param })) })));
      const insert = db.prepare(`INSERT OR IGNORE INTO listings(shop_session_id,item_fingerprint,item_key,item_id,upgrade,slots,card0,card1,card2,card3,price,quantity,last_quantity,status,first_seen_at,last_seen_at,last_changed_at,last_batch_id)
        SELECT json_extract(value,'$.sessionId'),json_extract(value,'$.fingerprint'),json_extract(value,'$.itemKey'),json_extract(value,'$.itemId'),json_extract(value,'$.upgrade'),json_extract(value,'$.slots'),json_extract(value,'$.cards[0]'),json_extract(value,'$.cards[1]'),json_extract(value,'$.cards[2]'),json_extract(value,'$.cards[3]'),json_extract(value,'$.price'),json_extract(value,'$.quantity'),json_extract(value,'$.quantity'),'active',json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),json_extract(value,'$.batchId') FROM json_each(?1)`);
      const history = db.prepare(`INSERT OR IGNORE INTO listing_price_history(listing_id,observed_at,price,quantity,event_type,batch_id)
        SELECT l.id,json_extract(item.value,'$.observedAt'),json_extract(item.value,'$.price'),json_extract(item.value,'$.quantity'),'first_seen',json_extract(item.value,'$.batchId') FROM json_each(?1) item JOIN listings l ON l.shop_session_id=CAST(json_extract(item.value,'$.sessionId') AS INTEGER) AND l.item_fingerprint=json_extract(item.value,'$.fingerprint') AND l.last_batch_id=json_extract(item.value,'$.batchId')`);
      const options = db.prepare(`INSERT OR REPLACE INTO listing_options(listing_id,option_index,option_type,option_value,option_param)
        SELECT l.id,CAST(option.key AS INTEGER),json_extract(option.value,'$.type'),json_extract(option.value,'$.value'),json_extract(option.value,'$.param') FROM json_each(?1) item JOIN listings l ON l.shop_session_id=CAST(json_extract(item.value,'$.sessionId') AS INTEGER) AND l.item_fingerprint=json_extract(item.value,'$.fingerprint') AND l.last_batch_id=json_extract(item.value,'$.batchId') JOIN json_each(json_extract(item.value,'$.options')) option`);
      assertBatchBounds(3, 3);
      await db.batch([insert.bind(payload), history.bind(payload), options.bind(payload)]);
    },
    async insertListingOptions(input: { listingId: number; options: ListingOption[] }) {
      if (input.options.length === 0) return;
      const options = [...input.options].sort((left, right) => left.type - right.type || left.value - right.value || left.param - right.param);
      for (let offset = 0; offset < options.length; offset += BULK_BATCH_SIZE) {
        const chunk = options.slice(offset, offset + BULK_BATCH_SIZE);
        assertBatchBounds(chunk.length, chunk.length * 5);
        await db.batch(chunk.map((option, index) => db.prepare('INSERT OR REPLACE INTO listing_options(listing_id,option_index,option_type,option_value,option_param) VALUES(?1,?2,?3,?4,?5)').bind(input.listingId, offset + index, option.type, option.value, option.param)));
      }
    },
    async insertHistory(input) { await db.prepare('INSERT OR IGNORE INTO listing_price_history(listing_id,observed_at,price,quantity,event_type,batch_id) VALUES(?1,?2,?3,?4,?5,?6)').bind(input.listingId, input.observedAt, input.price, input.quantity, input.eventType, input.batchId).run(); },
    async insertHistoriesBatch(inputs) {
      if (inputs.length === 0) return;
      for (let offset = 0; offset < inputs.length; offset += BULK_BATCH_SIZE) {
        const chunk = inputs.slice(offset, offset + BULK_BATCH_SIZE);
        assertBatchBounds(chunk.length, chunk.length * 5);
        await db.batch(chunk.map((input) => db.prepare('INSERT OR IGNORE INTO listing_price_history(listing_id,observed_at,price,quantity,event_type,batch_id) VALUES(?1,?2,?3,?4,?5,?6)').bind(input.listingId, input.observedAt, input.price, input.quantity, input.eventType, input.batchId)));
      }
    },
    async insertListingOptionsBatch(inputs) {
      const rows = inputs.flatMap((input) => [...input.options].sort((left, right) => left.type - right.type || left.value - right.value || left.param - right.param).map((option, index) => ({ listingId: input.listingId, optionIndex: index, type: option.type, value: option.value, param: option.param })));
      if (rows.length === 0) return;
      for (let offset = 0; offset < rows.length; offset += BULK_BATCH_SIZE) {
        const chunk = rows.slice(offset, offset + BULK_BATCH_SIZE);
        assertBatchBounds(chunk.length, chunk.length * 5);
        await db.batch(chunk.map((row) => db.prepare('INSERT OR REPLACE INTO listing_options(listing_id,option_index,option_type,option_value,option_param) VALUES(?1,?2,?3,?4,?5)').bind(row.listingId, row.optionIndex, row.type, row.value, row.param)));
      }
    },
    async insertSoldEvent(input) { const result = await db.prepare('INSERT OR IGNORE INTO sold_events(listing_id,sold_quantity,from_quantity,to_quantity,reason,observed_at,transition_key) VALUES(?1,?2,?3,?4,?5,?6,?7)').bind(input.listingId, input.soldQuantity, input.fromQuantity, input.toQuantity, input.reason, input.observedAt, input.transitionKey).run(); return Number(result.meta?.changes ?? 0) > 0; },
    async applyListingChanges(changes) {
      assertBatchBounds(changes.length, changes.length * 7);
      const statements = changes.map((change) => db.prepare(`UPDATE listings SET price=?1,quantity=?2,last_quantity=quantity,status=?3,last_seen_at=?4,last_changed_at=?4,state_version=state_version+1,last_batch_id=?5,missing_streak=0 WHERE id=?6 AND state_version=?7`).bind(change.price, change.quantity, change.status, change.observedAt, change.batchId, change.listingId, change.expectedVersion));
      const results = await db.batch(statements);
      return { updated: results.filter((result) => Number(result.meta?.changes ?? 0) > 0).length, conflicts: results.filter((result) => Number(result.meta?.changes ?? 0) === 0).length };
    },
    async applyListingTransitions(changes: ListingTransitionChange[]) {
      if (changes.length === 0) return { updated: 0, conflicts: 0, soldEvents: 0, conflictIds: [] };
      const chunkSize = 4;
      let updated = 0; let conflicts = 0; let soldEvents = 0; const conflictIds: number[] = [];
      for (let offset = 0; offset < changes.length; offset += chunkSize) {
        const chunk = changes.slice(offset, offset + chunkSize);
        const statements: D1PreparedStatement[] = [];
        let boundValues = 0;
        const updateIndexes: number[] = []; const soldIndexes: number[] = [];
        for (const change of chunk) {
          assertBatchBounds(1, 8);
          updateIndexes.push(statements.length);
          statements.push(db.prepare('UPDATE listings SET price=?1,quantity=?2,last_quantity=quantity,status=?3,last_seen_at=?4,last_changed_at=?4,state_version=state_version+1,last_batch_id=?5,missing_streak=0 WHERE id=?6 AND shop_session_id=?7 AND state_version=?8').bind(change.price, change.quantity, change.status, change.observedAt, change.batchId, change.listingId, change.shopSessionId, change.expectedVersion));
          boundValues += 8;
          if (change.history) { boundValues += 8; statements.push(db.prepare('INSERT OR IGNORE INTO listing_price_history(listing_id,observed_at,price,quantity,event_type,batch_id) SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS (SELECT 1 FROM listings WHERE id=?1 AND shop_session_id=?7 AND state_version=?8 AND last_batch_id=?6)').bind(change.listingId, change.observedAt, change.price, change.quantity, change.history.eventType, change.batchId, change.shopSessionId, change.expectedVersion + 1)); }
          if (change.soldEvent) { boundValues += 9; soldIndexes.push(statements.length); statements.push(db.prepare('INSERT OR IGNORE INTO sold_events(listing_id,sold_quantity,from_quantity,to_quantity,reason,observed_at,transition_key) SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS (SELECT 1 FROM listings WHERE id=?1 AND shop_session_id=?8 AND state_version=?9 AND last_batch_id=?6)').bind(change.listingId, change.soldEvent.soldQuantity, change.soldEvent.fromQuantity, change.soldEvent.toQuantity, change.soldEvent.reason, change.observedAt, change.soldEvent.transitionKey, change.shopSessionId, change.expectedVersion + 1)); }
        }
        assertBatchBounds(statements.length, boundValues);
        const results = await db.batch(statements);
        for (let index = 0; index < chunk.length; index += 1) {
          const result = results[updateIndexes[index]!];
          if (Number(result?.meta?.changes ?? 0) > 0) updated += 1; else { conflicts += 1; conflictIds.push(chunk[index]!.listingId); }
        }
        for (const index of soldIndexes) if (Number(results[index]?.meta?.changes ?? 0) > 0) soldEvents += 1;
      }
      return { updated, conflicts, soldEvents, conflictIds };
    },
    async applyListingTransitionsBulk(changes) {
      if (changes.length === 0) return { updated: 0, conflicts: 0, soldEvents: 0, conflictIds: [] };
      const payload = JSON.stringify(changes.map((change) => ({ ...change, history: change.history ?? null, soldEvent: change.soldEvent ?? null })));
      const update = db.prepare(`UPDATE listings SET
        price=(SELECT json_extract(input.value,'$.price') FROM json_each(?1) input WHERE CAST(json_extract(input.value,'$.listingId') AS INTEGER)=listings.id),
        quantity=(SELECT json_extract(input.value,'$.quantity') FROM json_each(?1) input WHERE CAST(json_extract(input.value,'$.listingId') AS INTEGER)=listings.id),
        last_quantity=quantity,
        status=(SELECT json_extract(input.value,'$.status') FROM json_each(?1) input WHERE CAST(json_extract(input.value,'$.listingId') AS INTEGER)=listings.id),
        last_seen_at=(SELECT json_extract(input.value,'$.observedAt') FROM json_each(?1) input WHERE CAST(json_extract(input.value,'$.listingId') AS INTEGER)=listings.id),
        last_changed_at=(SELECT json_extract(input.value,'$.observedAt') FROM json_each(?1) input WHERE CAST(json_extract(input.value,'$.listingId') AS INTEGER)=listings.id),
        state_version=state_version+1,
        last_batch_id=(SELECT json_extract(input.value,'$.batchId') FROM json_each(?1) input WHERE CAST(json_extract(input.value,'$.listingId') AS INTEGER)=listings.id),
        missing_streak=0
      WHERE id IN (SELECT CAST(json_extract(input.value,'$.listingId') AS INTEGER) FROM json_each(?1) input)
        AND EXISTS (SELECT 1 FROM json_each(?1) input WHERE CAST(json_extract(input.value,'$.listingId') AS INTEGER)=listings.id AND listings.shop_session_id=CAST(json_extract(input.value,'$.shopSessionId') AS INTEGER) AND listings.state_version=CAST(json_extract(input.value,'$.expectedVersion') AS INTEGER))
      RETURNING id`);
      const history = db.prepare(`INSERT OR IGNORE INTO listing_price_history(listing_id,observed_at,price,quantity,event_type,batch_id)
        SELECT l.id,json_extract(item.value,'$.observedAt'),json_extract(item.value,'$.price'),json_extract(item.value,'$.quantity'),json_extract(item.value,'$.history.eventType'),json_extract(item.value,'$.batchId')
        FROM json_each(?1) item JOIN listings l ON l.id=CAST(json_extract(item.value,'$.listingId') AS INTEGER) AND l.shop_session_id=CAST(json_extract(item.value,'$.shopSessionId') AS INTEGER) AND l.state_version=CAST(json_extract(item.value,'$.expectedVersion') AS INTEGER)+1 AND l.last_batch_id=json_extract(item.value,'$.batchId')
        WHERE json_type(item.value,'$.history')='object'`);
      const sold = db.prepare(`INSERT OR IGNORE INTO sold_events(listing_id,sold_quantity,from_quantity,to_quantity,reason,observed_at,transition_key)
        SELECT l.id,json_extract(item.value,'$.soldEvent.soldQuantity'),json_extract(item.value,'$.soldEvent.fromQuantity'),json_extract(item.value,'$.soldEvent.toQuantity'),json_extract(item.value,'$.soldEvent.reason'),json_extract(item.value,'$.observedAt'),json_extract(item.value,'$.soldEvent.transitionKey')
        FROM json_each(?1) item JOIN listings l ON l.id=CAST(json_extract(item.value,'$.listingId') AS INTEGER) AND l.shop_session_id=CAST(json_extract(item.value,'$.shopSessionId') AS INTEGER) AND l.state_version=CAST(json_extract(item.value,'$.expectedVersion') AS INTEGER)+1 AND l.last_batch_id=json_extract(item.value,'$.batchId')
        WHERE json_type(item.value,'$.soldEvent')='object'`);
      assertBatchBounds(3, 3);
      const results = await db.batch([update.bind(payload), history.bind(payload), sold.bind(payload)]);
      const returned = new Set<number>(((results[0] as unknown as { results?: Row[] })?.results ?? []).map((row) => Number(row.id)));
      const conflictIds = changes.filter((change) => !returned.has(change.listingId)).map((change) => change.listingId);
      return { updated: returned.size, conflicts: conflictIds.length, soldEvents: Number(results[2]?.meta?.changes ?? 0), conflictIds };
    },
    async markShopHeartbeats(sourceId, shopKeys, observedAt) {
      if (shopKeys.length === 0) return 0;
      let updated = 0;
      for (let offset = 0; offset < shopKeys.length; offset += 40) {
        const chunk = shopKeys.slice(offset, offset + 40);
        assertBatchBounds(1, 3);
        const result = await db.prepare('UPDATE shops SET last_seen_at=?3,updated_at=?3,status=CASE WHEN status=\'closed\' THEN status ELSE \'active\' END WHERE id IN (SELECT s.id FROM json_each(?1) input CROSS JOIN shops s ON s.source_id=?2 AND s.shop_key=input.value)').bind(JSON.stringify(chunk), sourceId, observedAt).run();
        updated += Number(result.meta?.changes ?? 0);
      }
      return updated;
    },
    async getUninitializedShopKeys(sourceId, shopKeys) {
      if (shopKeys.length === 0) return [];
      const missing: string[] = [];
      for (let offset = 0; offset < shopKeys.length; offset += 40) {
        const chunk = shopKeys.slice(offset, offset + 40);
        assertBatchBounds(1, 2);
        const rows = await many<Row>(db.prepare(`SELECT input.value AS shop_key FROM json_each(?1) input
          WHERE NOT EXISTS (SELECT 1 FROM shops s JOIN shop_sessions ss ON ss.shop_id=s.id
            WHERE s.source_id=?2 AND s.shop_key=input.value AND ss.ended_at IS NULL AND ss.initial_sync_complete=1)`).bind(JSON.stringify(chunk), sourceId));
        missing.push(...rows.map((row) => String(row.shop_key)));
      }
      return missing;
    },
    async recordSnapshotSessions(sourceId, snapshotId, sessionIds, observedAt) {
      if (sessionIds.length === 0) return;
      assertBatchBounds(1, 4);
      const payload = JSON.stringify(sessionIds.map((id) => ({ id })));
      await db.prepare('INSERT OR IGNORE INTO snapshot_sessions(source_id,snapshot_id,shop_session_id,observed_at) SELECT ?2,?3,CAST(json_extract(value,\'$.id\') AS INTEGER),?4 FROM json_each(?1)').bind(payload, sourceId, snapshotId, observedAt).run();
    },
    async getSnapshotSessionIds(sourceId, snapshotId) {
      const rows = await many<Row>(db.prepare('SELECT shop_session_id FROM snapshot_sessions WHERE source_id=?1 AND snapshot_id=?2 ORDER BY shop_session_id').bind(sourceId, snapshotId));
      return rows.map((row) => Number(row.shop_session_id));
    },
    async finalizeSnapshot(sourceId, snapshotId, observedAt) {
      await db.prepare('UPDATE market_sources SET last_full_snapshot_at=?1 WHERE id=?2').bind(observedAt, sourceId).run();
      await db.prepare('UPDATE shop_sessions SET last_complete_snapshot_id=?1,initial_sync_complete=1 WHERE id IN (SELECT shop_session_id FROM snapshot_sessions WHERE source_id=?2 AND snapshot_id=?1) AND ended_at IS NULL').bind(snapshotId, sourceId).run();
    },
    async reconcileSnapshot(input: SnapshotReconciliationInput): Promise<ReconciliationResult> {
      if (input.batchIds.length === 0) return { sourceId: input.sourceId, snapshotId: input.snapshotId, complete: false, baseline: false, shops: 0, candidates: 0, markedMissing: 0, inferredSold: 0, expired: 0 };
      const sessionIds = [...new Set((input.sessionIds ?? []).filter((id) => Number.isSafeInteger(id) && id > 0))];
      if (sessionIds.length === 0) return { sourceId: input.sourceId, snapshotId: input.snapshotId, complete: true, baseline: false, shops: 0, candidates: 0, markedMissing: 0, inferredSold: 0, expired: 0 };
      const scopePayload = JSON.stringify(sessionIds.map((id) => ({ id, observedAt: input.observedAt })));
      const batchPayload = JSON.stringify(input.batchIds);
      const scopeSql = `SELECT CAST(json_extract(value,'$.id') AS INTEGER) AS id FROM json_each(?2) WHERE json_extract(value,'$.observedAt')=?1`;
      const baselineRow = await one<Row>(db.prepare(`SELECT COUNT(*) AS count FROM shop_sessions ss JOIN shops s ON s.id=ss.shop_id WHERE s.source_id=?3 AND ss.id IN (${scopeSql}) AND ss.started_at <= ?1 AND ss.ended_at IS NULL AND ss.initial_sync_complete=0`).bind(input.observedAt, scopePayload, input.sourceId));
      const baseline = Number(baselineRow?.count ?? 0) > 0;
      if (baseline) {
        return { sourceId: input.sourceId, snapshotId: input.snapshotId, complete: true, baseline: true, shops: 0, candidates: 0, markedMissing: 0, inferredSold: 0, expired: 0 };
      }
      const scopedSessions = `(SELECT id FROM shop_sessions WHERE id IN (${scopeSql}) AND started_at <= ?1 AND last_seen_at=?1 AND initial_sync_complete=1)`;
      const stalePredicate = `shop_session_id IN ${scopedSessions} AND status IN ('active','missing') AND (last_batch_id IS NULL OR last_batch_id NOT IN (SELECT value FROM json_each(?3)))`;
      const candidateRows = await many<Row>(db.prepare(`SELECT id,quantity,state_version FROM listings WHERE ${stalePredicate} AND missing_streak=1 AND quantity>0`).bind(input.observedAt, scopePayload, batchPayload));
      const inferredCandidates = await Promise.all(candidateRows.map(async (row) => ({
        listingId: Number(row.id),
        soldQuantity: Number(row.quantity),
        fromQuantity: Number(row.quantity),
        toQuantity: 0,
        reason: 'missing_streak',
        observedAt: input.observedAt,
        newStateVersion: Number(row.state_version) + 1,
        transitionKey: await makeTransitionKey(Number(row.id), Number(row.state_version), Number(row.quantity), 0, 'missing_streak'),
      })));
      const staleSql = `UPDATE listings SET missing_streak=missing_streak+1,status=CASE WHEN missing_streak+1>=2 THEN 'missing' ELSE status END,last_changed_at=?1,state_version=state_version+1 WHERE ${stalePredicate}`;
      const writes = [db.prepare(staleSql).bind(input.observedAt, scopePayload, batchPayload)];
      if (inferredCandidates.length > 0) {
        writes.push(db.prepare(`INSERT OR IGNORE INTO sold_events(listing_id,sold_quantity,from_quantity,to_quantity,reason,observed_at,transition_key)
          SELECT json_extract(value,'$.listingId'),json_extract(value,'$.soldQuantity'),json_extract(value,'$.fromQuantity'),json_extract(value,'$.toQuantity'),json_extract(value,'$.reason'),json_extract(value,'$.observedAt'),json_extract(value,'$.transitionKey')
          FROM json_each(?1)
          WHERE EXISTS (SELECT 1 FROM listings l WHERE l.id=json_extract(value,'$.listingId') AND l.state_version=json_extract(value,'$.newStateVersion') AND l.missing_streak=2 AND l.status='missing' AND l.last_changed_at=json_extract(value,'$.observedAt'))`).bind(JSON.stringify(inferredCandidates)));
      }
      assertBatchBounds(writes.length, 3 + (inferredCandidates.length > 0 ? 1 : 0));
      const writeResults = await db.batch(writes);
      const staleResult = writeResults[0] ?? { meta: { changes: 0 } };
      const markedRow = await one<Row>(db.prepare(`SELECT COUNT(*) AS count FROM listings WHERE shop_session_id IN ${scopedSessions} AND status IN ('active','missing') AND missing_streak=1 AND (last_batch_id IS NULL OR last_batch_id NOT IN (SELECT value FROM json_each(?3)))`).bind(input.observedAt, scopePayload, batchPayload));
      const expiredResult = await db.prepare(`UPDATE listings SET status='expired',last_changed_at=?1 WHERE shop_session_id IN ${scopedSessions} AND status IN ('active','missing') AND EXISTS (SELECT 1 FROM shop_sessions ss WHERE ss.id=listings.shop_session_id AND ss.ended_at IS NOT NULL AND ss.ended_at <= ?1)`).bind(input.observedAt, scopePayload).run();
      const shopsRow = await one<Row>(db.prepare(`SELECT COUNT(DISTINCT s.id) AS count FROM shops s JOIN shop_sessions ss ON ss.shop_id=s.id WHERE ss.id IN ${scopedSessions} AND ss.ended_at IS NULL`).bind(input.observedAt, scopePayload));
      const candidates = Number(staleResult.meta?.changes ?? 0);
      const inferredSold = inferredCandidates.length > 0 ? Number(writeResults[1]?.meta?.changes ?? 0) : 0;
      return { sourceId: input.sourceId, snapshotId: input.snapshotId, complete: true, baseline, shops: Number(shopsRow?.count ?? 0), candidates, markedMissing: Number(markedRow?.count ?? 0), inferredSold, expired: Number(expiredResult.meta?.changes ?? 0) };
    },
    async searchListings(filters) {
      const params: unknown[] = [];
      const where = [filters.include_stale ? "l.status IN ('active','missing')" : "l.status='active'"];
      const add = (value: unknown) => { params.push(value); return `?${params.length}`; };
      if (filters.q) {
        const q = `%${filters.q.normalize('NFKC').trim().toLowerCase()}%`;
        const p = add(q);
        where.push(`(EXISTS (SELECT 1 FROM item_catalog c_q WHERE c_q.item_id=l.item_id AND (c_q.name_normalized LIKE ${p} OR EXISTS (SELECT 1 FROM item_aliases a_q WHERE a_q.item_id=c_q.item_id AND a_q.alias_normalized LIKE ${p}))) OR s.title_normalized LIKE ${p} OR v.name_normalized LIKE ${p})`);
      }
      if (filters.item_id !== undefined) where.push(`l.item_id=${add(filters.item_id)}`);
      if (filters.price_min !== undefined) where.push(`l.price>=${add(filters.price_min)}`);
      if (filters.price_max !== undefined) where.push(`l.price<=${add(filters.price_max)}`);
      if (filters.map) where.push(`s.map_name=${add(filters.map.normalize('NFKC').trim())}`);
      if (filters.shop_type) where.push(`s.shop_type=${add(filters.shop_type)}`);
      if (filters.options && filters.options.length > 0) {
        const clauses = filters.options.map((option) => `EXISTS (SELECT 1 FROM listing_options lo WHERE lo.listing_id=l.id AND lo.option_type=${add(option.type)} AND lo.option_value=${add(option.value)} AND lo.option_param=${add(option.param)})`);
        where.push(filters.option_mode === 'any' ? `(${clauses.join(' OR ')})` : clauses.join(' AND '));
      } else if (filters.option_type !== undefined) { where.push(`EXISTS (SELECT 1 FROM listing_options lo WHERE lo.listing_id=l.id AND lo.option_type=${add(filters.option_type)}${filters.option_value === undefined ? '' : ` AND lo.option_value=${add(filters.option_value)}`}${filters.option_param === undefined ? '' : ` AND lo.option_param=${add(filters.option_param)}`})`); }
      const cursor = filters.cursor ? decodeCursor(filters.cursor, { sort: filters.sort, context: searchCursorContext(filters) }, cursorSecret) : null;
      const sortColumn = filters.sort === 'updated_desc' ? 'l.last_seen_at' : 'l.price';
      if (cursor) {
        const value = add(cursor.sortValue);
        const sameValue = add(cursor.sortValue);
        const id = add(cursor.id);
        const operator = filters.sort === 'price_asc' ? '>' : '<';
        where.push(`(${sortColumn} ${operator} ${value} OR (${sortColumn} = ${sameValue} AND l.id ${operator} ${id}))`);
      }
      const limit = Math.min(50, Math.max(1, filters.limit)); params.push(limit + 1);
      const order = filters.sort === 'price_desc' ? 'l.price DESC,l.id DESC' : filters.sort === 'updated_desc' ? 'l.last_seen_at DESC,l.id DESC' : 'l.price ASC,l.id ASC';
      const rows = await many<Row>(db.prepare(`SELECT l.*,COALESCE(c.canonical_name_zh,'未知物品 #' || l.item_id) AS item_name_display,s.shop_key,s.title,v.name AS vendor_name,s.map_name,s.shop_type FROM listings l JOIN shop_sessions ss ON ss.id=l.shop_session_id JOIN shops s ON s.id=ss.shop_id JOIN vendors v ON v.id=s.vendor_id LEFT JOIN item_catalog c ON c.item_id=l.item_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?${params.length}`).bind(...params));
      const items = rows.slice(0, limit).map(listingFromSearchRow);
      if (items.length > 0) {
        const ids = items.map((item) => item.id);
        const optionPlaceholders = ids.map((_, index) => `?${index + 1}`).join(',');
        const optionRows = await many<Row>(db.prepare(`SELECT listing_id,option_type,option_value,option_param FROM listing_options WHERE listing_id IN (${optionPlaceholders}) ORDER BY listing_id,option_index`).bind(...ids));
        const optionsByListing = new Map<number, ListingOption[]>();
        for (const row of optionRows) {
          const listingId = Number(row.listing_id);
          optionsByListing.set(listingId, [...(optionsByListing.get(listingId) ?? []), { type: Number(row.option_type), value: Number(row.option_value), param: Number(row.option_param) }]);
        }
        for (const item of items) item.options = optionsByListing.get(item.id) ?? [];
      }
      const last = items.at(-1);
      const sortValue = last ? (filters.sort === 'updated_desc' ? last.lastSeenAt : last.price) : 0;
      return { items, nextCursor: rows.length > limit && last ? encodeCursor({ sort: filters.sort, sortValue, id: last.id, context: searchCursorContext(filters) }, cursorSecret) : null };
    },
    async getListingHistory(listingId, limit, cursor) {
      const listing = await one<Row>(db.prepare('SELECT id FROM listings WHERE id=?1 LIMIT 1').bind(listingId));
      if (!listing) return null;
      const params: unknown[] = [listingId];
      let sql = 'SELECT * FROM listing_price_history WHERE listing_id=?1';
      if (cursor) { params.push(decodeHistoryCursor(cursor, cursorSecret)); sql += ` AND id<?${params.length}`; }
      params.push(Math.min(50, Math.max(1, limit)) + 1); sql += ` ORDER BY id DESC LIMIT ?${params.length}`;
      const rows = await many<Row>(db.prepare(sql).bind(...params));
      const items = rows.slice(0, Number(params.at(-1)) - 1).map((row) => ({ id: Number(row.id), listingId: Number(row.listing_id), observedAt: Number(row.observed_at), price: Number(row.price), quantity: Number(row.quantity), eventType: String(row.event_type), batchId: String(row.batch_id) }));
      const saleRows = await many<Row>(db.prepare('SELECT observed_at,sold_quantity,from_quantity,to_quantity,reason FROM sold_events WHERE listing_id=?1 ORDER BY id DESC LIMIT ?2').bind(listingId, Math.min(50, Math.max(1, limit))));
      const inferredSales: InferredSaleRow[] = saleRows.map((row) => ({ observedAt: Number(row.observed_at), soldQuantity: Number(row.sold_quantity), fromQuantity: Number(row.from_quantity), toQuantity: Number(row.to_quantity), reason: String(row.reason) }));
      return { items, inferredSales, nextCursor: rows.length > items.length && items.at(-1) ? encodeHistoryCursor(items.at(-1)!.id, cursorSecret) : null };
    },
    async getOptionDictionary(version) {
      const statement = version ? db.prepare('SELECT * FROM option_dictionary WHERE version=?1 ORDER BY option_type,option_value,option_param').bind(version) : db.prepare('SELECT * FROM option_dictionary WHERE version=(SELECT MAX(version) FROM option_dictionary) ORDER BY option_type,option_value,option_param');
      const rows = await many<Row>(statement);
      return rows.map((row) => ({ version: String(row.version), optionType: Number(row.option_type), optionValue: Number(row.option_value), optionParam: Number(row.option_param), name: String(row.name), description: String(row.description), searchTokens: String(row.search_tokens) }));
    },
    async getCatalogVersion() {
      const row = await one<Row>(db.prepare('SELECT current_version FROM catalog_state WHERE id=1 LIMIT 1'));
      return row?.current_version === undefined || row.current_version === null ? 'unpublished' : String(row.current_version);
    },
    async searchItems(query, limit) {
      const normalized = normalizeCatalogQuery(query);
      if (!normalized) return [];
      const short = [...normalized].length <= 2;
      const match = short ? normalized : '"' + normalized.replaceAll('"', '""') + '"';
      const source = short
        ? "FROM search_short_tokens st JOIN item_catalog c ON c.item_id=st.scope_id WHERE st.scope_type='item' AND st.token=?1"
        : 'FROM item_search_fts f JOIN item_catalog c ON c.item_id=f.rowid WHERE f.text MATCH ?1';
      const sql = 'SELECT c.item_id,c.canonical_name_zh,' +
        "COALESCE((SELECT json_group_array(alias) FROM (SELECT alias FROM item_aliases a WHERE a.item_id=c.item_id ORDER BY a.alias_normalized)), '[]') AS aliases_json " +
        source +
        ' ORDER BY CASE WHEN c.name_normalized=?2 THEN 0 ELSE 1 END,c.item_id LIMIT ?3';
      const rows = await many<Row>(db.prepare(sql).bind(match, normalized, Math.min(20, Math.max(1, limit))));
      return rows.map((row): CatalogItemRow => ({ itemId: Number(row.item_id), name: String(row.canonical_name_zh), aliases: parseAliases(row.aliases_json) }));
    },
    async deleteExpiredHistory(before, limit) { const result = await db.prepare('DELETE FROM listing_price_history WHERE id IN (SELECT id FROM listing_price_history WHERE observed_at < ?1 ORDER BY observed_at,id LIMIT ?2)').bind(before, limit).run(); return Number(result.meta?.changes ?? 0); },
    async deleteExpiredSoldEvents(before, limit) { const result = await db.prepare('DELETE FROM sold_events WHERE id IN (SELECT id FROM sold_events WHERE observed_at < ?1 ORDER BY observed_at,id LIMIT ?2)').bind(before, limit).run(); return Number(result.meta?.changes ?? 0); },
    async countExpiredHistory(before, limit) { const row = await one<Row>(db.prepare('SELECT COUNT(*) AS count FROM (SELECT id FROM listing_price_history WHERE observed_at < ?1 ORDER BY observed_at,id LIMIT ?2)').bind(before, limit)); return Number(row?.count ?? 0); },
    async countExpiredSoldEvents(before, limit) { const row = await one<Row>(db.prepare('SELECT COUNT(*) AS count FROM (SELECT id FROM sold_events WHERE observed_at < ?1 ORDER BY observed_at,id LIMIT ?2)').bind(before, limit)); return Number(row?.count ?? 0); },
  };
}

function batchFromRow(row: Row): BatchRow { return { id: Number(row.id), sourceId: String(row.source_id), batchId: String(row.batch_id), snapshotId: String(row.snapshot_id), partIndex: Number(row.part_index), partCount: Number(row.part_count), snapshotMode: String(row.snapshot_mode) as BatchRow['snapshotMode'], payloadHash: String(row.payload_hash), status: String(row.status), responseJson: row.response_json === null ? null : String(row.response_json) }; }
function sessionFromRow(row: Row) { return { id: Number(row.id), shopId: Number(row.shop_id), clientRunId: String(row.client_run_id), startedAt: Number(row.started_at), lastSeenAt: Number(row.last_seen_at), endedAt: row.ended_at === null ? null : Number(row.ended_at), initialSyncComplete: bool(row.initial_sync_complete), lastCompleteSnapshotId: row.last_complete_snapshot_id ? String(row.last_complete_snapshot_id) : null }; }
function listingFromRow(row: Row): ListingRow { return { id: Number(row.id), shopSessionId: Number(row.shop_session_id), itemFingerprint: String(row.item_fingerprint), itemKey: row.item_key === null ? null : String(row.item_key), itemId: Number(row.item_id), upgrade: Number(row.upgrade), slots: Number(row.slots), cards: cards(row), price: Number(row.price), quantity: Number(row.quantity), lastQuantity: Number(row.last_quantity), status: String(row.status), stateVersion: Number(row.state_version), missingStreak: Number(row.missing_streak), lastSeenAt: Number(row.last_seen_at) }; }
function listingFromSearchRow(row: Row): ListingSearchRow { return { ...listingFromRow(row), itemName: String(row.item_name_display ?? `未知物品 #${Number(row.item_id)}`), shopKey: String(row.shop_key), title: String(row.title), vendorName: String(row.vendor_name), mapName: String(row.map_name), shopType: String(row.shop_type) as 'buy' | 'sell', options: [] }; }

async function closeShopSession(db: D1Database, shopId: number, observedAt: number): Promise<void> {
  const current = await one<Row>(db.prepare('SELECT id FROM shop_sessions WHERE shop_id=?1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1').bind(shopId));
  if (!current) return;
  await db.batch([
    db.prepare('UPDATE shop_sessions SET ended_at=?1 WHERE id=?2 AND ended_at IS NULL').bind(observedAt, current.id),
    db.prepare("UPDATE listings SET status='expired',last_changed_at=?1 WHERE shop_session_id=?2 AND status IN ('active','missing')").bind(observedAt, current.id),
  ]);
}

async function getOrCreateD1Session(db: D1Database, input: SessionInput): Promise<ReturnType<typeof sessionFromRow>> {
  const current = await one<Row>(db.prepare('SELECT * FROM shop_sessions WHERE shop_id=?1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1').bind(input.shopId));
  const ttl = 30 * 60 * 1000;
  if (current && String(current.client_run_id) === input.clientRunId && input.observedAt - Number(current.last_seen_at) <= ttl) {
    await db.prepare('UPDATE shop_sessions SET last_seen_at=?1 WHERE id=?2').bind(input.observedAt, current.id).run();
    return sessionFromRow({ ...current, last_seen_at: input.observedAt });
  }
  if (current) await closeShopSession(db, input.shopId, input.observedAt);
  const row = await one<Row>(db.prepare('INSERT INTO shop_sessions(shop_id,client_run_id,started_at,last_seen_at) VALUES(?1,?2,?3,?3) RETURNING *').bind(input.shopId, input.clientRunId, input.observedAt));
  if (!row) throw new Error('session insert returned no row');
  return sessionFromRow(row);
}

function normalizeCatalogQuery(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function parseAliases(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
