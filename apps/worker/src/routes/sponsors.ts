import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { DEFAULT_AFDIAN_USER_ID, fetchSponsorSummary, type SponsorSummary } from '../domain/afdian';
import { logError } from '../observability';

/**
 * 赛博化缘数据路由。
 *
 *   GET /api/v1/sponsors
 *     → { month, monthLabel, monthIncome, monthOrderCount, supporterCount, supporters, generatedAt }
 *
 * 爱发电 token 只保存在 Worker secret 中，浏览器永远接触不到；
 * Worker 内存缓存 10 分钟，边缘/浏览器再缓存 5/15 分钟，回源压力极低。
 * 上游偶发失败时若存在上一次成功结果，则降级返回旧数据（x-cache: stale）。
 */

const SUMMARY_CACHE_TTL_MS = 10 * 60_000;
const RESPONSE_CACHE_CONTROL = 'public, max-age=300, s-maxage=900';

interface SummaryCacheEntry {
  payload: SponsorSummary;
  fetchedAt: number;
}

let summaryCache: SummaryCacheEntry | undefined;

/** 仅供测试：清空内存中的爱发电汇总缓存。 */
export function resetSponsorSummaryCacheForTesting(): void {
  summaryCache = undefined;
}

export function registerSponsorRoutes(app: Hono<any>, env: AppEnv): void {
  app.get('/api/v1/sponsors', async (c) => {
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
      return c.json(summaryCache.payload, 200, {
        'cache-control': RESPONSE_CACHE_CONTROL,
        'x-cache': 'hit',
      });
    }

    try {
      const payload = await fetchSponsorSummary({
        userId: env.AFDIAN_USER_ID || DEFAULT_AFDIAN_USER_ID,
        token,
      });
      summaryCache = { payload, fetchedAt: Date.now() };
      return c.json(payload, 200, { 'cache-control': RESPONSE_CACHE_CONTROL, 'x-cache': 'miss' });
    } catch (error) {
      logError('lastroweb.afdian_sponsor_error', error, {
        request_id: c.get('requestId') as string | undefined,
      });
      if (summaryCache) {
        return c.json(summaryCache.payload, 200, { 'cache-control': 'no-store', 'x-cache': 'stale' });
      }
      return c.json(
        { error: { message: 'sponsor feed temporarily unavailable' } },
        502,
        { 'cache-control': 'no-store' },
      );
    }
  });
}
