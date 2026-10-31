import type { MysqlDatabase, MysqlRow } from '../db/mysql-client';
import { assertCommerceId, type CommerceTransaction } from './repository';

const MAX_COMMERCE_JOBS_PER_TICK = 20;
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000] as const;

export interface CommerceJobClaim {
  id: string;
  orderId: string;
  owner: string;
  fencingToken: string;
  dirtyGeneration: string;
  attempt: number;
}

export type CommerceJobCompletion = 'done' | 'requeued' | 'lost_lease';

export interface CommerceJobRepository {
  claimDue(input: { now: number; owner: string; leaseMs: number; limit: number }): Promise<CommerceJobClaim[]>;
  complete(claim: CommerceJobClaim, now: number): Promise<CommerceJobCompletion>;
  retry(claim: CommerceJobClaim, errorCode: string, now: number): Promise<boolean>;
}

function unsignedBigint(value: unknown, field: string): bigint {
  try {
    const result = BigInt(value as string | number | bigint);
    if (result < 0n || result > MAX_UNSIGNED_BIGINT) throw new RangeError();
    return result;
  } catch {
    throw new TypeError('invalid commerce job ' + field);
  }
}

function nonnegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid commerce job ' + field);
  return value;
}

function readAttempt(value: unknown): number {
  const attempt = Number(value);
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= 2_147_483_647) {
    throw new RangeError('invalid commerce job attempts');
  }
  return attempt;
}

function readClaim(row: MysqlRow, owner: string): CommerceJobClaim {
  const attempt = readAttempt(row.attempts) + 1;
  if (!Number.isSafeInteger(attempt)) throw new RangeError('invalid commerce job attempts');
  const fencingToken = unsignedBigint(row.fencing_token, 'fencing token') + 1n;
  if (fencingToken > MAX_UNSIGNED_BIGINT) throw new RangeError('commerce job fencing token exhausted');
  return {
    id: assertCommerceId(String(row.id)),
    orderId: assertCommerceId(String(row.order_id)),
    owner,
    fencingToken: fencingToken.toString(),
    dirtyGeneration: unsignedBigint(row.dirty_generation, 'dirty generation').toString(),
    attempt,
  };
}

export function commerceRetryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('invalid commerce job attempt');
  return RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!;
}

export async function enqueueCommerceReconcile(
  transaction: Pick<CommerceTransaction, 'run'>,
  orderIdInput: string,
  now: number,
): Promise<void> {
  const orderId = assertCommerceId(orderIdInput);
  nonnegativeInteger(now, 'timestamp');
  await transaction.run(
    'INSERT INTO commerce_jobs '
      + '(job_key, job_type, order_id, state, dirty_generation, processed_generation, next_run_at, created_at, updated_at) '
      + 'VALUES (?, \'order_reconcile\', ?, \'queued\', 1, 0, ?, ?, ?) '
      + 'ON DUPLICATE KEY UPDATE dirty_generation = dirty_generation + 1, '
      + 'state = CASE WHEN state = \'leased\' THEN \'leased\' ELSE \'queued\' END, '
      + 'next_run_at = LEAST(next_run_at, VALUES(next_run_at)), updated_at = VALUES(updated_at)',
    ['order-reconcile:' + orderId, orderId, now, now, now],
  );
}

export function createCommerceJobRepository(database: MysqlDatabase): CommerceJobRepository {
  return {
    claimDue: async ({ now, owner, leaseMs, limit }) => {
      nonnegativeInteger(now, 'timestamp');
      if (!/^[A-Za-z0-9_-]{1,64}$/u.test(owner)) throw new TypeError('invalid commerce job lease owner');
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(now + leaseMs)) {
        throw new RangeError('invalid commerce job lease duration');
      }
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('invalid commerce job claim limit');
      const boundedLimit = Math.min(limit, MAX_COMMERCE_JOBS_PER_TICK);
      return database.transaction(async (tx) => {
        const rows = await tx.all(
          'SELECT CAST(id AS CHAR) AS id, job_type, CAST(order_id AS CHAR) AS order_id, '
            + 'CAST(dirty_generation AS CHAR) AS dirty_generation, CAST(fencing_token AS CHAR) AS fencing_token, attempts '
            + 'FROM commerce_jobs WHERE ((state = \'queued\' AND next_run_at <= ?) '
            + 'OR (state = \'leased\' AND lease_until <= ?)) ORDER BY next_run_at, id LIMIT ? FOR UPDATE SKIP LOCKED',
          [now, now, boundedLimit],
        );
        const claims: CommerceJobClaim[] = [];
        for (const row of rows) {
          if (row.job_type !== 'order_reconcile') throw new TypeError('unsupported commerce job type');
          const claim = readClaim(row, owner);
          const result = await tx.run(
            'UPDATE commerce_jobs SET state = \'leased\', lease_owner = ?, lease_until = ?, fencing_token = ?, '
              + 'attempts = attempts + 1, updated_at = ? WHERE id = ? AND '
              + '((state = \'queued\' AND next_run_at <= ?) OR (state = \'leased\' AND lease_until <= ?))',
            [owner, now + leaseMs, claim.fencingToken, now, claim.id, now, now],
          );
          if (result.affectedRows === 1) claims.push(claim);
        }
        return claims;
      });
    },
    complete: async (claim, now) => {
      nonnegativeInteger(now, 'timestamp');
      return database.transaction(async (tx) => {
        const row = await tx.first(
          'SELECT state, lease_owner, CAST(fencing_token AS CHAR) AS fencing_token, '
            + 'CAST(dirty_generation AS CHAR) AS dirty_generation, lease_until '
            + 'FROM commerce_jobs WHERE id = ? FOR UPDATE',
          [claim.id],
        );
        if (!row || row.state !== 'leased' || row.lease_owner !== claim.owner
          || unsignedBigint(row.fencing_token, 'fencing token').toString() !== claim.fencingToken
          || unsignedBigint(row.lease_until, 'lease expiry') <= BigInt(now)) {
          return 'lost_lease';
        }
        const dirtyGeneration = unsignedBigint(row.dirty_generation, 'dirty generation');
        const claimedGeneration = unsignedBigint(claim.dirtyGeneration, 'claimed generation');
        if (dirtyGeneration < claimedGeneration) throw new Error('commerce job generation moved backwards');
        const completion: CommerceJobCompletion = dirtyGeneration > claimedGeneration ? 'requeued' : 'done';
        const updated = await tx.run(
          'UPDATE commerce_jobs SET processed_generation = ?, state = ?, next_run_at = ?, lease_owner = NULL, '
            + 'lease_until = NULL, last_error_code = NULL, updated_at = ? '
            + 'WHERE id = ? AND state = \'leased\' AND lease_owner = ? AND fencing_token = ? '
            + 'AND dirty_generation = ? AND lease_until > ?',
          [claim.dirtyGeneration, completion === 'done' ? 'done' : 'queued', now, now,
            claim.id, claim.owner, claim.fencingToken, dirtyGeneration.toString(), now],
        );
        return updated.affectedRows === 1 ? completion : 'lost_lease';
      });
    },
    retry: async (claim, errorCode, now) => {
      nonnegativeInteger(now, 'timestamp');
      if (!/^[A-Z0-9_]{1,64}$/u.test(errorCode)) throw new TypeError('invalid commerce job error code');
      const nextRunAt = now + commerceRetryDelayMs(claim.attempt);
      if (!Number.isSafeInteger(nextRunAt)) throw new RangeError('invalid commerce job retry timestamp');
      const result = await database.run(
        'UPDATE commerce_jobs SET state = \'queued\', next_run_at = ?, lease_owner = NULL, lease_until = NULL, '
          + 'last_error_code = ?, updated_at = ? '
          + 'WHERE id = ? AND state = \'leased\' AND lease_owner = ? AND fencing_token = ? AND lease_until > ?',
        [nextRunAt, errorCode, now, claim.id, claim.owner, claim.fencingToken, now],
      );
      return result.affectedRows === 1;
    },
  };
}
