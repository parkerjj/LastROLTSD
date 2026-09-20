import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

async function applyCatalogRelease(database: DatabaseSync, inputFile: string, version: string, outputDir: string): Promise<void> {
  const outputPath = resolve('.generated', outputDir);
  await mkdir(outputPath, { recursive: true });
  const result = spawnSync(process.execPath, [
    resolve('scripts/catalog-import.mjs'), '--input-file', inputFile, '--kind', 'items', '--version', version,
    '--encoding', 'utf8', '--output-dir', outputPath,
  ], { cwd: resolve('.'), encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  const manifestPath = join(outputPath, `catalog-items-${version}.manifest.json`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { batchFiles: string[] };
  for (const batchFile of manifest.batchFiles) database.exec(await readFile(join(outputPath, batchFile), 'utf8'));
}

function requestBody(snapshotId: string, mode: 'full' | 'delta' | 'heartbeat', observedAt: string, quantity = 2) {
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
        items: [{ item_key: 'e2e-slot-a', item_id: 1001, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 100, quantity, options: [{ type: 12, value: 60, param: 0 }] }],
      },
      ...(mode === 'full' ? [{
        uuid: '00000000-0000-4000-8000-000000000002', shop_status: 'opening' as const, vendor_account_id: 'e2e-account-b', vendor_name: 'Synthetic Vendor B',
        title: 'Synthetic Shop B', shop_type: 'sell' as const, map_name: 'e2e-map', x: 30, y: 40,
        items: [{ item_key: 'e2e-slot-b', item_id: 1002, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 200, quantity: 1, options: [{ type: 12, value: 40, param: 0 }] }],
      }, {
        uuid: '00000000-0000-4000-8000-000000000003', shop_status: 'opening' as const, vendor_account_id: 'e2e-account-c', vendor_name: 'Synthetic Vendor C',
        title: 'Synthetic Shop C', shop_type: 'sell' as const, map_name: 'e2e-map', x: 50, y: 60,
        items: [{ item_key: 'e2e-slot-c', item_id: 9999, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 300, quantity: 1, options: [{ type: 999, value: 7, param: 3 }] }],
      }] : []),
    ],
  };
}

describe('catalog/import/upload/search end-to-end flow', () => {
  it('runs a real local D1 flow from catalog import through rename and idempotent replay', async () => {
    const database = new DatabaseSync(':memory:');
    const outputDirs = ['e2e-catalog-v1', 'e2e-catalog-v2'];
    const sourceKey = 'e2e-source-key';
    try {
      applyMigrations(database);
      database.prepare('INSERT INTO market_sources(id,name,api_key_hash,created_at) VALUES (?1,?2,?3,?4)').run('e2e-source', 'Synthetic source', await hashApiKey(sourceKey), 0);
      const d1 = new LocalD1(database);
      const app = createApp({ DB: d1 as never, ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024, CURSOR_SECRET: 'e2e-cursor-secret-which-is-long' });
      await applyCatalogRelease(database, resolve('tests/fixtures/catalog-items.json'), 'catalog-e2e-v1', outputDirs[0]!);

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

      const firstPageResponse = await app.request('/api/v1/market/search?q=%E6%B3%A2%E5%88%A9&limit=1&sort=price_asc');
      expect(firstPageResponse.status).toBe(200);
      const firstPage = await firstPageResponse.json() as { items: Array<{ id: number; itemId: number; itemName: string }>; nextCursor: string | null };
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.items[0]).toMatchObject({ itemId: 1001, itemName: '波利帽' });
      expect(firstPage.nextCursor).toBeTruthy();
      const secondPageResponse = await app.request(`/api/v1/market/search?q=%E6%B3%A2%E5%88%A9&limit=1&sort=price_asc&cursor=${encodeURIComponent(firstPage.nextCursor!)}`);
      const secondPage = await secondPageResponse.json() as { items: Array<{ itemId: number }> };
      expect(secondPage.items.map((item) => item.itemId)).toEqual([1002]);

      const optionPage = await app.request('/api/v1/market/search?option=12:gte:50');
      expect((await optionPage.json() as { items: Array<{ itemId: number }> }).items.map((item) => item.itemId)).toEqual([1001]);
      const unknownPage = await app.request('/api/v1/market/search?item_id=9999');
      expect((await unknownPage.json() as { items: Array<{ itemName: string; options: Array<{ display: string }> }> }).items[0]).toMatchObject({ itemName: '未知物品 #9999', options: [{ display: '未知词条 type=999 value=7 param=3' }] });

      const delta = await upload(requestBody('e2e-delta', 'delta', '2026-09-20T10:10:00.000Z', 1));
      expect(delta.status).toBe(202);
      const deltaBody = await delta.json() as { batch_id: string; sold_events: number; duplicate: boolean };
      expect(deltaBody).toMatchObject({ batch_id: 'e2e-delta/0', sold_events: 1, duplicate: false });
      expect(database.prepare('SELECT COUNT(*) AS count FROM sold_events').get()).toEqual({ count: 1 });

      const replay = await upload(requestBody('e2e-delta', 'delta', '2026-09-20T10:10:00.000Z', 1));
      expect(await replay.json()).toMatchObject({ duplicate: true, sold_events: 1 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM sold_events').get()).toEqual({ count: 1 });

      const history = await app.request(`/api/v1/market/listings/${firstPage.items[0]!.id}/history`);
      expect(history.status).toBe(200);
      const historyBody = await history.json() as { items: Array<unknown>; inferredSales: Array<{ soldQuantity: number }> };
      expect(historyBody.items.length).toBeGreaterThanOrEqual(2);
      expect(historyBody.inferredSales[0]).toMatchObject({ soldQuantity: 1 });

      await applyCatalogRelease(database, resolve('tests/fixtures/catalog-items-renamed.json'), 'catalog-e2e-v2', outputDirs[1]!);
      const renamed = await app.request('/api/v1/market/search?item_id=1001');
      const renamedBody = await renamed.json() as { items: Array<{ id: number; itemName: string }> };
      expect(renamedBody.items[0]).toMatchObject({ id: firstPage.items[0]!.id, itemName: '波利帽改名' });
    } finally {
      database.close();
      for (const outputDir of outputDirs) await rm(resolve('.generated', outputDir), { recursive: true, force: true });
    }
  });
});
