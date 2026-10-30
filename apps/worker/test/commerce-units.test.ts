import { describe, expect, it } from 'vitest';
import { normalizeLegacySlotUnits } from '../src/commerce/units';
import type { CommerceTransaction } from '../src/commerce/repository';
import type { MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';

interface EntitlementFixture {
  id: string;
  user_id: string;
  resource: string;
  quantity: number;
  starts_at: number;
  expires_at: number;
  source: string;
  source_ref: string | null;
  actor_user_id: string | null;
  note: string | null;
  revoked_at: number | null;
  created_at: number;
}

interface UnitFixture {
  id: string;
  user_id: string;
  resource: string;
  unit_kind: string;
  ke_entitlement_id: string | null;
  baseline_source: string | null;
  baseline_source_ref: string | null;
  baseline_quantity: number;
  baseline_starts_at: number | null;
  baseline_expires_at: number | null;
  legacy_origin_id: string | null;
  legacy_ordinal: number | null;
  admin_revoked_at: number | null;
  refund_zeroed_at: number | null;
};

class FakeCommerceStore implements CommerceTransaction {
  readonly calls: string[] = [];
  readonly entitlements: EntitlementFixture[];
  readonly units: UnitFixture[] = [];
  private nextId = 100;
  private lastInsertId = '0';

  constructor(entitlements: EntitlementFixture[]) {
    this.entitlements = entitlements.map((row) => ({ ...row }));
  }

  async lockUser(userId: string): Promise<boolean> {
    this.calls.push('lock-user');
    return userId === '42';
  }

  async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    this.calls.push(sql);
    const userId = String(values[0] ?? '42');
    const now = Number(values[1] ?? 0);

    if (sql.includes('AS signed_total')) {
      const total = this.activeEntitlements(userId, now).filter((row) => row.resource === 'slots')
        .reduce((sum, row) => sum + row.quantity, 0);
      return [{ signed_total: String(total) } as unknown as T];
    }
    if (sql.includes('SUM(quantity) AS total')) {
      const grouped = new Map<string, number>();
      for (const row of this.activeEntitlements(userId, now)) grouped.set(row.resource, (grouped.get(row.resource) ?? 0) + row.quantity);
      return [...grouped].map(([resource, total]) => ({ resource, total }) as unknown as T);
    }
    if (sql.includes('FROM ke_entitlements e')) {
      return this.activeEntitlements(userId, now)
        .filter((row) => row.resource === 'slots')
        .filter((row) => row.quantity > 0)
        .filter((row) => !(row.source === 'signup' && row.source_ref === 'email-verified:slots'))
        .filter((row) => !this.units.some((unit) => unit.ke_entitlement_id === row.id)) as unknown as T[];
    }
    if (sql.includes('FROM commerce_units u')) {
      return this.units.filter((unit) => unit.user_id === userId && unit.resource === 'slots')
        .map((unit) => ({ ...unit, entitlement: this.entitlements.find((row) => row.id === unit.ke_entitlement_id) }))
        .filter(({ entitlement }) => entitlement && entitlement.revoked_at === null && entitlement.starts_at <= now && entitlement.expires_at > now)
        .map(({ entitlement, ...unit }) => ({
          ...unit,
          unit_id: unit.id,
          current_quantity: entitlement!.quantity,
          current_starts_at: entitlement!.starts_at,
          current_expires_at: entitlement!.expires_at,
        })) as unknown as T[];
    }
    return [];
  }

  async first<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T | null> {
    this.calls.push(sql);
    if (sql.includes('LAST_INSERT_ID')) return { id: this.lastInsertId } as unknown as T;
    if (sql.includes('FROM auth_users')) return { id: values[0] } as unknown as T;
    return null;
  }

  async run(sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> {
    this.calls.push(sql);
    if (sql.includes('INSERT INTO commerce_units')) {
      const [user_id, ke_entitlement_id, baseline_source, baseline_source_ref, baseline_starts_at,
        baseline_expires_at, legacy_origin_id, legacy_ordinal] = values;
      const id = String(this.nextId++);
      this.lastInsertId = id;
      this.units.push({
        id, user_id: String(user_id), resource: 'slots', unit_kind: 'legacy',
        ke_entitlement_id: ke_entitlement_id === null ? null : String(ke_entitlement_id),
        baseline_source: baseline_source === null ? null : String(baseline_source),
        baseline_source_ref: baseline_source_ref === null ? null : String(baseline_source_ref),
        baseline_quantity: 1, baseline_starts_at: Number(baseline_starts_at),
        baseline_expires_at: Number(baseline_expires_at), legacy_origin_id: legacy_origin_id === null ? null : String(legacy_origin_id),
        legacy_ordinal: legacy_ordinal === null ? null : Number(legacy_ordinal), admin_revoked_at: null, refund_zeroed_at: null,
      });
    } else if (sql.includes('INSERT INTO ke_entitlements')) {
      const [user_id, starts_at, expires_at, source_ref, actor_user_id, note, created_at] = values;
      const id = String(this.nextId++);
      this.lastInsertId = id;
      this.entitlements.push({
        id, user_id: String(user_id), resource: 'slots', quantity: 1, starts_at: Number(starts_at),
        expires_at: Number(expires_at), source: 'commerce', source_ref: String(source_ref),
        actor_user_id: actor_user_id === null ? null : String(actor_user_id), note: note === null ? null : String(note),
        revoked_at: null, created_at: Number(created_at),
      });
    } else if (sql.includes('UPDATE commerce_units SET ke_entitlement_id')) {
      const [entitlementId, _updatedAt, unitId] = values;
      const unit = this.units.find((entry) => entry.id === String(unitId));
      if (unit) unit.ke_entitlement_id = String(entitlementId);
    } else if (sql.includes('UPDATE ke_entitlements SET revoked_at')) {
      const [revokedAt, entitlementId] = values;
      const row = this.entitlements.find((entry) => entry.id === String(entitlementId));
      if (row) row.revoked_at = Number(revokedAt);
    }
    return { affectedRows: 1, insertId: this.nextId - 1 };
  }

  private activeEntitlements(userId: string, now: number): EntitlementFixture[] {
    return this.entitlements.filter((row) => row.user_id === userId && row.starts_at <= now && row.expires_at > now && row.revoked_at === null);
  }

  activeSlotTotal(userId: string, now: number): number {
    return this.activeEntitlements(userId, now).filter((row) => row.resource === 'slots').reduce((total, row) => total + row.quantity, 0);
  }
}

class SerializedCommerceStore extends FakeCommerceStore {
  private lockTail: Promise<void> = Promise.resolve();
  private releaseCurrentLock: (() => void) | null = null;

  override async lockUser(userId: string): Promise<boolean> {
    this.calls.push('lock-user');
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.releaseCurrentLock = release;
    return userId === '42';
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } finally {
      const release = this.releaseCurrentLock;
      this.releaseCurrentLock = null;
      release?.();
    }
  }
}

function entitlement(overrides: Partial<EntitlementFixture> = {}): EntitlementFixture {
  return {
    id: '9', user_id: '42', resource: 'slots', quantity: 6, starts_at: 1_700_000_000_000,
    expires_at: 1_900_000_000_000, source: 'admin', source_ref: 'legacy-grant', actor_user_id: '2',
    note: null, revoked_at: null, created_at: 1_700_000_000_000, ...overrides,
  };
}

describe('legacy slot unit normalization', () => {
  it('splits a positive quantity row into independent units without changing signed or effective totals', async () => {
    const row = entitlement();
    const store = new FakeCommerceStore([row]);
    const activeBefore = store.activeSlotTotal('42', 1_800_000_000_000);

    const units = await normalizeLegacySlotUnits(store, '42', 1_800_000_000_000n);

    expect(units).toHaveLength(6);
    expect(new Set(units.map((unit) => unit.unitId)).size).toBe(6);
    expect(units.map((unit) => unit.legacyOrdinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(units.every((unit) => unit.legacyOriginId === '9' && unit.baselineQuantity === 1)).toBe(true);
    expect(store.entitlements.filter((entry) => entry.id !== row.id)).toHaveLength(6);
    expect(store.entitlements.find((entry) => entry.id === row.id)?.revoked_at).toBe(1_800_000_000_000);
    expect(store.entitlements.filter((entry) => entry.id !== row.id).every((entry) => entry.quantity === 1 && entry.expires_at === row.expires_at)).toBe(true);
    expect(store.activeSlotTotal('42', 1_800_000_000_000)).toBe(activeBefore);
    expect(activeBefore).toBe(6);
    expect(store.calls[0]).toBe('lock-user');
  });

  it('rejects normalization above the account unit limit before mutating entitlement rows', async () => {
    const store = new FakeCommerceStore([entitlement({ quantity: 1001 })]);

    await expect(normalizeLegacySlotUnits(store, '42', 1_800_000_000_000n)).rejects.toThrow('commerce unit limit exceeded');
    expect(store.units).toEqual([]);
    expect(store.entitlements[0]?.revoked_at).toBeNull();
  });

  it('keeps the exact signup gift, negative adjustments, expired rows, and future rows outside sale units', async () => {
    const now = 1_800_000_000_000;
    const store = new FakeCommerceStore([
      entitlement({ id: '1', quantity: 1, source: 'signup', source_ref: 'email-verified:slots', expires_at: now + 99 * 365 * 24 * 60 * 60 * 1000 }),
      entitlement({ id: '2', quantity: -1 }),
      entitlement({ id: '3', quantity: 2, expires_at: now }),
      entitlement({ id: '4', quantity: 2, starts_at: now + 1 }),
      entitlement({ id: '5', quantity: 1, source: 'signup', source_ref: null }),
    ]);

    const units = await normalizeLegacySlotUnits(store, '42', BigInt(now));

    expect(units).toHaveLength(1);
    expect(units[0]?.legacyOriginId).toBe('5');
    expect(store.units).toHaveLength(1);
    expect(store.calls.find((sql) => sql.includes('FROM ke_entitlements e'))).toContain('e.source_ref IS NULL');
    expect(store.entitlements.every((entry) => entry.revoked_at === null)).toBe(true);
  });

  it('links quantity-one rows in place and returns the same units on repeated normalization', async () => {
    const store = new FakeCommerceStore([entitlement({ quantity: 1 })]);

    const first = await normalizeLegacySlotUnits(store, '42', 1_800_000_000_000n);
    const second = await normalizeLegacySlotUnits(store, '42', 1_800_000_000_000n);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.unitId).toBe(second[0]?.unitId);
    expect(first[0]?.keEntitlementId).toBe('9');
    expect(store.entitlements).toHaveLength(1);
    expect(store.units).toHaveLength(1);
  });

  it('serializes concurrent normalization through the account lock so rows are adopted once', async () => {
    const store = new SerializedCommerceStore([entitlement()]);

    const results = await Promise.all([
      store.transaction(() => normalizeLegacySlotUnits(store, '42', 1_800_000_000_000n)),
      store.transaction(() => normalizeLegacySlotUnits(store, '42', 1_800_000_000_000n)),
    ]);

    expect(results.map((units) => units.length)).toEqual([6, 6]);
    expect(store.units).toHaveLength(6);
    expect(store.entitlements.filter((entry) => entry.id !== '9')).toHaveLength(6);
  });

  it('rejects a missing user before selecting entitlements', async () => {
    const store = new FakeCommerceStore([]);

    await expect(normalizeLegacySlotUnits(store, '99', 1_800_000_000_000n)).rejects.toThrow('commerce user not found');
    expect(store.calls).toEqual(['lock-user']);
  });
});
