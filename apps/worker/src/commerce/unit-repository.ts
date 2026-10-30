import type { CommerceTransaction } from './repository';
import { assertCommerceId, readLastInsertId } from './repository';
import type { MysqlRow } from '../db/mysql-client';

export type CommerceUnitKind = 'commerce' | 'legacy';

export interface CommerceUnit {
  unitId: string;
  userId: string;
  resource: string;
  unitKind: CommerceUnitKind;
  keEntitlementId: string | null;
  baselineSource: string | null;
  baselineSourceRef: string | null;
  baselineQuantity: number;
  baselineStartsAt: bigint | null;
  baselineExpiresAt: bigint | null;
  legacyOriginId: string | null;
  legacyOrdinal: number | null;
  adminRevokedAt: bigint | null;
  refundZeroedAt: bigint | null;
  currentQuantity: number;
  currentStartsAt: bigint;
  currentExpiresAt: bigint;
}

export interface LegacySlotEntitlement {
  id: string;
  userId: string;
  quantity: number;
  startsAt: bigint;
  expiresAt: bigint;
  source: string;
  sourceRef: string | null;
  actorUserId: string | null;
  note: string | null;
  createdAt: bigint;
}

function safeNumber(value: unknown, field: string): number {
  const number = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError(`invalid commerce ${field}`);
  return number;
}

function safeMillis(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`invalid commerce ${field}`);
  const number = Number(value);
  if (BigInt(number) !== value) throw new RangeError(`invalid commerce ${field}`);
  return number;
}

function readBigint(value: unknown, field: string): bigint {
  if (value === null || value === undefined) throw new TypeError(`missing commerce ${field}`);
  try {
    return BigInt(value as string | number | bigint);
  } catch {
    throw new TypeError(`invalid commerce ${field}`);
  }
}

function readNullableBigint(value: unknown, field: string): bigint | null {
  return value === null || value === undefined ? null : readBigint(value, field);
}

function readNullableId(value: unknown): string | null {
  return value === null || value === undefined ? null : assertCommerceId(String(value));
}

function readNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function readUnit(row: MysqlRow): CommerceUnit {
  const unitKind = String(row.unit_kind);
  if (unitKind !== 'legacy' && unitKind !== 'commerce') throw new TypeError('invalid commerce unit kind');
  return {
    unitId: assertCommerceId(String(row.unit_id)),
    userId: assertCommerceId(String(row.user_id)),
    resource: String(row.resource),
    unitKind,
    keEntitlementId: readNullableId(row.ke_entitlement_id),
    baselineSource: readNullableString(row.baseline_source),
    baselineSourceRef: readNullableString(row.baseline_source_ref),
    baselineQuantity: safeNumber(row.baseline_quantity, 'baseline quantity'),
    baselineStartsAt: readNullableBigint(row.baseline_starts_at, 'baseline start'),
    baselineExpiresAt: readNullableBigint(row.baseline_expires_at, 'baseline expiry'),
    legacyOriginId: readNullableId(row.legacy_origin_id),
    legacyOrdinal: row.legacy_ordinal === null || row.legacy_ordinal === undefined ? null : safeNumber(row.legacy_ordinal, 'legacy ordinal'),
    adminRevokedAt: readNullableBigint(row.admin_revoked_at, 'admin revocation'),
    refundZeroedAt: readNullableBigint(row.refund_zeroed_at, 'refund zeroing'),
    currentQuantity: safeNumber(row.current_quantity, 'current quantity'),
    currentStartsAt: readBigint(row.current_starts_at, 'current start'),
    currentExpiresAt: readBigint(row.current_expires_at, 'current expiry'),
  };
}

export async function readActiveSlotUnits(tx: CommerceTransaction, userId: string, now: number): Promise<CommerceUnit[]> {
  const rows = await tx.all<MysqlRow>(
    `SELECT u.id AS unit_id, u.user_id, u.resource, u.unit_kind, u.ke_entitlement_id,
            u.baseline_source, u.baseline_source_ref, u.baseline_quantity, u.baseline_starts_at, u.baseline_expires_at,
            u.legacy_origin_id, u.legacy_ordinal, u.admin_revoked_at, u.refund_zeroed_at,
            e.quantity AS current_quantity, e.starts_at AS current_starts_at, e.expires_at AS current_expires_at
       FROM commerce_units u
       JOIN ke_entitlements e ON e.id = u.ke_entitlement_id
      WHERE u.user_id = ? AND u.resource = 'slots'
        AND e.starts_at <= ? AND e.expires_at > ? AND e.revoked_at IS NULL
      ORDER BY u.id FOR UPDATE`,
    [assertCommerceId(userId), now, now],
  );
  return rows.map(readUnit);
}

export async function readUnlinkedLegacySlotRows(tx: CommerceTransaction, userId: string, now: number): Promise<LegacySlotEntitlement[]> {
  const rows = await tx.all<MysqlRow>(
    `SELECT e.id, e.user_id, e.quantity, e.starts_at, e.expires_at, e.source, e.source_ref,
            e.actor_user_id, e.note, e.created_at
       FROM ke_entitlements e
      WHERE e.user_id = ? AND e.resource = 'slots' AND e.quantity > 0
        AND e.starts_at <= ? AND e.expires_at > ? AND e.revoked_at IS NULL
        AND (e.source <> 'signup' OR e.source_ref IS NULL OR e.source_ref <> 'email-verified:slots')
        AND NOT EXISTS (SELECT 1 FROM commerce_units u WHERE u.ke_entitlement_id = e.id)
      ORDER BY e.id FOR UPDATE`,
    [assertCommerceId(userId), now, now],
  );
  return rows.map((row) => ({
    id: assertCommerceId(String(row.id)),
    userId: assertCommerceId(String(row.user_id)),
    quantity: safeNumber(row.quantity, 'legacy quantity'),
    startsAt: readBigint(row.starts_at, 'legacy start'),
    expiresAt: readBigint(row.expires_at, 'legacy expiry'),
    source: String(row.source),
    sourceRef: readNullableString(row.source_ref),
    actorUserId: readNullableId(row.actor_user_id),
    note: readNullableString(row.note),
    createdAt: readBigint(row.created_at, 'legacy created at'),
  }));
}

export async function readActiveSignedSlotTotal(tx: CommerceTransaction, userId: string, now: number): Promise<bigint> {
  const rows = await tx.all<MysqlRow>(
    `SELECT CAST(COALESCE(SUM(quantity), 0) AS CHAR) AS signed_total
       FROM ke_entitlements
      WHERE user_id = ? AND resource = 'slots' AND starts_at <= ? AND expires_at > ? AND revoked_at IS NULL`,
    [assertCommerceId(userId), now, now],
  );
  return BigInt(String(rows[0]?.signed_total ?? '0'));
}

export async function insertLegacyCommerceUnit(tx: CommerceTransaction, row: LegacySlotEntitlement, now: number, ordinal: number, linkedEntitlementId: string | null): Promise<string> {
  await tx.run(
    `INSERT INTO commerce_units
       (user_id, resource, unit_kind, ke_entitlement_id, baseline_source, baseline_source_ref,
        baseline_quantity, baseline_starts_at, baseline_expires_at, legacy_origin_id, legacy_ordinal, created_at, updated_at)
     VALUES (?, 'slots', 'legacy', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    [row.userId, linkedEntitlementId, row.source, row.sourceRef, safeMillis(row.startsAt, 'legacy start'),
      safeMillis(row.expiresAt, 'legacy expiry'), row.id, ordinal, now, now],
  );
  return readLastInsertId(tx);
}

export async function insertLegacySlotProjection(tx: CommerceTransaction, row: LegacySlotEntitlement, unitId: string, now: number): Promise<string> {
  await tx.run(
    `INSERT INTO ke_entitlements
       (user_id, resource, quantity, starts_at, expires_at, source, source_ref, actor_user_id, note, created_at)
     VALUES (?, 'slots', 1, ?, ?, 'commerce', ?, ?, ?, ?)`,
    [row.userId, safeMillis(row.startsAt, 'legacy start'), safeMillis(row.expiresAt, 'legacy expiry'),
      `unit:${unitId}`, row.actorUserId, row.note, now],
  );
  return readLastInsertId(tx);
}

export async function linkCommerceUnitEntitlement(tx: CommerceTransaction, unitId: string, entitlementId: string, now: number): Promise<void> {
  await tx.run('UPDATE commerce_units SET ke_entitlement_id = ?, updated_at = ? WHERE id = ?', [entitlementId, now, unitId]);
}

export async function revokeLegacySlotRow(tx: CommerceTransaction, entitlementId: string, now: number): Promise<void> {
  const result = await tx.run('UPDATE ke_entitlements SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [now, entitlementId]);
  if (result.affectedRows !== 1) throw new Error('legacy entitlement changed during normalization');
}

export async function insertBaselineEvent(tx: CommerceTransaction, unitId: string, row: LegacySlotEntitlement, now: number, ordinal: number): Promise<void> {
  await tx.run(
    `INSERT INTO commerce_unit_events
       (unit_id, unit_seq, event_type, after_starts_at, after_expires_at, occurred_at, duration_ms, dedupe_key, detail_json, created_at)
     VALUES (?, 1, 'BASELINE', ?, ?, ?, 0, ?, ?, ?)`,
    [unitId, safeMillis(row.startsAt, 'legacy start'), safeMillis(row.expiresAt, 'legacy expiry'), now, `legacy-baseline:${unitId}`,
      JSON.stringify({ legacyOriginId: row.id, legacyOrdinal: ordinal, source: row.source, sourceRef: row.sourceRef }), now],
  );
}
