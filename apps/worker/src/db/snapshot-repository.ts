import type { MysqlDatabase, MysqlRow } from './mysql-client';
import { MysqlDatabaseError } from './mysql-client';
import type { UploadResultLike } from './repository';
import type { FullPartReceipt, FullReceiptStore, SnapshotMessage } from '../services/full-upload';
import { IngestionError } from '../services/ingestion';
import { logInfo } from '../observability';

export type SnapshotStage = 'materialize_parts' | 'reconcile_listings' | 'reconcile_shops' | 'publish_hashes' | 'finalize';
export interface SnapshotJob extends SnapshotMessage {
  stage: SnapshotStage;
  cursor: number;
  observedAt: number;
  clientRunId: string;
  partCount: number;
  leaseToken: string;
  attempts: number;
}
export interface ChunkProgress { stage: SnapshotStage; cursor: number; complete?: boolean; processed: number; }
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;

// Repository helpers may open transactions themselves. Inside an owned transaction
// they must reuse its connection; a nested pool transaction would break atomicity.
export function transactionView(tx: MysqlDatabase): MysqlDatabase {
  const view: MysqlDatabase = { ...tx, transaction: async (work) => work(view), close: async () => undefined };
  return view;
}

export async function lockMarketSource(tx: MysqlDatabase, sourceId: string): Promise<MysqlRow> {
  const source = await tx.first('SELECT id, last_full_snapshot_id, last_full_snapshot_at, active_full_snapshot_id FROM market_sources WHERE id = ? FOR UPDATE', [sourceId]);
  if (!source) throw new IngestionError(503, 'storage_unavailable', 'Market source is unavailable', { retryable: true });
  return source;
}

function toJob(row: MysqlRow): SnapshotJob {
  return { sourceId: String(row.source_id), snapshotId: String(row.snapshot_id), generation: Number(row.generation),
    stage: row.stage as SnapshotStage, cursor: Number(row.cursor_id), observedAt: Number(row.observed_at),
    clientRunId: String(row.client_run_id), partCount: Number(row.part_count), leaseToken: String(row.lease_token), attempts: Number(row.attempts) };
}

function mismatch(message: string): IngestionError {
  return new IngestionError(422, 'idempotency_key_reused', message, { action: 'new_snapshot' });
}

export function createSnapshotRepository(db: MysqlDatabase) {
  const receive: FullReceiptStore['receive'] = async (input: FullPartReceipt) => db.transaction(async (tx) => {
    await lockMarketSource(tx, input.sourceId);
    const { request } = input;
    const key = [input.sourceId, request.snapshot_id];
    const now = Date.now();
    const previous = await tx.first('SELECT payload_hash, response_json FROM upload_batches WHERE source_id = ? AND batch_id = ?', [input.sourceId, input.response.batch_id]);
    if (previous) {
      if (previous.payload_hash !== input.payloadHash || !previous.response_json) throw mismatch('Snapshot part already has different content');
      // Duplicate HTTP receipt never wakes an already scheduled generation.
      return { response: { ...JSON.parse(String(previous.response_json)) as UploadResultLike, duplicate: true }, wakeup: null };
    }
    const incompatible = await tx.first("SELECT batch_id FROM upload_batches WHERE source_id = ? AND snapshot_id = ? AND snapshot_mode <> 'full' LIMIT 1", key);
    if (incompatible) throw mismatch('Snapshot ID is already used by another upload mode');
    await tx.run(`INSERT INTO market_snapshots(source_id, snapshot_id, client_run_id, observed_at, part_count, available_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE snapshot_id = market_snapshots.snapshot_id`,
    [...key, request.client_run_id, Date.parse(request.observed_at), request.part_count, now, now]);
    const snapshot = await tx.first('SELECT * FROM market_snapshots WHERE source_id = ? AND snapshot_id = ? FOR UPDATE', key);
    if (!snapshot || snapshot.snapshot_id !== request.snapshot_id || snapshot.client_run_id !== request.client_run_id
      || Number(snapshot.observed_at) !== Date.parse(request.observed_at) || Number(snapshot.part_count) !== request.part_count
      || snapshot.status !== 'receiving') throw mismatch('Snapshot metadata does not match the accepted parts');

    // Store the payload once. Staging reads its JSON column in this same
    // transaction instead of binding a second copy through a derived JSON cast.
    await tx.run(`INSERT INTO upload_batches(source_id, batch_id, snapshot_id, part_index, part_count, snapshot_mode,
        payload_hash, status, shop_ids_json, shop_hashes_json, payload_json, response_json, received_at, completed_at)
      VALUES (?, ?, ?, ?, ?, 'full', ?, 'accepted', '[]', ?, ?, ?, ?, ?)`,
    [input.sourceId, input.response.batch_id, request.snapshot_id, request.part_index, request.part_count, input.payloadHash,
      JSON.stringify(input.identities.map((identity) => identity.identityHash)), input.payloadJson, JSON.stringify(input.response), now, now]);

    try {
      // MySQL extracts shop rows and computes conservative content hashes. No item
      // objects/fingerprints are materialized in the Worker on this path.
      await tx.run(`INSERT INTO market_snapshot_shops(source_id, snapshot_id, ordinal, identity_hash, public_shop_id,
          shop_json, items_json, content_hash, item_count)
        SELECT payload.source_id, payload.snapshot_id, payload.part_index * 300 + identities.position, identities.identity_hash, identities.public_shop_id,
          JSON_REMOVE(JSON_EXTRACT(payload.payload_json, CONCAT('$.shops[', identities.position - 1, ']')), '$.items'),
          JSON_EXTRACT(payload.payload_json, CONCAT('$.shops[', identities.position - 1, '].items')),
          SHA2(CAST(JSON_EXTRACT(payload.payload_json, CONCAT('$.shops[', identities.position - 1, '].items')) AS CHAR CHARACTER SET utf8mb4), 256),
          JSON_LENGTH(JSON_EXTRACT(payload.payload_json, CONCAT('$.shops[', identities.position - 1, '].items')))
        FROM upload_batches AS payload
        JOIN JSON_TABLE(?, '$[*]' COLUMNS(position FOR ORDINALITY, identity_hash CHAR(64) PATH '$.identityHash',
          public_shop_id VARCHAR(191) PATH '$.shopId')) AS identities
        WHERE payload.source_id = ? AND payload.batch_id = ?`,
      [JSON.stringify(input.identities), input.sourceId, input.response.batch_id]);
    } catch (error) {
      if (error instanceof MysqlDatabaseError && error.code === 'ER_DUP_ENTRY') {
        throw new IngestionError(422, 'duplicate_shop_identity', 'Shop identity occurs in more than one snapshot part', { action: 'new_snapshot' });
      }
      throw error;
    }
    const ready = Number(snapshot.accepted_parts) + 1 === request.part_count;
    await tx.run('UPDATE market_snapshots SET accepted_parts = accepted_parts + 1, status = ?, available_at = ? WHERE source_id = ? AND snapshot_id = ?',
      [ready ? 'queued' : 'receiving', now, ...key]);
    return { response: input.response, wakeup: ready ? { sourceId: input.sourceId, snapshotId: request.snapshot_id, generation: 0 } : null };
  });

  return {
    receive,
    async claim(now: number, message?: SnapshotMessage): Promise<SnapshotJob | null> {
      // The candidate read does not claim a job. The source lock serializes all
      // writers for this source, then the row/generation is checked again.
      const candidate = message ?? await db.first(`SELECT source_id AS sourceId, snapshot_id AS snapshotId, generation
        FROM market_snapshots WHERE status IN ('queued', 'running') AND available_at <= ?
          AND (lease_until IS NULL OR lease_until <= ?) ORDER BY available_at, source_id, snapshot_id LIMIT 1`, [now, now]) as SnapshotMessage | null;
      if (!candidate) return null;
      return db.transaction(async (tx) => {
        const source = await lockMarketSource(tx, candidate.sourceId);
        const row = await tx.first('SELECT * FROM market_snapshots WHERE source_id = ? AND snapshot_id = ? FOR UPDATE', [candidate.sourceId, candidate.snapshotId]);
        if (!row || !['queued', 'running'].includes(String(row.status)) || Number(row.generation) !== candidate.generation
          || Number(row.available_at) > now || (row.lease_until != null && Number(row.lease_until) > now)) return null;
        if (source.last_full_snapshot_at != null && Number(source.last_full_snapshot_at) >= Number(row.observed_at)) {
          await tx.run("UPDATE market_snapshots SET status = 'complete', completed_at = ?, lease_token = NULL, lease_until = NULL WHERE source_id = ? AND snapshot_id = ?", [now, candidate.sourceId, candidate.snapshotId]);
          await releaseSourceSnapshot(tx, candidate);
          return null;
        }
        // Keep ownership across all chunks, not just the current lease. An older
        // snapshot arriving late (or being repaired) cannot interleave its stages
        // with a newer full that has already started.
        if (source.active_full_snapshot_id != null && source.active_full_snapshot_id !== candidate.snapshotId) {
          await tx.run('UPDATE market_snapshots SET available_at = ? WHERE source_id = ? AND snapshot_id = ?', [now + LEASE_MS, candidate.sourceId, candidate.snapshotId]);
          return null;
        }
        const earlier = source.active_full_snapshot_id != null ? null : await tx.first(`SELECT snapshot_id FROM market_snapshots WHERE source_id = ? AND status IN ('queued', 'running')
          AND (observed_at < ? OR (observed_at = ? AND snapshot_id < ?)) LIMIT 1`, [candidate.sourceId, row.observed_at, row.observed_at, candidate.snapshotId]);
        if (earlier) {
          await tx.run('UPDATE market_snapshots SET available_at = ? WHERE source_id = ? AND snapshot_id = ?', [now + LEASE_MS, candidate.sourceId, candidate.snapshotId]);
          return null;
        }
        if (Number(row.attempts) >= MAX_ATTEMPTS) {
          await tx.run("UPDATE market_snapshots SET status = 'failed', last_error = 'attempt_limit', lease_until = NULL, lease_token = NULL WHERE source_id = ? AND snapshot_id = ?", [candidate.sourceId, candidate.snapshotId]);
          await releaseSourceSnapshot(tx, candidate);
          return null;
        }
        const token = crypto.randomUUID();
        const attempts = Number(row.attempts) + 1;
        await tx.run("UPDATE market_snapshots SET status = 'running', attempts = ?, lease_token = ?, lease_until = ? WHERE source_id = ? AND snapshot_id = ?", [attempts, token, now + LEASE_MS, candidate.sourceId, candidate.snapshotId]);
        await tx.run('UPDATE market_sources SET active_full_snapshot_id = ? WHERE id = ?', [candidate.snapshotId, candidate.sourceId]);
        return toJob({ ...row, attempts, lease_token: token });
      });
    },
    async process(job: SnapshotJob, run: (job: SnapshotJob, tx: MysqlDatabase) => Promise<ChunkProgress>, now = Date.now()): Promise<SnapshotMessage | null> {
      return db.transaction(async (connection) => {
        const tx = transactionView(connection);
        const source = await lockMarketSource(tx, job.sourceId);
        const row = await tx.first('SELECT * FROM market_snapshots WHERE source_id = ? AND snapshot_id = ? FOR UPDATE', [job.sourceId, job.snapshotId]);
        if (!row || row.status !== 'running' || row.lease_token !== job.leaseToken || Number(row.generation) !== job.generation
          || source.active_full_snapshot_id !== job.snapshotId) return null;
        if (source.last_full_snapshot_at != null && Number(source.last_full_snapshot_at) >= job.observedAt) {
          await tx.run("UPDATE market_snapshots SET status = 'complete', completed_at = ?, lease_token = NULL, lease_until = NULL WHERE source_id = ? AND snapshot_id = ?", [now, job.sourceId, job.snapshotId]);
          await releaseSourceSnapshot(tx, job);
          return null;
        }
        const progress = await run(toJob(row), tx);
        await tx.run(`UPDATE market_snapshots SET stage = ?, cursor_id = ?, generation = generation + 1,
          status = ?, attempts = 0, last_error = NULL, lease_token = NULL, lease_until = NULL, available_at = ?, completed_at = ?
          WHERE source_id = ? AND snapshot_id = ? AND lease_token = ? AND generation = ?`,
        [progress.stage, progress.cursor, progress.complete ? 'complete' : 'queued', now, progress.complete ? now : null,
          job.sourceId, job.snapshotId, job.leaseToken, job.generation]);
        if (progress.complete) await releaseSourceSnapshot(tx, job);
        logInfo('lastroweb.snapshot_chunk', { source_id: job.sourceId, snapshot_id: job.snapshotId,
          stage: job.stage, generation: job.generation, processed: progress.processed, next_stage: progress.stage });
        return progress.complete ? null : { sourceId: job.sourceId, snapshotId: job.snapshotId, generation: job.generation + 1 };
      });
    },
    async fail(job: SnapshotJob, now = Date.now()): Promise<void> {
      await db.transaction(async (tx) => {
        await lockMarketSource(tx, job.sourceId);
        const failed = job.attempts >= MAX_ATTEMPTS;
        const result = await tx.run(`UPDATE market_snapshots SET status = ?, last_error = 'chunk_failed', lease_token = NULL, lease_until = NULL,
          available_at = ? WHERE source_id = ? AND snapshot_id = ? AND generation = ? AND lease_token = ?`,
        [failed ? 'failed' : 'queued', now + Math.min(300_000, 1000 * 2 ** job.attempts), job.sourceId, job.snapshotId, job.generation, job.leaseToken]);
        if (failed && result.affectedRows === 1) await releaseSourceSnapshot(tx, job);
      });
    },
    async reserveQueueOperations(now: number, operations: number, dailyLimit: number): Promise<boolean> {
      const day = new Date(now).toISOString().slice(0, 10);
      return db.transaction(async (tx) => {
        await tx.run('INSERT INTO market_queue_budget(utc_day) VALUES (?) ON DUPLICATE KEY UPDATE utc_day = utc_day', [day]);
        const result = await tx.run(`UPDATE market_queue_budget SET reserved_operations = reserved_operations + ?
          WHERE utc_day = ? AND reserved_operations + ? <= ?`, [operations, day, operations, dailyLimit]);
        return result.affectedRows === 1;
      });
    },
    async status(sourceId: string, snapshotId: string): Promise<MysqlRow | null> {
      return db.first(`SELECT source_id, snapshot_id, part_count, accepted_parts, status, stage, cursor_id, generation,
        attempts, available_at, lease_until, last_error, completed_at FROM market_snapshots WHERE source_id = ? AND snapshot_id = ?`, [sourceId, snapshotId]);
    },
    async requeue(sourceId: string, snapshotId: string, now = Date.now()): Promise<boolean> {
      return db.transaction(async (tx) => {
        await lockMarketSource(tx, sourceId);
        const result = await tx.run(`UPDATE market_snapshots SET status = 'queued', attempts = 0, last_error = NULL,
          generation = generation + 1, lease_token = NULL, lease_until = NULL, available_at = ?
          WHERE source_id = ? AND snapshot_id = ? AND status = 'failed' AND accepted_parts = part_count`, [now, sourceId, snapshotId]);
        return result.affectedRows === 1;
      });
    },
    async cleanup(now: number): Promise<void> {
      const incomplete = await db.first(`SELECT source_id, snapshot_id FROM market_snapshots
        WHERE status = 'receiving' AND created_at < ? ORDER BY created_at LIMIT 1`, [now - 86_400_000]);
      if (incomplete) {
        await db.run(`UPDATE market_snapshots SET status = 'failed', last_error = 'incomplete_snapshot'
          WHERE source_id = ? AND snapshot_id = ? AND status = 'receiving'`, [incomplete.source_id, incomplete.snapshot_id]);
        return;
      }
      const candidate = await db.first(`SELECT source_id, snapshot_id FROM market_snapshots WHERE purged_at IS NULL
        AND ((status = 'complete' AND completed_at < ?) OR (status = 'failed' AND last_error = 'incomplete_snapshot' AND created_at < ?))
        ORDER BY created_at LIMIT 1`, [now - 7 * 86_400_000, now - 7 * 86_400_000]);
      if (!candidate) return;
      await db.transaction(async (tx) => {
        const key = [candidate.source_id, candidate.snapshot_id];
        const snapshot = await tx.first('SELECT status, last_error, purged_at FROM market_snapshots WHERE source_id = ? AND snapshot_id = ? FOR UPDATE', key);
        if (!snapshot || snapshot.purged_at != null || (snapshot.status !== 'complete' && !(snapshot.status === 'failed' && snapshot.last_error === 'incomplete_snapshot'))) return;
        const removed = await tx.run('DELETE FROM market_snapshot_shops WHERE source_id = ? AND snapshot_id = ? ORDER BY ordinal LIMIT 200', key);
        if (removed.affectedRows > 0) return;
        // There are at most 64 parts. Keep their hashes/responses as idempotency tombstones.
        await tx.run('UPDATE upload_batches SET payload_json = NULL WHERE source_id = ? AND snapshot_id = ? AND payload_json IS NOT NULL LIMIT 64', key);
        await tx.run('UPDATE market_snapshots SET purged_at = ? WHERE source_id = ? AND snapshot_id = ?', [now, ...key]);
      });
    },
  };
}

export type SnapshotRepository = ReturnType<typeof createSnapshotRepository>;

async function releaseSourceSnapshot(tx: MysqlDatabase, message: SnapshotMessage): Promise<void> {
  await tx.run('UPDATE market_sources SET active_full_snapshot_id = NULL WHERE id = ? AND active_full_snapshot_id = ?', [message.sourceId, message.snapshotId]);
}
