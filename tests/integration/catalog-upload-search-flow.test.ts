import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/worker/src/index';
import { createMysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import { hashApiKey } from '../../apps/worker/src/middleware/auth';

const mysqlTestUrl = process.env.MYSQL_TEST_URL;
const mysqlIntegration = mysqlTestUrl && process.env.ALLOW_MYSQL_TEST_DESTRUCTIVE === '1' ? it : it.skip;

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
        uuid: '00000000-0000-4000-8000-000000000003', shop_status: 'opening' as const, vendor_account_id: 'e2e-account-c', vendor_name: '杰利卡',
        title: 'Synthetic Shop C', shop_type: 'sell' as const, map_name: 'e2e-map', x: 50, y: 60,
        items: shouldInclude('00000000-0000-4000-8000-000000000003') ? [{ item_key: 'e2e-slot-c', item_id: 9999, upgrade: 0, slots: 0, cards: [0, 0, 0, 0], price: 300, quantity: 1, options: [{ type: 999, value: 7, param: 3 }] }] : [],
      }] : []),
    ],
  };
}

describe('catalog/import/upload/search end-to-end flow', () => {
  mysqlIntegration('runs the Worker flow against an explicitly enabled MySQL test database', async () => {
    const database = createMysqlDatabase(mysqlTestUrl!);
    const sourceId = `mysql-e2e-${crypto.randomUUID()}`;
    const sourceKey = crypto.randomUUID();
    let sourceCreated = false;
    try {
      await database.run(
        'INSERT INTO market_sources(id,name,api_key_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        [sourceId, 'Synthetic MySQL source', await hashApiKey(sourceKey), 'active', Date.now(), Date.now()],
      );
      sourceCreated = true;
      const app = createApp({ MYSQL_URL: mysqlTestUrl!, ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024, CURSOR_SECRET: 'e2e-cursor-secret-which-is-long' }, database);
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
      const firstPage = await firstPageResponse.json() as { items: Array<{ id: number; itemId: number; title: string }>; nextCursor: string | null };
      expect(firstPage.items.map((item) => item.itemId)).toEqual([4001, 1002]);
      expect(firstPage.items[1]).toMatchObject({ title: '利卡特价' });
      expect(firstPage.nextCursor).toBeTruthy();

      const optionPage = await app.request('/api/v1/market/search?item_id=4001&option_type=12&option_value=60&option_param=0');
      expect((await optionPage.json() as { items: Array<{ itemId: number }> }).items.map((item) => item.itemId)).toEqual([4001]);

      const delta = await upload(requestBody('e2e-delta', 'delta', '2026-09-20T10:10:00.000Z', 1));
      expect(delta.status).toBe(202);
      expect(await delta.json()).toMatchObject({ batch_id: 'e2e-delta/0', sold_events: 1, duplicate: false });
      const soldEvents = await database.first<{ count: number }>(
        'SELECT COUNT(*) AS count FROM listing_events AS e INNER JOIN listings AS l ON l.id=e.listing_id INNER JOIN shops AS s ON s.id=l.shop_id WHERE s.source_id=? AND e.sold_quantity > 0',
        [sourceId],
      );
      expect(Number(soldEvents?.count)).toBe(1);

      const replay = await upload(requestBody('e2e-delta', 'delta', '2026-09-20T10:10:00.000Z', 1));
      expect(await replay.json()).toMatchObject({ duplicate: true, sold_events: 1 });

      const history = await app.request(`/api/v1/market/listings/${firstPage.items[0]!.id}/history`);
      expect(history.status).toBe(200);
      const historyBody = await history.json() as { items: Array<unknown>; inferredSales: Array<{ soldQuantity: number }> };
      expect(historyBody.items.length).toBeGreaterThanOrEqual(2);
      expect(historyBody.inferredSales[0]).toMatchObject({ soldQuantity: 1 });

      await expect(upload(requestBody('e2e-missing-1', 'full', '2026-09-20T10:20:00.000Z', 1, ['00000000-0000-4000-8000-000000000002']))).resolves.toMatchObject({ status: 202 });
      await expect(upload(requestBody('e2e-missing-2', 'full', '2026-09-20T10:25:00.000Z', 1, ['00000000-0000-4000-8000-000000000002']))).resolves.toMatchObject({ status: 202 });
      const missing = await database.first<{ status: string; missing_full_count: number }>(
        'SELECT l.status,l.missing_full_count FROM listings AS l INNER JOIN shops AS s ON s.id=l.shop_id WHERE s.source_id=? AND l.item_id=?',
        [sourceId, 1002],
      );
      expect(missing).toMatchObject({ status: 'missing', missing_full_count: 2 });
    } finally {
      if (sourceCreated) await database.run('DELETE FROM market_sources WHERE id=?', [sourceId]);
      await database.close();
    }
  });
});
