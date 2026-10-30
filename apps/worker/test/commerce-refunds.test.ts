import { describe, expect, it, vi } from 'vitest';
import { syncOrderRefunds, retainedDurationMs } from '../src/commerce/refunds';
import type { CommerceRepository, CommerceTransaction } from '../src/commerce/repository';
import type { MysqlRow, MysqlWriteResult } from '../src/db/mysql-client';
import type { StripeClient } from '../src/commerce/stripe-client';

const DAY_MS = 86_400_000n;
const NOW = 1_800_000_000_000;

const REFUND_ORDER = {
  id: '701',
  user_id: '42',
  stripe_account_id: 'acct_test',
  stripe_livemode: 0,
  paid_total_cents: '18000',
  stripe_payment_intent_id: 'pi_test_701',
  stripe_charge_id: 'ch_test_701',
  fulfillment_state: 'fulfilled',
  refund_snapshot_hash: null,
  refund_sync_generation: '0',
  refund_revision: '0',
  applied_refund_revision: '0',
  refund_state: 'none',
};

function stripeRefund(id: string, amount: number, status = 'succeeded') {
  return {
    id,
    object: 'refund',
    amount,
    currency: 'cny',
    status,
    created: 1_800_000_000,
    payment_intent: 'pi_test_701',
    charge: 'ch_test_701',
  };
}

class RefundRepository implements CommerceRepository {
  order = { ...REFUND_ORDER };
  refunds: MysqlRow[] = [];
  writes: Array<{ sql: string; values: readonly unknown[] }> = [];

  async transaction<T>(work: (tx: CommerceTransaction) => Promise<T>): Promise<T> {
    const tx: CommerceTransaction = {
      lockUser: async (userId) => userId === '42',
      all: async <R extends MysqlRow = MysqlRow>(sql: string) => {
        if (sql.includes('FROM commerce_refunds')) return this.refunds as R[];
        return [] as R[];
      },
      first: async <R extends MysqlRow = MysqlRow>(sql: string) => {
        if (sql.includes('FROM commerce_orders')) return this.order as R;
        return null;
      },
      run: async (sql, values = []) => {
        this.writes.push({ sql, values });
        if (sql.includes('INSERT INTO commerce_refunds')) {
          const refund = {
            order_id: values[0],
            stripe_account_id: values[1],
            stripe_livemode: values[2],
            stripe_refund_id: values[3],
            amount_cents: values[4],
            currency: 'CNY',
            status: values[5],
            stripe_created_at: values[6],
          } as unknown as MysqlRow;
          const existingIndex = this.refunds.findIndex((row) => row.stripe_refund_id === values[3]);
          if (existingIndex === -1) this.refunds.push(refund);
          else this.refunds[existingIndex] = refund;
        }
        if (sql.includes("UPDATE commerce_refunds SET status = 'canceled'")) {
          this.refunds = this.refunds.map((refund) => refund.stripe_refund_id === values[4]
            ? { ...refund, status: 'canceled' }
            : refund);
        }
        if (sql.includes('refund_sync_generation =')) {
          this.order = {
            ...this.order,
            stripe_payment_intent_id: values[0],
            refund_sync_generation: String(values[1]),
          };
        }
        if (sql.includes('SET refund_snapshot_hash =')) {
          this.order = {
            ...this.order,
            refund_snapshot_hash: values[0],
            refund_revision: String(values[1]),
            applied_refund_revision: String(values[2]),
            refund_state: values[3],
          };
        }
        return { affectedRows: 1, insertId: 1 } as MysqlWriteResult;
      },
    };
    return work(tx);
  }
}

function dependencies(options: {
  repository?: RefundRepository;
  pages: Array<Record<string, unknown>>;
}): { repository: RefundRepository; stripe: StripeClient } {
  const repository = options.repository ?? new RefundRepository();
  const pages = [...options.pages];
  const stripe = {
    get: vi.fn(async () => {
      const page = pages.shift();
      if (!page) throw new Error('unexpected Stripe pagination request');
      return page;
    }),
    post: vi.fn(),
  } as unknown as StripeClient;
  return { repository, stripe };
}

describe('Stripe refund synchronization', () => {
  it('uses cumulative target duration so split refunds equal one refund of the same total', () => {
    const slotDuration = 90n * DAY_MS;
    const moduleDuration = 30n * DAY_MS;

    const slotAfterFirst = retainedDurationMs(slotDuration, 18_000n, 3_600n);
    const moduleAfterFirst = retainedDurationMs(moduleDuration, 18_000n, 3_600n);
    const slotAfterSecond = retainedDurationMs(slotDuration, 18_000n, 5_400n);
    const moduleAfterSecond = retainedDurationMs(moduleDuration, 18_000n, 5_400n);

    expect(slotDuration - slotAfterFirst).toBe(18n * DAY_MS);
    expect(moduleDuration - moduleAfterFirst).toBe(6n * DAY_MS);
    expect(slotAfterFirst - slotAfterSecond).toBe(9n * DAY_MS);
    expect(moduleAfterFirst - moduleAfterSecond).toBe(3n * DAY_MS);
    expect(slotAfterSecond + moduleAfterSecond).toBe(
      retainedDurationMs(slotDuration, 18_000n, 5_400n)
        + retainedDurationMs(moduleDuration, 18_000n, 5_400n),
    );
  });

  it('restores the contribution target when a previously successful refund fails', () => {
    const duration = 90n * DAY_MS;
    const afterSuccessfulRefund = retainedDurationMs(duration, 18_000n, 5_400n);
    const afterFailure = retainedDurationMs(duration, 18_000n, 3_600n);

    expect(afterFailure - afterSuccessfulRefund).toBe(9n * DAY_MS);
  });

  it('keeps a zero-price order whole without dividing by zero', () => {
    expect(retainedDurationMs(30n * DAY_MS, 0n, 0n)).toBe(30n * DAY_MS);
  });

  it('does not persist a partial snapshot when Stripe pagination fails', async () => {
    const repository = new RefundRepository();
    const { stripe } = dependencies({
      repository,
      pages: [
        { object: 'list', data: [stripeRefund('re_test_1', 3_600)], has_more: true },
      ],
    });
    await expect(syncOrderRefunds('701', {
      repository,
      stripe,
      stripeAccountId: 'acct_test',
      livemode: false,
      now: () => NOW,
    })).rejects.toThrow();

    expect(repository.writes.some(({ sql }) => sql.includes('INSERT INTO commerce_refunds'))).toBe(false);
    expect(repository.order.refund_revision).toBe('0');
    expect(repository.order.refund_snapshot_hash).toBeNull();
  });

  it('syncs the full paginated refund set and records the authoritative statuses', async () => {
    const repository = new RefundRepository();
    const { stripe } = dependencies({
      repository,
      pages: [
        { object: 'list', data: [stripeRefund('re_test_2', 1_800)], has_more: true },
        { object: 'list', data: [stripeRefund('re_test_1', 3_600, 'requires_action')], has_more: false },
      ],
    });

    const result = await syncOrderRefunds('701', {
      repository,
      stripe,
      stripeAccountId: 'acct_test',
      livemode: false,
      now: () => NOW,
    });

    expect(result).toMatchObject({ changed: true, refundRevision: 1, refundedTotalCents: '1800', refundState: 'partial' });
    expect(stripe.get).toHaveBeenCalledTimes(2);
    expect(repository.writes.some(({ sql }) => sql.includes('INSERT INTO commerce_refunds'))).toBe(true);
    expect(repository.writes.some(({ sql }) => sql.includes('refund_revision'))).toBe(true);

    const refundWriteCount = repository.writes.filter(({ sql }) => sql.includes('INSERT INTO commerce_refunds')).length;
    const replay = dependencies({
      repository,
      pages: [
        { object: 'list', data: [stripeRefund('re_test_2', 1_800), stripeRefund('re_test_1', 3_600, 'requires_action')], has_more: false },
      ],
    });
    const repeated = await syncOrderRefunds('701', {
      repository,
      stripe: replay.stripe,
      stripeAccountId: 'acct_test',
      livemode: false,
      now: () => NOW,
    });

    expect(repeated).toMatchObject({ changed: false, refundRevision: 1, refundedTotalCents: '1800' });
    expect(repository.writes.filter(({ sql }) => sql.includes('INSERT INTO commerce_refunds'))).toHaveLength(refundWriteCount);
  });

  it('uses the latest Stripe status for a refund ID even when reconciliation runs again', async () => {
    const repository = new RefundRepository();
    for (const [status, expectedTotal, expectedRevision] of [
      ['succeeded', '3_600', 1],
      ['failed', '0', 2],
    ] as const) {
      const { stripe } = dependencies({
        repository,
        pages: [{ object: 'list', data: [stripeRefund('re_test_1', 3_600, status)], has_more: false }],
      });
      const result = await syncOrderRefunds('701', {
        repository,
        stripe,
        stripeAccountId: 'acct_test',
        livemode: false,
        now: () => NOW,
      });
      expect(result).toMatchObject({ changed: true, refundRevision: expectedRevision, refundedTotalCents: expectedTotal.replaceAll('_', '') });
    }
    expect(repository.refunds).toHaveLength(1);
    expect(repository.refunds[0]?.status).toBe('failed');
  });

  it('does not allow an older concurrent Stripe snapshot to overwrite the newer one', async () => {
    const repository = new RefundRepository();
    let releaseOldSnapshot: (snapshot: Record<string, unknown>) => void = () => {};
    let signalOldRequest: () => void = () => {};
    const oldRequestStarted = new Promise<void>((resolve) => { signalOldRequest = resolve; });
    let call = 0;
    const stripe = {
      get: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          signalOldRequest();
          return new Promise<Record<string, unknown>>((resolve) => { releaseOldSnapshot = resolve; });
        }
        return { object: 'list', data: [stripeRefund('re_test_1', 3_600)], has_more: false };
      }),
      post: vi.fn(),
    } as unknown as StripeClient;
    const deps = {
      repository,
      stripe,
      stripeAccountId: 'acct_test',
      livemode: false,
      now: () => NOW,
    };

    const older = syncOrderRefunds('701', deps);
    await oldRequestStarted;
    const newer = await syncOrderRefunds('701', deps);
    releaseOldSnapshot({ object: 'list', data: [], has_more: false });
    const olderResult = await older;

    expect(newer).toMatchObject({ status: 'synced', refundRevision: 1, refundedTotalCents: '3600' });
    expect(olderResult.status).toBe('superseded');
    expect(repository.refunds).toHaveLength(1);
    expect(repository.refunds[0]?.status).toBe('succeeded');
    expect(repository.order.refund_revision).toBe('1');
  });
});
