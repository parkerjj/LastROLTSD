import { createHmac } from 'node:crypto';
import { currentMonthWindow, type SponsorHonorEntry } from './afdian';

/**
 * Stripe 捐款接入（「赛博化缘」页的次要数据来源，与爱发电光荣榜合并展示）。
 *
 * 方案 A：Worker 用 Secret Key 调 Stripe REST API 轮询 checkout sessions，
 * 不建表、不依赖 webhook。Worker 内存缓存与爱发电共用（routes/sponsors.ts）。
 *
 * 收款币种为人民币 CNY（Stripe 把 CNY 视作 2 位小数：amount_total 单位是「分」，
 * 与爱发电一致，可直接累加、按 100 折算成元）。
 */

/** LTSD_RO 在 Stripe 后台创建的 Payment Link 公开捐款地址（外链跳转用）。 */
export const STRIPE_DONATE_URL = 'https://donate.stripe.com/3cI3cxa8B4Q0fY8ejM1RC00';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
/** checkout sessions 翻页上限，避免异常情况下无限回源；100×10 = 1000 笔已足够覆盖光荣榜。 */
const MAX_CHECKOUT_PAGES = 10;
const STRIPE_PAGE_SIZE = 100;
const COMPLETE_STATUS = 'complete';

export interface StripeSponsorData {
  supporters: SponsorHonorEntry[];
  /** 本月（北京时间自然月）累计入账金额（分）。 */
  monthCents: number;
  /** 本月成功支付订单数。 */
  monthOrderCount: number;
}

interface StripePaymentLink {
  id: string;
  url?: string;
}

interface StripePaymentLinksResponse {
  data?: StripePaymentLink[];
  has_more?: boolean;
}

interface StripeCustomerDetails {
  email?: string | null;
  name?: string | null;
}

interface StripeCheckoutSession {
  id: string;
  status?: string;
  payment_status?: string;
  amount_total?: number;
  currency?: string;
  created?: number;
  customer_details?: StripeCustomerDetails | null;
  // Populated by expanding data.payment_intent.latest_charge.balance_transaction.
  payment_intent?: string | {
    latest_charge?: string | {
      created?: number;
      amount_refunded?: number;
      balance_transaction?: string | { created?: number } | null;
    } | null;
  } | null;
  metadata?: { public_name_opt_in?: string; public_display_name?: string } | null;
}

interface StripeCheckoutSessionsResponse {
  data?: StripeCheckoutSession[];
  has_more?: boolean;
}

interface DonorAggregate {
  cents: number;
  lastPaidAt: number;
  publicName: string | null;
}

/** 模块级缓存：解析出的 Payment Link ID 在 Worker 进程内复用，避免每次都列表 payment_links。 */
let cachedPaymentLinkId: string | undefined;

/** 仅供测试：清空内存中的 Payment Link ID 缓存。 */
export function resetStripeCacheForTesting(): void {
  cachedPaymentLinkId = undefined;
}

async function fetchStripeJson<T>(path: string, secretKey: string): Promise<T> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    headers: { authorization: `Bearer ${secretKey}` },
  });
  if (!response.ok) {
    throw new Error(`stripe ${path.split('?')[0]} upstream status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/**
 * 列出当前账户的 payment_links，找到 url === donateUrl 的那条，返回 plink_ 开头的 ID。
 * 缓存命中直接返回，避免每次列表查询。
 */
async function resolvePaymentLinkId(secretKey: string, donateUrl: string): Promise<string> {
  if (cachedPaymentLinkId) return cachedPaymentLinkId;
  const params = new URLSearchParams({ limit: '100' });
  const body = await fetchStripeJson<StripePaymentLinksResponse>(
    `/payment_links?${params.toString()}`,
    secretKey,
  );
  const match = (body.data ?? []).find((item) => item.url === donateUrl);
  if (!match) {
    throw new Error(`stripe payment link not found for url ${donateUrl}`);
  }
  cachedPaymentLinkId = match.id;
  return cachedPaymentLinkId;
}

/** Never expose donor emails as public IDs. The Stripe secret is scoped
 * with a versioned purpose prefix so hashes are not enumerable offline. */
function publicDonorId(key: string, secretKey: string): string {
  const digest = createHmac('sha256', secretKey)
    .update('lastroweb-sponsor-id-v1\0')
    .update(key)
    .digest('hex')
    .slice(0, 32);
  return `stripe:${digest}`;
}

/** Session creation is not payment completion: use payment transaction time,
 * not session.created, when counting the current month's received donations. */
function confirmedPaymentAt(session: StripeCheckoutSession): number | null {
  const intent = session.payment_intent;
  const charge = intent && typeof intent === 'object' ? intent.latest_charge : null;
  if (!charge || typeof charge !== 'object') return null;
  const balance = charge.balance_transaction;
  const settled = balance && typeof balance === 'object' ? Number(balance.created) : NaN;
  const charged = Number(charge.created);
  const at = Number.isSafeInteger(settled) && settled > 0 ? settled : charged;
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

/** Stripe billing name is not an opt-in public name. */
function optedInName(session: StripeCheckoutSession): string | null {
  const metadata = session.metadata;
  if (metadata?.public_name_opt_in !== 'true') return null;
  const value = metadata.public_display_name?.trim();
  if (!value || value.includes('@')) return null;
  return value.slice(0, 40);
}

/** 元值（分）转两位小数字符串，与爱发电光荣榜 amount 口径一致。 */
function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * 抓取某条 Payment Link 下所有 checkout sessions，按 email 聚合为光荣榜条目。
 *
 * 月份统计以支付对应 Charge/Balance Transaction 的时间为准，按北京时间自然月归类，
 * 与 afdian.ts 的 currentMonthWindow 对齐——两者共用同一窗口，可直接相加。
 */
export async function fetchStripeDonors(options: {
  secretKey: string;
  donateUrl?: string;
  nowMs?: number;
}): Promise<StripeSponsorData> {
  const secretKey = options.secretKey;
  const donateUrl = options.donateUrl ?? STRIPE_DONATE_URL;
  const nowMs = options.nowMs ?? Date.now();
  const window = currentMonthWindow(nowMs);

  const paymentLinkId = await resolvePaymentLinkId(secretKey, donateUrl);

  const collected: StripeCheckoutSession[] = [];
  let pages = 0;
  let startingAfter: string | undefined;
  do {
    pages += 1;
    const params = new URLSearchParams({
      payment_link: paymentLinkId,
      limit: String(STRIPE_PAGE_SIZE),
    });
    if (startingAfter) params.set('starting_after', startingAfter);
    params.append('expand[]', 'data.payment_intent.latest_charge.balance_transaction');
    const body = await fetchStripeJson<StripeCheckoutSessionsResponse>(
      `/checkout/sessions?${params.toString()}`,
      secretKey,
    );
    const items = Array.isArray(body.data) ? body.data : [];
    collected.push(...items);
    if (!body.has_more || items.length === 0) break;
    const lastItem = items[items.length - 1];
    if (!lastItem) break;
    startingAfter = lastItem.id;
  } while (pages < MAX_CHECKOUT_PAGES);

  const byEmail = new Map<string, DonorAggregate>();
  let monthCents = 0;
  let monthOrderCount = 0;

  for (const session of collected) {
    if (session.status !== COMPLETE_STATUS || session.payment_status !== 'paid') continue;
    if (session.currency?.toLowerCase() !== 'cny') continue;
    const amountCents = Number(session.amount_total ?? 0);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) continue;
    const intent = session.payment_intent;
    const charge = intent && typeof intent === 'object' ? intent.latest_charge : null;
    const rawRefunded = charge && typeof charge === 'object' ? Number(charge.amount_refunded ?? 0) : 0;
    // Stripe's original balance transaction does not deduct later refunds.
    // Count only the retained part of the Checkout Session payment.
    const refundedCents = Number.isSafeInteger(rawRefunded) && rawRefunded > 0 ? rawRefunded : 0;
    const retainedCents = Math.max(0, amountCents - refundedCents);
    if (retainedCents === 0) continue;
    const email = typeof session.customer_details?.email === 'string'
      ? session.customer_details.email.trim().toLowerCase()
      : '';
    // Email-less sessions belong to distinct donors; do not merge unrelated
    // payments or credit another donor's explicitly opted-in public name.
    const key = email || `session:${session.id}`;
    const publicName = optedInName(session);
    const paidAt = confirmedPaymentAt(session);
    const existing = byEmail.get(key);
    if (existing) {
      existing.cents += retainedCents;
      if (paidAt !== null && paidAt > existing.lastPaidAt) existing.lastPaidAt = paidAt;
      if (!existing.publicName && publicName) existing.publicName = publicName;
    } else {
      byEmail.set(key, {
        cents: retainedCents,
        lastPaidAt: paidAt ?? 0,
        publicName,
      });
    }
    if (paidAt !== null && paidAt >= window.startSec && paidAt < window.endSec) {
      monthCents += retainedCents;
      monthOrderCount += 1;
    }
  }

  const supporters: SponsorHonorEntry[] = [];
  for (const [key, agg] of byEmail.entries()) {
    supporters.push({
      id: publicDonorId(key, secretKey),
      name: agg.publicName || '匿名善人',
      avatar: '',
      url: '',
      amount: centsToYuan(agg.cents),
      lastPayAt: agg.lastPaidAt > 0 ? agg.lastPaidAt : null,
      source: 'stripe',
    });
  }

  supporters.sort((a, b) => {
    const amountDiff = Number.parseFloat(b.amount) - Number.parseFloat(a.amount);
    if (amountDiff !== 0) return amountDiff;
    return (b.lastPayAt ?? 0) - (a.lastPayAt ?? 0);
  });

  return { supporters, monthCents, monthOrderCount };
}
