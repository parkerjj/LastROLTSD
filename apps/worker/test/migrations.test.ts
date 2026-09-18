import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('D1 migrations', () => {
  it('declares the required tables and source-scoped uniqueness', () => {
    const initial = readFileSync(resolve(process.cwd(), 'migrations/0001_initial.sql'), 'utf8');
    const indexes = readFileSync(resolve(process.cwd(), 'migrations/0002_indexes.sql'), 'utf8');
    for (const table of ['market_sources','vendors','shops','shop_sessions','listings','listing_options','option_dictionary','listing_price_history','sold_events','upload_batches']) {
      expect(initial).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(initial).toContain('UNIQUE(source_id, batch_id)');
    expect(initial).toContain('UNIQUE(source_id, snapshot_id, part_index)');
    expect(initial).not.toContain('CREATE TABLE IF NOT EXISTS snapshot_sessions');
    const followup = readFileSync(resolve(process.cwd(), 'migrations/0004_history_idempotency.sql'), 'utf8');
    expect(followup).toContain('CREATE TABLE IF NOT EXISTS snapshot_sessions');
    expect(followup).toContain('idx_history_batch_event');
    expect(initial).toContain('UNIQUE(source_id, shop_key)');
    expect(initial).toContain('UNIQUE(shop_session_id, item_fingerprint)');
    expect(initial).toContain('transition_key TEXT NOT NULL UNIQUE');
    expect(indexes).toContain('idx_shops_source_status_seen');
    expect(indexes).toContain('idx_options_type_value');
  });
});
