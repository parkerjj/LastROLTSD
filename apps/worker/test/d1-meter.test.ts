import { describe, expect, it } from 'vitest';
import { createD1Meter, createMeteredD1Database } from '../src/db/d1-meter';

describe('D1 resource meter', () => {
  it('tracks rows independently from changes', () => {
    const meter = createD1Meter();

    meter.record('listing_diff', {
      rows_read: 12,
      rows_written: 4,
      changes: 1,
      duration: 0.8,
    });

    expect(meter.snapshot()).toEqual({
      rowsRead: 12,
      rowsWritten: 4,
      changes: 1,
      durationMs: 0.8,
      stages: {
        listing_diff: {
          rowsRead: 12,
          rowsWritten: 4,
          changes: 1,
          durationMs: 0.8,
        },
      },
    });
  });

  it('accumulates stages and returns detached snapshots', () => {
    const meter = createD1Meter();
    meter.record('shop_lookup', { rows_read: 3, duration: 0.2 });
    meter.record('shop_lookup', { rows_read: 2, duration: 0.3 });
    meter.record('shop_write', { rows_written: 8, changes: 1, duration: 1.1 });

    const first = meter.snapshot();
    first.stages.shop_lookup!.rowsRead = 999;

    expect(meter.snapshot()).toEqual({
      rowsRead: 5,
      rowsWritten: 8,
      changes: 1,
      durationMs: 1.6,
      stages: {
        shop_lookup: { rowsRead: 5, rowsWritten: 0, changes: 0, durationMs: 0.5 },
        shop_write: { rowsRead: 0, rowsWritten: 8, changes: 1, durationMs: 1.1 },
      },
    });
  });

  it('resets all totals and stage buckets', () => {
    const meter = createD1Meter();
    meter.record('search', { rows_read: 20, duration: 2 });

    meter.reset();

    expect(meter.snapshot()).toEqual({
      rowsRead: 0,
      rowsWritten: 0,
      changes: 0,
      durationMs: 0,
      stages: {},
    });
  });

  it('meters all, run, and batch results without relying on statement SQL properties', async () => {
    class Prepared {
      bind(): this { return this; }
      async all<T>() { return { results: [] as T[], meta: { rows_read: 7, rows_written: 0, changes: 0, duration: 0.4 } }; }
      async run() { return { success: true, results: [], meta: { rows_read: 0, rows_written: 3, changes: 1, duration: 0.6 } }; }
    }

    const database = {
      prepare: () => new Prepared(),
      batch: async () => [
        { success: true, results: [], meta: { rows_read: 0, rows_written: 8, changes: 1, duration: 1.2 } },
      ],
    };
    const meter = createD1Meter();
    const metered = createMeteredD1Database(database as never, meter);

    await metered.prepare('SELECT * FROM listings').bind().all();
    await metered.prepare('UPDATE shops SET status=?1').bind('active').run();
    await metered.batch([metered.prepare('INSERT INTO upload_batches(batch_id) VALUES(?1)').bind('batch')]);

    expect(meter.snapshot()).toEqual({
      rowsRead: 7,
      rowsWritten: 11,
      changes: 2,
      durationMs: 2.2,
      stages: {
        listing_read: { rowsRead: 7, rowsWritten: 0, changes: 0, durationMs: 0.4 },
        shop_state: { rowsRead: 0, rowsWritten: 3, changes: 1, durationMs: 0.6 },
        upload_batch: { rowsRead: 0, rowsWritten: 8, changes: 1, durationMs: 1.2 },
      },
    });
  });
});
