import type { AuthSessionResponse } from '../auth/types';
import type { CommerceRepository, CommerceTransaction } from './repository';
import { assertCommerceId } from './repository';
import type { StripeClient } from './stripe-client';

export interface CommerceCustomer {
  userId: string;
  stripeAccountId: string;
  livemode: boolean;
  stripeCustomerId: string;
}

export interface CommerceCustomerDependencies {
  repository: CommerceRepository;
  stripe: StripeClient;
  stripeAccountId: string;
  livemode: boolean;
  now: () => number;
}

interface CustomerRow {
  user_id: string | number | bigint;
  stripe_account_id: string;
  stripe_livemode: number | boolean | string;
  stripe_customer_id: string;
}

export class CommerceCustomerError extends Error {
  constructor() {
    super('无法初始化支付客户，请稍后重试');
    this.name = 'CommerceCustomerError';
  }
}

function readCustomer(row: CustomerRow, expectedUserId: string, stripeAccountId: string, livemode: boolean): CommerceCustomer {
  const stripeLivemode = row.stripe_livemode === true || row.stripe_livemode === 1 || row.stripe_livemode === '1';
  const validStripeLivemode = stripeLivemode || row.stripe_livemode === false || row.stripe_livemode === 0 || row.stripe_livemode === '0';
  if (!validStripeLivemode) throw new CommerceCustomerError();
  const customer: CommerceCustomer = {
    userId: assertCommerceId(String(row.user_id)),
    stripeAccountId: String(row.stripe_account_id),
    livemode: stripeLivemode,
    stripeCustomerId: String(row.stripe_customer_id),
  };
  if (customer.userId !== expectedUserId || customer.stripeAccountId !== stripeAccountId || customer.livemode !== livemode || !/^cus_[A-Za-z0-9]+$/u.test(customer.stripeCustomerId)) {
    throw new CommerceCustomerError();
  }
  return customer;
}

async function findCustomer(tx: CommerceTransaction, userId: string, stripeAccountId: string, livemode: boolean): Promise<CommerceCustomer | null> {
  const row = await tx.first<CustomerRow>(
    `SELECT user_id, stripe_account_id, stripe_livemode, stripe_customer_id
       FROM commerce_customers
      WHERE user_id = ? AND stripe_account_id = ? AND stripe_livemode = ?
      LIMIT 1`,
    [userId, stripeAccountId, livemode ? 1 : 0],
  );
  return row ? readCustomer(row, userId, stripeAccountId, livemode) : null;
}

export async function ensureCommerceCustomer(
  userIdInput: string,
  identity: AuthSessionResponse['user'],
  dependencies: CommerceCustomerDependencies,
): Promise<CommerceCustomer> {
  const userId = assertCommerceId(userIdInput);
  const stripeAccountId = dependencies.stripeAccountId;
  if (!/^acct_[A-Za-z0-9]+$/u.test(stripeAccountId) || identity.id !== userId || typeof identity.email !== 'string' || !identity.email.includes('@')) {
    throw new CommerceCustomerError();
  }
  const now = dependencies.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('invalid commerce customer timestamp');

  const existing = await dependencies.repository.transaction(async (tx) => {
    if (!(await tx.lockUser(userId))) throw new CommerceCustomerError();
    return findCustomer(tx, userId, stripeAccountId, dependencies.livemode);
  });
  if (existing) return existing;

  const stripeCustomer = await dependencies.stripe.post<{ id?: unknown }>('/customers', {
    email: identity.email,
    name: identity.display_name,
    metadata: { ltsd_user_id: userId },
  }, {
    idempotencyKey: `ke-commerce:customer:v1:${dependencies.livemode ? 'live' : 'test'}:${stripeAccountId}:${userId}`,
  });
  if (typeof stripeCustomer.id !== 'string' || !/^cus_[A-Za-z0-9]+$/u.test(stripeCustomer.id)) throw new CommerceCustomerError();

  return dependencies.repository.transaction(async (tx) => {
    if (!(await tx.lockUser(userId))) throw new CommerceCustomerError();
    await tx.run(
      `INSERT IGNORE INTO commerce_customers
         (user_id, stripe_account_id, stripe_livemode, stripe_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, stripeAccountId, dependencies.livemode ? 1 : 0, stripeCustomer.id, now, now],
    );
    const persisted = await findCustomer(tx, userId, stripeAccountId, dependencies.livemode);
    if (!persisted) throw new CommerceCustomerError();
    return persisted;
  });
}
