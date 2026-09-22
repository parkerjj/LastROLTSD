import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/worker/src/index';
import { createMysqlDatabase, type MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import { hashApiKey } from '../../apps/worker/src/middleware/auth';

const mysqlTestUrl = process.env.MYSQL_TEST_URL;

describe('MySQL upload execution in session-private tables', () => {
  it.skipIf(!mysqlTestUrl)('uploads, updates, retries and dismisses without touching persistent rows', async () => {
    const database = createMysqlDatabase(mysqlTestUrl!);
    try {
      await database.transaction(async (connection) => {
        // MySQL resolves these names to this connection's temporary tables only.
        // Keep every repository transaction on that connection; closing it drops
        // all fixtures even if the test fails. CREATE ... LIKE omits foreign keys.
        for (const table of ['market_sources', 'shops', 'listings', 'listing_options', 'listing_events', 'upload_batches']) {
          // LIKE cannot use the same source and destination name in one statement.
          await connection.run(`CREATE TEMPORARY TABLE diagnostic_schema LIKE ${table}`);
          await connection.run(`CREATE TEMPORARY TABLE ${table} LIKE diagnostic_schema`);
          await connection.run('DROP TEMPORARY TABLE diagnostic_schema');
        }
        const session: MysqlDatabase = {
          ...connection,
          async transaction(work) { return work(session); },
        };
        const key = 'session-private-test-key';
        await session.run('INSERT INTO market_sources(id,name,api_key_hash,status,created_at) VALUES (?,?,?,?,?)',
          ['diagnostic', 'Diagnostic', await hashApiKey(key), 'active', 1]);
        const app = createApp({ ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 512 * 1024 }, session);
        const body = (snapshotId: string, quantity: number, status: 'opening' | 'dismissed' = 'opening') => ({
          protocol_version: 2, client_run_id: 'diagnostic', snapshot_id: snapshotId,
          snapshot_mode: snapshotId === '0' ? 'full' : 'delta', part_index: 0, part_count: 1,
          observed_at: `2026-09-22T10:0${snapshotId}:00Z`,
          shops: [{
            uuid: '00000000-0000-4000-8000-000000000001', shop_status: status,
            vendor_account_id: 'diagnostic', vendor_name: 'Diagnostic', title: 'Diagnostic',
            shop_type: 'sell', map_name: 'diagnostic', x: 1, y: 1,
            items: status === 'dismissed' ? [] : [{ item_id: 501, item_key: 'slot-1', upgrade: 0, slots: 0, cards: [0, 0, 0, 0],
              price: 100, quantity, options: [{ type: 1, value: 1, param: 0 }] }],
          }],
        });
        const upload = async (payload: ReturnType<typeof body>) => {
          const response = await app.request('/api/v1/market/upload', {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': `${payload.snapshot_id}/0` },
            body: JSON.stringify(payload),
          });
          expect(response.status).toBe(202);
          return response.json();
        };
        expect(await upload(body('0', 3))).toMatchObject({ accepted: true, processed_listings: 1, duplicate: false });
        expect(await upload(body('1', 2))).toMatchObject({ accepted: true, changed_listings: 1, sold_events: 1 });
        expect(await upload(body('2', 1))).toMatchObject({ accepted: true, changed_listings: 1, sold_events: 1 });
        expect(await upload(body('2', 1))).toMatchObject({ duplicate: true });
        expect(await session.first('SELECT quantity,state_version FROM listings')).toMatchObject({ quantity: 1, state_version: 2 });
        expect(await session.first('SELECT SUM(sold_quantity) AS sold FROM listing_events')).toMatchObject({ sold: '2' });
        expect(await upload(body('3', 0, 'dismissed'))).toMatchObject({ accepted: true });
        expect(await session.first('SELECT status FROM listings')).toMatchObject({ status: 'expired' });
      });
    } finally {
      await database.close();
    }
  }, 30_000);
});
