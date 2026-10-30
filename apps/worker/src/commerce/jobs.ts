import type { AppEnv } from '../env';
import type { MysqlDatabase } from '../db/mysql-client';
import { createWorkerDatabase } from '../db/mysql-connection';
import { logError } from '../observability';
import { createCommerceJobRepository, type CommerceJobClaim } from './commerce-job-repository';
import { reconcilePaidOrder } from './fulfillment';
import { createCommerceRepository } from './repository';
import type { StripeClient } from './stripe-client';

const MAX_JOBS_PER_TICK = 20;
const MAX_RUNTIME_MS = 20_000;
const JOB_LEASE_MS = 120_000;

export interface CommerceTickResult {
  status: 'completed' | 'idle' | 'unconfigured';
  processed: number;
  retried: number;
  lostLease: number;
}

export interface CommerceTickOptions {
  now?: number;
  limit?: number;
  maxRuntimeMs?: number;
  leaseMs?: number;
  owner?: string;
  monotonicNow?: () => number;
  createDatabase?: (env: AppEnv) => MysqlDatabase | undefined;
  processOrder?: (orderId: string, claim: CommerceJobClaim) => Promise<void>;
  createProcessor?: (database: MysqlDatabase) => (orderId: string, claim: CommerceJobClaim) => Promise<void>;
}

export interface CommerceReconcileConfig {
  stripe: StripeClient;
  stripeAccountId: string;
  livemode: boolean;
  now: () => number;
}

export function createCommerceOrderProcessor(database: MysqlDatabase, config: CommerceReconcileConfig) {
  const dependencies = {
    repository: createCommerceRepository(database),
    stripe: config.stripe,
    stripeAccountId: config.stripeAccountId,
    livemode: config.livemode,
    now: config.now,
  };
  return async (orderId: string): Promise<void> => {
    await reconcilePaidOrder(orderId, dependencies);
  };
}

function result(status: CommerceTickResult['status']): CommerceTickResult {
  return { status, processed: 0, retried: 0, lostLease: 0 };
}

function boundedPositiveInteger(value: number | undefined, fallback: number, max: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError('invalid commerce tick ' + field);
  return Math.min(resolved, max);
}

export async function runCommerceJobTick(env: AppEnv, options: CommerceTickOptions = {}): Promise<CommerceTickResult> {
  if (!options.processOrder && !options.createProcessor) return result('unconfigured');
  const database = (options.createDatabase ?? createWorkerDatabase)(env);
  if (!database) return result('idle');

  try {
    const tick = result('completed');
    const limit = boundedPositiveInteger(options.limit, MAX_JOBS_PER_TICK, MAX_JOBS_PER_TICK, 'limit');
    const maxRuntimeMs = boundedPositiveInteger(options.maxRuntimeMs, MAX_RUNTIME_MS, MAX_RUNTIME_MS, 'runtime');
    const leaseMs = boundedPositiveInteger(options.leaseMs, JOB_LEASE_MS, 10 * 60_000, 'lease');
    const owner = options.owner ?? crypto.randomUUID();
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    const startedAt = monotonicNow();
    const repository = createCommerceJobRepository(database);
    const processOrder = options.processOrder ?? options.createProcessor?.(database);
    if (!processOrder) return result('unconfigured');
    for (let handled = 0; handled < limit; handled += 1) {
      if (monotonicNow() - startedAt >= maxRuntimeMs) break;
      const now = options.now ?? Date.now();
      const [claim] = await repository.claimDue({ now, owner, leaseMs, limit: 1 });
      if (!claim) break;
      try {
        await processOrder(claim.orderId, claim);
        const completion = await repository.complete(claim, options.now ?? Date.now());
        if (completion === 'lost_lease') tick.lostLease += 1;
        else tick.processed += 1;
      } catch (error) {
        logError('lastroweb.commerce_order_reconcile_failed', error, {
          order_id: claim.orderId,
          attempt: claim.attempt,
        });
        const retried = await repository.retry(claim, 'COMMERCE_RECONCILE_FAILED', options.now ?? Date.now());
        if (retried) tick.retried += 1;
        else tick.lostLease += 1;
      }
    }
    return tick.processed + tick.retried + tick.lostLease > 0 ? tick : result('idle');
  } finally {
    await database.close();
  }
}

export async function runCommerceCronTick(env: AppEnv, options: CommerceTickOptions = {}): Promise<void> {
  try {
    await runCommerceJobTick(env, options);
  } catch (error) {
    logError('lastroweb.commerce_job_tick_failed', error);
    throw new Error('commerce background job failed');
  }
}
