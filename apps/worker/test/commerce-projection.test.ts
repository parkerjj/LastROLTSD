import { describe, expect, it } from 'vitest';
import { applyUnitProjection, replayCommerceUnit } from '../src/commerce/projection';
import type { CommerceTransaction } from '../src/commerce/repository';
import type { MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';

const DAY_MS = 24n * 60n * 60n * 1000n;

const emptyBaseline = {
  quantity: 1,
  startsAt: null,
  expiresAt: null,
  adminRevokedAt: null,
  refundZeroedAt: null,
};

class ProjectionTransaction implements CommerceTransaction {
  readonly writes: Array<{ sql: string; values: readonly unknown[] }> = [];

  async lockUser(): Promise<boolean> { return true; }
  async all<T extends MysqlRow>(): Promise<T[]> { return []; }
  async first<T extends MysqlRow>(sql: string): Promise<T | null> {
    if (sql.includes('FROM commerce_units')) return {
      id: '90', user_id: '42', resource: 'slots', ke_entitlement_id: '91',
      admin_revoked_at: null, refund_zeroed_at: null,
    } as unknown as T;
    return null;
  }
  async run(sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> {
    this.writes.push({ sql, values });
    return { affectedRows: 1, insertId: 1 };
  }
}

describe('commerce unit projection replay', () => {
  it('replays a purchase and an admin extension as separate contributions', () => {
    const projection = replayCommerceUnit(emptyBaseline, [
      { unitSeq: 1, eventType: 'PURCHASE', occurredAt: 0n, deliveredAt: 0n, durationMs: 30n * DAY_MS },
      { unitSeq: 2, eventType: 'ADMIN_DELTA', occurredAt: 5n * DAY_MS, durationMs: 5n * DAY_MS },
    ]);

    expect(projection).toMatchObject({ startsAt: 0n, expiresAt: 35n * DAY_MS, quantity: 1 });
  });

  it('keeps the admin contribution when the original purchase is fully refunded', () => {
    const projection = replayCommerceUnit(emptyBaseline, [
      {
        unitSeq: 1,
        eventType: 'PURCHASE',
        occurredAt: 0n,
        deliveredAt: 0n,
        durationMs: 30n * DAY_MS,
        retainedDurationMs: 0n,
      },
      { unitSeq: 2, eventType: 'ADMIN_DELTA', occurredAt: 5n * DAY_MS, durationMs: 5n * DAY_MS },
    ]);

    expect(projection).toMatchObject({ startsAt: 5n * DAY_MS, expiresAt: 10n * DAY_MS, quantity: 1 });
  });

  it('applies successive refund deltas to only the current paid time window', () => {
    const first = replayCommerceUnit(emptyBaseline, [
      { unitSeq: 1, eventType: 'PURCHASE', orderItemId: '801', occurredAt: 0n, deliveredAt: 0n, durationMs: 90n * DAY_MS },
      { unitSeq: 2, eventType: 'PURCHASE', orderItemId: '802', occurredAt: 0n, deliveredAt: 0n, durationMs: 30n * DAY_MS },
      { unitSeq: 3, eventType: 'REFUND_REPROJECT', orderItemId: '801', refundRevision: 1, occurredAt: 1n * DAY_MS, durationMs: -18n * DAY_MS, retainedDurationMs: 72n * DAY_MS },
      { unitSeq: 4, eventType: 'REFUND_REPROJECT', orderItemId: '802', refundRevision: 1, occurredAt: 1n * DAY_MS, durationMs: -6n * DAY_MS, retainedDurationMs: 24n * DAY_MS },
    ]);
    const splitRefunds = replayCommerceUnit(emptyBaseline, [
      { unitSeq: 1, eventType: 'PURCHASE', orderItemId: '801', occurredAt: 0n, deliveredAt: 0n, durationMs: 90n * DAY_MS },
      { unitSeq: 2, eventType: 'PURCHASE', orderItemId: '802', occurredAt: 0n, deliveredAt: 0n, durationMs: 30n * DAY_MS },
      { unitSeq: 3, eventType: 'REFUND_REPROJECT', orderItemId: '801', refundRevision: 1, occurredAt: 1n * DAY_MS, durationMs: -18n * DAY_MS, retainedDurationMs: 72n * DAY_MS },
      { unitSeq: 4, eventType: 'REFUND_REPROJECT', orderItemId: '802', refundRevision: 1, occurredAt: 1n * DAY_MS, durationMs: -6n * DAY_MS, retainedDurationMs: 24n * DAY_MS },
      { unitSeq: 5, eventType: 'REFUND_REPROJECT', orderItemId: '801', refundRevision: 2, occurredAt: 2n * DAY_MS, durationMs: -9n * DAY_MS, retainedDurationMs: 63n * DAY_MS },
      { unitSeq: 6, eventType: 'REFUND_REPROJECT', orderItemId: '802', refundRevision: 2, occurredAt: 2n * DAY_MS, durationMs: -3n * DAY_MS, retainedDurationMs: 21n * DAY_MS },
    ]);

    expect(first.expiresAt).toBe(96n * DAY_MS);
    expect(splitRefunds.expiresAt).toBe(84n * DAY_MS);
  });

  it('restores a failed refund with a positive contribution delta', () => {
    const projection = replayCommerceUnit(emptyBaseline, [
      { unitSeq: 1, eventType: 'PURCHASE', orderItemId: '801', occurredAt: 0n, deliveredAt: 0n, durationMs: 90n * DAY_MS },
      { unitSeq: 2, eventType: 'REFUND_REPROJECT', orderItemId: '801', refundRevision: 1, occurredAt: 1n * DAY_MS, durationMs: -27n * DAY_MS, retainedDurationMs: 63n * DAY_MS },
      { unitSeq: 3, eventType: 'REFUND_REPROJECT', orderItemId: '801', refundRevision: 2, occurredAt: 2n * DAY_MS, durationMs: 27n * DAY_MS, retainedDurationMs: 90n * DAY_MS },
    ]);

    expect(projection.expiresAt).toBe(90n * DAY_MS);
  });

  it('preserves unrelated order and legacy gift time when one purchase is fully refunded', () => {
    const projection = replayCommerceUnit({
      ...emptyBaseline,
      startsAt: 0n,
      expiresAt: 99n * 365n * DAY_MS,
    }, [
      { unitSeq: 1, eventType: 'PURCHASE', orderItemId: '801', occurredAt: 0n, deliveredAt: 0n, durationMs: 90n * DAY_MS },
      { unitSeq: 2, eventType: 'PURCHASE', orderItemId: '802', occurredAt: 0n, deliveredAt: 0n, durationMs: 30n * DAY_MS },
      { unitSeq: 3, eventType: 'REFUND_REPROJECT', orderItemId: '801', refundRevision: 1, occurredAt: DAY_MS, durationMs: -90n * DAY_MS, retainedDurationMs: 0n },
    ]);

    expect(projection.expiresAt).toBe(99n * 365n * DAY_MS + 30n * DAY_MS);
    expect(projection.refundZeroedAt).toBeNull();
  });

  it('clears refund zeroing when a later paid purchase restores the unit', () => {
    const projection = replayCommerceUnit({
      ...emptyBaseline,
      refundZeroedAt: 5n * DAY_MS,
    }, [
      { unitSeq: 1, eventType: 'PURCHASE', occurredAt: 10n * DAY_MS, deliveredAt: 10n * DAY_MS, durationMs: 30n * DAY_MS },
    ]);

    expect(projection).toMatchObject({ startsAt: 10n * DAY_MS, expiresAt: 40n * DAY_MS, refundZeroedAt: null });
  });

  it('starts a positive admin contribution at its occurrence when the old window ended', () => {
    const projection = replayCommerceUnit({
      ...emptyBaseline,
      startsAt: 0n,
      expiresAt: 30n * DAY_MS,
    }, [
      { unitSeq: 1, eventType: 'ADMIN_DELTA', occurredAt: 100n * DAY_MS, durationMs: 30n * DAY_MS },
    ]);

    expect(projection).toMatchObject({ startsAt: 100n * DAY_MS, expiresAt: 130n * DAY_MS });
  });

  it('treats a past absolute admin expiry as a cutoff without creating later time debt', () => {
    const projection = replayCommerceUnit({
      ...emptyBaseline,
      startsAt: 0n,
      expiresAt: 30n * DAY_MS,
    }, [
      { unitSeq: 1, eventType: 'ADMIN_CUTOFF', occurredAt: 100n * DAY_MS, requestedExpiresAt: 50n * DAY_MS },
      { unitSeq: 2, eventType: 'PURCHASE', occurredAt: 101n * DAY_MS, deliveredAt: 101n * DAY_MS, durationMs: 30n * DAY_MS },
    ]);

    expect(projection).toMatchObject({ startsAt: 101n * DAY_MS, expiresAt: 131n * DAY_MS });
  });

  it('does not carry a negative admin adjustment into a later purchase', () => {
    const projection = replayCommerceUnit({
      ...emptyBaseline,
      startsAt: 0n,
      expiresAt: 30n * DAY_MS,
    }, [
      { unitSeq: 1, eventType: 'ADMIN_DELTA', occurredAt: 5n * DAY_MS, durationMs: -40n * DAY_MS },
      { unitSeq: 2, eventType: 'PURCHASE', occurredAt: 100n * DAY_MS, deliveredAt: 100n * DAY_MS, durationMs: 30n * DAY_MS },
    ]);

    expect(projection).toMatchObject({ startsAt: 100n * DAY_MS, expiresAt: 130n * DAY_MS });
  });

  it('applies admin revocation independently from the projected time window', () => {
    const projection = replayCommerceUnit(emptyBaseline, [
      { unitSeq: 1, eventType: 'PURCHASE', occurredAt: 0n, deliveredAt: 0n, durationMs: 30n * DAY_MS },
      { unitSeq: 2, eventType: 'ADMIN_REVOKE', occurredAt: 5n * DAY_MS },
      { unitSeq: 3, eventType: 'ADMIN_RESTORE', occurredAt: 6n * DAY_MS },
    ]);

    expect(projection).toMatchObject({ expiresAt: 30n * DAY_MS, adminRevokedAt: null, refundZeroedAt: null });
  });

  it('updates the existing entitlement projection on renewal instead of inserting an overlapping row', async () => {
    const tx = new ProjectionTransaction();

    await applyUnitProjection(tx, '90', {
      quantity: 1,
      startsAt: 0n,
      expiresAt: 60n * DAY_MS,
      adminRevokedAt: null,
      refundZeroedAt: null,
      appliedAt: 30n * DAY_MS,
    });

    expect(tx.writes.some(({ sql }) => sql.startsWith('UPDATE ke_entitlements SET starts_at'))).toBe(true);
    expect(tx.writes.some(({ sql }) => sql.startsWith('INSERT INTO ke_entitlements'))).toBe(false);
  });

  it('preserves a multi-quantity legacy standalone module projection', async () => {
    const tx = new ProjectionTransaction();

    await applyUnitProjection(tx, '90', {
      quantity: 3,
      startsAt: 0n,
      expiresAt: 60n * DAY_MS,
      adminRevokedAt: null,
      refundZeroedAt: null,
      appliedAt: 30n * DAY_MS,
    });

    const update = tx.writes.find(({ sql }) => sql.startsWith('UPDATE ke_entitlements SET starts_at'));
    expect(update?.values[2]).toBe(3);
  });
});
