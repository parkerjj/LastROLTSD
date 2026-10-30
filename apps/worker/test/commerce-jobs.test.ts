import { describe, expect, it, vi } from 'vitest';
import {
  commerceRetryDelayMs,
  createCommerceJobRepository,
  enqueueCommerceReconcile,
  type CommerceJobClaim,
} from '../src/commerce/commerce-job-repository';
import { runCommerceJobTick } from '../src/commerce/jobs';
import type { MysqlDatabase, MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';

interface JobRow extends MysqlRow {
  id: string;
  job_key: string;
  job_type: string;
  order_id: string;
  state: string;
  dirty_generation: string;
  processed_generation: string;
  next_run_at: number;
  lease_owner: string | null;
  lease_until: number | null;
  fencing_token: string;
  attempts: number;
  last_error_code: string | null;
  updated_at: number;
}

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: '1', job_key: 'order-reconcile:7', job_type: 'order_reconcile', order_id: '7', state: 'queued',
    dirty_generation: '1', processed_generation: '0', next_run_at: 0, lease_owner: null, lease_until: null,
    fencing_token: '0', attempts: 0, last_error_code: null, updated_at: 0, ...overrides,
  };
}

class JobDatabase implements MysqlDatabase {
  readonly calls: Array<{ method: 'all' | 'first' | 'run'; sql: string; values: readonly unknown[] }> = [];
  readonly jobs = new Map<string, JobRow>();
  closeCalls = 0;
  failQueries = false;

  constructor(rows: JobRow[] = []) {
    for (const row of rows) this.jobs.set(row.id, { ...row });
  }

  async all<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T[]> {
    this.calls.push({ method: 'all', sql, values });
    if (this.failQueries) throw new Error('database unavailable');
    if (!sql.includes('FROM commerce_jobs')) return [];
    const now = Number(values[0]);
    const limit = Number(values[2]);
    return [...this.jobs.values()]
      .filter((row) => (row.state === 'queued' && row.next_run_at <= now)
        || (row.state === 'leased' && (row.lease_until ?? Number.MAX_SAFE_INTEGER) <= now))
      .sort((left, right) => left.next_run_at - right.next_run_at || Number(left.id) - Number(right.id))
      .slice(0, limit)
      .map((row) => ({ ...row }) as T);
  }

  async first<T extends MysqlRow>(sql: string, values: readonly unknown[] = []): Promise<T | null> {
    this.calls.push({ method: 'first', sql, values });
    if (!sql.includes('FROM commerce_jobs')) return null;
    const row = this.jobs.get(String(values[0]));
    return row ? { ...row } as T : null;
  }

  async run(sql: string, values: readonly unknown[] = []): Promise<MysqlWriteResult> {
    this.calls.push({ method: 'run', sql, values });
    if (sql.startsWith('INSERT INTO commerce_jobs')) {
      const [jobKey, orderId, now] = values;
      const existing = [...this.jobs.values()].find((row) => row.job_key === jobKey);
      if (existing) {
        existing.dirty_generation = String(BigInt(existing.dirty_generation) + 1n);
        if (existing.state !== 'leased') existing.state = 'queued';
        existing.next_run_at = Math.min(existing.next_run_at, Number(now));
        existing.updated_at = Number(now);
      } else {
        const row = makeJob({ job_key: String(jobKey), order_id: String(orderId), next_run_at: Number(now), updated_at: Number(now) });
        this.jobs.set(row.id, row);
      }
      return { affectedRows: 1, insertId: 1 };
    }

    if (sql.includes("SET state = 'leased'")) {
      const [owner, leaseUntil, fencingToken, updatedAt] = values;
      const row = this.jobs.get(String(values[4]));
      if (!row) return { affectedRows: 0, insertId: 0 };
      row.state = 'leased';
      row.lease_owner = String(owner);
      row.lease_until = Number(leaseUntil);
      row.fencing_token = String(fencingToken);
      row.attempts += 1;
      row.updated_at = Number(updatedAt);
      return { affectedRows: 1, insertId: 0 };
    }

    if (sql.includes('processed_generation = ?')) {
      const [generation, state, nextRunAt, updatedAt, , owner, fencingToken] = values;
      const row = this.jobs.get(String(values[4]));
      if (!row) return { affectedRows: 0, insertId: 0 };
      if (row.state !== 'leased' || row.lease_owner !== owner || row.fencing_token !== String(fencingToken)) {
        return { affectedRows: 0, insertId: 0 };
      }
      row.processed_generation = String(generation);
      row.state = String(state);
      row.next_run_at = Number(nextRunAt);
      row.lease_owner = null;
      row.lease_until = null;
      row.last_error_code = null;
      row.updated_at = Number(updatedAt);
      return { affectedRows: 1, insertId: 0 };
    }

    if (sql.includes('last_error_code = ?')) {
      const [nextRunAt, errorCode, updatedAt] = values;
      const row = this.jobs.get(String(values[3]));
      if (!row) return { affectedRows: 0, insertId: 0 };
      if (row.state !== 'leased' || row.lease_owner !== values[4] || row.fencing_token !== String(values[5])) {
        return { affectedRows: 0, insertId: 0 };
      }
      row.state = 'queued';
      row.next_run_at = Number(nextRunAt);
      row.lease_owner = null;
      row.lease_until = null;
      row.last_error_code = String(errorCode);
      row.updated_at = Number(updatedAt);
      return { affectedRows: 1, insertId: 0 };
    }

    return { affectedRows: 1, insertId: 0 };
  }

  async transaction<T>(work: (database: MysqlDatabase) => Promise<T>): Promise<T> {
    return work(this);
  }

  async healthcheck(): Promise<void> {}

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

const noBindings = { ENVIRONMENT: 'test', BUILD_VERSION: 'test' } as never;

describe('durable commerce jobs', () => {
  it('takes over an expired lease with a new owner and a larger fencing token', async () => {
    const db = new JobDatabase([makeJob({
      state: 'leased', lease_owner: 'worker-old', lease_until: 9_000, fencing_token: '11', attempts: 2,
      dirty_generation: '4',
    })]);

    const claims = await createCommerceJobRepository(db).claimDue({
      now: 10_000, owner: 'worker-new', leaseMs: 120_000, limit: 1,
    });

    expect(claims).toEqual([expect.objectContaining({
      id: '1', orderId: '7', owner: 'worker-new', fencingToken: '12', dirtyGeneration: '4', attempt: 3,
    })]);
    expect(db.calls[0]?.sql).toContain("state = 'leased' AND lease_until <= ?");
    expect(db.calls[0]?.sql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('rejects completion from a worker whose fencing token has been replaced', async () => {
    const db = new JobDatabase([makeJob({ state: 'leased', lease_owner: 'worker-new', lease_until: 20_000, fencing_token: '12' })]);
    const oldClaim: CommerceJobClaim = {
      id: '1', orderId: '7', owner: 'worker-old', fencingToken: '11', dirtyGeneration: '1', attempt: 1,
    };

    await expect(createCommerceJobRepository(db).complete(oldClaim, 10_000)).resolves.toBe('lost_lease');
    expect(db.calls.some((call) => call.method === 'run')).toBe(false);
  });

  it('rejects completion by an owner after its lease has expired even before takeover', async () => {
    const db = new JobDatabase([makeJob({
      state: 'leased', lease_owner: 'worker-1', lease_until: 9_999, fencing_token: '5',
    })]);
    const claim: CommerceJobClaim = {
      id: '1', orderId: '7', owner: 'worker-1', fencingToken: '5', dirtyGeneration: '1', attempt: 1,
    };

    await expect(createCommerceJobRepository(db).complete(claim, 10_000)).resolves.toBe('lost_lease');
    expect(db.calls.some((call) => call.method === 'run')).toBe(false);
  });

  it('requeues a completed generation when an event arrived during processing', async () => {
    const db = new JobDatabase([makeJob({
      state: 'leased', lease_owner: 'worker-1', lease_until: 120_000, fencing_token: '5', dirty_generation: '4',
    })]);
    const claim: CommerceJobClaim = {
      id: '1', orderId: '7', owner: 'worker-1', fencingToken: '5', dirtyGeneration: '3', attempt: 2,
    };

    await expect(createCommerceJobRepository(db).complete(claim, 10_000)).resolves.toBe('requeued');
    expect(db.jobs.get('1')).toMatchObject({ state: 'queued', processed_generation: '3', next_run_at: 10_000 });
    expect(db.jobs.get('1')?.dirty_generation).toBe('4');
  });

  it('coalesces duplicate event wakeups while preserving a current lease and dirty generation', async () => {
    const db = new JobDatabase([makeJob({ state: 'leased', lease_owner: 'worker-1', lease_until: 50_000, dirty_generation: '2' })]);

    await enqueueCommerceReconcile(db, '7', 10_000);
    await enqueueCommerceReconcile(db, '7', 10_100);

    expect(db.jobs.get('1')).toMatchObject({ state: 'leased', lease_owner: 'worker-1', dirty_generation: '4', next_run_at: 0 });
    expect(db.calls.every((call) => call.sql.includes('dirty_generation = dirty_generation + 1'))).toBe(true);
  });

  it('uses capped exponential retry delays of 5s, 30s, 2m, 10m, then 1h', () => {
    expect([1, 2, 3, 4, 5, 6].map(commerceRetryDelayMs)).toEqual([5_000, 30_000, 120_000, 600_000, 3_600_000, 3_600_000]);
  });

  it('retries after a worker restart takes over an abandoned lease', async () => {
    const db = new JobDatabase([makeJob()]);
    const repository = createCommerceJobRepository(db);
    const [abandoned] = await repository.claimDue({ now: 1_000, owner: 'worker-crashed', leaseMs: 100, limit: 1 });
    expect(abandoned).toBeDefined();

    const [recovered] = await repository.claimDue({ now: 1_100, owner: 'worker-restarted', leaseMs: 100, limit: 1 });
    expect(recovered).toEqual(expect.objectContaining({ owner: 'worker-restarted', fencingToken: '2' }));
  });

  it('stops starting work at 20 jobs or 20 seconds and closes its scoped connection', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => makeJob({
      id: String(index + 1), job_key: `order-reconcile:${index + 1}`, order_id: String(index + 1),
    }));
    const db = new JobDatabase(rows);
    let monotonic = 0;
    const processOrder = vi.fn(async () => { monotonic += 5_000; });

    const result = await runCommerceJobTick(noBindings, {
      now: 1_000, limit: 25, maxRuntimeMs: 20_000, owner: 'worker-tick', monotonicNow: () => monotonic,
      createDatabase: () => db, processOrder,
    });

    expect(result).toMatchObject({ status: 'completed', processed: 4, retried: 0, lostLease: 0 });
    expect(processOrder).toHaveBeenCalledTimes(4);
    expect(db.closeCalls).toBe(1);
  });

  it('retries failed reconciliation and lets the next cron tick complete it', async () => {
    const db = new JobDatabase([makeJob()]);
    const processOrder = vi.fn()
      .mockRejectedValueOnce(new Error('Stripe temporarily unavailable'))
      .mockResolvedValueOnce(undefined);

    await expect(runCommerceJobTick(noBindings, {
      now: 1_000, owner: 'worker-first', createDatabase: () => db, processOrder,
    })).resolves.toMatchObject({ status: 'completed', processed: 0, retried: 1 });
    expect(db.jobs.get('1')).toMatchObject({ state: 'queued', next_run_at: 6_000, last_error_code: 'COMMERCE_RECONCILE_FAILED' });

    await expect(runCommerceJobTick(noBindings, {
      now: 6_000, owner: 'worker-next', createDatabase: () => db, processOrder,
    })).resolves.toMatchObject({ status: 'completed', processed: 1, retried: 0 });
    expect(db.jobs.get('1')).toMatchObject({ state: 'done', processed_generation: '1' });
    expect(processOrder).toHaveBeenCalledTimes(2);
    expect(db.closeCalls).toBe(2);
  });

  it('closes its database connection when claiming fails during an outage', async () => {
    const db = new JobDatabase([makeJob()]);
    db.failQueries = true;

    await expect(runCommerceJobTick(noBindings, {
      now: 1_000, createDatabase: () => db, processOrder: vi.fn(),
    })).rejects.toThrow('database unavailable');
    expect(db.closeCalls).toBe(1);
  });

  it('leaves jobs untouched until an order processor is configured', async () => {
    const createDatabase = vi.fn(() => new JobDatabase([makeJob()]));

    await expect(runCommerceJobTick(noBindings, { createDatabase })).resolves.toMatchObject({
      status: 'unconfigured', processed: 0,
    });
    expect(createDatabase).not.toHaveBeenCalled();
  });
});
