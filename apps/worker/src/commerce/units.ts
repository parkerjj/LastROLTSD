import { queryEntitlements } from '../ke/entitlements';
import type { CommerceTransaction } from './repository';
import { assertCommerceId } from './repository';
import {
  insertBaselineEvent,
  insertLegacyCommerceUnit,
  insertLegacySlotProjection,
  linkCommerceUnitEntitlement,
  readActiveSignedSlotTotal,
  readActiveSlotUnits,
  readUnlinkedLegacySlotRows,
  revokeLegacySlotRow,
  type CommerceUnit,
} from './unit-repository';

const MAX_COMMERCE_UNITS = 1000;
const MAX_SAFE_MILLIS = BigInt(Number.MAX_SAFE_INTEGER);

function mysqlMillis(value: bigint): number {
  if (value < 0n || value > MAX_SAFE_MILLIS) throw new RangeError('invalid commerce timestamp');
  const timestamp = Number(value);
  if (BigInt(timestamp) !== value) throw new RangeError('invalid commerce timestamp');
  return timestamp;
}

function sameEffectiveEntitlements(a: { slots: number; modules: ReadonlySet<string> }, b: { slots: number; modules: ReadonlySet<string> }): boolean {
  if (a.slots !== b.slots || a.modules.size !== b.modules.size) return false;
  for (const module of a.modules) if (!b.modules.has(module)) return false;
  return true;
}

export async function normalizeLegacySlotUnits(tx: CommerceTransaction, userId: string, now: bigint): Promise<CommerceUnit[]> {
  const id = assertCommerceId(userId);
  const at = mysqlMillis(now);
  if (!await tx.lockUser(id)) throw new Error('commerce user not found');

  const existing = await readActiveSlotUnits(tx, id, at);
  const candidates = await readUnlinkedLegacySlotRows(tx, id, at);
  const pendingUnitCount = candidates.reduce((total, row) => total + row.quantity, 0);
  if (existing.length + pendingUnitCount > MAX_COMMERCE_UNITS) throw new RangeError('commerce unit limit exceeded');

  const signedBefore = await readActiveSignedSlotTotal(tx, id, at);
  const effectiveBefore = await queryEntitlements(tx, id, at);

  for (const row of candidates) {
    if (row.quantity === 1) {
      const unitId = await insertLegacyCommerceUnit(tx, row, at, 1, row.id);
      await insertBaselineEvent(tx, unitId, row, at, 1);
      continue;
    }

    for (let ordinal = 1; ordinal <= row.quantity; ordinal += 1) {
      const unitId = await insertLegacyCommerceUnit(tx, row, at, ordinal, null);
      const entitlementId = await insertLegacySlotProjection(tx, row, unitId, at);
      await linkCommerceUnitEntitlement(tx, unitId, entitlementId, at);
      await insertBaselineEvent(tx, unitId, row, at, ordinal);
    }
    await revokeLegacySlotRow(tx, row.id, at);
  }

  const signedAfter = await readActiveSignedSlotTotal(tx, id, at);
  const effectiveAfter = await queryEntitlements(tx, id, at);
  if (signedAfter !== signedBefore || !sameEffectiveEntitlements(effectiveBefore, effectiveAfter)) {
    throw new Error('legacy entitlement normalization changed effective access');
  }

  return readActiveSlotUnits(tx, id, at);
}
