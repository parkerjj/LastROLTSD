import type { CommerceTransaction } from './repository';
import { assertCommerceId, readLastInsertId } from './repository';
import type { MysqlRow } from '../db/mysql-client';

export type CommerceUnitEventType = 'BASELINE' | 'PURCHASE' | 'ADMIN_DELTA' | 'ADMIN_CUTOFF' | 'ADMIN_REVOKE' | 'ADMIN_RESTORE' | 'REFUND_REPROJECT';

export interface CommerceUnitBaseline {
  quantity: number;
  startsAt: bigint | null;
  expiresAt: bigint | null;
  adminRevokedAt: bigint | null;
  refundZeroedAt: bigint | null;
}

export interface CommerceUnitEvent {
  unitSeq: number;
  eventType: CommerceUnitEventType;
  orderItemId?: string | null;
  refundRevision?: number | null;
  occurredAt: bigint;
  deliveredAt?: bigint | null;
  durationMs?: bigint;
  retainedDurationMs?: bigint;
  requestedExpiresAt?: bigint;
}

export interface UnitProjection extends CommerceUnitBaseline {
  appliedAt?: bigint;
}

export interface AdminEntitlementChange {
  userId: string;
  entitlementId: string;
  actorUserId: string;
  requestId: string;
  occurredAt: bigint;
  beforeExpiresAt: bigint;
  afterExpiresAt: bigint;
  beforeRevokedAt: bigint | null;
  afterRevokedAt: bigint | null;
}

const MAX_SAFE_MILLIS = BigInt(Number.MAX_SAFE_INTEGER);

function mysqlMillis(value: bigint, field: string): number {
  if (value < 0n || value > MAX_SAFE_MILLIS) throw new RangeError(`invalid commerce ${field}`);
  const timestamp = Number(value);
  if (BigInt(timestamp) !== value) throw new RangeError(`invalid commerce ${field}`);
  return timestamp;
}

function nullableBigint(value: unknown): bigint | null {
  return value === null || value === undefined ? null : BigInt(value as string | number | bigint);
}

function serializeAdminChange(change: AdminEntitlementChange): Record<string, string | null> {
  return {
    actorUserId: change.actorUserId,
    requestId: change.requestId,
    beforeExpiresAt: change.beforeExpiresAt.toString(),
    afterExpiresAt: change.afterExpiresAt.toString(),
    beforeRevokedAt: change.beforeRevokedAt?.toString() ?? null,
    afterRevokedAt: change.afterRevokedAt?.toString() ?? null,
  };
}

export function replayCommerceUnit(baseline: CommerceUnitBaseline, events: readonly CommerceUnitEvent[]): UnitProjection {
  let startsAt = baseline.startsAt;
  let expiresAt = baseline.expiresAt;
  let adminRevokedAt = baseline.adminRevokedAt;
  let refundZeroedAt = baseline.refundZeroedAt;
  const orderedEvents = [...events].sort((left, right) => left.unitSeq - right.unitSeq);
  const retainedDurations = new Map<string, bigint>();
  let zeroedByRefundAt: bigint | null = null;

  for (const event of orderedEvents) {
    if (event.eventType !== 'REFUND_REPROJECT') continue;
    if (event.orderItemId && event.retainedDurationMs !== undefined) {
      retainedDurations.set(event.orderItemId, event.retainedDurationMs);
      if (event.retainedDurationMs === 0n) zeroedByRefundAt = event.occurredAt;
      else zeroedByRefundAt = null;
    }
  }

  for (const event of orderedEvents) {
    if (event.eventType === 'REFUND_REPROJECT') continue;
    if (event.eventType === 'PURCHASE') {
      const duration = (event.orderItemId ? retainedDurations.get(event.orderItemId) : undefined)
        ?? event.retainedDurationMs ?? event.durationMs ?? 0n;
      if (duration <= 0n) continue;
      const deliveredAt = event.deliveredAt ?? event.occurredAt;
      if (startsAt === null || expiresAt === null || expiresAt <= deliveredAt) {
        startsAt = deliveredAt;
        expiresAt = deliveredAt + duration;
      } else {
        expiresAt += duration;
      }
      refundZeroedAt = null;
      continue;
    }

    if (event.eventType === 'ADMIN_DELTA') {
      const delta = event.durationMs ?? 0n;
      if (delta > 0n) {
        if (startsAt === null || expiresAt === null || expiresAt < event.occurredAt) {
          startsAt = event.occurredAt;
          expiresAt = event.occurredAt + delta;
        } else {
          expiresAt += delta;
        }
        refundZeroedAt = null;
      } else if (delta < 0n && startsAt !== null && expiresAt !== null && expiresAt > event.occurredAt) {
        const nextExpiry = expiresAt + delta;
        if (nextExpiry <= startsAt) {
          startsAt = null;
          expiresAt = null;
        } else {
          expiresAt = nextExpiry;
        }
      }
      continue;
    }

    if (event.eventType === 'ADMIN_CUTOFF') {
      const requestedExpiresAt = event.requestedExpiresAt ?? event.occurredAt;
      if (startsAt !== null && expiresAt !== null && expiresAt > event.occurredAt) {
        if (startsAt < event.occurredAt) expiresAt = event.occurredAt;
        else { startsAt = null; expiresAt = null; }
      } else if (requestedExpiresAt < (expiresAt ?? requestedExpiresAt)) {
        expiresAt = requestedExpiresAt;
      }
      continue;
    }

    if (event.eventType === 'ADMIN_REVOKE') adminRevokedAt = event.occurredAt;
    else if (event.eventType === 'ADMIN_RESTORE') adminRevokedAt = null;
  }

  if (startsAt === null && expiresAt === null && zeroedByRefundAt !== null) {
    refundZeroedAt = zeroedByRefundAt;
  }

  return { quantity: baseline.quantity, startsAt, expiresAt, adminRevokedAt, refundZeroedAt };
}

export async function applyUnitProjection(tx: CommerceTransaction, unitId: string, projection: UnitProjection): Promise<void> {
  if (!Number.isSafeInteger(projection.quantity) || projection.quantity <= 0) {
    throw new RangeError('commerce unit quantity must be positive');
  }
  if ((projection.startsAt === null) !== (projection.expiresAt === null)) throw new RangeError('incomplete commerce unit window');
  if (projection.startsAt !== null && projection.expiresAt !== null && projection.expiresAt <= projection.startsAt) {
    throw new RangeError('invalid commerce unit window');
  }
  const id = assertCommerceId(unitId);
  const unit = await tx.first<MysqlRow>(
    'SELECT id, user_id, resource, ke_entitlement_id FROM commerce_units WHERE id = ? FOR UPDATE', [id],
  );
  if (!unit) throw new Error('commerce unit not found');

  const userId = assertCommerceId(String(unit.user_id));
  const resource = String(unit.resource);
  const entitlementId = unit.ke_entitlement_id === null || unit.ke_entitlement_id === undefined
    ? null
    : assertCommerceId(String(unit.ke_entitlement_id));
  const appliedAt = mysqlMillis(projection.appliedAt ?? BigInt(Date.now()), 'projection timestamp');
  const hasWindow = projection.startsAt !== null && projection.expiresAt !== null;
  const marker = projection.adminRevokedAt ?? projection.refundZeroedAt;
  const revokedAt = marker === null ? (hasWindow ? null : BigInt(appliedAt)) : marker;

  let nextEntitlementId = entitlementId;
  if (entitlementId !== null) {
    if (hasWindow) {
      await tx.run(
        'UPDATE ke_entitlements SET starts_at = ?, expires_at = ?, quantity = ?, revoked_at = ? WHERE id = ?',
        [mysqlMillis(projection.startsAt!, 'projection start'), mysqlMillis(projection.expiresAt!, 'projection expiry'),
          projection.quantity, revokedAt === null ? null : mysqlMillis(revokedAt, 'revocation timestamp'), entitlementId],
      );
    } else {
      await tx.run(
        'UPDATE ke_entitlements SET quantity = ?, revoked_at = ? WHERE id = ?',
        [projection.quantity, revokedAt === null ? null : mysqlMillis(revokedAt, 'revocation timestamp'), entitlementId],
      );
    }
  } else if (hasWindow) {
    await tx.run(
      `INSERT INTO ke_entitlements
         (user_id, resource, quantity, starts_at, expires_at, source, source_ref, actor_user_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, 'commerce', ?, NULL, NULL, ?)`,
      [userId, resource, projection.quantity, mysqlMillis(projection.startsAt!, 'projection start'),
        mysqlMillis(projection.expiresAt!, 'projection expiry'), `unit:${id}`, appliedAt],
    );
    nextEntitlementId = await readLastInsertId(tx);
  }

  await tx.run(
    'UPDATE commerce_units SET ke_entitlement_id = ?, admin_revoked_at = ?, refund_zeroed_at = ?, updated_at = ? WHERE id = ?',
    [nextEntitlementId, projection.adminRevokedAt === null ? null : mysqlMillis(projection.adminRevokedAt, 'admin revocation'),
      projection.refundZeroedAt === null ? null : mysqlMillis(projection.refundZeroedAt, 'refund zeroing'), appliedAt, id],
  );
}

async function appendAdminEvent(
  tx: CommerceTransaction,
  unitId: string,
  unitSeq: number,
  eventType: 'ADMIN_DELTA' | 'ADMIN_CUTOFF' | 'ADMIN_REVOKE' | 'ADMIN_RESTORE',
  change: AdminEntitlementChange,
  durationMs: bigint,
): Promise<void> {
  await tx.run(
    `INSERT INTO commerce_unit_events
       (unit_id, unit_seq, event_type, before_expires_at, after_expires_at, occurred_at, duration_ms, dedupe_key, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [unitId, unitSeq, eventType, change.beforeExpiresAt, change.afterExpiresAt, change.occurredAt, durationMs,
      `admin:${unitId}:${unitSeq}`, JSON.stringify(serializeAdminChange(change)), mysqlMillis(change.occurredAt, 'admin event timestamp')],
  );
}

export async function recordAdminEntitlementChange(tx: CommerceTransaction, change: AdminEntitlementChange): Promise<void> {
  const userId = assertCommerceId(change.userId);
  const entitlementId = assertCommerceId(change.entitlementId);
  const row = await tx.first<MysqlRow>(
    `SELECT id, admin_revoked_at, refund_zeroed_at
       FROM commerce_units
      WHERE user_id = ? AND ke_entitlement_id = ? FOR UPDATE`,
    [userId, entitlementId],
  );
  if (!row) return;
  const unitId = assertCommerceId(String(row.id));
  const refundZeroedAt = nullableBigint(row.refund_zeroed_at);
  const maxSeqRow = await tx.first<MysqlRow>(
    'SELECT COALESCE(MAX(unit_seq), 0) AS unit_seq FROM commerce_unit_events WHERE unit_id = ?', [unitId],
  );
  let unitSeq = Number(maxSeqRow?.unit_seq ?? 0);
  if (!Number.isSafeInteger(unitSeq) || unitSeq < 0) throw new RangeError('invalid commerce event sequence');

  if (change.afterExpiresAt !== change.beforeExpiresAt) {
    if (change.afterExpiresAt <= change.occurredAt) {
      unitSeq += 1;
      await appendAdminEvent(tx, unitId, unitSeq, 'ADMIN_CUTOFF', change, 0n);
    } else {
      const delta = change.afterExpiresAt - (change.beforeExpiresAt > change.occurredAt ? change.beforeExpiresAt : change.occurredAt);
      if (delta !== 0n) {
        unitSeq += 1;
        await appendAdminEvent(tx, unitId, unitSeq, 'ADMIN_DELTA', change, delta);
      }
    }
  }

  if (change.beforeRevokedAt !== change.afterRevokedAt) {
    const eventType = change.afterRevokedAt === null ? 'ADMIN_RESTORE' : 'ADMIN_REVOKE';
    unitSeq += 1;
    await appendAdminEvent(tx, unitId, unitSeq, eventType, change, 0n);
    await tx.run(
      'UPDATE commerce_units SET admin_revoked_at = ?, updated_at = ? WHERE id = ?',
      [change.afterRevokedAt === null ? null : mysqlMillis(change.afterRevokedAt, 'admin revocation'),
        mysqlMillis(change.occurredAt, 'admin event timestamp'), unitId],
    );
  }

  if (change.afterRevokedAt === null && refundZeroedAt !== null) {
    await tx.run('UPDATE ke_entitlements SET revoked_at = ? WHERE id = ?', [mysqlMillis(refundZeroedAt, 'refund zeroing'), entitlementId]);
  }
}
