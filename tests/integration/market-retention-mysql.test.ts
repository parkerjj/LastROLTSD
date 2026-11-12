import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMysqlDatabase, type MysqlDatabase } from '../../apps/worker/src/db/mysql-client';
import { runMarketRetention } from '../../apps/worker/src/db/market-retention';
import { runRetention } from '../../apps/worker/src/services/retention';
import { createMysqlRepository } from '../../apps/worker/src/db/mysql-repository';
import { createUploadHandler } from '../../apps/worker/src/services/upload-handler';
import { createSnapshotRepository } from '../../apps/worker/src/db/snapshot-repository';

const DAY = 86_400_000;
const now = 100 * DAY;
const cutoff = 70 * DAY;
const mysqlTestUrl = process.env.MYSQL_TEST_URL;
const foreignKeys = process.env.MARKET_RETENTION_TEST_FOREIGN_KEYS === '1';

async function fixtures(work: (db: MysqlDatabase) => Promise<void>): Promise<void> {
  if (!new URL(mysqlTestUrl!).pathname.toLowerCase().endsWith('_test')) throw new Error('market retention tests require a database ending in _test');
  const url = new URL(mysqlTestUrl!);
  if (foreignKeys && (url.hostname !== '127.0.0.1' || url.pathname !== '/ltsd_retention_test')) throw new Error('foreign-key fixtures require the isolated local ltsd_retention_test database');
  const database = createMysqlDatabase(mysqlTestUrl!);
  try {
    await database.transaction(async (connection) => {
      for (const table of foreignKeys ? [] : ['market_sources', 'shops', 'listings', 'listing_options', 'listing_events', 'upload_batches', 'market_snapshots', 'market_snapshot_shops', 'market_snapshot_listings', 'guestbook_rate_limits']) {
        await connection.run(`CREATE TEMPORARY TABLE retention_schema LIKE ${table}`);
        await connection.run(`CREATE TEMPORARY TABLE ${table} LIKE retention_schema`);
        await connection.run('DROP TEMPORARY TABLE retention_schema');
      }
      if (foreignKeys && await connection.first("SELECT id FROM market_sources WHERE id = 'source'")) throw new Error('foreign-key fixtures require an unused synthetic source');
      if (!(await connection.first("SHOW COLUMNS FROM market_sources LIKE 'retention_cutoff_at'"))) {
        const migration = await readFile(new URL('../../migrations/mysql/031_market_retention.sql', import.meta.url), 'utf8');
        for (const statement of migration.split(';').map((part) => part.trim()).filter(Boolean)) await connection.run(statement);
      }
      const db: MysqlDatabase = { ...connection, async transaction(callback) { return callback(db); } };
      await db.run("INSERT INTO market_sources(id,name,api_key_hash,created_at,last_full_snapshot_id) VALUES ('source','Test',?,1,'latest')", ['a'.repeat(64)]);
      try { await work(db); }
      finally { if (foreignKeys) await db.run("DELETE FROM market_sources WHERE id = 'source'"); }
    });
  } finally { await database.close(); }
}

async function shop(db: MysqlDatabase, id: number, status: string, at: number): Promise<void> {
  await db.run(`INSERT INTO shops(id,source_id,identity_hash,public_shop_id,vendor_account_id,shop_type,status,profile_hash,last_status_observed_at,last_changed_at,last_inventory_observed_at)
    VALUES (?,'source',?,?,'vendor','sell',?,'profile',?,?,?)`, [id, String(id).padStart(64, '0'), `shop-${id}`, status, at, at, at]);
}
async function listing(db: MysqlDatabase, id: number, shopId: number, status: string, at: number): Promise<void> {
  await db.run(`INSERT INTO listings(id,shop_id,item_fingerprint,item_id,price,quantity,status,first_seen_at,last_changed_at,last_changed_snapshot_id)
    VALUES (?,?,?,501,100,1,?,1,?,'old')`, [id, shopId, String(id).padStart(64, '0'), status, at]);
}
async function snapshot(db: MysqlDatabase, id: string, status: string, at: number): Promise<void> {
  await db.run(`INSERT INTO market_snapshots(source_id,snapshot_id,client_run_id,observed_at,part_count,status,available_at,created_at,completed_at)
    VALUES ('source',?,'run',?,1,?,?,?,?)`, [id, at, status, at, at, status === 'complete' ? at : null]);
}
async function batch(db: MysqlDatabase, id: string, at: number, status = 'accepted'): Promise<void> {
  await db.run(`INSERT INTO upload_batches(source_id,batch_id,snapshot_id,part_index,part_count,snapshot_mode,payload_hash,status,shop_ids_json,shop_hashes_json,received_at,completed_at)
    VALUES ('source',?,?,0,1,'full','hash',?,'[]','[]',?,?)`, [`${id}/0`, id, status, at, at]);
}

describe.skipIf(!mysqlTestUrl)(`market retention × MySQL (${foreignKeys ? 'real foreign keys' : 'session-private tables'})`, () => {
  it('deletes only expired history, inactive listings and empty inactive shops, preserving the exact boundary', async () => {
    await fixtures(async (db) => {
      for (const [id, status, at] of [[1, 'closed', cutoff - 1], [2, 'active', cutoff - 1], [3, 'closed', cutoff], [4, 'closed', cutoff - 1]] as const) await shop(db, id, status, at);
      await listing(db, 1, 1, 'expired', cutoff - 1);
      await listing(db, 2, 2, 'active', cutoff - 1);
      await listing(db, 3, 3, 'expired', cutoff);
      await listing(db, 4, 4, 'expired', cutoff - 1);
      for (const [id, at] of [[1, cutoff - 1], [3, cutoff], [4, cutoff + 1]]) {
        await db.run("INSERT INTO listing_events(listing_id,snapshot_id,observed_at,event_type,to_price,to_quantity,transition_key) VALUES (?,'old',?,'first_seen',100,1,?)", [id, at, `event-${id}`]);
      }
      await db.run('INSERT INTO listing_options VALUES (1,0,1,2,3)');
      const history = await runRetention(now, {}, createMysqlRepository(db));
      expect(history.historyDeleted).toBe(1);
      const result = await runMarketRetention(now, db);
      expect(result).toMatchObject({ listingsDeleted: 1, shopsDeleted: 1, listingOptionsDeleted: 1, cutoff });
      expect((await db.all('SELECT id FROM shops ORDER BY id')).map((row) => Number(row.id))).toEqual([2, 3, 4]);
      expect((await db.all('SELECT id FROM listings ORDER BY id')).map((row) => Number(row.id))).toEqual([2, 3, 4]);
      expect(await db.first('SELECT retention_cutoff_at FROM market_sources')).toMatchObject({ retention_cutoff_at: cutoff });
    });
  });

  it('purges terminal snapshots child-first and old receipts, keeping recent, processing and latest full receipts', async () => {
    await fixtures(async (db) => {
      for (const id of ['old', 'latest']) { await snapshot(db, id, 'complete', cutoff - 1); await batch(db, id, cutoff - 1); }
      await snapshot(db, 'recent', 'complete', cutoff);
      await batch(db, 'recent', cutoff);
      await batch(db, 'processing', cutoff - 1, 'processing');
      await db.run(`INSERT INTO market_snapshot_shops(source_id,snapshot_id,ordinal,identity_hash,public_shop_id,shop_json,items_json,content_hash,item_count)
        VALUES ('source','old',1,'identity','public','{}','[]','content',0)`);
      await db.run("INSERT INTO market_snapshot_listings VALUES ('source','old',1,'fingerprint')");
      const result = await runMarketRetention(now, db);
      expect(result).toMatchObject({ snapshotListingsDeleted: 1, snapshotShopsDeleted: 1, snapshotsDeleted: 1, uploadBatchesDeleted: 1 });
      expect((await db.all('SELECT snapshot_id FROM market_snapshots ORDER BY snapshot_id')).map((row) => row.snapshot_id)).toEqual(['latest', 'recent']);
      expect((await db.all('SELECT snapshot_id FROM upload_batches ORDER BY snapshot_id')).map((row) => row.snapshot_id)).toEqual(['latest', 'processing', 'recent']);
    });
  });

  it.each(['receiving', 'queued', 'running'])('preserves sources with a %s full snapshot and their upload acceptance window', async (status) => {
    await fixtures(async (db) => {
      await shop(db, 1, 'closed', cutoff - 1);
      await snapshot(db, 'pending', status, cutoff - 1);
      await runMarketRetention(now, db);
      expect(await db.first('SELECT id FROM shops')).not.toBeNull();
      expect(await db.first('SELECT retention_cutoff_at FROM market_sources')).toMatchObject({ retention_cutoff_at: 0 });
    });
  });

  it('bounds work and rejects stale full/delta replays after receipts have been removed', async () => {
    await fixtures(async (db) => {
      for (let id = 1; id <= 3; id++) await shop(db, id, 'closed', cutoff - 1);
      expect((await runMarketRetention(now, db, { chunkSize: 2, maxChunks: 1 })).shopsDeleted).toBe(2);
      expect((await db.all('SELECT id FROM shops')).length).toBe(1);
      const handler = createUploadHandler(db, { ENVIRONMENT: 'test', BUILD_VERSION: 'test', MAX_BODY_BYTES: 524288 });
      for (const mode of ['full', 'delta', 'heartbeat'] as const) {
        await expect(handler({ id: 'source', name: 'Test', apiKeyHash: '', tokenHash: '', status: 'active' }, {
          protocol_version: 2, client_run_id: 'run', snapshot_id: 'replayed', snapshot_mode: mode,
          part_index: 0, part_count: 1, observed_at: new Date(cutoff - 1).toISOString(), shops: [],
        }, 'replayed/0')).rejects.toMatchObject({ status: 422, code: 'snapshot_expired', action: 'new_snapshot' });
      }
      expect(await db.first('SELECT batch_id FROM upload_batches')).toBeNull();
      expect(await db.first('SELECT snapshot_id FROM market_snapshots')).toBeNull();
    });
  });

  it.each([false, true])('clears full-upload payloads on completion while retaining retry receipts (superseded: %s)', async (superseded) => {
    await fixtures(async (db) => {
      await snapshot(db, 'finish', 'running', cutoff);
      await batch(db, 'finish', cutoff);
      await db.run("UPDATE upload_batches SET payload_json = '{}', response_json = '{}' WHERE snapshot_id = 'finish'");
      await db.run("UPDATE market_sources SET active_full_snapshot_id = 'finish'");
      if (superseded) await db.run('UPDATE market_sources SET last_full_snapshot_at = ?', [cutoff + 1]);
      await db.run("UPDATE market_snapshots SET lease_token = 'lease', accepted_parts = 1 WHERE snapshot_id = 'finish'");
      await createSnapshotRepository(db).process({ sourceId: 'source', snapshotId: 'finish', generation: 0,
        stage: 'finalize', cursor: 0, observedAt: cutoff, clientRunId: 'run', partCount: 1, leaseToken: 'lease', attempts: 0 },
      async () => ({ stage: 'finalize', cursor: 0, complete: true, processed: 0 }), now);
      expect(await db.first("SELECT payload_json, payload_hash, response_json FROM upload_batches WHERE snapshot_id = 'finish'"))
        .toMatchObject({ payload_json: null, payload_hash: 'hash', response_json: '{}' });
    });
  });

  it('clears payloads when an obsolete queued snapshot completes without being processed', async () => {
    await fixtures(async (db) => {
      await snapshot(db, 'obsolete', 'queued', cutoff);
      await batch(db, 'obsolete', cutoff);
      await db.run("UPDATE upload_batches SET payload_json = '{}' WHERE snapshot_id = 'obsolete'");
      await db.run('UPDATE market_sources SET last_full_snapshot_at = ?', [cutoff + 1]);
      expect(await createSnapshotRepository(db).claim(now)).toBeNull();
      expect(await db.first("SELECT payload_json FROM upload_batches WHERE snapshot_id = 'obsolete'"))
        .toMatchObject({ payload_json: null });
    });
  });

  it('does not requeue failed snapshots before the retention watermark', async () => {
    await fixtures(async (db) => {
      await db.run('UPDATE market_sources SET retention_cutoff_at = ?', [cutoff]);
      await snapshot(db, 'expired', 'failed', cutoff - 1);
      await snapshot(db, 'boundary', 'failed', cutoff);
      await db.run('UPDATE market_snapshots SET accepted_parts = part_count');
      expect(await createSnapshotRepository(db).requeue('source', 'expired', now)).toBe(false);
      expect(await createSnapshotRepository(db).requeue('source', 'boundary', now)).toBe(true);
    });
  });

  it('drains full receipt batches within the configured work budget', async () => {
    await fixtures(async (db) => {
      for (let index = 0; index < 7; index++) await batch(db, `expired-${index}`, cutoff - 1);
      expect((await runMarketRetention(now, db, { chunkSize: 2, maxChunks: 2 })).uploadBatchesDeleted).toBe(4);
      expect((await db.all('SELECT batch_id FROM upload_batches')).length).toBe(3);
      expect((await runMarketRetention(now, db, { chunkSize: 2 })).uploadBatchesDeleted).toBe(3);
    });
  });

  it.each(['complete', 'failed'])('cleans old inactive goods in a live shop unless its %s snapshot needs them', async (status) => {
    await fixtures(async (db) => {
      await shop(db, 1, 'active', now);
      await listing(db, 1, 1, 'expired', cutoff - 1);
      await listing(db, 2, 1, 'active', cutoff - 1);
      await snapshot(db, 'latest', status, cutoff + 1);
      await db.run(`INSERT INTO market_snapshot_shops(source_id,snapshot_id,ordinal,identity_hash,public_shop_id,shop_json,items_json,content_hash,item_count,shop_id)
        VALUES ('source','latest',1,?,'shop-1','{}','[]','content',0,1)`, ['1'.padStart(64, '0')]);
      await runMarketRetention(now, db);
      expect((await db.all('SELECT id FROM listings ORDER BY id')).map((row) => Number(row.id)))
        .toEqual(status === 'complete' ? [2] : [1, 2]);
      expect(await db.first('SELECT id FROM shops')).toMatchObject({ id: 1 });
    });
  });
});
