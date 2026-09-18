import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { assertBatchBounds } from './repository';
import { decodeCursor, decodeHistoryCursor, encodeCursor, encodeHistoryCursor, searchCursorContext } from '../domain/search';
import type { BatchRow, ListingRow, ListingOption, ListingSearchRow, SessionInput, ShopInput, ShopRow, SourceRow, VendorInput } from './types';
import type { ListingTransitionChange, MarketRepository, ReconciliationResult, SnapshotReconciliationInput, UploadResultLike } from './repository';

type Row = Record<string, unknown>;
const BULK_BATCH_SIZE = 12;
const one = async <T extends Row>(statement: D1PreparedStatement): Promise<T | null> => ((await statement.first<T>()) ?? null);
const many = async <T extends Row>(statement: D1PreparedStatement): Promise<T[]> => (await statement.all<T>()).results ?? [];
const bool = (value: unknown): boolean => Number(value) === 1;
const cards = (row: Row): number[] => [row.card0, row.card1, row.card2, row.card3].map((v) => Number(v ?? 0));

export function createD1Repository(db: D1Database): MarketRepository {
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
      if (current) await db.prepare('UPDATE shop_sessions SET ended_at=?1 WHERE id=?2').bind(input.observedAt, current.id).run();
      const row = await one<Row>(db.prepare('INSERT INTO shop_sessions(shop_id,client_run_id,started_at,last_seen_at) VALUES(?1,?2,?3,?3) RETURNING *').bind(input.shopId, input.clientRunId, input.observedAt));
      if (!row) throw new Error('session insert returned no row');
      return { id: Number(row.id), shopId: Number(row.shop_id), clientRunId: String(row.client_run_id), startedAt: Number(row.started_at), lastSeenAt: Number(row.last_seen_at), endedAt: null, initialSyncComplete: false, lastCompleteSnapshotId: null };
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
      await db.prepare('UPDATE upload_batches SET status=\'accepted\',processed_shops=?1,processed_listings=?2,changed_listings=?3,sold_events=?4,response_json=?5 WHERE source_id=?6 AND batch_id=?7').bind(response.processedShops, response.processedListings, response.changedListings, response.soldEvents, JSON.stringify(response), sourceId, batchId).run();
    },
    async loadListingsByFingerprint(sessionId, fingerprints) {
      if (fingerprints.length === 0) return [];
      if (fingerprints.length > 40) throw new Error('listing lookup exceeds bounded batch size');
      const placeholders = fingerprints.map((_, index) => `?${index + 2}`).join(',');
      const rows = await many<Row>(db.prepare(`SELECT * FROM listings WHERE shop_session_id=?1 AND item_fingerprint IN (${placeholders})`).bind(sessionId, ...fingerprints));
      return rows.map(listingFromRow);
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
      const row = await one<Row>(db.prepare(`INSERT INTO listings(shop_session_id,item_fingerprint,item_key,item_id,item_name,item_name_normalized,upgrade,slots,card0,card1,card2,card3,price,quantity,last_quantity,status,first_seen_at,last_seen_at,last_changed_at,last_batch_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14,'active',?15,?15,?15,?16) RETURNING *`).bind(input.sessionId, input.fingerprint, input.itemKey ?? null, input.itemId, input.itemName, input.itemNameNormalized, input.upgrade, input.slots, input.cards[0] ?? 0, input.cards[1] ?? 0, input.cards[2] ?? 0, input.cards[3] ?? 0, input.price, input.quantity, input.observedAt, input.batchId));
      if (!row) throw new Error('listing insert returned no row');
      return listingFromRow(row);
    },
    async createListingsBatch(inputs) {
      if (inputs.length === 0) return [];
      assertBatchBounds(1, 1);
      const payload = JSON.stringify(inputs.map((input) => ({ ...input, itemKey: input.itemKey ?? null, cards: [input.cards[0] ?? 0, input.cards[1] ?? 0, input.cards[2] ?? 0, input.cards[3] ?? 0] })));
      const rows = await many<Row>(db.prepare(`INSERT INTO listings(shop_session_id,item_fingerprint,item_key,item_id,item_name,item_name_normalized,upgrade,slots,card0,card1,card2,card3,price,quantity,last_quantity,status,first_seen_at,last_seen_at,last_changed_at,last_batch_id)
        SELECT json_extract(value,'$.sessionId'),json_extract(value,'$.fingerprint'),json_extract(value,'$.itemKey'),json_extract(value,'$.itemId'),json_extract(value,'$.itemName'),json_extract(value,'$.itemNameNormalized'),json_extract(value,'$.upgrade'),json_extract(value,'$.slots'),json_extract(value,'$.cards[0]'),json_extract(value,'$.cards[1]'),json_extract(value,'$.cards[2]'),json_extract(value,'$.cards[3]'),json_extract(value,'$.price'),json_extract(value,'$.quantity'),json_extract(value,'$.quantity'),'active',json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),json_extract(value,'$.batchId') FROM json_each(?1) RETURNING *`).bind(payload));
      return rows.map(listingFromRow);
    },
    async insertListingOptions(input: { listingId: number; options: ListingOption[] }) {
      if (input.options.length === 0) return;
      const options = [...input.options].sort((left, right) => left.type - right.type || left.value - right.value || left.param - right.param);
      assertBatchBounds(options.length, options.length * 5);
      await db.batch(options.map((option, index) => db.prepare('INSERT OR REPLACE INTO listing_options(listing_id,option_index,option_type,option_value,option_param,display_value) VALUES(?1,?2,?3,?4,?5,?6)').bind(input.listingId, index, option.type, option.value, option.param, option.displayValue ?? (option as unknown as { display_value?: string }).display_value ?? null)));
    },
    async insertHistory(input) { await db.prepare('INSERT INTO listing_price_history(listing_id,observed_at,price,quantity,event_type,batch_id) VALUES(?1,?2,?3,?4,?5,?6)').bind(input.listingId, input.observedAt, input.price, input.quantity, input.eventType, input.batchId).run(); },
    async insertHistoriesBatch(inputs) {
      if (inputs.length === 0) return;
      for (let offset = 0; offset < inputs.length; offset += BULK_BATCH_SIZE) {
        const chunk = inputs.slice(offset, offset + BULK_BATCH_SIZE);
        assertBatchBounds(chunk.length, chunk.length * 6);
        await db.batch(chunk.map((input) => db.prepare('INSERT INTO listing_price_history(listing_id,observed_at,price,quantity,event_type,batch_id) VALUES(?1,?2,?3,?4,?5,?6)').bind(input.listingId, input.observedAt, input.price, input.quantity, input.eventType, input.batchId)));
      }
    },
    async insertListingOptionsBatch(inputs) {
      const rows = inputs.flatMap((input) => [...input.options].sort((left, right) => left.type - right.type || left.value - right.value || left.param - right.param).map((option, index) => ({ listingId: input.listingId, optionIndex: index, type: option.type, value: option.value, param: option.param, displayValue: option.displayValue ?? (option as unknown as { display_value?: string }).display_value ?? null })));
      if (rows.length === 0) return;
      for (let offset = 0; offset < rows.length; offset += BULK_BATCH_SIZE) {
        const chunk = rows.slice(offset, offset + BULK_BATCH_SIZE);
        assertBatchBounds(chunk.length, chunk.length * 6);
        await db.batch(chunk.map((row) => db.prepare('INSERT OR REPLACE INTO listing_options(listing_id,option_index,option_type,option_value,option_param,display_value) VALUES(?1,?2,?3,?4,?5,?6)').bind(row.listingId, row.optionIndex, row.type, row.value, row.param, row.displayValue)));
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
          if (change.history) { boundValues += 8; statements.push(db.prepare('INSERT INTO listing_price_history(listing_id,observed_at,price,quantity,event_type,batch_id) SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS (SELECT 1 FROM listings WHERE id=?1 AND shop_session_id=?7 AND state_version=?8 AND last_batch_id=?6)').bind(change.listingId, change.observedAt, change.price, change.quantity, change.history.eventType, change.batchId, change.shopSessionId, change.expectedVersion + 1)); }
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
    async markShopHeartbeats(sourceId, shopKeys, observedAt) {
      if (shopKeys.length === 0) return 0;
      let updated = 0;
      for (let offset = 0; offset < shopKeys.length; offset += 40) {
        const chunk = shopKeys.slice(offset, offset + 40);
        assertBatchBounds(chunk.length, chunk.length * 3);
        const statements = chunk.map((key) => db.prepare('UPDATE shops SET last_seen_at=?1,updated_at=?1,status=CASE WHEN status=\'closed\' THEN status ELSE \'active\' END WHERE source_id=?2 AND shop_key=?3').bind(observedAt, sourceId, key));
        const results = await db.batch(statements);
        updated += results.reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0);
      }
      return updated;
    },
    async finalizeSnapshot(sourceId, snapshotId, observedAt) {
      await db.prepare('UPDATE market_sources SET last_full_snapshot_at=?1 WHERE id=?2').bind(observedAt, sourceId).run();
      await db.prepare('UPDATE shop_sessions SET last_complete_snapshot_id=?1,initial_sync_complete=1 WHERE shop_id IN (SELECT id FROM shops WHERE source_id=?2) AND ended_at IS NULL').bind(snapshotId, sourceId).run();
    },
    async reconcileSnapshot(input: SnapshotReconciliationInput): Promise<ReconciliationResult> {
      if (input.batchIds.length === 0) return { sourceId: input.sourceId, snapshotId: input.snapshotId, complete: false, baseline: false, shops: 0, candidates: 0, markedMissing: 0, inferredSold: 0, expired: 0 };
      const placeholders = input.batchIds.map((_, index) => `?${index + 2}`).join(',');
      const params = [...input.batchIds, input.sourceId];
      const baselineRow = await one<Row>(db.prepare(`SELECT COUNT(*) AS count FROM shop_sessions ss JOIN shops s ON s.id=ss.shop_id WHERE s.source_id=?1 AND ss.ended_at IS NULL AND ss.initial_sync_complete=0`).bind(input.sourceId));
      const baseline = Number(baselineRow?.count ?? 0) > 0;
      const staleSql = `UPDATE listings SET missing_streak=missing_streak+1,status=CASE WHEN missing_streak+1>=2 THEN 'missing' ELSE status END,last_changed_at=?1 WHERE shop_session_id IN (SELECT ss.id FROM shop_sessions ss JOIN shops s ON s.id=ss.shop_id WHERE s.source_id=?${input.batchIds.length + 2} AND ss.ended_at IS NULL AND ss.initial_sync_complete=1) AND status IN ('active','missing') AND (last_batch_id IS NULL OR last_batch_id NOT IN (${placeholders}))`;
      const markedRow = await one<Row>(db.prepare(`SELECT COUNT(*) AS count FROM listings WHERE shop_session_id IN (SELECT ss.id FROM shop_sessions ss JOIN shops s ON s.id=ss.shop_id WHERE s.source_id=?1 AND ss.ended_at IS NULL AND ss.initial_sync_complete=1) AND status IN ('active','missing') AND missing_streak=1 AND (last_batch_id IS NULL OR last_batch_id NOT IN (${placeholders}))`).bind(input.sourceId, ...input.batchIds));
      const staleResult = await db.prepare(staleSql).bind(input.observedAt, ...params).run();
      const expiredResult = await db.prepare(`UPDATE listings SET status='expired',last_changed_at=?1 WHERE shop_session_id IN (SELECT ss.id FROM shop_sessions ss JOIN shops s ON s.id=ss.shop_id WHERE s.source_id=?2 AND ss.ended_at IS NOT NULL) AND status IN ('active','missing')`).bind(input.observedAt, input.sourceId).run();
      const shopsRow = await one<Row>(db.prepare('SELECT COUNT(DISTINCT s.id) AS count FROM shops s JOIN shop_sessions ss ON ss.shop_id=s.id WHERE s.source_id=?1 AND ss.ended_at IS NULL').bind(input.sourceId));
      const candidates = Number(staleResult.meta?.changes ?? 0);
      return { sourceId: input.sourceId, snapshotId: input.snapshotId, complete: true, baseline, shops: Number(shopsRow?.count ?? 0), candidates, markedMissing: Number(markedRow?.count ?? 0), inferredSold: 0, expired: Number(expiredResult.meta?.changes ?? 0) };
    },
    async searchListings(filters) {
      const params: unknown[] = [];
      const where = [filters.include_stale ? "l.status IN ('active','missing')" : "l.status='active'"];
      const add = (value: unknown) => { params.push(value); return `?${params.length}`; };
      if (filters.q) { const q = `%${filters.q.normalize('NFKC').trim().toLowerCase()}%`; const p = add(q); where.push(`(l.item_name_normalized LIKE ${p} OR s.title_normalized LIKE ${p} OR v.name_normalized LIKE ${p})`); }
      if (filters.item_id !== undefined) where.push(`l.item_id=${add(filters.item_id)}`);
      if (filters.price_min !== undefined) where.push(`l.price>=${add(filters.price_min)}`);
      if (filters.price_max !== undefined) where.push(`l.price<=${add(filters.price_max)}`);
      if (filters.map) where.push(`s.map_name=${add(filters.map.normalize('NFKC').trim())}`);
      if (filters.shop_type) where.push(`s.shop_type=${add(filters.shop_type)}`);
      if (filters.option_type !== undefined) { where.push(`EXISTS (SELECT 1 FROM listing_options lo WHERE lo.listing_id=l.id AND lo.option_type=${add(filters.option_type)}${filters.option_value === undefined ? '' : ` AND lo.option_value=${add(filters.option_value)}`}${filters.option_param === undefined ? '' : ` AND lo.option_param=${add(filters.option_param)}`})`); }
      const cursor = filters.cursor ? decodeCursor(filters.cursor, { sort: filters.sort, context: searchCursorContext(filters) }) : null;
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
      const rows = await many<Row>(db.prepare(`SELECT l.*,s.shop_key,s.title,v.name AS vendor_name,s.map_name,s.shop_type FROM listings l JOIN shop_sessions ss ON ss.id=l.shop_session_id JOIN shops s ON s.id=ss.shop_id JOIN vendors v ON v.id=s.vendor_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?${params.length}`).bind(...params));
      const items = rows.slice(0, limit).map(listingFromSearchRow);
      if (items.length > 0) {
        const ids = items.map((item) => item.id);
        const optionPlaceholders = ids.map((_, index) => `?${index + 1}`).join(',');
        const optionRows = await many<Row>(db.prepare(`SELECT listing_id,option_type,option_value,option_param,display_value FROM listing_options WHERE listing_id IN (${optionPlaceholders}) ORDER BY listing_id,option_index`).bind(...ids));
        const optionsByListing = new Map<number, ListingOption[]>();
        for (const row of optionRows) {
          const listingId = Number(row.listing_id);
          optionsByListing.set(listingId, [...(optionsByListing.get(listingId) ?? []), { type: Number(row.option_type), value: Number(row.option_value), param: Number(row.option_param), ...(row.display_value === null || row.display_value === undefined ? {} : { displayValue: String(row.display_value) }) }]);
        }
        for (const item of items) item.options = optionsByListing.get(item.id) ?? [];
      }
      const last = items.at(-1);
      const sortValue = last ? (filters.sort === 'updated_desc' ? last.lastSeenAt : last.price) : 0;
      return { items, nextCursor: rows.length > limit && last ? encodeCursor({ sort: filters.sort, sortValue, id: last.id, context: searchCursorContext(filters) }) : null };
    },
    async getListingHistory(listingId, limit, cursor) {
      const listing = await one<Row>(db.prepare('SELECT id FROM listings WHERE id=?1 LIMIT 1').bind(listingId));
      if (!listing) return null;
      const params: unknown[] = [listingId];
      let sql = 'SELECT * FROM listing_price_history WHERE listing_id=?1';
      if (cursor) { params.push(decodeHistoryCursor(cursor)); sql += ` AND id<?${params.length}`; }
      params.push(Math.min(50, Math.max(1, limit)) + 1); sql += ` ORDER BY id DESC LIMIT ?${params.length}`;
      const rows = await many<Row>(db.prepare(sql).bind(...params));
      const items = rows.slice(0, Number(params.at(-1)) - 1).map((row) => ({ id: Number(row.id), listingId: Number(row.listing_id), observedAt: Number(row.observed_at), price: Number(row.price), quantity: Number(row.quantity), eventType: String(row.event_type), batchId: String(row.batch_id) }));
      return { items, nextCursor: rows.length > items.length && items.at(-1) ? encodeHistoryCursor(items.at(-1)!.id) : null };
    },
    async getOptionDictionary(version) {
      const statement = version ? db.prepare('SELECT * FROM option_dictionary WHERE version=?1 ORDER BY option_type,option_value,option_param').bind(version) : db.prepare('SELECT * FROM option_dictionary WHERE version=(SELECT MAX(version) FROM option_dictionary) ORDER BY option_type,option_value,option_param');
      const rows = await many<Row>(statement);
      return rows.map((row) => ({ version: String(row.version), optionType: Number(row.option_type), optionValue: Number(row.option_value), optionParam: Number(row.option_param), name: String(row.name), description: String(row.description), searchTokens: String(row.search_tokens) }));
    },
    async deleteExpiredHistory(before, limit) { const result = await db.prepare('DELETE FROM listing_price_history WHERE id IN (SELECT id FROM listing_price_history WHERE observed_at < ?1 ORDER BY id LIMIT ?2)').bind(before, limit).run(); return Number(result.meta?.changes ?? 0); },
    async deleteExpiredSoldEvents(before, limit) { const result = await db.prepare('DELETE FROM sold_events WHERE id IN (SELECT id FROM sold_events WHERE observed_at < ?1 ORDER BY id LIMIT ?2)').bind(before, limit).run(); return Number(result.meta?.changes ?? 0); },
    async countExpiredHistory(before) { const row = await one<Row>(db.prepare('SELECT COUNT(*) AS count FROM listing_price_history WHERE observed_at < ?1').bind(before)); return Number(row?.count ?? 0); },
    async countExpiredSoldEvents(before) { const row = await one<Row>(db.prepare('SELECT COUNT(*) AS count FROM sold_events WHERE observed_at < ?1').bind(before)); return Number(row?.count ?? 0); },
  };
}

function batchFromRow(row: Row): BatchRow { return { id: Number(row.id), sourceId: String(row.source_id), batchId: String(row.batch_id), snapshotId: String(row.snapshot_id), partIndex: Number(row.part_index), partCount: Number(row.part_count), snapshotMode: String(row.snapshot_mode) as BatchRow['snapshotMode'], payloadHash: String(row.payload_hash), status: String(row.status), responseJson: row.response_json === null ? null : String(row.response_json) }; }
function listingFromRow(row: Row): ListingRow { return { id: Number(row.id), shopSessionId: Number(row.shop_session_id), itemFingerprint: String(row.item_fingerprint), itemKey: row.item_key === null ? null : String(row.item_key), itemId: Number(row.item_id), itemName: String(row.item_name), itemNameNormalized: String(row.item_name_normalized), upgrade: Number(row.upgrade), slots: Number(row.slots), cards: cards(row), price: Number(row.price), quantity: Number(row.quantity), lastQuantity: Number(row.last_quantity), status: String(row.status), stateVersion: Number(row.state_version), missingStreak: Number(row.missing_streak), lastSeenAt: Number(row.last_seen_at) }; }
function listingFromSearchRow(row: Row): ListingSearchRow { return { ...listingFromRow(row), shopKey: String(row.shop_key), title: String(row.title), vendorName: String(row.vendor_name), mapName: String(row.map_name), shopType: String(row.shop_type) as 'buy' | 'sell', options: [] }; }
