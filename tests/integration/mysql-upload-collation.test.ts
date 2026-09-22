import { describe, expect, it } from 'vitest';
import { createMysqlDatabase, type MysqlDatabase, type MysqlRow } from '../../apps/worker/src/db/mysql-client';
import { createMysqlRepository } from '../../apps/worker/src/db/mysql-repository';

const mysqlTestUrl = process.env.MYSQL_TEST_URL;

describe('MySQL upload SQL (read-only)', () => {
  it.skipIf(!mysqlTestUrl)('executes and reuses the prepared locking read for listing transitions', async () => {
    const database = createMysqlDatabase(mysqlTestUrl!);
    try {
      const repository = createMysqlRepository(database);
      // ID zero is absent from the auto-increment table, so no writes are reached.
      expect(await database.first('SELECT id FROM listings WHERE id = 0')).toBeNull();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(repository.applyListingTransitions!([{
          listingId: 0, shopSessionId: 0, expectedVersion: 0, price: 1, quantity: 1,
          status: 'active', observedAt: 1, batchId: 'diagnostic/0',
        }])).resolves.toMatchObject({ updated: 0, conflicts: 1, soldEvents: 0, conflictIds: [0] });
      }
    } finally {
      await database.close();
    }
  }, 20_000);

  it.skipIf(!mysqlTestUrl).each(['pool', 'transaction'] as const)(
    'joins upload JSON_TABLE strings to migrated tables through a %s connection',
    async (mode) => {
      const database = createMysqlDatabase(mysqlTestUrl!);
      try {
        const query = async (db: typeof database) => {
          const repository = createMysqlRepository(db);
          // A negative shop ID cannot match the unsigned primary key. The real
          // upload query must still resolve its JSON_TABLE comparison types.
          await expect(repository.loadListingsByObservations!([
            { sessionId: -1, fingerprint: '0'.repeat(64) },
          ])).resolves.toEqual([]);
        };
        if (mode === 'transaction') await database.transaction(query);
        else await query(database);
      } finally {
        await database.close();
      }
    },
    20_000,
  );

  it.skipIf(!mysqlTestUrl).each(['shops', 'new listings', 'listing transitions'] as const)(
    'plans %s upload statements without modifying data',
    async (operation) => {
      const database = createMysqlDatabase(mysqlTestUrl!);
      let plannedWrites = 0;
      // EXPLAIN validates real MySQL syntax and column resolution without executing
      // writes. Synthetic read results let the repository reach every write branch.
      const planner: MysqlDatabase = {
        ...database,
        async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
          await database.all(`EXPLAIN ${sql}`, values);
          return [{ id: 1, source_id: 'diagnostic', identity_hash: '0'.repeat(64), public_shop_id: 'diagnostic', status: 'active', last_status_observed_at: 0, last_changed_at: 0, full_state_hash: null }] as unknown as T[];
        },
        async run(sql, values) {
          await database.all(`EXPLAIN ${sql}`, values);
          plannedWrites += 1;
          return { affectedRows: 0, insertId: 0 };
        },
        async transaction(work) { return work(planner); },
      };
      try {
        const repository = createMysqlRepository(planner);
        if (operation === 'shops') {
          await repository.resolveShopObservations!([{
            sourceId: 'diagnostic', identityHash: '0'.repeat(64), shopId: 'diagnostic',
            shopStatus: 'opening', batchId: 'diagnostic/0', vendorAccountId: 'diagnostic', clientRunId: 'diagnostic',
            observedAt: 1, vendorName: 'diagnostic', title: 'diagnostic', shopType: 'sell', mapName: 'diagnostic', x: 0, y: 0,
          }]);
          expect(plannedWrites).toBe(4);
        } else if (operation === 'new listings') {
          await repository.insertNewListingsBulk!([{
            sessionId: 1, fingerprint: '0'.repeat(64), itemId: 1, upgrade: 0, slots: 0, cards: [0, 0, 0, 0],
            price: 1, quantity: 2, observedAt: 1, batchId: 'diagnostic/0', options: [{ type: 1, value: 1, param: 0 }],
          }]);
          expect(plannedWrites).toBe(3);
        } else {
          await repository.applyListingTransitions!([{
            listingId: 1, shopSessionId: 1, expectedVersion: 0, price: 1, quantity: 1, status: 'active', observedAt: 2, batchId: 'diagnostic/0',
            history: { eventType: 'quantity_changed' },
            soldEvent: { soldQuantity: 1, fromQuantity: 2, toQuantity: 1, reason: 'quantity_decrease', transitionKey: 'diagnostic' },
          }]);
          expect(plannedWrites).toBe(3);
        }
      } finally {
        await database.close();
      }
    },
    20_000,
  );
});
