import { DEFAULT_CURSOR_SECRET, SearchValidationError, decodeCursor, decodeHistoryCursor, encodeCursor, encodeHistoryCursor, searchCursorContext } from '../domain/search';
import { makeTransitionKey } from '../domain/transitions';
import { getOptionDefinitionSet, OPTION_DEFINITION_MAP } from '../domain/option-definitions';
import { OptionConditionValidationError, compileOptionPredicates, formatOptionDisplay, parseStructuredOptionCondition } from '../domain/option-conditions';
import { chunkRows, type MysqlDatabase, type MysqlRow } from './mysql-client';
import type { SearchFilters } from '@lastroweb/protocol';
import type { BatchRow, ListingOption, ListingRow, ListingSearchOption, ListingSearchRow, ShopRow, ShopSessionRow, SourceRow, VendorInput, VendorRow } from './types';
import type { ListingTransitionChange, MarketRepository, ShopResolution, ShopSessionContextInput, UploadResultLike } from './repository';

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
  batch_id VARCHAR(191) PATH '$.batchId',
  observed_at BIGINT UNSIGNED PATH '$.observedAt'
)) AS observation`;

const LISTING_OBSERVATION_JSON_TABLE = `JSON_TABLE(?, '$[*]' COLUMNS(
  session_id BIGINT UNSIGNED PATH '$.sessionId',
  fingerprint CHAR(64) PATH '$.fingerprint'
)) AS observation`;

const LISTING_INPUT_JSON_TABLE = `JSON_TABLE(?, '$[*]' COLUMNS(
  session_id BIGINT UNSIGNED PATH '$.sessionId',
  fingerprint CHAR(64) PATH '$.fingerprint',
  item_key VARCHAR(191) PATH '$.itemKey' NULL ON EMPTY,
  item_id BIGINT UNSIGNED PATH '$.itemId',
  upgrade INT UNSIGNED PATH '$.upgrade',
  slots INT UNSIGNED PATH '$.slots',
  card0 BIGINT UNSIGNED PATH '$.cards[0]',
  card1 BIGINT UNSIGNED PATH '$.cards[1]',
  card2 BIGINT UNSIGNED PATH '$.cards[2]',
  card3 BIGINT UNSIGNED PATH '$.cards[3]',
  price BIGINT UNSIGNED PATH '$.price',
  quantity BIGINT UNSIGNED PATH '$.quantity',
  observed_at BIGINT UNSIGNED PATH '$.observedAt',
  batch_id VARCHAR(191) PATH '$.batchId'
)) AS listing_input`;

const LISTING_OPTIONS_JSON_TABLE = `JSON_TABLE(?, '$[*]' COLUMNS(
  session_id BIGINT UNSIGNED PATH '$.sessionId',
  fingerprint CHAR(64) PATH '$.fingerprint',
  batch_id VARCHAR(191) PATH '$.batchId',
  NESTED PATH '$.options[*]' COLUMNS(
    option_ordinal FOR ORDINALITY,
    option_type BIGINT UNSIGNED PATH '$.type',
    option_value BIGINT PATH '$.value',
    option_param BIGINT PATH '$.param'
  )
)) AS listing_option_input`;

const LISTING_TRANSITION_JSON_TABLE = `JSON_TABLE(?, '$[*]' COLUMNS(
  listing_id BIGINT UNSIGNED PATH '$.listingId',
  shop_id BIGINT UNSIGNED PATH '$.shopSessionId',
  expected_version BIGINT UNSIGNED PATH '$.expectedVersion',
  price BIGINT UNSIGNED PATH '$.price',
  quantity BIGINT UNSIGNED PATH '$.quantity',
  status VARCHAR(16) PATH '$.status',
  observed_at BIGINT UNSIGNED PATH '$.observedAt',
  batch_id VARCHAR(191) PATH '$.batchId',
  history_event_type VARCHAR(32) PATH '$.historyEventType' NULL ON EMPTY,
  sold_quantity BIGINT UNSIGNED PATH '$.soldQuantity' NULL ON EMPTY,
  sold_from_quantity BIGINT UNSIGNED PATH '$.soldFromQuantity' NULL ON EMPTY,
  sold_to_quantity BIGINT UNSIGNED PATH '$.soldToQuantity' NULL ON EMPTY,
  sold_reason VARCHAR(32) PATH '$.soldReason' NULL ON EMPTY,
  transition_key VARCHAR(255) PATH '$.transitionKey' NULL ON EMPTY
)) AS transition_input`;

const shopResolutionKey = (sourceId: string, identityHash: string): string => JSON.stringify([sourceId, identityHash]);
const SHOP_RESOLUTION_COLUMNS = `shops.id, shops.source_id, shops.identity_hash, shops.public_shop_id,
  shops.status, shops.last_status_observed_at, shops.last_changed_at, shops.full_state_hash, shops.full_snapshot_at, shops.closed_at`;

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
    batchId: input.batchId,
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
    initialSyncComplete: row.full_snapshot_at != null || row.full_state_hash != null,
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

function listingFromRow(row: Row): ListingRow {
  return {
    id: Number(row.id),
    shopSessionId: Number(row.shop_id),
    itemFingerprint: String(row.item_fingerprint),
    itemKey: row.item_key == null ? null : String(row.item_key),
    itemId: Number(row.item_id),
    upgrade: Number(row.upgrade),
    slots: Number(row.slots),
    cards: [row.card0, row.card1, row.card2, row.card3].map((value) => Number(value ?? 0)),
    price: Number(row.price),
    quantity: Number(row.quantity),
    lastQuantity: Number(row.quantity),
    status: String(row.status),
    stateVersion: Number(row.state_version),
    missingStreak: Number(row.missing_full_count),
    lastChangedAt: Number(row.last_changed_at),
  };
}

function listingFromSearchRow(row: Row): ListingSearchRow {
  return {
    ...listingFromRow(row),
    shopId: String(row.shop_id_display ?? row.shop_key),
    shopStatus: String(row.shop_status) as ListingSearchRow['shopStatus'],
    shopKey: String(row.shop_key),
    title: String(row.title),
    vendorName: String(row.vendor_name),
    mapName: String(row.map_name),
    x: Number(row.x),
    y: Number(row.y),
    shopType: String(row.shop_type) as ListingSearchRow['shopType'],
    options: [],
  };
}

// This receives only SQL emitted by compileOptionPredicates, whose numbered
// placeholders are positional and sequential. User input remains in values.
function mysqlPlaceholders(sql: string): string {
  return sql.replace(/\?\d+/gu, '?');
}

type NewListingInput = {
  sessionId: number;
  fingerprint: string;
  itemKey?: string;
  itemId: number;
  upgrade: number;
  slots: number;
  cards: number[];
  price: number;
  quantity: number;
  observedAt: number;
  batchId: string;
  options?: ListingOption[];
};

function listingInputPayload(inputs: readonly NewListingInput[]): string {
  return JSON.stringify(inputs.map((input) => ({
    sessionId: input.sessionId,
    fingerprint: input.fingerprint,
    itemKey: input.itemKey ?? null,
    itemId: input.itemId,
    upgrade: input.upgrade,
    slots: input.slots,
    cards: [input.cards[0] ?? 0, input.cards[1] ?? 0, input.cards[2] ?? 0, input.cards[3] ?? 0],
    price: input.price,
    quantity: input.quantity,
    observedAt: input.observedAt,
    batchId: input.batchId,
    options: [...(input.options ?? [])].sort((left, right) => left.type - right.type || left.value - right.value || left.param - right.param),
  })));
}

function listingTransitionPayload(changes: readonly ListingTransitionChange[]): string {
  return JSON.stringify(changes.map((change) => ({
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
}

function parseShopIds(value: unknown): number[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? [...new Set(parsed.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))] : [];
  } catch {
    return [];
  }
}

function parseProfileHashes(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((hash): hash is string => typeof hash === 'string' && /^[0-9a-f]{64}$/u.test(hash)))] : [];
  } catch {
    return [];
  }
}

export function createMysqlRepository(db: MysqlDatabase, cursorSecret = DEFAULT_CURSOR_SECRET, options: { deferListingExpiry?: boolean } = {}): MarketRepository {
  // The search implementation added in the later repository task consumes this
  // value. Keeping it part of the factory avoids a second production factory.
  void cursorSecret;

  const resolveShopObservations = async (inputs: ShopSessionContextInput[]): Promise<ShopResolution[]> => {
    if (inputs.length === 0) return [];
    const payload = shopResolutionPayload(inputs);
    const hasOpenings = inputs.some((input) => input.shopStatus === 'opening');
    const hasDismissals = inputs.some((input) => input.shopStatus === 'dismissed');

    return db.transaction(async (tx) => {
      const existingRows = await tx.all<Row>(`SELECT ${SHOP_RESOLUTION_COLUMNS} FROM shops
        JOIN ${SHOP_JSON_TABLE}
          ON shops.source_id = observation.source_id AND shops.identity_hash = observation.identity_hash`, [payload]);
      const existingByKey = new Map(existingRows.map((row) => [shopResolutionKey(String(row.source_id), String(row.identity_hash)), row]));

      if (hasDismissals) await tx.run(`INSERT INTO shops(
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

      if (hasOpenings) await tx.run(`INSERT INTO shops(
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
          public_shop_id = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(public_shop_id), shops.public_shop_id),
          vendor_account_id = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(vendor_account_id), shops.vendor_account_id),
          vendor_name = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(vendor_name), shops.vendor_name),
          vendor_name_normalized = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(vendor_name_normalized), shops.vendor_name_normalized),
          title = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(title), shops.title),
          title_normalized = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(title_normalized), shops.title_normalized),
          shop_type = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(shop_type), shops.shop_type),
          map_name = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(map_name), shops.map_name),
          x = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(x), shops.x),
          y = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(y), shops.y),
          profile_hash = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(profile_hash), shops.profile_hash),
          full_state_hash = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), IF(shops.status = 'closed', NULL, shops.full_state_hash), shops.full_state_hash),
          full_snapshot_at = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), IF(shops.status = 'closed', NULL, shops.full_snapshot_at), shops.full_snapshot_at),
          missing_full_count = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), IF(shops.status = 'closed', 0, shops.missing_full_count), shops.missing_full_count),
          last_changed_at = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(last_changed_at), shops.last_changed_at),
          closed_at = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), NULL, shops.closed_at),
          close_reason = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), NULL, shops.close_reason),
          status = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), 'active', shops.status),
          last_status_observed_at = IF(VALUES(last_status_observed_at) > shops.last_status_observed_at OR (VALUES(last_status_observed_at) = shops.last_status_observed_at AND shops.status <> 'closed'), VALUES(last_status_observed_at), shops.last_status_observed_at)`, [payload]);

      if (hasDismissals) await tx.run(`UPDATE shops
        JOIN ${SHOP_JSON_TABLE}
          ON shops.source_id = observation.source_id AND shops.identity_hash = observation.identity_hash
        SET shops.status = 'closed',
          shops.full_state_hash = NULL,
          shops.full_snapshot_at = NULL,
          shops.inventory_epoch_at = observation.observed_at,
          shops.last_status_observed_at = observation.observed_at,
          shops.last_changed_at = observation.observed_at,
          shops.closed_at = observation.observed_at,
          shops.close_reason = 'explicit_dismissed'
        WHERE observation.shop_status = 'dismissed'
          AND shops.last_status_observed_at <= observation.observed_at`, [payload]);

      if (hasDismissals && !options.deferListingExpiry) {
        // Match makeTransitionKey's input without reading every listing into the Worker.
        await tx.run(`INSERT INTO listing_events(
            listing_id, snapshot_id, observed_at, event_type, from_price, to_price, from_quantity, to_quantity,
            sold_quantity, reason, transition_key
          ) SELECT listings.id, observation.batch_id, observation.observed_at, 'expired',
            listings.price, listings.price, listings.quantity, listings.quantity, 0, 'shop_closed',
            LOWER(SHA2(CONCAT(listings.id, ':', listings.state_version, ':', listings.quantity, ':', listings.quantity, ':shop_closed'), 256))
          FROM listings
          JOIN shops ON shops.id = listings.shop_id
          JOIN ${SHOP_JSON_TABLE}
            ON shops.source_id = observation.source_id AND shops.identity_hash = observation.identity_hash
          WHERE observation.shop_status = 'dismissed'
            AND shops.status = 'closed'
            AND shops.last_status_observed_at <= observation.observed_at
            AND listings.status IN ('active', 'missing')
          ON DUPLICATE KEY UPDATE transition_key = listing_events.transition_key`, [payload]);

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
      }

      const resolvedRows = await tx.all<Row>(`SELECT ${SHOP_RESOLUTION_COLUMNS} FROM shops
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

  const insertListingRows = async (target: MysqlDatabase, payload: string): Promise<void> => {
    await target.run(`INSERT INTO listings(
        shop_id, item_fingerprint, item_key, item_id, upgrade, slots, card0, card1, card2, card3,
        price, quantity, status, first_seen_at, last_changed_at, last_changed_snapshot_id
      ) SELECT
        session_id, fingerprint, item_key, item_id, upgrade, slots, card0, card1, card2, card3,
        price, quantity, 'active', observed_at, observed_at, batch_id
      FROM ${LISTING_INPUT_JSON_TABLE}
      ON DUPLICATE KEY UPDATE id = id`, [payload]);
  };

  const insertNewListingsBulk = async (inputs: NewListingInput[]): Promise<void> => {
    if (inputs.length === 0) return;
    const payload = listingInputPayload(inputs);
    await db.transaction(async (tx) => {
      await insertListingRows(tx, payload);
      await tx.run(`INSERT INTO listing_events(
          listing_id, snapshot_id, observed_at, event_type, from_price, to_price, from_quantity, to_quantity,
          sold_quantity, reason, transition_key
        ) SELECT
          listings.id, listing_input.batch_id, listing_input.observed_at, 'first_seen', NULL, listing_input.price,
          NULL, listing_input.quantity, 0, NULL, CONCAT(listing_input.batch_id, ':', listings.id)
        FROM ${LISTING_INPUT_JSON_TABLE}
        JOIN listings ON listings.shop_id = listing_input.session_id
          AND listings.item_fingerprint = listing_input.fingerprint
          AND listings.last_changed_snapshot_id = listing_input.batch_id
        ON DUPLICATE KEY UPDATE transition_key = transition_key`, [payload]);
      await tx.run(`INSERT INTO listing_options(listing_id, option_index, option_type, option_value, option_param)
        SELECT listings.id, listing_option_input.option_ordinal - 1, listing_option_input.option_type,
          listing_option_input.option_value, listing_option_input.option_param
        FROM ${LISTING_OPTIONS_JSON_TABLE}
        JOIN listings ON listings.shop_id = listing_option_input.session_id
          AND listings.item_fingerprint = listing_option_input.fingerprint
          AND listings.last_changed_snapshot_id = listing_option_input.batch_id
        WHERE listing_option_input.option_ordinal IS NOT NULL
        ON DUPLICATE KEY UPDATE
          option_type = VALUES(option_type), option_value = VALUES(option_value), option_param = VALUES(option_param)`, [payload]);
    });
  };

  const applyListingTransitions = async (changes: ListingTransitionChange[]) => {
    if (changes.length === 0) return { updated: 0, conflicts: 0, soldEvents: 0, conflictIds: [] };
    const payload = listingTransitionPayload(changes);
    return db.transaction(async (tx) => {
      // The lock read is the authoritative optimistic-lock decision. The following
      // writes use the same predicates and connection, so histories/events can only
      // be emitted for winners. Exclude JSON_TABLE from locking: MySQL 8.4 rejects
      // the unqualified FOR UPDATE with ER_DUPLICATE_TABLE_LOCK at execution time.
      const winnerRows = await tx.all<Row>(`SELECT listings.id FROM listings
        JOIN ${LISTING_TRANSITION_JSON_TABLE}
          ON listings.id = transition_input.listing_id
          AND (transition_input.shop_id = 0 OR listings.shop_id = transition_input.shop_id)
          AND listings.state_version = transition_input.expected_version
        FOR UPDATE OF listings`, [payload]);
      const updatedIds = new Set(winnerRows.map((row) => Number(row.id)));
      if (updatedIds.size === 0) {
        return { updated: 0, conflicts: changes.length, soldEvents: 0, conflictIds: changes.map((change) => change.listingId) };
      }
      await tx.run(`UPDATE listings
        JOIN ${LISTING_TRANSITION_JSON_TABLE}
          ON listings.id = transition_input.listing_id
          AND (transition_input.shop_id = 0 OR listings.shop_id = transition_input.shop_id)
          AND listings.state_version = transition_input.expected_version
        SET listings.price = transition_input.price,
          listings.quantity = transition_input.quantity,
          listings.status = transition_input.status,
          listings.last_changed_at = transition_input.observed_at,
          listings.state_version = listings.state_version + 1,
          listings.last_changed_snapshot_id = transition_input.batch_id,
          listings.missing_full_count = 0`, [payload]);

      const historyCandidates = changes.some((change) => change.history !== undefined);
      if (historyCandidates) {
        await tx.run(`INSERT INTO listing_events(
            listing_id, snapshot_id, observed_at, event_type, from_price, to_price, from_quantity, to_quantity,
            sold_quantity, reason, transition_key
          ) SELECT
            listings.id, transition_input.batch_id, transition_input.observed_at,
            CASE WHEN transition_input.history_event_type = 'first_seen' THEN 'first_seen'
              WHEN transition_input.history_event_type = 'reappeared' THEN 'reappeared' ELSE 'state_changed' END,
            NULL, transition_input.price, NULL, transition_input.quantity, 0,
            CASE WHEN transition_input.history_event_type = 'price_changed' THEN 'price'
              WHEN transition_input.history_event_type = 'reappeared' THEN 'reappeared' ELSE NULL END,
            CONCAT(transition_input.batch_id, ':', listings.id, ':', transition_input.history_event_type)
          FROM ${LISTING_TRANSITION_JSON_TABLE}
          JOIN listings ON listings.id = transition_input.listing_id
            AND (transition_input.shop_id = 0 OR listings.shop_id = transition_input.shop_id)
            AND listings.last_changed_snapshot_id = transition_input.batch_id
            AND listings.state_version = transition_input.expected_version + 1
          WHERE transition_input.history_event_type IS NOT NULL
          ON DUPLICATE KEY UPDATE transition_key = listing_events.transition_key`, [payload]);
      }

      const soldCandidates = changes.filter((change) => change.soldEvent !== undefined);
      if (soldCandidates.length > 0) {
        await tx.run(`INSERT INTO listing_events(
            listing_id, snapshot_id, observed_at, event_type, from_price, to_price, from_quantity, to_quantity,
            sold_quantity, reason, transition_key
          ) SELECT
            listings.id, transition_input.batch_id, transition_input.observed_at, 'state_changed', NULL,
            transition_input.price, transition_input.sold_from_quantity, transition_input.sold_to_quantity,
            transition_input.sold_quantity, transition_input.sold_reason, transition_input.transition_key
          FROM ${LISTING_TRANSITION_JSON_TABLE}
          JOIN listings ON listings.id = transition_input.listing_id
            AND (transition_input.shop_id = 0 OR listings.shop_id = transition_input.shop_id)
            AND listings.last_changed_snapshot_id = transition_input.batch_id
            AND listings.state_version = transition_input.expected_version + 1
          WHERE transition_input.sold_quantity IS NOT NULL
          ON DUPLICATE KEY UPDATE transition_key = listing_events.transition_key`, [payload]);
      }

      const conflictIds = changes.filter((change) => !updatedIds.has(change.listingId)).map((change) => change.listingId);
      const soldEvents = soldCandidates.filter((change) => updatedIds.has(change.listingId)).length;
      return { updated: updatedIds.size, conflicts: conflictIds.length, soldEvents, conflictIds };
    });
  };

  const insertListingOptionsBatch = async (inputs: Array<{ listingId: number; options: ListingOption[] }>): Promise<void> => {
    const payload = JSON.stringify(inputs.map((input) => ({
      listingId: input.listingId,
      options: [...input.options].sort((left, right) => left.type - right.type || left.value - right.value || left.param - right.param),
    })));
    if (inputs.length === 0) return;
    await db.run(`INSERT INTO listing_options(listing_id, option_index, option_type, option_value, option_param)
      SELECT option_input.listing_id, option_input.option_ordinal - 1, option_input.option_type,
        option_input.option_value, option_input.option_param
      FROM JSON_TABLE(?, '$[*]' COLUMNS(
        listing_id BIGINT UNSIGNED PATH '$.listingId',
        NESTED PATH '$.options[*]' COLUMNS(
          option_ordinal FOR ORDINALITY,
          option_type BIGINT UNSIGNED PATH '$.type',
          option_value BIGINT PATH '$.value',
          option_param BIGINT PATH '$.param'
        )
      )) AS option_input
      WHERE option_input.option_ordinal IS NOT NULL
      ON DUPLICATE KEY UPDATE
        option_type = VALUES(option_type), option_value = VALUES(option_value), option_param = VALUES(option_param)`, [payload]);
  };

  const insertHistoriesBatch = async (inputs: Array<{ listingId: number; observedAt: number; price: number; quantity: number; eventType: string; batchId: string }>): Promise<void> => {
    if (inputs.length === 0) return;
    await db.run(`INSERT INTO listing_events(
        listing_id, snapshot_id, observed_at, event_type, from_price, to_price, from_quantity, to_quantity,
        sold_quantity, reason, transition_key
      ) SELECT history_input.listing_id, history_input.batch_id, history_input.observed_at,
        CASE WHEN history_input.event_type = 'first_seen' THEN 'first_seen' ELSE 'state_changed' END,
        NULL, history_input.price, NULL, history_input.quantity, 0,
        CASE WHEN history_input.event_type = 'price_changed' THEN 'price' ELSE NULL END,
        CONCAT(history_input.batch_id, ':', history_input.listing_id, ':', history_input.event_type)
      FROM JSON_TABLE(?, '$[*]' COLUMNS(
        listing_id BIGINT UNSIGNED PATH '$.listingId',
        observed_at BIGINT UNSIGNED PATH '$.observedAt',
        price BIGINT UNSIGNED PATH '$.price',
        quantity BIGINT UNSIGNED PATH '$.quantity',
        event_type VARCHAR(32) PATH '$.eventType',
        batch_id VARCHAR(191) PATH '$.batchId'
      )) AS history_input
      ON DUPLICATE KEY UPDATE transition_key = transition_key`, [JSON.stringify(inputs)]);
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
          source_id, batch_id, snapshot_id, part_index, part_count, snapshot_mode, payload_hash, status, shop_ids_json, shop_hashes_json, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?)
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
    async markShopHeartbeats(sourceId, identityHashes, observedAt) {
      if (identityHashes.length === 0) return 0;
      const result = await db.run(`UPDATE shops
        JOIN JSON_TABLE(?, '$[*]' COLUMNS(identity_hash CHAR(64) PATH '$')) AS heartbeat
          ON shops.identity_hash = heartbeat.identity_hash
        SET shops.last_status_observed_at = ?, shops.last_changed_at = ?,
          shops.status = CASE WHEN shops.status = 'closed' THEN shops.status ELSE 'active' END
        WHERE shops.source_id = ?`, [JSON.stringify([...new Set(identityHashes)]), observedAt, observedAt, sourceId]);
      return result.affectedRows;
    },
    async getUninitializedShopKeys(sourceId, identityHashes) {
      if (identityHashes.length === 0) return [];
      const rows = await db.all<Row>(`SELECT requested.identity_hash AS shop_key
        FROM JSON_TABLE(?, '$[*]' COLUMNS(identity_hash CHAR(64) PATH '$')) AS requested
        LEFT JOIN shops ON shops.source_id = ? AND shops.identity_hash = requested.identity_hash
          AND shops.full_state_hash IS NOT NULL AND shops.status IN ('active', 'stale')
        WHERE shops.id IS NULL`, [JSON.stringify([...new Set(identityHashes)]), sourceId]);
      return rows.map((row) => String(row.shop_key));
    },
    async recordSnapshotSessions(sourceId, snapshotId, sessionIds, observedAt) {
      if (sessionIds.length === 0) return;
      await db.transaction(async (tx) => {
        const row = await tx.first<Row>('SELECT shop_ids_json FROM upload_batches WHERE source_id = ? AND snapshot_id = ? ORDER BY part_index LIMIT 1 FOR UPDATE', [sourceId, snapshotId]);
        const merged = [...new Set([...parseShopIds(row?.shop_ids_json), ...sessionIds])];
        await tx.run('UPDATE upload_batches SET shop_ids_json = ? WHERE source_id = ? AND snapshot_id = ?', [JSON.stringify(merged), sourceId, snapshotId]);
      });
      void observedAt;
    },
    async recordSnapshotProfileHashes(sourceId, snapshotId, profileHashes, observedAt) {
      if (profileHashes.length === 0) return;
      await db.transaction(async (tx) => {
        const row = await tx.first<Row>('SELECT shop_hashes_json FROM upload_batches WHERE source_id = ? AND snapshot_id = ? ORDER BY part_index LIMIT 1 FOR UPDATE', [sourceId, snapshotId]);
        const merged = [...new Set([...parseProfileHashes(row?.shop_hashes_json), ...profileHashes])];
        await tx.run('UPDATE upload_batches SET shop_hashes_json = ? WHERE source_id = ? AND snapshot_id = ?', [JSON.stringify(merged), sourceId, snapshotId]);
      });
      void observedAt;
    },
    async getSnapshotSessionIds(sourceId, snapshotId) {
      const row = await db.first<Row>('SELECT shop_ids_json FROM upload_batches WHERE source_id = ? AND snapshot_id = ? ORDER BY part_index LIMIT 1', [sourceId, snapshotId]);
      return parseShopIds(row?.shop_ids_json);
    },
    async getSnapshotProfileHashes(sourceId, snapshotId) {
      const row = await db.first<Row>('SELECT shop_hashes_json FROM upload_batches WHERE source_id = ? AND snapshot_id = ? ORDER BY part_index LIMIT 1', [sourceId, snapshotId]);
      return parseProfileHashes(row?.shop_hashes_json);
    },
    async updateShopFullStateHashes(updates, observedAt) {
      if (updates.length === 0) return;
      await db.run(`UPDATE shops
        JOIN JSON_TABLE(?, '$[*]' COLUMNS(
          shop_id BIGINT UNSIGNED PATH '$.shopId',
          full_state_hash CHAR(64) PATH '$.fullStateHash'
        )) AS state_update ON shops.id = state_update.shop_id
        SET shops.full_state_hash = state_update.full_state_hash
        WHERE shops.last_status_observed_at <= ?`, [JSON.stringify(updates), observedAt]);
    },
    async finalizeSnapshot(sourceId, snapshotId, observedAt) {
      const latestSnapshot = await db.first<Row>('SELECT last_full_snapshot_id, last_full_snapshot_at FROM market_sources WHERE id = ?', [sourceId]);
      if (latestSnapshot?.last_full_snapshot_id !== snapshotId && latestSnapshot?.last_full_snapshot_at != null && Number(latestSnapshot.last_full_snapshot_at) > observedAt) return;
      const sourceUpdate = await db.run('UPDATE market_sources SET last_full_snapshot_id = ?, last_full_snapshot_at = ?, updated_at = ? WHERE id = ? AND (last_full_snapshot_at IS NULL OR last_full_snapshot_at < ? OR (last_full_snapshot_at = ? AND (last_full_snapshot_id IS NULL OR last_full_snapshot_id <> ?)))', [snapshotId, observedAt, observedAt, sourceId, observedAt, observedAt, snapshotId]);
      void sourceUpdate;
      const row = await db.first<Row>('SELECT shop_ids_json FROM upload_batches WHERE source_id = ? AND snapshot_id = ? ORDER BY part_index LIMIT 1', [sourceId, snapshotId]);
      const sessionIds = parseShopIds(row?.shop_ids_json);
      if (sessionIds.length === 0) return;
      await db.run(`UPDATE shops
        JOIN JSON_TABLE(?, '$[*]' COLUMNS(shop_id BIGINT UNSIGNED PATH '$')) AS snapshot_shop
          ON shops.id = snapshot_shop.shop_id
        SET shops.full_snapshot_at = ?,
          shops.status = CASE WHEN shops.status = 'closed' THEN shops.status ELSE 'active' END,
          shops.last_changed_at = ?
        WHERE shops.source_id = ? AND shops.last_status_observed_at <= ?`, [JSON.stringify(sessionIds), observedAt, observedAt, sourceId, observedAt]);
    },
    async reconcileSnapshot(input) {
      const empty = (complete: boolean, baseline: boolean) => ({
        sourceId: input.sourceId,
        snapshotId: input.snapshotId,
        complete,
        baseline,
        shops: 0,
        candidates: 0,
        markedMissing: 0,
        inferredSold: 0,
        expired: 0,
      });
      if (input.batchIds.length === 0) return empty(false, false);
      const sessionIds = [...new Set((input.sessionIds ?? []).filter((id) => Number.isSafeInteger(id) && id > 0))];
      const scope = JSON.stringify(sessionIds);
      const batches = JSON.stringify([...new Set(input.batchIds)]);

      return db.transaction(async (tx) => {
        const latestSnapshot = await tx.first<Row>('SELECT last_full_snapshot_id, last_full_snapshot_at FROM market_sources WHERE id = ? FOR UPDATE', [input.sourceId]);
        if (latestSnapshot?.last_full_snapshot_id === input.snapshotId || (latestSnapshot?.last_full_snapshot_at != null && Number(latestSnapshot.last_full_snapshot_at) > input.observedAt)) return empty(true, true);
        const profileHashes = input.profileHashes === undefined ? null : [...new Set(input.profileHashes.filter((hash) => /^[0-9a-f]{64}$/u.test(hash)))];
        const presenceSql = profileHashes === null
          ? `NOT EXISTS (
              SELECT 1 FROM JSON_TABLE(?, '$[*]' COLUMNS(shop_id BIGINT UNSIGNED PATH '$')) AS snapshot_shop
              WHERE snapshot_shop.shop_id = shops.id
            )`
          : `NOT EXISTS (
              SELECT 1 FROM JSON_TABLE(?, '$[*]' COLUMNS(profile_hash CHAR(64) PATH '$')) AS snapshot_shop
              WHERE snapshot_shop.profile_hash = shops.profile_hash
            )`;
        const presenceValues = profileHashes === null ? scope : JSON.stringify(profileHashes);
        await tx.run(`UPDATE shops
          SET status = 'closed', full_state_hash = NULL, missing_full_count = 0,
            last_status_observed_at = ?, last_changed_at = ?, closed_at = ?, close_reason = 'missing_full'
          WHERE shops.source_id = ? AND shops.status IN ('active', 'stale') AND ${presenceSql}`, [input.observedAt, input.observedAt, input.observedAt, input.sourceId, presenceValues]);
        await tx.run(`UPDATE listings
          JOIN shops ON shops.id = listings.shop_id
          SET listings.status = 'expired', listings.last_changed_at = ?, listings.state_version = listings.state_version + 1,
            listings.missing_full_count = 0
          WHERE shops.source_id = ? AND listings.status IN ('active', 'missing')
            AND shops.status = 'closed' AND shops.closed_at = ? AND shops.close_reason = 'missing_full'
            `, [input.observedAt, input.sourceId, input.observedAt]);
        const baseline = await tx.first<Row>(`SELECT COUNT(*) AS count FROM shops
          JOIN JSON_TABLE(?, '$[*]' COLUMNS(shop_id BIGINT UNSIGNED PATH '$')) AS snapshot_shop
            ON shops.id = snapshot_shop.shop_id
          WHERE shops.source_id = ? AND shops.full_state_hash IS NULL`, [scope, input.sourceId]);
        if (Number(baseline?.count ?? 0) > 0) return empty(true, true);

        const candidateRows = await tx.all<Row>(`SELECT listings.id, listings.quantity, listings.state_version FROM listings
          JOIN JSON_TABLE(?, '$[*]' COLUMNS(shop_id BIGINT UNSIGNED PATH '$')) AS snapshot_shop
            ON listings.shop_id = snapshot_shop.shop_id
          WHERE listings.status IN ('active', 'missing')
            AND listings.missing_full_count = 1
            AND listings.quantity > 0
            AND (listings.last_changed_snapshot_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM JSON_TABLE(?, '$[*]' COLUMNS(batch_id VARCHAR(191) PATH '$')) AS accepted_batch
              WHERE accepted_batch.batch_id = listings.last_changed_snapshot_id
            ))`, [scope, batches]);
        const inferredCandidates = await Promise.all(candidateRows.map(async (row) => ({
          listingId: Number(row.id),
          soldQuantity: Number(row.quantity),
          fromQuantity: Number(row.quantity),
          toQuantity: 0,
          observedAt: input.observedAt,
          newStateVersion: Number(row.state_version) + 1,
          transitionKey: await makeTransitionKey(Number(row.id), Number(row.state_version), Number(row.quantity), 0, 'missing_full'),
        })));

        const stale = await tx.run(`UPDATE listings
          JOIN JSON_TABLE(?, '$[*]' COLUMNS(shop_id BIGINT UNSIGNED PATH '$')) AS snapshot_shop
            ON listings.shop_id = snapshot_shop.shop_id
          SET listings.missing_full_count = listings.missing_full_count + 1,
            listings.status = CASE WHEN listings.missing_full_count + 1 >= 2 THEN 'missing' ELSE listings.status END,
            listings.last_changed_at = ?, listings.state_version = listings.state_version + 1
          WHERE listings.status IN ('active', 'missing')
            AND (listings.last_changed_snapshot_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM JSON_TABLE(?, '$[*]' COLUMNS(batch_id VARCHAR(191) PATH '$')) AS accepted_batch
              WHERE accepted_batch.batch_id = listings.last_changed_snapshot_id
            ))`, [scope, input.observedAt, batches]);

        let inferredSold = 0;
        if (inferredCandidates.length > 0) {
          const inferred = await tx.run(`INSERT INTO listing_events(
              listing_id, snapshot_id, observed_at, event_type, from_price, to_price, from_quantity, to_quantity,
              sold_quantity, reason, transition_key
            ) SELECT candidate.listing_id, ?, candidate.observed_at, 'missing', NULL, 0,
              candidate.from_quantity, candidate.to_quantity, candidate.sold_quantity, 'missing_full', candidate.transition_key
            FROM JSON_TABLE(?, '$[*]' COLUMNS(
              listing_id BIGINT UNSIGNED PATH '$.listingId',
              sold_quantity BIGINT UNSIGNED PATH '$.soldQuantity',
              from_quantity BIGINT UNSIGNED PATH '$.fromQuantity',
              to_quantity BIGINT UNSIGNED PATH '$.toQuantity',
              observed_at BIGINT UNSIGNED PATH '$.observedAt',
              new_state_version BIGINT UNSIGNED PATH '$.newStateVersion',
              transition_key VARCHAR(255) PATH '$.transitionKey'
            )) AS candidate
            JOIN listings ON listings.id = candidate.listing_id
              AND listings.state_version = candidate.new_state_version
              AND listings.missing_full_count = 2
              AND listings.status = 'missing'
            ON DUPLICATE KEY UPDATE transition_key = transition_key`, [input.snapshotId, JSON.stringify(inferredCandidates)]);
          inferredSold = inferred.affectedRows;
        }

        const expired = await tx.run(`UPDATE listings
          JOIN JSON_TABLE(?, '$[*]' COLUMNS(shop_id BIGINT UNSIGNED PATH '$')) AS snapshot_shop
            ON listings.shop_id = snapshot_shop.shop_id
          JOIN shops ON shops.id = listings.shop_id
          SET listings.status = 'expired', listings.last_changed_at = ?
          WHERE listings.status IN ('active', 'missing')
            AND shops.status = 'closed' AND shops.closed_at IS NOT NULL AND shops.closed_at <= ?`, [scope, input.observedAt, input.observedAt]);
        const shops = await tx.first<Row>(`SELECT COUNT(*) AS count FROM shops
          JOIN JSON_TABLE(?, '$[*]' COLUMNS(shop_id BIGINT UNSIGNED PATH '$')) AS snapshot_shop
            ON shops.id = snapshot_shop.shop_id
          WHERE shops.source_id = ? AND shops.status IN ('active', 'stale')`, [scope, input.sourceId]);
        const markedMissing = stale.affectedRows;
        return {
          sourceId: input.sourceId,
          snapshotId: input.snapshotId,
          complete: true,
          baseline: false,
          shops: Number(shops?.count ?? 0),
          candidates: markedMissing,
          markedMissing,
          inferredSold,
          expired: expired.affectedRows,
        };
      });
    },
    async loadListingsByFingerprint(sessionId, fingerprints) {
      if (fingerprints.length === 0) return [];
      const uniqueFingerprints = [...new Set(fingerprints)];
      const placeholders = uniqueFingerprints.map(() => '?').join(', ');
      const rows = await db.all<Row>(`SELECT * FROM listings WHERE shop_id = ? AND item_fingerprint IN (${placeholders})`, [sessionId, ...uniqueFingerprints]);
      return rows.map(listingFromRow);
    },
    async loadListingsByObservations(observations) {
      if (observations.length === 0) return [];
      const payload = JSON.stringify(observations);
      const rows = await db.all<Row>(`SELECT listings.* FROM listings
        JOIN ${LISTING_OBSERVATION_JSON_TABLE}
          ON listings.shop_id = observation.session_id
          AND listings.item_fingerprint = observation.fingerprint`, [payload]);
      return rows.map(listingFromRow);
    },
    async loadListingById(listingId, sessionId) {
      const row = sessionId === undefined
        ? await db.first<Row>('SELECT * FROM listings WHERE id = ? LIMIT 1', [listingId])
        : await db.first<Row>('SELECT * FROM listings WHERE id = ? AND shop_id = ? LIMIT 1', [listingId, sessionId]);
      return row ? listingFromRow(row) : null;
    },
    async markListingsObservedBulk(observations, batchId, observedAt) {
      if (observations.length === 0) return 0;
      const payload = JSON.stringify(observations);
      const result = await db.run(`UPDATE listings
        JOIN ${LISTING_OBSERVATION_JSON_TABLE}
          ON listings.shop_id = observation.session_id
          AND listings.item_fingerprint = observation.fingerprint
        SET listings.last_changed_at = ?, listings.last_changed_snapshot_id = ?, listings.missing_full_count = 0,
          listings.status = CASE WHEN listings.quantity = 0 THEN 'sold_out' ELSE 'active' END`, [payload, observedAt, batchId]);
      return result.affectedRows;
    },
    async markListingsObserved(sessionId, fingerprints, batchId, observedAt) {
      if (fingerprints.length === 0) return 0;
      const uniqueFingerprints = [...new Set(fingerprints)];
      const placeholders = uniqueFingerprints.map(() => '?').join(', ');
      const result = await db.run(`UPDATE listings
        SET last_changed_at = ?, last_changed_snapshot_id = ?, missing_full_count = 0,
          status = CASE WHEN quantity = 0 THEN 'sold_out' ELSE 'active' END
        WHERE shop_id = ? AND item_fingerprint IN (${placeholders})`, [observedAt, batchId, sessionId, ...uniqueFingerprints]);
      return result.affectedRows;
    },
    async createListing(input) {
      const payload = listingInputPayload([input]);
      return db.transaction(async (tx) => {
        await insertListingRows(tx, payload);
        const row = await tx.first<Row>('SELECT * FROM listings WHERE shop_id = ? AND item_fingerprint = ? LIMIT 1', [input.sessionId, input.fingerprint]);
        if (!row) throw new Error('listing insert returned no row');
        return listingFromRow(row);
      });
    },
    async createListingsBatch(inputs) {
      if (inputs.length === 0) return [];
      const payload = listingInputPayload(inputs);
      return db.transaction(async (tx) => {
        await insertListingRows(tx, payload);
        const rows = await tx.all<Row>(`SELECT listings.* FROM listings
          JOIN ${LISTING_OBSERVATION_JSON_TABLE}
            ON listings.shop_id = observation.session_id
            AND listings.item_fingerprint = observation.fingerprint`, [JSON.stringify(inputs.map((input) => ({ sessionId: input.sessionId, fingerprint: input.fingerprint })))]);
        return rows.map(listingFromRow);
      });
    },
    async createListingsBundleBatch(inputs) {
      if (inputs.length === 0) return [];
      await insertNewListingsBulk(inputs);
      const rows = await db.all<Row>(`SELECT listings.* FROM listings
        JOIN ${LISTING_OBSERVATION_JSON_TABLE}
          ON listings.shop_id = observation.session_id
          AND listings.item_fingerprint = observation.fingerprint`, [JSON.stringify(inputs.map((input) => ({ sessionId: input.sessionId, fingerprint: input.fingerprint })))]);
      return rows.map(listingFromRow);
    },
    insertNewListingsBulk,
    async insertListingOptions(input) {
      await insertListingOptionsBatch([input]);
    },
    insertListingOptionsBatch,
    async insertHistory(input) {
      await insertHistoriesBatch([input]);
    },
    insertHistoriesBatch,
    async insertSoldEvent(input) {
      const result = await db.run(`INSERT INTO listing_events(
          listing_id, snapshot_id, observed_at, event_type, from_price, to_price, from_quantity, to_quantity,
          sold_quantity, reason, transition_key
        ) VALUES (?, ?, ?, 'state_changed', NULL, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE transition_key = transition_key`, [
        input.listingId, input.snapshotId ?? input.transitionKey, input.observedAt, input.price ?? 0,
        input.fromQuantity, input.toQuantity, input.soldQuantity, input.reason, input.transitionKey,
      ]);
      return result.affectedRows === 1;
    },
    applyListingTransitions,
    applyListingTransitionsBulk: applyListingTransitions,
    async applyListingChanges(changes) {
      const result = await applyListingTransitions(changes.map((change) => ({ ...change, shopSessionId: 0 })));
      return { updated: result.updated, conflicts: result.conflicts };
    },
    async getOptionDefinitions(version) {
      return getOptionDefinitionSet(version);
    },
    async getCatalogVersion() {
      return 'static';
    },
    async searchItems() {
      return [];
    },
    async searchListings(filters: SearchFilters) {
      const params: unknown[] = [];
      const add = (value: unknown): string => {
        params.push(value);
        return '?';
      };
      const where = [
        filters.include_stale ? "l.status IN ('active', 'missing')" : "l.status = 'active'",
        filters.include_stale ? "s.status IN ('active', 'stale')" : "s.status = 'active'",
      ];
      const itemIds = [...new Set([
        ...(filters.item_ids ?? []).filter((id) => Number.isSafeInteger(id) && id >= 0),
        ...(filters.item_id !== undefined ? [filters.item_id] : []),
      ])];
      const matchPredicates: string[] = [];
      if (itemIds.length > 0) {
        matchPredicates.push(`l.item_id IN (${itemIds.map((itemId) => add(itemId)).join(', ')})`);
      }
      const normalizedQuery = filters.q ? normalizeCatalogQuery(filters.q) : '';
      if ([...normalizedQuery].length >= 2) {
        const escaped = normalizedQuery.replace(/[\\%_]/gu, (value) => `\\${value}`);
        const titleQuery = add(`%${escaped}%`);
        const vendorQuery = add(`%${escaped}%`);
        matchPredicates.push(`(s.title_normalized LIKE ${titleQuery} ESCAPE '\\\\' OR COALESCE(s.vendor_name_normalized, '') LIKE ${vendorQuery} ESCAPE '\\\\')`);
      }
      if (matchPredicates.length > 0) where.push(`(${matchPredicates.join(' OR ')})`);
      if (filters.price_min !== undefined) where.push(`l.price >= ${add(filters.price_min)}`);
      if (filters.price_max !== undefined) where.push(`l.price <= ${add(filters.price_max)}`);
      if (filters.map) where.push(`s.map_name = ${add(normalizeCatalogQuery(filters.map))}`);
      if (filters.shop_type) where.push(`s.shop_type = ${add(filters.shop_type)}`);

      getOptionDefinitionSet(filters.optionVersion);
      const definitionMap = OPTION_DEFINITION_MAP;
      if (filters.options && filters.options.length > 0) {
        try {
          const conditions = filters.options.map((option) => parseStructuredOptionCondition(option, definitionMap));
          const compiled = compileOptionPredicates(conditions, filters.option_mode ?? 'all', definitionMap, params.length + 1);
          where.push(mysqlPlaceholders(compiled.sql));
          params.push(...compiled.values);
        } catch (error) {
          if (error instanceof OptionConditionValidationError) throw new SearchValidationError(error.message);
          throw error;
        }
      } else if (filters.option_type !== undefined && filters.option_value !== undefined && filters.option_param !== undefined) {
        where.push(`EXISTS (SELECT 1 FROM listing_options lo WHERE lo.listing_id = l.id AND lo.option_type = ${add(filters.option_type)} AND lo.option_value = ${add(filters.option_value)} AND lo.option_param = ${add(filters.option_param)})`);
      } else if (filters.option_type !== undefined || filters.option_value !== undefined || filters.option_param !== undefined) {
        throw new SearchValidationError('Incomplete legacy option filter');
      }

      const cursor = filters.cursor ? decodeCursor(filters.cursor, { sort: filters.sort, context: searchCursorContext(filters) }, cursorSecret) : null;
      const sortColumn = filters.sort === 'changed_desc' ? 'l.last_changed_at' : 'l.price';
      if (cursor) {
        const operator = filters.sort === 'price_asc' ? '>' : '<';
        const value = add(cursor.sortValue);
        const sameValue = add(cursor.sortValue);
        const id = add(cursor.id);
        where.push(`(${sortColumn} ${operator} ${value} OR (${sortColumn} = ${sameValue} AND l.id ${operator} ${id}))`);
      }
      const limit = Math.min(50, Math.max(1, filters.limit));
      params.push(limit + 1);
      const order = filters.sort === 'price_desc'
        ? 'l.price DESC, l.id DESC'
        : filters.sort === 'changed_desc'
          ? 'l.last_changed_at DESC, l.id DESC'
          : 'l.price ASC, l.id ASC';
      const rows = await db.all<Row>(`SELECT l.id, l.shop_id, l.item_fingerprint, l.item_key, l.item_id, l.upgrade, l.slots,
          l.card0, l.card1, l.card2, l.card3, l.price, l.quantity, l.status, l.state_version, l.missing_full_count,
          l.last_changed_at, s.public_shop_id AS shop_id_display, s.status AS shop_status, s.public_shop_id AS shop_key,
          s.title, s.vendor_name, s.map_name, s.x, s.y, s.shop_type
        FROM listings l JOIN shops s ON s.id = l.shop_id
        WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`, params);
      const items = rows.slice(0, limit).map(listingFromSearchRow);
      if (items.length > 0) {
        const optionRows = await db.all<Row>(`SELECT listing_options.listing_id, listing_options.option_type,
            listing_options.option_value, listing_options.option_param
          FROM listing_options
          JOIN JSON_TABLE(?, '$[*]' COLUMNS(listing_id BIGINT UNSIGNED PATH '$')) AS result_listing
            ON listing_options.listing_id = result_listing.listing_id
          ORDER BY listing_options.listing_id, listing_options.option_index`, [JSON.stringify(items.map((item) => item.id))]);
        const optionsByListing = new Map<number, ListingSearchOption[]>();
        for (const row of optionRows) {
          const listingId = Number(row.listing_id);
          const option = { type: Number(row.option_type), value: Number(row.option_value), param: Number(row.option_param) };
          let listingOptions = optionsByListing.get(listingId);
          if (!listingOptions) { listingOptions = []; optionsByListing.set(listingId, listingOptions); }
          listingOptions.push({ ...option, display: formatOptionDisplay(option, definitionMap.get(option.type)) });
        }
        for (const item of items) item.options = optionsByListing.get(item.id) ?? [];
      }
      const last = items.at(-1);
      const sortValue = last ? (filters.sort === 'changed_desc' ? last.lastChangedAt : last.price) : 0;
      return {
        items,
        nextCursor: rows.length > limit && last ? encodeCursor({ sort: filters.sort, sortValue, id: last.id, context: searchCursorContext(filters) }, cursorSecret) : null,
      };
    },
    async getListingHistory(listingId, limit, cursor) {
      const listing = await db.first<Row>('SELECT id FROM listings WHERE id = ? LIMIT 1', [listingId]);
      if (!listing) return null;
      const boundedLimit = Math.min(50, Math.max(1, limit));
      const values: unknown[] = [listingId];
      let where = 'listing_id = ?';
      if (cursor) {
        where += ' AND id < ?';
        values.push(decodeHistoryCursor(cursor, cursorSecret));
      }
      values.push(boundedLimit + 1);
      const rows = await db.all<Row>(`SELECT id, listing_id, snapshot_id, observed_at, event_type, from_price, to_price,
          from_quantity, to_quantity, sold_quantity, reason, transition_key
        FROM listing_events WHERE ${where} ORDER BY id DESC LIMIT ?`, values);
      const items = rows.slice(0, boundedLimit).map((row) => ({
        id: Number(row.id),
        listingId: Number(row.listing_id),
        observedAt: Number(row.observed_at),
        price: Number(row.to_price),
        quantity: Number(row.to_quantity),
        eventType: row.reason == null ? String(row.event_type) : String(row.reason),
        batchId: String(row.snapshot_id),
      }));
      const saleRows = await db.all<Row>(`SELECT observed_at, sold_quantity, from_quantity, to_quantity, reason
        FROM listing_events WHERE listing_id = ? AND sold_quantity > 0 ORDER BY id DESC LIMIT ?`, [listingId, boundedLimit]);
      const inferredSales = saleRows.map((row) => ({
        observedAt: Number(row.observed_at),
        soldQuantity: Number(row.sold_quantity),
        fromQuantity: Number(row.from_quantity),
        toQuantity: Number(row.to_quantity),
        reason: String(row.reason),
      }));
      const last = items.at(-1);
      return { items, inferredSales, nextCursor: rows.length > boundedLimit && last ? encodeHistoryCursor(last.id, cursorSecret) : null };
    },
    async getItemMarketHistory(itemId, windowStart, windowEnd) {
      const item = await db.first<Row>('SELECT item_id FROM listings WHERE item_id = ? LIMIT 1', [itemId]);
      if (!item) return null;
      const [currentRows, saleRows, eventRows] = await Promise.all([
        db.all<Row>(`SELECT listings.id, listings.price, listings.quantity, listings.last_changed_at,
            shops.vendor_name, shops.title, shops.map_name
          FROM listings JOIN shops ON shops.id = listings.shop_id
          WHERE listings.item_id = ? AND listings.status = 'active' AND shops.status = 'active' AND shops.shop_type = 'sell'
          ORDER BY listings.price ASC, listings.id ASC`, [itemId]),
        db.all<Row>(`SELECT listing_events.listing_id, listing_events.observed_at, listing_events.to_price,
            listing_events.sold_quantity, shops.vendor_name, shops.title
          FROM listing_events JOIN listings ON listings.id = listing_events.listing_id
          JOIN shops ON shops.id = listings.shop_id
          WHERE listings.item_id = ? AND listing_events.observed_at >= ? AND listing_events.observed_at <= ?
            AND listing_events.sold_quantity > 0 AND shops.shop_type = 'sell'
          ORDER BY listing_events.observed_at DESC, listing_events.id DESC`, [itemId, windowStart, windowEnd]),
        db.all<Row>(`SELECT listing_events.listing_id, listing_events.observed_at, listing_events.to_price,
            listing_events.to_quantity, listing_events.event_type, listing_events.reason
          FROM listing_events JOIN listings ON listings.id = listing_events.listing_id
          JOIN shops ON shops.id = listings.shop_id
          WHERE listings.item_id = ? AND listing_events.observed_at >= ? AND listing_events.observed_at <= ?
            AND shops.shop_type = 'sell'
          ORDER BY listing_events.observed_at ASC, listing_events.id ASC`, [itemId, windowStart, windowEnd]),
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
    async deleteExpiredHistory(before, limit) {
      const result = await db.run(`DELETE FROM listing_events
        WHERE id IN (
          SELECT id FROM (
            SELECT id FROM listing_events WHERE observed_at < ? ORDER BY observed_at, id LIMIT ?
          ) AS expired_history
        )`, [before, limit]);
      return result.affectedRows;
    },
    async deleteExpiredSoldEvents(before, limit) {
      const result = await db.run(`DELETE FROM listing_events
        WHERE id IN (
          SELECT id FROM (
            SELECT id FROM listing_events WHERE observed_at < ? ORDER BY observed_at, id LIMIT ?
          ) AS expired_sold_events
        )`, [before, limit]);
      return result.affectedRows;
    },
    async countExpiredHistory(before, limit) {
      const row = await db.first<Row>(`SELECT COUNT(*) AS count FROM (
        SELECT id FROM listing_events WHERE observed_at < ? ORDER BY observed_at, id LIMIT ?
      ) AS expired_history`, [before, limit]);
      return Number(row?.count ?? 0);
    },
    async countExpiredSoldEvents(before, limit) {
      const row = await db.first<Row>(`SELECT COUNT(*) AS count FROM (
        SELECT id FROM listing_events WHERE observed_at < ? ORDER BY observed_at, id LIMIT ?
      ) AS expired_sold_events`, [before, limit]);
      return Number(row?.count ?? 0);
    },
    async deleteGuestbookRateBuckets(before, limit) {
      const boundedLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
      const result = await db.run(`DELETE FROM guestbook_rate_limits WHERE (rate_key, bucket_start) IN (
        SELECT rate_key, bucket_start FROM (
          SELECT rate_key, bucket_start FROM guestbook_rate_limits WHERE bucket_start < ? ORDER BY bucket_start LIMIT ?
        ) AS expired_rate_buckets
      )`, [before, boundedLimit]);
      return result.affectedRows;
    },
  } as MarketRepository;
}

export const mysqlRepositoryBatchReadChunks = <T>(rows: readonly T[]): T[][] => chunkRows(rows, 2, 400);
