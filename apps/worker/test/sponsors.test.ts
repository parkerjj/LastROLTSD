import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AFDIAN_API_BASE,
  buildAfdianSignedRequest,
  currentMonthWindow,
  fetchSponsorSummary,
  parseAfdianTime,
} from '../src/domain/afdian';
import type { AppEnv } from '../src/env';
import { registerSponsorRoutes, resetSponsorSummaryCacheForTesting } from '../src/routes/sponsors';

const TOKEN = 'test-afdian-token';
const USER_ID = 'cc5b9728bd2111f185435254001e7c00';

function makeEnv(token: string | undefined): AppEnv {
  return {
    ENVIRONMENT: 'local',
    BUILD_VERSION: 'test',
    MAX_BODY_BYTES: 512 * 1024,
    ...(token ? { AFDIAN_TOKEN: token, AFDIAN_USER_ID: USER_ID } : {}),
  } as AppEnv;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 秒级时间戳格式化为爱发货返回的北京时间字符串 "YYYY-MM-DD HH:mm:ss"。 */
function beijingString(sec: number): string {
  const d = new Date(sec * 1000 + 8 * 3600_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function expectedSign(paramsJson: string, ts: number): string {
  return createHash('md5').update(`${TOKEN}params${paramsJson}ts${ts}user_id${USER_ID}`).digest('hex');
}

describe('afdian signing and time helpers', () => {
  it('builds the canonical md5 sign over params/ts/user_id', () => {
    const request = buildAfdianSignedRequest(USER_ID, TOKEN, { page: 1, per_page: 100 }, 1727740800);
    expect(request).toEqual({
      user_id: USER_ID,
      params: '{"page":1,"per_page":100}',
      ts: 1727740800,
      sign: createHash('md5').update(`${TOKEN}params{"page":1,"per_page":100}ts1727740800user_id${USER_ID}`).digest('hex'),
    });
  });

  it('computes Beijing natural-month windows', () => {
    // 2026-10-15 12:00 UTC = 20:00 Beijing, still October.
    const october = currentMonthWindow(Date.UTC(2026, 9, 15, 12, 0, 0));
    expect(october.key).toBe('2026-10');
    expect(october.label).toBe('2026 年 10 月');
    // 月初边界：2026-09-30 16:00 UTC = 2026-10-01 00:00 Beijing。
    expect(october.startSec).toBe(Math.floor(Date.UTC(2026, 8, 30, 16, 0, 0) / 1000));
    // 月末边界：2026-10-31 16:00 UTC = 2026-11-01 00:00 Beijing（区间右开）。
    expect(october.endSec).toBe(Math.floor(Date.UTC(2026, 9, 31, 16, 0, 0) / 1000));

    // 2026-12-31 17:30 UTC = 2027-01-01 01:30 Beijing，必须跨入新年。
    const january = currentMonthWindow(Date.UTC(2026, 11, 31, 17, 30, 0));
    expect(january.key).toBe('2027-01');
  });

  it('parses Beijing strings, seconds and milliseconds', () => {
    // 2026-10-01 00:00:00 Beijing = 2026-09-30 16:00 UTC。
    expect(parseAfdianTime('2026-10-01 00:00:00')).toBe(Math.floor(Date.UTC(2026, 8, 30, 16, 0, 0) / 1000));
    expect(parseAfdianTime(1727740800)).toBe(1727740800);
    expect(parseAfdianTime('1727740800')).toBe(1727740800);
    expect(parseAfdianTime(1727740800000)).toBe(1727740800);
    expect(parseAfdianTime('not-a-date')).toBeNull();
    expect(parseAfdianTime(undefined)).toBeNull();
  });
});

describe('fetchSponsorSummary', () => {
  it('paginates, verifies signatures, filters the current month and ranks supporters', async () => {
    const nowMs = Date.UTC(2026, 9, 15, 12, 0, 0);
    const window = currentMonthWindow(nowMs);
    const inMonthTime = beijingString(window.startSec + 3600);
    const lastMonthTime = beijingString(window.startSec - 86_400);

    const sponsorPageOne = [
      {
        all_sum_amount: '66.00',
        last_pay_time: window.startSec + 7200,
        user: { user_id: 'alice-uid', name: '爱丽丝', avatar: 'https://img.example/alice.jpg' },
      },
      {
        // 累计金额最高，应排榜首。
        all_sum_amount: '188.50',
        last_pay_time: window.startSec + 100,
        user: { user_id: 'bob-uid', name: 'Bob', avatar: 'https://img.example/bob.jpg' },
      },
      {
        // 爱发电默认匿名昵称，回退为 user_id 前 5 位。
        all_sum_amount: '9.90',
        last_pay_time: null,
        user: { user_id: 'guest123456', name: '爱发电用户_xxx', avatar: '' },
      },
      {
        // 累计为 0（兑换码等），不进光荣榜。
        all_sum_amount: '0.00',
        user: { user_id: 'free-uid', name: 'FreeLoader', avatar: '' },
      },
    ];
    const sponsorPageTwo = [
      {
        all_sum_amount: '30',
        user: { user_id: 'carol-uid', name: '卡萝' },
      },
    ];

    const orders = [
      { status: 2, total_amount: '10.00', create_time: inMonthTime },
      { status: 2, total_amount: '2.50', create_time: inMonthTime },
      { status: 3, total_amount: '999.00', create_time: inMonthTime },
      { status: 2, total_amount: '50.00', create_time: lastMonthTime },
      { status: 2, total_amount: '8.00', create_time: 'bad-time' },
    ];

    const seenPages: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as { user_id: string; params: string; ts: number; sign: string };
      expect(body.user_id).toBe(USER_ID);
      const params = JSON.parse(body.params) as { page: number; per_page?: number };
      expect(body.sign).toBe(expectedSign(body.params, body.ts));

      if (url === `${AFDIAN_API_BASE}/query-sponsor`) {
        seenPages.push(`query-sponsor:${params.page}`);
        const list = params.page === 1 ? sponsorPageOne : sponsorPageTwo;
        return jsonResponse({ ec: 200, em: '', data: { total_count: 5, total_page: 2, list } });
      }
      if (url === `${AFDIAN_API_BASE}/query-order`) {
        seenPages.push(`query-order:${params.page}`);
        // 订单接口必须带 100 条/页参数，且只请求第一页。
        expect(params.per_page).toBe(100);
        expect(params.page).toBe(1);
        return jsonResponse({ ec: 200, em: '', data: { total_count: orders.length, total_page: 1, list: orders } });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as typeof fetch);

    try {
      const summary = await fetchSponsorSummary({ userId: USER_ID, token: TOKEN, nowMs });
      expect(summary.month).toBe('2026-10');
      expect(summary.monthLabel).toBe('2026 年 10 月');
      expect(summary.monthIncome).toBe('12.50');
      expect(summary.monthOrderCount).toBe(2);
      expect(summary.supporterCount).toBe(4);
      expect(summary.supporters.map((s) => s.id)).toEqual(['bob-uid', 'alice-uid', 'carol-uid', 'guest123456']);
      expect(summary.supporters[0]!.amount).toBe('188.50');
      // 匿名昵称回退 + 空头像容错。
      const guest = summary.supporters.find((s) => s.id === 'guest123456');
      expect(guest?.name).toBe('guest');
      expect(guest?.avatar).toBe('');
      expect(guest?.url).toBe('https://afdian.com/u/guest123456');
      // 赞助者翻到了第二页，订单只拉第一页。
      expect(seenPages).toContain('query-sponsor:2');
      expect(seenPages).not.toContain('query-order:2');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('throws on non-200 ec envelopes', async () => {
    // Promise.all 会并发请求两个接口，每次都要返回全新的 Response，
    // 否则 body 只能消费一次会得到 "Body is unusable"。
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ ec: 401, em: 'invalid sign', data: null }),
    );
    try {
      await expect(fetchSponsorSummary({ userId: USER_ID, token: TOKEN })).rejects.toThrow(/ec=401/);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('GET /api/v1/sponsors route', () => {
  beforeEach(() => {
    resetSponsorSummaryCacheForTesting();
  });

  it('returns 503 when no token is configured', async () => {
    const app = new Hono();
    registerSponsorRoutes(app, makeEnv(undefined));
    const response = await app.request('/api/v1/sponsors');
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns summary JSON, caches in memory for 10 minutes and never leaks the token', async () => {
    const window = currentMonthWindow();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('query-order')) {
        return jsonResponse({
          ec: 200,
          data: {
            total_page: 1,
            list: [{ status: 2, total_amount: '5.20', create_time: beijingString(window.startSec + 60) }],
          },
        });
      }
      return jsonResponse({
        ec: 200,
        data: {
          total_page: 1,
          list: [
            { all_sum_amount: '5.20', user: { user_id: 'alice-uid', name: '爱丽丝', avatar: '' } },
          ],
        },
      });
    });

    try {
      const app = new Hono();
      registerSponsorRoutes(app, makeEnv(TOKEN));

      const first = await app.request('/api/v1/sponsors');
      expect(first.status).toBe(200);
      expect(first.headers.get('x-cache')).toBe('miss');
      expect(first.headers.get('cache-control')).toContain('s-maxage=900');
      const firstBody = (await first.json()) as { monthIncome: string; supporters: unknown[] };
      expect(firstBody.monthIncome).toBe('5.20');
      expect(firstBody.supporters).toHaveLength(1);

      const second = await app.request('/api/v1/sponsors');
      expect(second.status).toBe(200);
      expect(second.headers.get('x-cache')).toBe('hit');
      // 两次请求只回源一轮（sponsor + order 各一次）。
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(firstBody)).not.toContain(TOKEN);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('returns 502 when the upstream fails and no cached payload exists', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream down', { status: 502 }));
    try {
      const app = new Hono();
      registerSponsorRoutes(app, makeEnv(TOKEN));
      const failed = await app.request('/api/v1/sponsors');
      expect(failed.status).toBe(502);
      expect(failed.headers.get('cache-control')).toBe('no-store');
      const body = (await failed.json()) as { error?: { message?: string } };
      expect(body.error?.message).toBeTruthy();
      // 错误体里绝不能带上 token。
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('serves stale payload when the upstream fails after the in-memory TTL expires', async () => {
    const baseNow = Date.UTC(2026, 9, 15, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(baseNow);
    const window = currentMonthWindow(baseNow);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      // fetchSponsorSummary 中 query-order 先发起、query-sponsor 后发起。
      .mockImplementationOnce(async () => jsonResponse({
        ec: 200,
        data: { total_page: 1, list: [{ status: 2, total_amount: '1.00', create_time: beijingString(window.startSec + 60) }] },
      }))
      .mockImplementationOnce(async () => jsonResponse({ ec: 200, data: { total_page: 1, list: [] } }))
      // TTL 过期后的回源全部失败。
      .mockResolvedValue(new Response('upstream down', { status: 502 }));

    try {
      const app = new Hono();
      registerSponsorRoutes(app, makeEnv(TOKEN));

      const fresh = await app.request('/api/v1/sponsors');
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get('x-cache')).toBe('miss');

      vi.advanceTimersByTime(11 * 60_000);

      const stale = await app.request('/api/v1/sponsors');
      expect(stale.status).toBe(200);
      expect(stale.headers.get('x-cache')).toBe('stale');
      expect(stale.headers.get('cache-control')).toBe('no-store');
      const body = (await stale.json()) as { monthIncome: string };
      expect(body.monthIncome).toBe('1.00');
    } finally {
      fetchMock.mockRestore();
      vi.useRealTimers();
    }
  });
});
