import type { MysqlDatabase, MysqlRow } from '../db/mysql-client';
import { queryEntitlements } from '../ke/entitlements';
import { normalizeLegacySlotUnits } from './units';
import { assertCommerceId, createCommerceRepository, readLastInsertId, type CommerceTransaction } from './repository';
import type { QuoteAccountState, QuoteEntitlement, QuotePersistenceRecord, QuoteRepository } from './quotes';

function readBigint(value: unknown, field: string): bigint {
  if (value === null || value === undefined) throw new TypeError(`missing commerce ${field}`);
  try {
    return BigInt(value as string | number | bigint);
  } catch {
    throw new TypeError(`invalid commerce ${field}`);
  }
}

function readQuantity(value: unknown): number {
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity)) throw new RangeError('invalid commerce entitlement quantity');
  return quantity;
}

function readEntitlement(row: MysqlRow, unitIdByEntitlement: ReadonlyMap<string, string>): QuoteEntitlement {
  const id = assertCommerceId(String(row.id));
  return {
    id,
    unitId: unitIdByEntitlement.get(id) ?? null,
    resource: String(row.resource),
    quantity: readQuantity(row.quantity),
    startsAt: readBigint(row.starts_at, 'entitlement start'),
    expiresAt: readBigint(row.expires_at, 'entitlement expiry'),
    source: String(row.source),
    sourceRef: row.source_ref === null || row.source_ref === undefined ? null : String(row.source_ref),
  };
}

async function readAccount(tx: CommerceTransaction, userId: string, now: number): Promise<QuoteAccountState> {
  const slotUnits = await normalizeLegacySlotUnits(tx, userId, BigInt(now));
  const unitIdByEntitlement = new Map(slotUnits.flatMap((unit) => unit.keEntitlementId ? [[unit.keEntitlementId, unit.unitId] as const] : []));
  const rows = await tx.all<MysqlRow>(
    `SELECT id, resource, quantity, starts_at, expires_at, source, source_ref
       FROM ke_entitlements
      WHERE user_id = ? AND starts_at <= ? AND expires_at > ? AND revoked_at IS NULL
      ORDER BY resource, expires_at, id`,
    [userId, now, now],
  );
  const effective = await queryEntitlements(tx, userId, now);
  return {
    slotUnits,
    entitlements: rows.map((row) => readEntitlement(row, unitIdByEntitlement)),
    effective,
  };
}

function safeCents(value: bigint): string {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('invalid commerce quote total');
  return value.toString();
}

async function insertQuote(tx: CommerceTransaction, record: QuotePersistenceRecord): Promise<string> {
  if (!/^[A-Za-z0-9._-]{1,32}$/u.test(record.pricingVersion) || !/^[a-f0-9]{64}$/u.test(record.requestHash)
    || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
    || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.createdAt) {
    throw new RangeError('invalid commerce quote snapshot');
  }
  if (!await tx.lockUser(record.userId)) throw new Error('commerce user not found');
  await tx.run(
    `INSERT INTO commerce_quotes
       (user_id, pricing_version, currency, request_hash, input_snapshot, preview_snapshot,
        raw_total_cents, tier_total_cents, promo_total_cents, selected_total_cents,
        discount_strategy, promotion_snapshot, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.userId, record.pricingVersion, record.currency, record.requestHash,
      JSON.stringify(record.inputSnapshot), JSON.stringify(record.previewSnapshot),
      safeCents(record.rawTotalCents), safeCents(record.tierTotalCents),
      record.promoTotalCents === null ? null : safeCents(record.promoTotalCents),
      safeCents(record.selectedTotalCents), record.discountStrategy,
      record.promotionSnapshot === null ? null : JSON.stringify(record.promotionSnapshot),
      record.createdAt, record.expiresAt],
  );
  return readLastInsertId(tx);
}

export function createQuoteRepository(database: MysqlDatabase): QuoteRepository {
  const repository = createCommerceRepository(database);
  return {
    readAccount(userId, now) {
      const id = assertCommerceId(userId);
      if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('invalid commerce quote timestamp');
      return repository.transaction((tx) => readAccount(tx, id, now));
    },
    insertQuote(record) {
      return repository.transaction((tx) => insertQuote(tx, record));
    },
  };
}
