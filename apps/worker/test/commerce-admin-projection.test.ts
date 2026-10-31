import { describe, expect, it } from 'vitest';
import { recordAdminEntitlementChange, type AdminEntitlementChange } from '../src/commerce/projection';
import type { CommerceTransaction } from '../src/commerce/repository';
import type { MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';

const DAY_MS = 24n * 60n * 60n * 1000n;

class RecordingTransaction implements CommerceTransaction {
  readonly writes: Array<{ sql: string; values: readonly unknown[] }> = [];
  unitRow: MysqlRow | null = { id: '90', admin_revoked_at: null, refund_zeroed_at: null };
  seq = 4;

  async lockUser(): Promise<boolean> {
    return true;
  }

  async all<T extends MysqlRow>(): Promise<T[]> {
    return [];
  }

  async first<T extends MysqlRow>(sql: string): Promise<T | null> {
    if (sql.includes('FROM commerce_units')) return this.unitRow as T | null;
    if (sql.includes('MAX(unit_seq)')) return { unit_seq: this.seq } as unknown as T;
    return null;
  }

  async run(sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> {
    this.writes.push({ sql, values });
    return { affectedRows: 1, insertId: 1 };
  }
}

function change(overrides: Partial<AdminEntitlementChange> = {}): AdminEntitlementChange {
  return {
    userId: '42', entitlementId: '91', actorUserId: '7', requestId: 'request-1', occurredAt: 100n * DAY_MS,
    beforeExpiresAt: 30n * DAY_MS, afterExpiresAt: 130n * DAY_MS, beforeRevokedAt: null, afterRevokedAt: null,
    ...overrides,
  };
}

describe('admin changes recorded for commerce units', () => {
  it('replays only the effective extension after an old window has ended', async () => {
    const tx = new RecordingTransaction();

    await recordAdminEntitlementChange(tx, change());

    const event = tx.writes.find(({ sql }) => sql.includes('INSERT INTO commerce_unit_events'));
    expect(event?.values).toEqual(expect.arrayContaining([
      '90', 5, 'ADMIN_DELTA', 30n * DAY_MS,
    ]));
    expect(event?.values[4]).toBe(130n * DAY_MS);
  });

  it('records a past requested expiry as a cutoff and preserves admin revocation separately', async () => {
    const tx = new RecordingTransaction();

    await recordAdminEntitlementChange(tx, change({
      afterExpiresAt: 50n * DAY_MS,
      beforeRevokedAt: null,
      afterRevokedAt: 100n * DAY_MS,
    }));

    expect(tx.writes.some(({ sql, values }) => sql.includes('INSERT INTO commerce_unit_events')
      && values.includes('ADMIN_CUTOFF') && values.includes(0n))).toBe(true);
    expect(tx.writes.some(({ sql, values }) => sql.includes('UPDATE commerce_units SET admin_revoked_at')
      && values.includes(Number(100n * DAY_MS)))).toBe(true);
    expect(tx.writes.filter(({ sql }) => sql.includes('INSERT INTO commerce_unit_events'))).toHaveLength(2);
  });

  it('does not restore a refund-zeroed entitlement when an admin clears their revocation', async () => {
    const tx = new RecordingTransaction();
    tx.unitRow = { id: '90', admin_revoked_at: 90n * DAY_MS, refund_zeroed_at: 80n * DAY_MS };

    await recordAdminEntitlementChange(tx, change({
      beforeRevokedAt: 90n * DAY_MS,
      afterRevokedAt: null,
    }));

    expect(tx.writes.some(({ sql, values }) => sql.includes('UPDATE ke_entitlements SET revoked_at')
      && values[0] === Number(80n * DAY_MS))).toBe(true);
    expect(tx.writes.some(({ sql, values }) => sql.includes('UPDATE commerce_units SET admin_revoked_at')
      && values[0] === null)).toBe(true);
  });

  it('does nothing for an entitlement not yet adopted as a commerce unit', async () => {
    const tx = new RecordingTransaction();
    tx.unitRow = null;

    await recordAdminEntitlementChange(tx, change());

    expect(tx.writes).toEqual([]);
  });
});
