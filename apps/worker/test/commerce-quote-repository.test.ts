import { describe, expect, it } from 'vitest';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';
import { createQuoteRepository } from '../src/commerce/quote-repository';
import type { QuotePersistenceRecord } from '../src/commerce/quotes';

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;

class QuoteDatabase implements MysqlDatabase {
  readonly allCalls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly firstCalls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly runCalls: Array<{ sql: string; values: readonly unknown[] }> = [];

  async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    this.allCalls.push({ sql, values });
    if (sql.includes('SELECT u.id AS unit_id')) return [
      {
        unit_id: '11', user_id: '42', resource: 'slots', unit_kind: 'commerce', ke_entitlement_id: '101',
        baseline_source: 'commerce', baseline_source_ref: 'unit:11', baseline_quantity: 1,
        baseline_starts_at: NOW - DAY_MS, baseline_expires_at: NOW + 15 * DAY_MS,
        legacy_origin_id: null, legacy_ordinal: null, admin_revoked_at: null, refund_zeroed_at: null,
        current_quantity: 1, current_starts_at: NOW - DAY_MS, current_expires_at: NOW + 15 * DAY_MS,
      },
    ] as unknown as T[];
    if (sql.includes('signed_total')) return [{ signed_total: '1' }] as unknown as T[];
    if (sql.includes('GROUP BY resource')) return [
      { resource: 'slots', total: 1 }, { resource: 'module:standalone', total: 1 },
    ] as unknown as T[];
    if (sql.includes('SELECT id, resource, quantity, starts_at, expires_at, source, source_ref')) return [
      { id: '101', resource: 'slots', quantity: 1, starts_at: NOW - DAY_MS, expires_at: NOW + 15 * DAY_MS, source: 'commerce', source_ref: 'unit:11' },
      { id: '201', resource: 'slots', quantity: 1, starts_at: NOW - DAY_MS, expires_at: NOW + 99 * 365 * DAY_MS, source: 'signup', source_ref: 'email-verified:slots' },
      { id: '202', resource: 'slots', quantity: -1, starts_at: NOW - DAY_MS, expires_at: NOW + 60 * DAY_MS, source: 'admin', source_ref: null },
      { id: '203', resource: 'module:standalone', quantity: 1, starts_at: NOW - DAY_MS, expires_at: NOW + 3 * DAY_MS, source: 'legacy', source_ref: null },
    ] as unknown as T[];
    return [];
  }

  async first<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T | null> {
    this.firstCalls.push({ sql, values });
    if (sql.includes('LAST_INSERT_ID')) return { id: '501' } as unknown as T;
    if (sql.includes('FROM auth_users')) return { id: '42' } as unknown as T;
    return null;
  }

  async run(sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> {
    this.runCalls.push({ sql, values });
    return { affectedRows: 1, insertId: 501 };
  }

  transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> { return work(this); }
  async healthcheck(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('commerce quote repository', () => {
  it('normalizes slot rows under the account lock and reads only active entitlement rows', async () => {
    const database = new QuoteDatabase();
    const repository = createQuoteRepository(database);
    const state = await repository.readAccount('42', NOW);

    expect(state.slotUnits.map((unit) => unit.unitId)).toEqual(['11']);
    expect(state.entitlements.map((row) => row.id)).toEqual(['101', '201', '202', '203']);
    expect(state.entitlements.find((row) => row.id === '201')).toMatchObject({ source: 'signup', quantity: 1 });
    expect(state.entitlements.find((row) => row.id === '202')?.quantity).toBe(-1);
    expect(state.effective).toMatchObject({ slots: 1 });
    expect(state.effective.modules.has('standalone')).toBe(true);
    expect(database.firstCalls.some((call) => call.sql.includes('SELECT id FROM auth_users') && call.sql.includes('FOR UPDATE'))).toBe(true);
    const rowsQuery = database.allCalls.find((call) => call.sql.includes('SELECT id, resource, quantity, starts_at, expires_at, source, source_ref'));
    expect(rowsQuery?.sql).toContain('starts_at <= ? AND expires_at > ? AND revoked_at IS NULL');
    expect(rowsQuery?.values).toEqual(['42', NOW, NOW]);
  });

  it('persists the immutable quote inputs, preview snapshots, prices, version, and expiry', async () => {
    const database = new QuoteDatabase();
    const repository = createQuoteRepository(database);
    const record: QuotePersistenceRecord = {
      userId: '42', pricingVersion: 'ke-commerce-v1', currency: 'CNY', requestHash: 'a'.repeat(64),
      inputSnapshot: { selection: [{ type: 'slot_add', quantity: 1, termDays: 30 }] },
      previewSnapshot: { items: [{ ordinal: 1, expectedExpiresAt: String(NOW + 30 * DAY_MS) }], accountPreview: { before: [], after: [] } },
      rawTotalCents: 5000n, tierTotalCents: 5000n, promoTotalCents: null, selectedTotalCents: 5000n,
      discountStrategy: 'term', promotionSnapshot: null, createdAt: NOW, expiresAt: NOW + 120_000,
    };

    await expect(repository.insertQuote(record)).resolves.toBe('501');
    const insert = database.runCalls[0]!;
    expect(insert.sql).toContain('INSERT INTO commerce_quotes');
    expect(insert.values).toEqual([
      '42', 'ke-commerce-v1', 'CNY', 'a'.repeat(64), JSON.stringify(record.inputSnapshot), JSON.stringify(record.previewSnapshot),
      '5000', '5000', null, '5000', 'term', null, NOW, NOW + 120_000,
    ]);
  });
});
