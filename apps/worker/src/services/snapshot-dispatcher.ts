import { Buffer } from 'node:buffer';
import type { AppEnv } from '../env';
import type { SnapshotRepository } from '../db/snapshot-repository';
import type { SnapshotMessage } from './full-upload';
import { runSnapshotJobChunk } from './snapshot-jobs';

export function isSnapshotMessage(value: unknown): value is SnapshotMessage {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.sourceId === 'string' && row.sourceId.length > 0 && row.sourceId.length <= 191
    && typeof row.snapshotId === 'string' && row.snapshotId.length > 0 && row.snapshotId.length <= 160
    && typeof row.generation === 'number' && Number.isSafeInteger(row.generation) && row.generation >= 0;
}

export function createSnapshotDispatcher(env: AppEnv, repo: SnapshotRepository) {
  return async (message: SnapshotMessage): Promise<'queued' | 'cron_fallback'> => {
    if (!env.SNAPSHOT_QUEUE) return 'cron_fallback';
    const body: SnapshotMessage = { sourceId: message.sourceId, snapshotId: message.snapshotId, generation: message.generation };
    const operations = 3 * Math.ceil((Buffer.byteLength(JSON.stringify(body), 'utf8') + 100) / 64_000);
    if (!await repo.reserveQueueOperations(Date.now(), operations, env.SNAPSHOT_QUEUE_DAILY_BUDGET ?? 9000)) return 'cron_fallback';
    try {
      await env.SNAPSHOT_QUEUE.send(body);
      return 'queued';
    } catch {
      // Reservations are conservative: an ambiguous send may already be queued.
      console.warn(JSON.stringify({ event: 'snapshot_queue_unavailable', ...body }));
      return 'cron_fallback';
    }
  };
}

export async function processSnapshotWakeup(env: AppEnv, repo: SnapshotRepository, message?: SnapshotMessage): Promise<void> {
  const job = await repo.claim(Date.now(), message);
  if (!job) return;
  let next: SnapshotMessage | null;
  try {
    next = await repo.process(job, (claimed, tx) => runSnapshotJobChunk(claimed, tx, {
      reconcileBatchSize: env.SNAPSHOT_RECONCILE_BATCH_SIZE ?? 200,
    }));
  } catch (error) {
    await repo.fail(job);
    throw error;
  }
  // Dispatch follows the commit. A failed send leaves durable work for Cron.
  if (next) {
    try { await createSnapshotDispatcher(env, repo)(next); }
    catch { console.warn(JSON.stringify({ event: 'snapshot_dispatch_fallback', ...next })); }
  }
}

export interface SnapshotQueueMessage { body: unknown; ack(): void; retry(options?: { delaySeconds?: number }): void; }
export async function consumeSnapshotBatch(messages: readonly SnapshotQueueMessage[], env: AppEnv, repo: SnapshotRepository): Promise<void> {
  if (messages.length !== 1) {
    // Never combine several chunks in one invocation, even after a configuration mistake.
    for (const message of messages) message.retry({ delaySeconds: 60 });
    console.error(JSON.stringify({ event: 'snapshot_queue_batch_size_invalid', count: messages.length }));
    return;
  }
  const message = messages[0]!;
  if (!isSnapshotMessage(message.body)) {
    message.ack();
    console.error(JSON.stringify({ event: 'snapshot_queue_message_invalid' }));
    return;
  }
  try {
    await processSnapshotWakeup(env, repo, message.body);
    message.ack();
  } catch {
    message.retry({ delaySeconds: 60 });
  }
}
