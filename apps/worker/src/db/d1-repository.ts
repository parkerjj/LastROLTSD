import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { assertBatchBounds } from './repository';
import { decodeCursor, decodeHistoryCursor, encodeCursor, encodeHistoryCursor, searchCursorContext, DEFAULT_CURSOR_SECRET, SearchValidationError } from '../domain/search';
import { compileOptionPredicates, formatOptionDisplay, OPTION_OPERATORS, OptionConditionValidationError, parseStructuredOptionCondition, type OptionDefinition, type OptionOperator, type OptionParamPolicy } from '../domain/option-conditions';
import { makeTransitionKey } from '../domain/transitions';
import { createMeteredD1Database, type D1Meter } from './d1-meter';
import { getOptionDefinitionSet } from '@lastroweb/options';
import type { BatchRow, CatalogItemRow, InferredSaleRow, ListingRow, ListingOption, ListingSearchOption, ListingSearchRow, SessionInput, ShopInput, ShopRow, ShopSessionRow, SourceRow, VendorInput } from './types';
import type { ListingTransitionChange, MarketRepository, ReconciliationResult, ShopResolution, SnapshotReconciliationInput, UploadResultLike, ShopSessionContextInput } from './repository';

type Row = Record<string, unknown>;
const BULK_BATCH_SIZE = 12;
const one = async <T extends Row>(statement: D1PreparedStatement): Promise<T | null> => ((await statement.all<T>()).results?.[0] ?? null);
const many = async <T extends Row>(statement: D1PreparedStatement): Promise<T[]> => (await statement.all<T>()).results ?? [];
const cards = (row: Row): number[] => [row.card0, row.card1, row.card2, row.card3].map((v) => Number(v ?? 0));
const shopResolutionKey = (sourceId: string, identityHash: string): string => JSON.stringify([sourceId, identityHash]);

function rowsFromBatchResult(result: unknown): Row[] {
  if (!result || typeof result !== 'object') return [];
  const rows = (result as { results?: unknown }).results;
  return Array.isArray(rows) ? rows.filter((row): row is Row => row !== null && typeof row === 'object' && !Array.isArray(row)) : [];
}

function isStaleShopObservation(existing: Row | undefined, input: ShopSessionContextInput): boolean {
  return existing !== undefined && (input.observedAt < Number(existing.last_status_observed_at) || (input.observedAt === Number(existing.last_status_observed_at) && input.shopStatus === 'opening' && String(existing.status) === 'closed'));
}

function shopResolutionPayload(inputs: ShopSessionContextInput[]): string {
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

export function createD1Repository(inputDb: D1Database, cursorSecret = DEFAULT_CURSOR_SECRET, meter?: D1Meter): MarketRepository {
  const db = meter ? createMeteredD1Database(inputDb, meter) : inputDb;
  const resolveShopObservations = async (inputs: ShopSessionContextInput[]): Promise<ShopResolution[]> => {
    if (inputs.length === 0) return [];
    const identities = JSON.stringify(inputs.map((input) => ({ sourceId: input.sourceId, identityHash: input.identityHash })));
    const existingRows = await many<Row>(db.prepare(`SELECT shops.* FROM shops JOIN json_each(?1) AS input
      ON shops.source_id=json_extract(input.value,'$.sourceId') AND shops.identity_hash=json_extract(input.value,'$.identityHash')`).bind(identities));
    const existingByKey = new Map(existingRows.map((row) => [shopResolutionKey(String(row.source_id), String(row.identity_hash)), row]));
    const payload = shopResolutionPayload(inputs);
    const insertDismissed = db.prepare(`INSERT OR IGNORE INTO shops(source_id,identity_hash,public_shop_id,vendor_account_id,vendor_name,vendor_name_normalized,title,title_normalized,shop_type,map_name,x,y,status,profile_hash,full_state_hash,last_status_observed_at,last_changed_at,closed_at,close_reason)
      SELECT json_extract(value,'$.sourceId'),json_extract(value,'$.identityHash'),json_extract(value,'$.shopId'),json_extract(value,'$.vendorAccountId'),json_extract(value,'$.vendorName'),json_extract(value,'$.vendorNameNormalized'),json_extract(value,'$.title'),json_extract(value,'$.titleNormalized'),json_extract(value,'$.shopType'),json_extract(value,'$.mapName'),json_extract(value,'$.x'),json_extract(value,'$.y'),'closed',json_extract(value,'$.profileHash'),NULL,json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),'explicit_dismissed'
      FROM json_each(?1) WHERE json_extract(value,'$.shopStatus')='dismissed'`);
    const upsertOpening = db.prepare(`INSERT INTO shops(source_id,identity_hash,public_shop_id,vendor_account_id,vendor_name,vendor_name_normalized,title,title_normalized,shop_type,map_name,x,y,status,profile_hash,full_state_hash,last_status_observed_at,last_changed_at,closed_at,close_reason)
      SELECT json_extract(value,'$.sourceId'),json_extract(value,'$.identityHash'),json_extract(value,'$.shopId'),json_extract(value,'$.vendorAccountId'),json_extract(value,'$.vendorName'),json_extract(value,'$.vendorNameNormalized'),json_extract(value,'$.title'),json_extract(value,'$.titleNormalized'),json_extract(value,'$.shopType'),json_extract(value,'$.mapName'),json_extract(value,'$.x'),json_extract(value,'$.y'),'active',json_extract(value,'$.profileHash'),json_extract(value,'$.fullStateHash'),json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),NULL,NULL
      FROM json_each(?1) WHERE json_extract(value,'$.shopStatus')='opening'
      ON CONFLICT(source_id,identity_hash) DO UPDATE SET public_shop_id=excluded.public_shop_id,vendor_account_id=excluded.vendor_account_id,vendor_name=excluded.vendor_name,vendor_name_normalized=excluded.vendor_name_normalized,title=excluded.title,title_normalized=excluded.title_normalized,shop_type=excluded.shop_type,map_name=excluded.map_name,x=excluded.x,y=excluded.y,status='active',profile_hash=excluded.profile_hash,full_state_hash=CASE WHEN shops.status='closed' THEN NULL ELSE shops.full_state_hash END,missing_full_count=CASE WHEN shops.status='closed' THEN 0 ELSE shops.missing_full_count END,last_status_observed_at=excluded.last_status_observed_at,last_changed_at=excluded.last_changed_at,closed_at=NULL,close_reason=NULL
      WHERE excluded.last_status_observed_at>shops.last_status_observed_at OR (excluded.last_status_observed_at=shops.last_status_observed_at AND shops.status<>'closed')
      RETURNING *`);
    const closeDismissed = db.prepare(`UPDATE shops SET status='closed',last_status_observed_at=(SELECT json_extract(input.value,'$.observedAt') FROM json_each(?1) AS input WHERE input.value IS NOT NULL AND shops.source_id=json_extract(input.value,'$.sourceId') AND shops.identity_hash=json_extract(input.value,'$.identityHash') LIMIT 1),last_changed_at=(SELECT json_extract(input.value,'$.observedAt') FROM json_each(?1) AS input WHERE input.value IS NOT NULL AND shops.source_id=json_extract(input.value,'$.sourceId') AND shops.identity_hash=json_extract(input.value,'$.identityHash') LIMIT 1),closed_at=(SELECT json_extract(input.value,'$.observedAt') FROM json_each(?1) AS input WHERE input.value IS NOT NULL AND shops.source_id=json_extract(input.value,'$.sourceId') AND shops.identity_hash=json_extract(input.value,'$.identityHash') LIMIT 1),close_reason='explicit_dismissed'
      WHERE EXISTS (SELECT 1 FROM json_each(?1) AS input WHERE json_extract(input.value,'$.shopStatus')='dismissed' AND shops.source_id=json_extract(input.value,'$.sourceId') AND shops.identity_hash=json_extract(input.value,'$.identityHash') AND shops.last_status_observed_at<=json_extract(input.value,'$.observedAt'))
      RETURNING *`);
    const expireDismissedListings = db.prepare(`UPDATE listings SET status='expired',last_changed_at=(SELECT json_extract(input.value,'$.observedAt') FROM shops JOIN json_each(?1) AS input ON shops.source_id=json_extract(input.value,'$.sourceId') AND shops.identity_hash=json_extract(input.value,'$.identityHash') WHERE shops.id=listings.shop_id AND json_extract(input.value,'$.shopStatus')='dismissed' LIMIT 1),state_version=state_version+1,missing_full_count=0
      WHERE status IN ('active','missing') AND EXISTS (SELECT 1 FROM shops JOIN json_each(?1) AS input
        ON shops.source_id=json_extract(input.value,'$.sourceId') AND shops.identity_hash=json_extract(input.value,'$.identityHash')
        WHERE shops.id=listings.shop_id AND json_extract(input.value,'$.shopStatus')='dismissed' AND shops.status='closed' AND shops.last_status_observed_at<=json_extract(input.value,'$.observedAt'))`);
    assertBatchBounds(4, 4);
    const writeResults = await db.batch([insertDismissed.bind(payload), upsertOpening.bind(payload), closeDismissed.bind(payload), expireDismissedListings.bind(payload)]);
    const resolvedRows = new Map(existingByKey);
    for (const row of [...rowsFromBatchResult(writeResults[1]), ...rowsFromBatchResult(writeResults[2])]) resolvedRows.set(shopResolutionKey(String(row.source_id), String(row.identity_hash)), row);

    return inputs.map((input) => {
      const key = shopResolutionKey(input.sourceId, input.identityHash);
      const existing = existingByKey.get(key);
      const row = resolvedRows.get(key);
      if (!row) throw new Error('shop resolution failed');
      if (isStaleShopObservation(existing, input)) return { internalShopId: Number(row.id), shopId: String(row.public_shop_id), identityHash: input.identityHash, resolution: 'stale_event_ignored' as const, status: String(row.status) === 'closed' ? 'dismissed' as const : 'opening' as const, applied: false, session: null };
      if (input.shopStatus === 'dismissed') return { internalShopId: Number(row.id), shopId: String(row.public_shop_id), identityHash: input.identityHash, resolution: 'dismissed' as const, status: 'dismissed' as const, applied: true, session: null };
      const unchangedFull = input.fullStateHash !== undefined && existing?.full_state_hash === input.fullStateHash && existing?.status !== 'closed';
      return { internalShopId: Number(row.id), shopId: String(row.public_shop_id), identityHash: input.identityHash, resolution: existing?.status === 'closed' ? 'created' as const : existing ? 'matched' as const : 'created' as const, status: 'opening' as const, applied: true, readListings: !unchangedFull, session: sessionFromShopRow(row, input.clientRunId, input.observedAt) };
    });
  };
  const applyListingTransitionBatch = async (changes: ListingTransitionChange[]) => {
    if (changes.length === 0) return { updated: 0, conflicts: 0, soldEvents: 0, conflictIds: [] };
    const payload = JSON.stringify(changes.map((change) => ({
      listingId: change.listingId,
      shopSessionId: change.shopSessionId,
      expectedVersion: change.expectedVersion,
      price: change.price,
      quantity: change.quantity,
      status: change.status,
      observedAt: change.observedAt,
      batchId: change.batchId,
      historyEventType: change.history?.eventType ?? null,
      soldQuantity: change.soldEvent?.soldQuantity ?? null,
      soldFromQuantity: change.soldEvent?.fromQuantity ?? null,
      soldToQuantity: change.soldEvent?.toQuantity ?? null,
      soldReason: change.soldEvent?.reason ?? null,
      transitionKey: change.soldEvent?.transitionKey ?? null,
    })));
    const update = db.prepare(`UPDATE listings SET price=json_extract(input.value,'$.price'),quantity=json_extract(input.value,'$.quantity'),status=json_extract(input.value,'$.status'),last_changed_at=json_extract(input.value,'$.observedAt'),state_version=state_version+1,last_changed_snapshot_id=json_extract(input.value,'$.batchId'),missing_full_count=0
      FROM json_each(?1) AS input WHERE listings.id=CAST(json_extract(input.value,'$.listingId') AS INTEGER) AND listings.shop_id=CAST(json_extract(input.value,'$.shopSessionId') AS INTEGER) AND listings.state_version=CAST(json_extract(input.value,'$.expectedVersion') AS INTEGER)
      RETURNING listings.id`);
    const history = db.prepare(`INSERT OR IGNORE INTO listing_events(listing_id,snapshot_id,observed_at,event_type,from_price,to_price,from_quantity,to_quantity,reason,transition_key)
      SELECT listings.id,json_extract(input.value,'$.batchId'),json_extract(input.value,'$.observedAt'),CASE WHEN json_extract(input.value,'$.historyEventType')='first_seen' THEN 'first_seen' ELSE 'state_changed' END,NULL,json_extract(input.value,'$.price'),NULL,json_extract(input.value,'$.quantity'),CASE WHEN json_extract(input.value,'$.historyEventType')='price_changed' THEN 'price' ELSE NULL END,json_extract(input.value,'$.batchId') || ':' || listings.id || ':' || json_extract(input.value,'$.historyEventType')
      FROM json_each(?1) AS input JOIN listings ON listings.id=CAST(json_extract(input.value,'$.listingId') AS INTEGER) AND listings.shop_id=CAST(json_extract(input.value,'$.shopSessionId') AS INTEGER)
      WHERE json_extract(input.value,'$.historyEventType') IS NOT NULL AND listings.last_changed_snapshot_id=json_extract(input.value,'$.batchId') AND listings.state_version=CAST(json_extract(input.value,'$.expectedVersion') AS INTEGER)+1`);
    const soldEvent = db.prepare(`INSERT OR IGNORE INTO listing_events(listing_id,snapshot_id,observed_at,event_type,from_price,to_price,from_quantity,to_quantity,sold_quantity,reason,transition_key)
      SELECT listings.id,json_extract(input.value,'$.batchId'),json_extract(input.value,'$.observedAt'),'state_changed',NULL,json_extract(input.value,'$.price'),json_extract(input.value,'$.soldFromQuantity'),json_extract(input.value,'$.soldToQuantity'),json_extract(input.value,'$.soldQuantity'),json_extract(input.value,'$.soldReason'),json_extract(input.value,'$.transitionKey')
      FROM json_each(?1) AS input JOIN listings ON listings.id=CAST(json_extract(input.value,'$.listingId') AS INTEGER) AND listings.shop_id=CAST(json_extract(input.value,'$.shopSessionId') AS INTEGER)
      WHERE json_extract(input.value,'$.soldQuantity') IS NOT NULL AND listings.last_changed_snapshot_id=json_extract(input.value,'$.batchId') AND listings.state_version=CAST(json_extract(input.value,'$.expectedVersion') AS INTEGER)+1`);
    assertBatchBounds(3, 3);
    const results = await db.batch([update.bind(payload), history.bind(payload), soldEvent.bind(payload)]);
    const updatedIds = new Set(rowsFromBatchResult(results[0]).map((row) => Number(row.id)));
    const conflictIds = changes.filter((change) => !updatedIds.has(change.listingId)).map((change) => change.listingId);
    return { updated: updatedIds.size, conflicts: conflictIds.length, soldEvents: Number(results[2]?.meta?.changes ?? 0), conflictIds };
  };
  return {
    async getLatestMarketUpdateAt() {
      const row = await one<Row>(db.prepare("SELECT MAX(completed_at) AS latest_updated_at FROM upload_batches WHERE status='accepted'").bind());
      if (row?.latest_updated_at === null || row?.latest_updated_at === undefined) return null;
      const latestUpdatedAt = Number(row.latest_updated_at);
      return Number.isSafeInteger(latestUpdatedAt) ? latestUpdatedAt : null;
    },
    async findSourceByApiKeyHash(hash) {
      const row = await one<Row>(db.prepare('SELECT id,name,api_key_hash,status FROM market_sources WHERE api_key_hash = ?1 LIMIT 1').bind(hash));
      return row ? { id: String(row.id), name: String(row.name), apiKeyHash: String(row.api_key_hash), status: String(row.status) as SourceRow['status'] } : null;
    },
    async getOrCreateVendor(sourceId, input: VendorInput) {
      return { id: 0, sourceId, vendorKey: input.vendorKey, name: input.name, mapName: input.mapName, x: input.x, y: input.y, updatedAt: input.updatedAt };
    },
    async getOrCreateShop(sourceId, input: ShopInput) {
      const row = await one<Row>(db.prepare(`INSERT INTO shops(source_id,identity_hash,public_shop_id,vendor_account_id,vendor_name,vendor_name_normalized,title,title_normalized,shop_type,map_name,x,y,status,profile_hash,last_status_observed_at,last_changed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'active',?2,?13,?13) ON CONFLICT(source_id,identity_hash) DO UPDATE SET vendor_account_id=excluded.vendor_account_id,vendor_name=excluded.vendor_name,vendor_name_normalized=excluded.vendor_name_normalized,title=excluded.title,title_normalized=excluded.title_normalized,shop_type=excluded.shop_type,map_name=excluded.map_name,x=excluded.x,y=excluded.y,status='active',last_status_observed_at=excluded.last_status_observed_at,last_changed_at=excluded.last_changed_at RETURNING *`).bind(sourceId,input.shopKey,input.shopKey,String(input.vendorId),String(input.vendorId),String(input.vendorId),input.title,input.title.normalize('NFKC').toLowerCase(),input.shopType,input.mapName,input.x,input.y,input.lastSeenAt));
      if (!row) throw new Error('shop upsert returned no row');
      return { id: Number(row.id), sourceId, shopKey: String(row.identity_hash), vendorId: input.vendorId, title: String(row.title), shopType: String(row.shop_type) as ShopRow['shopType'], mapName: String(row.map_name), x: Number(row.x), y: Number(row.y), status: String(row.status) as ShopRow['status'], lastSeenAt: Number(row.last_status_observed_at), closedAt: row.closed_at == null ? null : Number(row.closed_at), updatedAt: Number(row.last_changed_at) };
    },
    async getOrCreateSession(input: SessionInput) {
      const row = await one<Row>(db.prepare('SELECT * FROM shops WHERE id=?1 LIMIT 1').bind(input.shopId));
      if (!row) throw new Error('shop not found');
      return sessionFromShopRow(row, input.clientRunId, input.observedAt);
    },
    async resolveShopObservation(input) {
      const [resolution] = await resolveShopObservations([input]);
      if (!resolution) throw new Error('shop resolution failed');
      return resolution;
    },
    resolveShopObservations,
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
      await db.prepare('UPDATE upload_batches SET status=\'accepted\',response_json=?1,completed_at=?2 WHERE source_id=?3 AND batch_id=?4').bind(JSON.stringify(response), Date.now(), sourceId, batchId).run();
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
      const rows = await many<Row>(db.prepare(`SELECT * FROM listings WHERE shop_id=?1 AND item_fingerprint IN (${placeholders})`).bind(sessionId, ...fingerprints));
      return rows.map(listingFromRow);
    },
    async loadListingsByObservations(observations) {
      if (observations.length === 0) return [];
      const payload = JSON.stringify(observations);
      const rows = await many<Row>(db.prepare(`SELECT l.* FROM listings l JOIN json_each(?1) input ON l.shop_id=CAST(json_extract(input.value,'$.sessionId') AS INTEGER) AND l.item_fingerprint=json_extract(input.value,'$.fingerprint')`).bind(payload));
      return rows.map(listingFromRow);
    },
    async markListingsObservedBulk(observations, batchId, observedAt) {
      if (observations.length === 0) return 0;
      const payload = JSON.stringify(observations);
      assertBatchBounds(1, 3);
      const result = await db.prepare(`UPDATE listings SET last_changed_at=?3,last_changed_snapshot_id=?2,missing_full_count=0,status=CASE WHEN quantity=0 THEN 'sold_out' ELSE 'active' END WHERE id IN (SELECT l.id FROM json_each(?1) input JOIN listings l ON l.shop_id=CAST(json_extract(input.value,'$.sessionId') AS INTEGER) AND l.item_fingerprint=json_extract(input.value,'$.fingerprint'))`).bind(payload, batchId, observedAt).run();
      return Number(result.meta?.changes ?? 0);
    },
    async loadListingById(listingId, sessionId) {
      const statement = sessionId === undefined
        ? db.prepare('SELECT * FROM listings WHERE id=?1 LIMIT 1').bind(listingId)
        : db.prepare('SELECT * FROM listings WHERE id=?1 AND shop_id=?2 LIMIT 1').bind(listingId, sessionId);
      const row = await one<Row>(statement);
      return row ? listingFromRow(row) : null;
    },
    async markListingsObserved(sessionId, fingerprints, batchId, observedAt) {
      if (fingerprints.length === 0) return 0;
      if (fingerprints.length > 40) throw new Error('listing observation exceeds bounded batch size');
      const placeholders = fingerprints.map((_, index) => `?${index + 4}`).join(',');
      const result = await db.prepare(`UPDATE listings SET last_changed_at=?1,last_changed_snapshot_id=?2,missing_full_count=0,status=CASE WHEN quantity=0 THEN 'sold_out' ELSE 'active' END WHERE shop_id=?3 AND item_fingerprint IN (${placeholders})`).bind(observedAt, batchId, sessionId, ...fingerprints).run();
      return Number(result.meta?.changes ?? 0);
    },
    async createListing(input) {
      const row = await one<Row>(db.prepare(`INSERT INTO listings(shop_id,item_fingerprint,item_key,item_id,upgrade,slots,card0,card1,card2,card3,price,quantity,status,first_seen_at,last_changed_at,last_changed_snapshot_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'active',?13,?13,?14) RETURNING *`).bind(input.sessionId, input.fingerprint, input.itemKey ?? null, input.itemId, input.upgrade, input.slots, input.cards[0] ?? 0, input.cards[1] ?? 0, input.cards[2] ?? 0, input.cards[3] ?? 0, input.price, input.quantity, input.observedAt, input.batchId));
      if (!row) throw new Error('listing insert returned no row');
      return listingFromRow(row);
    },
    async createListingsBatch(inputs) {
      if (inputs.length === 0) return [];
      assertBatchBounds(1, 1);
      const payload = JSON.stringify(inputs.map((input) => ({ sessionId: input.sessionId, fingerprint: input.fingerprint, itemKey: input.itemKey ?? null, itemId: input.itemId, upgrade: input.upgrade, slots: input.slots, cards: [input.cards[0] ?? 0, input.cards[1] ?? 0, input.cards[2] ?? 0, input.cards[3] ?? 0], price: input.price, quantity: input.quantity, observedAt: input.observedAt, batchId: input.batchId })));
      const rows = await many<Row>(db.prepare(`INSERT OR IGNORE INTO listings(shop_id,item_fingerprint,item_key,item_id,upgrade,slots,card0,card1,card2,card3,price,quantity,status,first_seen_at,last_changed_at,last_changed_snapshot_id)
        SELECT json_extract(value,'$.sessionId'),json_extract(value,'$.fingerprint'),json_extract(value,'$.itemKey'),json_extract(value,'$.itemId'),json_extract(value,'$.upgrade'),json_extract(value,'$.slots'),json_extract(value,'$.cards[0]'),json_extract(value,'$.cards[1]'),json_extract(value,'$.cards[2]'),json_extract(value,'$.cards[3]'),json_extract(value,'$.price'),json_extract(value,'$.quantity'),'active',json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),json_extract(value,'$.batchId') FROM json_each(?1) RETURNING *`).bind(payload));
      return rows.map(listingFromRow);
    },
    async createListingsBundleBatch(inputs) {
      if (inputs.length === 0) return [];
      const payload = JSON.stringify(inputs.map((input) => ({ sessionId: input.sessionId, fingerprint: input.fingerprint, itemKey: input.itemKey ?? null, itemId: input.itemId, upgrade: input.upgrade, slots: input.slots, cards: [input.cards[0] ?? 0, input.cards[1] ?? 0, input.cards[2] ?? 0, input.cards[3] ?? 0], price: input.price, quantity: input.quantity, observedAt: input.observedAt, batchId: input.batchId, options: input.options.map((option) => ({ type: option.type, value: option.value, param: option.param })) })));
      const insert = db.prepare(`INSERT OR IGNORE INTO listings(shop_id,item_fingerprint,item_key,item_id,upgrade,slots,card0,card1,card2,card3,price,quantity,status,first_seen_at,last_changed_at,last_changed_snapshot_id)
        SELECT json_extract(value,'$.sessionId'),json_extract(value,'$.fingerprint'),json_extract(value,'$.itemKey'),json_extract(value,'$.itemId'),json_extract(value,'$.upgrade'),json_extract(value,'$.slots'),json_extract(value,'$.cards[0]'),json_extract(value,'$.cards[1]'),json_extract(value,'$.cards[2]'),json_extract(value,'$.cards[3]'),json_extract(value,'$.price'),json_extract(value,'$.quantity'),'active',json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),json_extract(value,'$.batchId') FROM json_each(?1)`);
      const history = db.prepare(`INSERT OR IGNORE INTO listing_events(listing_id,snapshot_id,observed_at,event_type,from_price,to_price,from_quantity,to_quantity,reason,transition_key)
        SELECT l.id,json_extract(item.value,'$.batchId'),json_extract(item.value,'$.observedAt'),'first_seen',NULL,json_extract(item.value,'$.price'),NULL,json_extract(item.value,'$.quantity'),NULL,json_extract(item.value,'$.batchId') || ':' || l.id
        FROM json_each(?1) item JOIN listings l ON l.shop_id=json_extract(item.value,'$.sessionId') AND l.item_fingerprint=json_extract(item.value,'$.fingerprint') AND l.last_changed_snapshot_id=json_extract(item.value,'$.batchId')`);
      const options = db.prepare(`INSERT OR REPLACE INTO listing_options(listing_id,option_index,option_type,option_value,option_param)
        SELECT l.id,CAST(option.key AS INTEGER),json_extract(option.value,'$.type'),json_extract(option.value,'$.value'),json_extract(option.value,'$.param')
        FROM json_each(?1) item JOIN listings l ON l.shop_id=json_extract(item.value,'$.sessionId') AND l.item_fingerprint=json_extract(item.value,'$.fingerprint') AND l.last_changed_snapshot_id=json_extract(item.value,'$.batchId')
        JOIN json_each(json_extract(item.value,'$.options')) option`);
      await db.batch([insert.bind(payload), history.bind(payload), options.bind(payload)]);
      const first = inputs[0]!;
      return (await this.loadListingsByFingerprint(first.sessionId, inputs.map((input) => input.fingerprint))).filter((listing) => inputs.some((input) => input.fingerprint === listing.itemFingerprint));
    },
    async insertNewListingsBulk(inputs) {
      if (inputs.length === 0) return;
      const payload = JSON.stringify(inputs.map((input) => ({ sessionId: input.sessionId, fingerprint: input.fingerprint, itemKey: input.itemKey ?? null, itemId: input.itemId, upgrade: input.upgrade, slots: input.slots, cards: [input.cards[0] ?? 0, input.cards[1] ?? 0, input.cards[2] ?? 0, input.cards[3] ?? 0], price: input.price, quantity: input.quantity, observedAt: input.observedAt, batchId: input.batchId, options: [...input.options].sort((a, b) => a.type - b.type || a.value - b.value || a.param - b.param).map((option) => ({ type: option.type, value: option.value, param: option.param })) })));
      const insert = db.prepare(`INSERT OR IGNORE INTO listings(shop_id,item_fingerprint,item_key,item_id,upgrade,slots,card0,card1,card2,card3,price,quantity,status,first_seen_at,last_changed_at,last_changed_snapshot_id)
        SELECT json_extract(value,'$.sessionId'),json_extract(value,'$.fingerprint'),json_extract(value,'$.itemKey'),json_extract(value,'$.itemId'),json_extract(value,'$.upgrade'),json_extract(value,'$.slots'),json_extract(value,'$.cards[0]'),json_extract(value,'$.cards[1]'),json_extract(value,'$.cards[2]'),json_extract(value,'$.cards[3]'),json_extract(value,'$.price'),json_extract(value,'$.quantity'),'active',json_extract(value,'$.observedAt'),json_extract(value,'$.observedAt'),json_extract(value,'$.batchId') FROM json_each(?1)`);
      const history = db.prepare(`INSERT OR IGNORE INTO listing_events(listing_id,snapshot_id,observed_at,event_type,from_price,to_price,from_quantity,to_quantity,reason,transition_key)
        SELECT l.id,json_extract(item.value,'$.batchId'),json_extract(item.value,'$.observedAt'),'first_seen',NULL,json_extract(item.value,'$.price'),NULL,json_extract(item.value,'$.quantity'),NULL,json_extract(item.value,'$.batchId') || ':' || l.id FROM json_each(?1) item JOIN listings l ON l.shop_id=CAST(json_extract(item.value,'$.sessionId') AS INTEGER) AND l.item_fingerprint=json_extract(item.value,'$.fingerprint') AND l.last_changed_snapshot_id=json_extract(item.value,'$.batchId')`);
      const options = db.prepare(`INSERT OR REPLACE INTO listing_options(listing_id,option_index,option_type,option_value,option_param)
        SELECT l.id,CAST(option.key AS INTEGER),json_extract(option.value,'$.type'),json_extract(option.value,'$.value'),json_extract(option.value,'$.param') FROM json_each(?1) item JOIN listings l ON l.shop_id=CAST(json_extract(item.value,'$.sessionId') AS INTEGER) AND l.item_fingerprint=json_extract(item.value,'$.fingerprint') AND l.last_changed_snapshot_id=json_extract(item.value,'$.batchId') JOIN json_each(json_extract(item.value,'$.options')) option`);
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
    async insertHistory(input) { await db.prepare(`INSERT OR IGNORE INTO listing_events(listing_id,snapshot_id,observed_at,event_type,from_price,to_price,from_quantity,to_quantity,reason,transition_key) VALUES(?1,?6,?2,CASE WHEN ?5='first_seen' THEN 'first_seen' ELSE 'state_changed' END,NULL,?3,NULL,?4,CASE WHEN ?5='price_changed' THEN 'price' ELSE NULL END,?6 || ':' || ?1 || ':' || ?5)`).bind(input.listingId, input.observedAt, input.price, input.quantity, input.eventType, input.batchId).run(); },
    async insertHistoriesBatch(inputs) {
      if (inputs.length === 0) return;
      for (let offset = 0; offset < inputs.length; offset += BULK_BATCH_SIZE) {
        const chunk = inputs.slice(offset, offset + BULK_BATCH_SIZE);
        assertBatchBounds(chunk.length, chunk.length * 5);
        await db.batch(chunk.map((input) => db.prepare(`INSERT OR IGNORE INTO listing_events(listing_id,snapshot_id,observed_at,event_type,from_price,to_price,from_quantity,to_quantity,reason,transition_key) VALUES(?1,?6,?2,CASE WHEN ?5='first_seen' THEN 'first_seen' ELSE 'state_changed' END,NULL,?3,NULL,?4,CASE WHEN ?5='price_changed' THEN 'price' ELSE NULL END,?6 || ':' || ?1 || ':' || ?5)`).bind(input.listingId, input.observedAt, input.price, input.quantity, input.eventType, input.batchId)));
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
    async insertSoldEvent(input) { const result = await db.prepare(`INSERT OR IGNORE INTO listing_events(listing_id,snapshot_id,observed_at,event_type,from_price,to_price,from_quantity,to_quantity,sold_quantity,reason,transition_key) VALUES(?1,?7,?6,'state_changed',NULL,?8,?3,?4,?2,?5,?9)`).bind(input.listingId, input.soldQuantity, input.fromQuantity, input.toQuantity, input.reason, input.observedAt, input.snapshotId ?? input.transitionKey, input.price ?? 0, input.transitionKey).run(); return Number(result.meta?.changes ?? 0) > 0; },
    async applyListingChanges(changes) {
      assertBatchBounds(changes.length, changes.length * 7);
      const statements = changes.map((change) => db.prepare(`UPDATE listings SET price=?1,quantity=?2,status=?3,last_changed_at=?4,state_version=state_version+1,last_changed_snapshot_id=?5,missing_full_count=0 WHERE id=?6 AND state_version=?7`).bind(change.price, change.quantity, change.status, change.observedAt, change.batchId, change.listingId, change.expectedVersion));
      const results = await db.batch(statements);
      return { updated: results.filter((result) => Number(result.meta?.changes ?? 0) > 0).length, conflicts: results.filter((result) => Number(result.meta?.changes ?? 0) === 0).length };
    },
    applyListingTransitions: applyListingTransitionBatch,
    applyListingTransitionsBulk: applyListingTransitionBatch,
    async markShopHeartbeats(sourceId, shopKeys, observedAt) {
      if (shopKeys.length === 0) return 0;
      let updated = 0;
      for (let offset = 0; offset < shopKeys.length; offset += 40) {
        const chunk = shopKeys.slice(offset, offset + 40);
        const result = await db.prepare("UPDATE shops SET last_status_observed_at=?3,last_changed_at=?3,status=CASE WHEN status='closed' THEN status ELSE 'active' END WHERE source_id=?2 AND identity_hash IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(chunk), sourceId, observedAt).run();
        updated += Number(result.meta?.changes ?? 0);
      }
      return updated;
    },
    async getUninitializedShopKeys(sourceId, shopKeys) {
      if (shopKeys.length === 0) return [];
      const missing: string[] = [];
      for (let offset = 0; offset < shopKeys.length; offset += 40) {
        const chunk = shopKeys.slice(offset, offset + 40);
        const rows = await many<Row>(db.prepare("SELECT input.value AS shop_key FROM json_each(?1) input WHERE NOT EXISTS (SELECT 1 FROM shops s WHERE s.source_id=?2 AND s.identity_hash=input.value AND s.full_state_hash IS NOT NULL AND s.status IN ('active','stale'))").bind(JSON.stringify(chunk), sourceId));
        missing.push(...rows.map((row) => String(row.shop_key)));
      }
      return missing;
    },
    async recordSnapshotSessions(sourceId, snapshotId, sessionIds, observedAt) {
      if (sessionIds.length === 0) return;
      await db.prepare("UPDATE upload_batches SET shop_ids_json=?1 WHERE source_id=?2 AND snapshot_id=?3").bind(JSON.stringify(sessionIds), sourceId, snapshotId).run();
      void observedAt;
    },
    async getSnapshotSessionIds(sourceId, snapshotId) {
      const rows = await many<Row>(db.prepare("SELECT shop_ids_json FROM upload_batches WHERE source_id=?1 AND snapshot_id=?2 ORDER BY part_index LIMIT 1").bind(sourceId, snapshotId));
      if (!rows[0]?.shop_ids_json) return [];
      try { const parsed = JSON.parse(String(rows[0].shop_ids_json)); return Array.isArray(parsed) ? parsed.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : []; } catch { return []; }
    },
    async updateShopFullStateHashes(updates, observedAt) {
      if (updates.length === 0) return;
      const payload = JSON.stringify(updates);
      await db.prepare("UPDATE shops SET full_state_hash=(SELECT json_extract(input.value,'$.fullStateHash') FROM json_each(?1) AS input WHERE CAST(json_extract(input.value,'$.shopId') AS INTEGER)=shops.id) WHERE id IN (SELECT CAST(json_extract(input.value,'$.shopId') AS INTEGER) FROM json_each(?1) AS input)").bind(payload).run();
    },
    async finalizeSnapshot(sourceId, snapshotId, observedAt) {
      await db.prepare('UPDATE market_sources SET last_full_snapshot_id=?1,last_full_snapshot_at=?2,updated_at=?2 WHERE id=?3').bind(snapshotId, observedAt, sourceId).run();
      const rows = await many<Row>(db.prepare("SELECT shop_ids_json FROM upload_batches WHERE source_id=?1 AND snapshot_id=?2 ORDER BY part_index LIMIT 1").bind(sourceId, snapshotId));
      let ids: number[] = [];
      try { const parsed = rows[0]?.shop_ids_json ? JSON.parse(String(rows[0].shop_ids_json)) : []; ids = Array.isArray(parsed) ? parsed.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : []; } catch { ids = []; }
      if (ids.length > 0) await db.prepare("UPDATE shops SET full_state_hash=?1,status=CASE WHEN status='closed' THEN status ELSE 'active' END,last_changed_at=?2 WHERE source_id=?3 AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?4))").bind(snapshotId, observedAt, sourceId, JSON.stringify(ids)).run();
    },
    async reconcileSnapshot(input: SnapshotReconciliationInput): Promise<ReconciliationResult> {
      if (input.batchIds.length === 0) return { sourceId: input.sourceId, snapshotId: input.snapshotId, complete: false, baseline: false, shops: 0, candidates: 0, markedMissing: 0, inferredSold: 0, expired: 0 };
      const shopIds = [...new Set((input.sessionIds ?? []).filter((id) => Number.isSafeInteger(id) && id > 0))];
      if (shopIds.length === 0) return { sourceId: input.sourceId, snapshotId: input.snapshotId, complete: true, baseline: false, shops: 0, candidates: 0, markedMissing: 0, inferredSold: 0, expired: 0 };
      const scope = JSON.stringify(shopIds); const batches = JSON.stringify(input.batchIds);
      const baselineRow = await one<Row>(db.prepare("SELECT COUNT(*) AS count FROM shops WHERE source_id=?3 AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?2)) AND full_state_hash IS NULL").bind(input.observedAt, scope, input.sourceId));
      if (Number(baselineRow?.count ?? 0) > 0) return { sourceId: input.sourceId, snapshotId: input.snapshotId, complete: true, baseline: true, shops: 0, candidates: 0, markedMissing: 0, inferredSold: 0, expired: 0 };
      const stalePredicate = "shop_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?2)) AND status IN ('active','missing') AND (last_changed_snapshot_id IS NULL OR last_changed_snapshot_id NOT IN (SELECT value FROM json_each(?3)))";
      const candidateRows = await many<Row>(db.prepare('SELECT id,quantity,state_version FROM listings WHERE ' + stalePredicate + ' AND missing_full_count=1 AND quantity>0').bind(input.observedAt, scope, batches));
      const inferredCandidates = await Promise.all(candidateRows.map(async (row) => ({ listingId: Number(row.id), soldQuantity: Number(row.quantity), fromQuantity: Number(row.quantity), toQuantity: 0, reason: 'missing_full', observedAt: input.observedAt, newStateVersion: Number(row.state_version) + 1, transitionKey: await makeTransitionKey(Number(row.id), Number(row.state_version), Number(row.quantity), 0, 'missing_full') })));
      const staleSql = "UPDATE listings SET missing_full_count=missing_full_count+1,status=CASE WHEN missing_full_count+1>=2 THEN 'missing' ELSE status END,last_changed_at=?1,state_version=state_version+1 WHERE " + stalePredicate;
      const writes = [db.prepare(staleSql).bind(input.observedAt, scope, batches)];
      if (inferredCandidates.length > 0) writes.push(db.prepare("INSERT OR IGNORE INTO listing_events(listing_id,snapshot_id,observed_at,event_type,from_price,to_price,from_quantity,to_quantity,sold_quantity,reason,transition_key) SELECT json_extract(value,'$.listingId'),?2,json_extract(value,'$.observedAt'),'missing',NULL,0,json_extract(value,'$.fromQuantity'),json_extract(value,'$.toQuantity'),json_extract(value,'$.soldQuantity'),json_extract(value,'$.reason'),json_extract(value,'$.transitionKey') FROM json_each(?1) WHERE EXISTS (SELECT 1 FROM listings l WHERE l.id=json_extract(value,'$.listingId') AND l.state_version=json_extract(value,'$.newStateVersion') AND l.missing_full_count=2 AND l.status='missing')").bind(JSON.stringify(inferredCandidates), input.snapshotId));
      const writeResults = await db.batch(writes);
      const expiredResult = await db.prepare("UPDATE listings SET status='expired',last_changed_at=?1 WHERE shop_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?2)) AND status IN ('active','missing') AND EXISTS (SELECT 1 FROM shops s WHERE s.id=listings.shop_id AND s.status='closed' AND s.closed_at IS NOT NULL AND s.closed_at<=?1)").bind(input.observedAt, scope).run();
      const shopsRow = await one<Row>(db.prepare("SELECT COUNT(*) AS count FROM shops WHERE source_id=?2 AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?1)) AND status IN ('active','stale')").bind(scope, input.sourceId));
      const markedMissing = Number(writeResults[0]?.meta?.changes ?? 0);
      return { sourceId: input.sourceId, snapshotId: input.snapshotId, complete: true, baseline: false, shops: Number(shopsRow?.count ?? 0), candidates: markedMissing, markedMissing, inferredSold: inferredCandidates.length > 0 ? Number(writeResults[1]?.meta?.changes ?? 0) : 0, expired: Number(expiredResult.meta?.changes ?? 0) };
    },
    async searchListings(filters) {
      const params: unknown[] = [];
      const where = [
        filters.include_stale ? "l.status IN ('active','missing')" : "l.status='active'",
        filters.include_stale ? "s.status IN ('active','stale')" : "s.status='active'",
      ];
      const add = (value: unknown) => { params.push(value); return `?${params.length}`; };
      const itemIds = [...new Set([...(filters.item_ids ?? [])].filter((id) => Number.isSafeInteger(id) && id >= 0))];
      if (filters.item_id !== undefined) itemIds.push(filters.item_id);
      const uniqueItemIds = [...new Set(itemIds)];
      const matchPredicates: string[] = [];
      if (uniqueItemIds.length > 0) {
        const placeholders = uniqueItemIds.map((id) => add(id)).join(',');
        matchPredicates.push(`l.item_id IN (${placeholders})`);
      }
      const normalizedQ = filters.q ? normalizeCatalogQuery(filters.q) : '';
      if ([...normalizedQ].length >= 2) {
        const q = normalizedQ.replace(/[\\%_]/gu, (value) => '\\' + value);
        const p = add(`%${q}%`);
        const vendorColumn = "COALESCE(s.vendor_name_normalized, '')";
        matchPredicates.push(`(s.title_normalized LIKE ${p} ESCAPE '\\' OR ${vendorColumn} LIKE ${p} ESCAPE '\\')`);
      }
      if (matchPredicates.length > 0) where.push(`(${matchPredicates.join(' OR ')})`);
      if (filters.price_min !== undefined) where.push(`l.price>=${add(filters.price_min)}`);
      if (filters.price_max !== undefined) where.push(`l.price<=${add(filters.price_max)}`);
      if (filters.map) where.push(`s.map_name=${add(normalizeCatalogQuery(filters.map))}`);
      if (filters.shop_type) where.push(`s.shop_type=${add(filters.shop_type)}`);
      let definitionSet: { version: string; items: OptionDefinition[] };
      try {
        definitionSet = getOptionDefinitionSet(filters.optionVersion);
      } catch (error) {
        if (error instanceof Error && /no such table|no such column/i.test(error.message)) definitionSet = { version: "unpublished", items: [] };
        else throw error;
      }
      const definitionMap = new Map(definitionSet.items.map((definition) => [definition.type, definition]));
      if (filters.options && filters.options.length > 0) {
        try {
          const conditions = filters.options.map((option) => parseStructuredOptionCondition(option, definitionMap));
          const compiled = compileOptionPredicates(conditions, filters.option_mode ?? 'all', definitionMap, params.length + 1);
          where.push(compiled.sql);
          params.push(...compiled.values);
        } catch (error) {
          if (error instanceof OptionConditionValidationError) throw new SearchValidationError(error.message);
          throw error;
        }
      } else if (filters.option_type !== undefined && filters.option_value !== undefined && filters.option_param !== undefined) {
        where.push(`EXISTS (SELECT 1 FROM listing_options lo WHERE lo.listing_id=l.id AND lo.option_type=${add(filters.option_type)} AND lo.option_value=${add(filters.option_value)} AND lo.option_param=${add(filters.option_param)})`);
      } else if (filters.option_type !== undefined || filters.option_value !== undefined || filters.option_param !== undefined) {
        throw new SearchValidationError('Incomplete legacy option filter');
      }
      const cursor = filters.cursor ? decodeCursor(filters.cursor, { sort: filters.sort, context: searchCursorContext(filters) }, cursorSecret) : null;
      const sortColumn = filters.sort === 'changed_desc' ? 'l.last_changed_at' : 'l.price';
      if (cursor) {
        const value = add(cursor.sortValue);
        const sameValue = add(cursor.sortValue);
        const id = add(cursor.id);
        const operator = filters.sort === 'price_asc' ? '>' : '<';
        where.push(`(${sortColumn} ${operator} ${value} OR (${sortColumn} = ${sameValue} AND l.id ${operator} ${id}))`);
      }
      const limit = Math.min(50, Math.max(1, filters.limit)); params.push(limit + 1);
      const order = filters.sort === 'price_desc' ? 'l.price DESC,l.id DESC' : filters.sort === 'changed_desc' ? 'l.last_changed_at DESC,l.id DESC' : 'l.price ASC,l.id ASC';
      const searchSql = `SELECT l.id,l.shop_id,l.item_fingerprint,l.item_key,l.item_id,l.upgrade,l.slots,l.card0,l.card1,l.card2,l.card3,l.price,l.quantity,l.status,l.state_version,l.missing_full_count,l.last_changed_at,s.public_shop_id AS shop_id_display,s.status AS shop_status,s.public_shop_id AS shop_key,s.title,s.vendor_name,s.map_name,s.x,s.y,s.shop_type FROM listings l JOIN shops s ON s.id=l.shop_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?${params.length}`;
      assertQueryBounds(searchSql, params.length);
      const rows = await many<Row>(db.prepare(searchSql).bind(...params));
      const items = rows.slice(0, limit).map(listingFromSearchRow);
      if (items.length > 0) {
        const ids = items.map((item) => item.id);
        const optionSql = `SELECT lo.listing_id,lo.option_type,lo.option_value,lo.option_param FROM listing_options lo JOIN json_each(?1) input ON lo.listing_id=CAST(input.value AS INTEGER) ORDER BY lo.listing_id,lo.option_index`;
        assertQueryBounds(optionSql, 1);
        const optionRows = await many<Row>(db.prepare(optionSql).bind(JSON.stringify(ids)));
        const optionsByListing = new Map<number, ListingSearchOption[]>();
        for (const row of optionRows) {
          const listingId = Number(row.listing_id);
          const option = { type: Number(row.option_type), value: Number(row.option_value), param: Number(row.option_param) };
          optionsByListing.set(listingId, [...(optionsByListing.get(listingId) ?? []), { ...option, display: formatOptionDisplay(option, definitionMap.get(option.type)) }]);
        }
        for (const item of items) item.options = optionsByListing.get(item.id) ?? [];
      }
      const last = items.at(-1);
      const sortValue = last ? (filters.sort === 'changed_desc' ? last.lastChangedAt : last.price) : 0;
      return { items, nextCursor: rows.length > limit && last ? encodeCursor({ sort: filters.sort, sortValue, id: last.id, context: searchCursorContext(filters) }, cursorSecret) : null };
    },
    async getListingHistory(listingId, limit, cursor) {
      const listing = await one<Row>(db.prepare('SELECT id FROM listings WHERE id=?1 LIMIT 1').bind(listingId));
      if (!listing) return null;
      const params: unknown[] = [listingId];
      let sql = 'SELECT id,listing_id,snapshot_id,observed_at,event_type,from_price,to_price,from_quantity,to_quantity,sold_quantity,reason,transition_key FROM listing_events WHERE listing_id=?1';
      if (cursor) { params.push(decodeHistoryCursor(cursor, cursorSecret)); sql += ` AND id<?${params.length}`; }
      params.push(Math.min(50, Math.max(1, limit)) + 1); sql += ` ORDER BY id DESC LIMIT ?${params.length}`;
      const rows = await many<Row>(db.prepare(sql).bind(...params));
      const items = rows.slice(0, Number(params.at(-1)) - 1).map((row) => ({ id: Number(row.id), listingId: Number(row.listing_id), observedAt: Number(row.observed_at), price: Number(row.to_price), quantity: Number(row.to_quantity), eventType: row.reason == null ? String(row.event_type) : String(row.reason), batchId: String(row.snapshot_id) }));
      const saleRows = await many<Row>(db.prepare('SELECT observed_at,sold_quantity,from_quantity,to_quantity,reason FROM listing_events WHERE listing_id=?1 AND sold_quantity>0 ORDER BY id DESC LIMIT ?2').bind(listingId, Math.min(50, Math.max(1, limit))));
      const inferredSales: InferredSaleRow[] = saleRows.map((row) => ({ observedAt: Number(row.observed_at), soldQuantity: Number(row.sold_quantity), fromQuantity: Number(row.from_quantity), toQuantity: Number(row.to_quantity), reason: String(row.reason) }));
      return { items, inferredSales, nextCursor: rows.length > items.length && items.at(-1) ? encodeHistoryCursor(items.at(-1)!.id, cursorSecret) : null };
    },
    async getItemMarketHistory(itemId, windowStart, windowEnd) {
      const item = await one<Row>(db.prepare('SELECT item_id FROM listings WHERE item_id=?1 LIMIT 1').bind(itemId));
      if (!item) return null;
      const [currentRows, saleRows, eventRows] = await Promise.all([
        many<Row>(db.prepare(`SELECT l.id,l.price,l.quantity,l.last_changed_at,s.vendor_name,s.title,s.map_name
          FROM listings l JOIN shops s ON s.id=l.shop_id
          WHERE l.item_id=?1 AND l.status='active' AND s.status='active' AND s.shop_type='sell'
          ORDER BY l.price ASC,l.id ASC`).bind(itemId)),
        many<Row>(db.prepare(`SELECT e.listing_id,e.observed_at,e.to_price,e.sold_quantity,s.vendor_name,s.title
          FROM listing_events e JOIN listings l ON l.id=e.listing_id JOIN shops s ON s.id=l.shop_id
          WHERE l.item_id=?1 AND e.observed_at>=?2 AND e.observed_at<=?3 AND e.sold_quantity>0 AND s.shop_type='sell'
          ORDER BY e.observed_at DESC,e.id DESC`).bind(itemId, windowStart, windowEnd)),
        many<Row>(db.prepare(`SELECT e.listing_id,e.observed_at,e.to_price,e.to_quantity,e.event_type,e.reason
          FROM listing_events e JOIN listings l ON l.id=e.listing_id JOIN shops s ON s.id=l.shop_id
          WHERE l.item_id=?1 AND e.observed_at>=?2 AND e.observed_at<=?3 AND s.shop_type='sell'
          ORDER BY e.observed_at ASC,e.id ASC`).bind(itemId, windowStart, windowEnd)),
      ]);
      return {
        itemId,
        windowStart,
        windowEnd,
        currentListings: currentRows.map((row) => ({ listingId: Number(row.id), price: Number(row.price), quantity: Number(row.quantity), vendorName: String(row.vendor_name), title: String(row.title), mapName: String(row.map_name), lastChangedAt: Number(row.last_changed_at) })),
        sales: saleRows.map((row) => ({ listingId: Number(row.listing_id), observedAt: Number(row.observed_at), price: Number(row.to_price), soldQuantity: Number(row.sold_quantity), vendorName: String(row.vendor_name), title: String(row.title) })),
        events: eventRows.map((row) => ({ listingId: Number(row.listing_id), observedAt: Number(row.observed_at), price: Number(row.to_price), quantity: Number(row.to_quantity), eventType: row.reason == null ? String(row.event_type) : String(row.reason) })),
      };
    },
    async getOptionDefinitions(version) {
      return getOptionDefinitionSet(version);
    },
    async getCatalogVersion() { return 'static'; },
    async searchItems(_query, _limit) {
      return [];
    },
    async deleteExpiredHistory(before, limit) { const result = await db.prepare('DELETE FROM listing_events WHERE id IN (SELECT id FROM listing_events WHERE observed_at < ?1 ORDER BY observed_at,id LIMIT ?2)').bind(before, limit).run(); return Number(result.meta?.changes ?? 0); },
    async deleteExpiredSoldEvents(before, limit) { const result = await db.prepare('DELETE FROM listing_events WHERE id IN (SELECT id FROM listing_events WHERE observed_at < ?1 ORDER BY observed_at,id LIMIT ?2)').bind(before, limit).run(); return Number(result.meta?.changes ?? 0); },
    async countExpiredHistory(before, limit) { const row = await one<Row>(db.prepare('SELECT COUNT(*) AS count FROM (SELECT id FROM listing_events WHERE observed_at < ?1 ORDER BY observed_at,id LIMIT ?2)').bind(before, limit)); return Number(row?.count ?? 0); },
    async countExpiredSoldEvents(before, limit) { const row = await one<Row>(db.prepare('SELECT COUNT(*) AS count FROM (SELECT id FROM listing_events WHERE observed_at < ?1 ORDER BY observed_at,id LIMIT ?2)').bind(before, limit)); return Number(row?.count ?? 0); },
  };
}

function batchFromRow(row: Row): BatchRow { return { id: Number(row.id), sourceId: String(row.source_id), batchId: String(row.batch_id), snapshotId: String(row.snapshot_id), partIndex: Number(row.part_index), partCount: Number(row.part_count), snapshotMode: String(row.snapshot_mode) as BatchRow['snapshotMode'], payloadHash: String(row.payload_hash), status: String(row.status), responseJson: row.response_json === null ? null : String(row.response_json) }; }
function listingFromRow(row: Row): ListingRow { return { id: Number(row.id), shopSessionId: Number(row.shop_id), itemFingerprint: String(row.item_fingerprint), itemKey: row.item_key === null ? null : String(row.item_key), itemId: Number(row.item_id), upgrade: Number(row.upgrade), slots: Number(row.slots), cards: cards(row), price: Number(row.price), quantity: Number(row.quantity), lastQuantity: Number(row.quantity), status: String(row.status), stateVersion: Number(row.state_version), missingStreak: Number(row.missing_full_count), lastChangedAt: Number(row.last_changed_at) }; }
function listingFromSearchRow(row: Row): ListingSearchRow { return { ...listingFromRow(row), shopId: String(row.shop_id_display ?? row.shop_key), shopStatus: String(row.shop_status) as ListingSearchRow['shopStatus'], shopKey: String(row.shop_key), title: String(row.title), vendorName: String(row.vendor_name), mapName: String(row.map_name), x: Number(row.x), y: Number(row.y), shopType: String(row.shop_type) as 'buy' | 'sell', options: [] }; }

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

function assertQueryBounds(sql: string, boundValues: number): void { assertBatchBounds(1, boundValues); if (new TextEncoder().encode(sql).length > 100 * 1024) throw new Error('D1 SQL size limit exceeded'); }

function normalizeCatalogQuery(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}
