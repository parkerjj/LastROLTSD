import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/worker/src/index';
import { hashApiKey } from '../../apps/worker/src/middleware/auth';

class LocalStatement {
  private values: unknown[] = [];

  constructor(private readonly database: DatabaseSync, public readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values as never[]) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.values as never[]) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values as never[]);
    return { meta: { changes: Number(result.changes ?? 0) } };
  }
}

class LocalD1 {
  constructor(public readonly database: DatabaseSync) {}

  prepare(sql: string): LocalStatement {
    return new LocalStatement(this.database, sql);
  }

  async batch(statements: LocalStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec('BEGIN');
    try {
      const results: Array<{ meta: { changes: number } }> = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function applyMigrations(database: DatabaseSync): void {
  for (const name of readdirSync(resolve('migrations')).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
    database.exec(readFileSync(resolve('migrations', name), 'utf8'));
  }
}

function requestBody(snapshotId: string, mode: 'full' | 'delta' | 'heartbeat', observedAt: string, quantity = 2, missingShopUuids: string[] = []) {
  const shouldInclude = (uuid: string) => !missingShopUuids.includes(uuid);
  return {
    protocol_version: 2,
    client_run_id: 'e2e-run',
    snapshot_id: snapshotId,
    snapshot_mode: mode,
    part_index: 0,
    part_count: 1,
    observed_at: observedAt,
    shops: mode === 'heartbeat' ? [{
      uuid: '00000000-0000-4000-8000-000000000001', shop_status: 'opening', vendor_account_id: 'e2e-account-a', vendor_name: 'Synthetic Vendor A',
      title: 'Synthetic Shop A', shop_type: 'sell', map_name: 'e2e-map', x: 10, y: 20, items: [],
    }] : [
      {
        uuid: '00000000-0000-4000-8000-000000000001', shop_status: 'opening', vendor_account_id: 'e2e-account-a', vendor_name: 'Synthetic Vendor A',
        title: 'Synthetic Shop A', shop_type: 'sell', map_name: 'e2e-map', x: 10, y: 20,
        items: shouldInclude('00000000-0000-4000-8000-000000000001') ? [{ item_key: 'e2e-slot-a', item_id: 4001, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 100, quantity, options: [{ type: 12, value: 60, param: 0 }] }] : [],
      },
      ...(mode === 'full' ? [{
        uuid: '00000000-0000-4000-8000-000000000002', shop_status: 'opening' as const, vendor_account_id: 'e2e-account-b', vendor_name: 'Synthetic Vendor B',
        title: '利卡特价', shop_type: 'sell' as const, map_name: 'e2e-map', x: 30, y: 40,
        items: shouldInclude('00000000-0000-4000-8000-000000000002') ? [{ item_key: 'e2e-slot-b', item_id: 1002, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 200, quantity: 1, options: [{ type: 12, value: 40, param: 0 }] }] : [],
      }, {
        uuid: '00000000-0000-4000-8000-000000000003', shop_status: 'opening' as const, vendor_account_id: 'e2e-account-c',
        title: 'Synthetic Shop C', shop_type: 'sell' as const, map_name: 'e2e-map', x: 50, y: 60,
        vendor_name: '杰利卡',
        items: shouldInclude('00000000-0000-4000-8000-000000000003') ? [{ item_key: 'e2e-slot-c', item_id: 9999, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 300, quantity: 1, options: [{ type: 999, value: 7, param: 3 }] }] : [],
      }] : []),
    ],
  };
}

describe('catalog/import/upload/search end-to-end flow', () => {
  it('runs a real local D1 flow through upload, search, transitions, replay, and reconciliation', async () => {
    const database = new DatabaseSync(':memory:');
    const sourceKey = 'e2e-source-key';
    try {
      applyMigrations(database);
      database.prepare('INSERT INTO market_sources(id,name,api_key_hash,created_at) VALUES (?1,?2,?3,?4)').run('e2e-source', 'Synthetic source', await hashApiKey(sourceKey), 0);
      const d1 = new LocalD1(database);
      const app = createApp({ DB: d1 as never, ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024, CURSOR_SECRET: 'e2e-cursor-secret-which-is-long' });
      const upload = async (body: ReturnType<typeof requestBody>) => app.request('/api/v1/market/upload', {
        method: 'POST',
        headers: { authorization: `Bearer ${sourceKey}`, 'content-type': 'application/json', 'idempotency-key': `${body.snapshot_id}/0` },
        body: JSON.stringify(body),
      });
      const full = await upload(requestBody('e2e-full', 'full', '2026-09-20T10:00:00.000Z'));
      expect(full.status).toBe(202);
      expect(await full.json()).toMatchObject({ accepted: true, duplicate: false, processed_listings: 3, sold_events: 0 });

      const heartbeat = await upload(requestBody('e2e-heartbeat', 'heartbeat', '2026-09-20T10:05:00.000Z'));
      expect(heartbeat.status).toBe(202);
      expect(await heartbeat.json()).toMatchObject({ processed_listings: 0, changed_listings: 0, sold_events: 0 });

      const firstPageResponse = await app.request('/api/v1/market/search?item_ids=4001&q=%E5%88%A9%E5%8D%A1&limit=2&sort=price_asc');
      expect(firstPageResponse.status).toBe(200);
      const firstPage = await firstPageResponse.json() as { items: Array<{ id: number; itemId: number; itemName?: string; title: string; vendorName: string }>; nextCursor: string | null };
      expect(firstPage.items.map((item) => item.itemId)).toEqual([4001, 1002]);
      expect(firstPage.items[0]?.itemName).toBeUndefined();
      expect(firstPage.items[1]).toMatchObject({ title: '利卡特价' });
      expect(firstPage.nextCursor).toBeTruthy();
      const secondPageResponse = await app.request(`/api/v1/market/search?item_ids=4001&q=%E5%88%A9%E5%8D%A1&limit=2&sort=price_asc&cursor=${encodeURIComponent(firstPage.nextCursor!)}`);
      const secondPage = await secondPageResponse.json() as { items: Array<{ itemId: number }> };
      expect(secondPage.items.map((item) => item.itemId)).toEqual([9999]);

      const optionPage = await app.request('/api/v1/market/search?item_id=4001&option_type=12&option_value=60&option_param=0');
      expect((await optionPage.json() as { items: Array<{ itemId: number }> }).items.map((item) => item.itemId)).toEqual([4001]);
      const unknownPage = await app.request('/api/v1/market/search?item_id=9999');
      expect((await unknownPage.json() as { items: Array<{ itemId: number; itemName?: string; options: Array<{ display: string }> }> }).items[0]).toMatchObject({ itemId: 9999, options: [{ display: expect.stringContaining('type=999') }] });

      const delta = await upload(requestBody('e2e-delta', 'delta', '2026-09-20T10:10:00.000Z', 1));
      expect(delta.status).toBe(202);
      const deltaBody = await delta.json() as { batch_id: string; sold_events: number; duplicate: boolean };
      expect(deltaBody).toMatchObject({ batch_id: 'e2e-delta/0', sold_events: 1, duplicate: false });
      expect(database.prepare('SELECT COUNT(*) AS count FROM listing_events WHERE sold_quantity > 0').get()).toEqual({ count: 1 });

      const replay = await upload(requestBody('e2e-delta', 'delta', '2026-09-20T10:10:00.000Z', 1));
      expect(await replay.json()).toMatchObject({ duplicate: true, sold_events: 1 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM listing_events WHERE sold_quantity > 0').get()).toEqual({ count: 1 });

      const history = await app.request(`/api/v1/market/listings/${firstPage.items[0]!.id}/history`);
      expect(history.status).toBe(200);
      const historyBody = await history.json() as { items: Array<unknown>; inferredSales: Array<{ soldQuantity: number }> };
      expect(historyBody.items.length).toBeGreaterThanOrEqual(2);
      expect(historyBody.inferredSales[0]).toMatchObject({ soldQuantity: 1 });

      const missingOne = await upload(requestBody('e2e-missing-1', 'full', '2026-09-20T10:20:00.000Z', 1, ['00000000-0000-4000-8000-000000000002']));
      expect(missingOne.status).toBe(202);
      const missingTwo = await upload(requestBody('e2e-missing-2', 'full', '2026-09-20T10:25:00.000Z', 1, ['00000000-0000-4000-8000-000000000002']));
      expect(missingTwo.status).toBe(202);
      expect(database.prepare('SELECT status,missing_full_count FROM listings WHERE item_id=1002').get()).toEqual({ status: 'missing', missing_full_count: 2 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM listing_events WHERE event_type='missing'").get()).toEqual({ count: 1 });

      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toEqual(['listing_events', 'listing_options', 'listings', 'market_sources', 'shops', 'upload_batches']);
    } finally {
      database.close();
    }
  });
});
