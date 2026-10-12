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
const ANONYMOUS_KEY = '__anonymous__';

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
  amount_total?: number;
  currency?: string;
  created?: number;
  customer_details?: StripeCustomerDetails | null;
}

interface StripeCheckoutSessionsResponse {
  data?: StripeCheckoutSession[];
  has_more?: boolean;
}

interface DonorAggregate {
  cents: number;
  lastCreated: number;
  name: string | null;
  email: string | null;
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

/** 元值（分）转两位小数字符串，与爱发电光荣榜 amount 口径一致。 */
function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * 抓取某条 Payment Link 下所有 checkout sessions，按 email 聚合为光荣榜条目。
 *
 * 月份统计以 Stripe 服务器返回的 created（Unix 秒）为准，按北京时间自然月归类，
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
    if (session.status !== COMPLETE_STATUS) continue;
    const amountCents = Number(session.amount_total ?? 0);
    if (!Number.isFinite(amountCents) || amountCents <= 0) continue;
    const email = typeof session.customer_details?.email === 'string'
      ? session.customer_details.email.trim().toLowerCase()
      : '';
    const key = email || ANONYMOUS_KEY;
    const name = typeof session.customer_details?.name === 'string'
      ? session.customer_details.name.trim()
      : null;
    const created = Number(session.created ?? 0);
    const existing = byEmail.get(key);
    if (existing) {
      existing.cents += amountCents;
      if (created > existing.lastCreated) existing.lastCreated = created;
      if (!existing.name && name) existing.name = name;
    } else {
      byEmail.set(key, {
        cents: amountCents,
        lastCreated: created,
        name,
        email: email || null,
      });
    }
    if (created >= window.startSec && created < window.endSec) {
      monthCents += amountCents;
      monthOrderCount += 1;
    }
  }

  const supporters: SponsorHonorEntry[] = [];
  for (const [key, agg] of byEmail.entries()) {
    const emailLocalPart = agg.email ? (agg.email.split('@')[0] ?? '') : '';
    const displayName = agg.name?.trim() || emailLocalPart || '匿名善人';
    supporters.push({
      id: `stripe:${key === ANONYMOUS_KEY ? 'anon' : key}`,
      name: displayName,
      avatar: '',
      url: '',
      amount: centsToYuan(agg.cents),
      lastPayAt: agg.lastCreated > 0 ? agg.lastCreated : null,
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
