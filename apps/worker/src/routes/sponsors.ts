import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { DEFAULT_AFDIAN_USER_ID, fetchSponsorSummary, type SponsorHonorEntry, type SponsorSummary } from '../domain/afdian';
import { STRIPE_DONATE_URL, fetchStripeDonors } from '../domain/stripe';
import { logError } from '../observability';

/**
 * 赛博化缘数据路由。
 *
 *   GET /api/v1/sponsors
 *     → { month, monthLabel, monthIncome, monthOrderCount, supporterCount, supporters, generatedAt }
 *
 * 主源爱发电 + 次源 Stripe 合并光荣榜；两者都只把机密 token/key 留在 Worker secret，
 * 浏览器永远接触不到。Worker 内存缓存 10 分钟，边缘/浏览器再缓存 5/15 分钟，回源压力极低。
 * 上游偶发失败时若存在上一次成功结果，则降级返回旧数据（x-cache: stale）。
 *
 * 缺省配置策略：
 * - AFDIAN_TOKEN 缺省 → 503（爱发电是主源，主源没了就报错）；
 * - STRIPE_SECRET_KEY 缺省 → 静默跳过，光荣榜只展示爱发电；
 * - STRIPE_SECRET_KEY 存在但 Stripe 调用失败 → logError 后降级为只爱发电。
 */

const SUMMARY_CACHE_TTL_MS = 10 * 60_000;
const RESPONSE_CACHE_CONTROL = 'public, max-age=300, s-maxage=900';

interface SummaryCacheEntry {
  payload: SponsorSummary;
  fetchedAt: number;
}

let summaryCache: SummaryCacheEntry | undefined;

/** 仅供测试：清空内存中的合并汇总缓存。 */
export function resetSponsorSummaryCacheForTesting(): void {
  summaryCache = undefined;
}

export function registerSponsorRoutes(app: Hono<any>, env: AppEnv): void {
  app.get('/api/v1/sponsors', async (c) => {
    // Public configuration: same link that the server queries via Stripe.
    const stripeDonateUrl = env.STRIPE_DONATE_URL || STRIPE_DONATE_URL;
    const token = env.AFDIAN_TOKEN;
    if (!token) {
      return c.json(
        { error: { message: 'sponsor feed is not configured' } },
        503,
        { 'cache-control': 'no-store' },
      );
    }

    const now = Date.now();
    if (summaryCache && now - summaryCache.fetchedAt < SUMMARY_CACHE_TTL_MS) {
      return c.json({ ...summaryCache.payload, stripeDonateUrl }, 200, {
        'cache-control': RESPONSE_CACHE_CONTROL,
        'x-cache': 'hit',
      });
    }

    try {
      const afdianSummary = await fetchSponsorSummary({
        userId: env.AFDIAN_USER_ID || DEFAULT_AFDIAN_USER_ID,
        token,
      });
      const merged = await mergeStripeSupporters(env, afdianSummary);
      summaryCache = { payload: merged, fetchedAt: Date.now() };
      return c.json({ ...merged, stripeDonateUrl }, 200, { 'cache-control': RESPONSE_CACHE_CONTROL, 'x-cache': 'miss' });
    } catch (error) {
      logError('lastroweb.afdian_sponsor_error', error, {
        request_id: c.get('requestId') as string | undefined,
      });
      if (summaryCache) {
        return c.json({ ...summaryCache.payload, stripeDonateUrl }, 200, { 'cache-control': 'no-store', 'x-cache': 'stale' });
      }
      return c.json(
        { error: { message: 'sponsor feed temporarily unavailable' } },
        502,
        { 'cache-control': 'no-store' },
      );
    }
  });
}

/**
 * 拉取 Stripe 捐款者并合并到爱发电汇总里。Stripe 缺省或失败时静默降级为纯爱发电。
 *
 * 合并规则：
 * - 金额按「分」相加后转回两位小数元字符串（爱发电 amount_total 与 Stripe amount_total 单位一致）；
 * - supporters 按 amount 降序、lastPayAt 降序重排，两源同台竞争榜首；
 * - source 字段透传给前端用于来源徽章（爱发电=金色描边、Stripe=紫色实底）。
 */
async function mergeStripeSupporters(env: AppEnv, afdianSummary: SponsorSummary): Promise<SponsorSummary> {
  if (!env.STRIPE_SECRET_KEY) return afdianSummary;
  try {
    const stripeData = await fetchStripeDonors({
      secretKey: env.STRIPE_SECRET_KEY,
      donateUrl: env.STRIPE_DONATE_URL || STRIPE_DONATE_URL,
    });
    const mergedSupporters = mergeSortedHonorRoll(afdianSummary.supporters, stripeData.supporters);
    const afdianMonthCents = Math.round(Number.parseFloat(afdianSummary.monthIncome) * 100);
    const monthCents = afdianMonthCents + stripeData.monthCents;
    const monthOrderCount = afdianSummary.monthOrderCount + stripeData.monthOrderCount;
    return {
      ...afdianSummary,
      monthIncome: (monthCents / 100).toFixed(2),
      monthOrderCount,
      supporterCount: mergedSupporters.length,
      supporters: mergedSupporters,
    };
  } catch (error) {
    logError('lastroweb.stripe_sponsor_error', error, {});
    return afdianSummary;
  }
}

function mergeSortedHonorRoll(afdian: SponsorHonorEntry[], stripe: SponsorHonorEntry[]): SponsorHonorEntry[] {
  return [...afdian, ...stripe].sort((a, b) => {
    const amountDiff = Number.parseFloat(b.amount) - Number.parseFloat(a.amount);
    if (amountDiff !== 0) return amountDiff;
    return (b.lastPayAt ?? 0) - (a.lastPayAt ?? 0);
  });
}
