import { createHash } from 'node:crypto';

/**
 * 爱发电开放平台对接（「赛博化缘」页的数据来源）。
 * 官方文档：https://afdian.com/p/9c65d9cc617011ed81c352540025c377
 *
 * 鉴权方式：API token 不随请求传输，只参与 MD5 签名：
 *   sign = md5(`${token}params${paramsJson}ts${ts}user_id${userId}`)
 * 赞助者列表与订单列表分别 POST 到 query-sponsor / query-order。
 *
 * 本模块只包含纯计算与无状态抓取逻辑，内存缓存与响应细节在 routes/sponsors.ts。
 */

export const AFDIAN_API_BASE = 'https://afdian.com/api/open';
/**
 * LTSD_RO 创作者的公开 user_id。
 * 该值不是机密：爱发电创作者主页、头像 CDN 地址等公开页面均可看到；
 * 真正的机密是 API token（AFDIAN_TOKEN，仅存在于 Worker secret）。
 */
export const DEFAULT_AFDIAN_USER_ID = 'cc5b9728bd2111f185435254001e7c00';
/** 赛博化缘页对外的打赏入口。 */
export const AFDIAN_SPONSOR_PAGE_URL = 'https://afdian.com/a/LTSD_RO';

/** 爱发电文档约定：status=2 表示交易成功（目前接口也只会推送成功单）。 */
const PAID_ORDER_STATUS = 2;
/** 赞助者每页 20 条，最多翻 10 页（200 位），避免异常情况下无限回源。 */
const MAX_SPONSOR_PAGES = 10;
/** 订单请求每页 100 条，最多翻 6 页（600 单）；按月统计只需覆盖近月数据。 */
const MAX_ORDER_PAGES = 6;
const ORDER_PAGE_SIZE = 100;
/** 爱发电服务器时间均为北京时间（UTC+8）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

export interface SponsorHonorEntry {
  /** 爱发电用户 ID（公开，非隐私信息）。 */
  id: string;
  name: string;
  avatar: string;
  url: string;
  /** 累计赞助金额（元，两位小数字符串，爱发电展示口径 all_sum_amount）。 */
  amount: string;
  /** 最近一次赞助的秒级时间戳，无记录时为 null。 */
  lastPayAt: number | null;
}

export interface SponsorSummary {
  /** 统计所属自然月（北京时间），格式 YYYY-MM。 */
  month: string;
  monthLabel: string;
  /** 本月真实入账金额（元，两位小数字符串，合计 total_amount）。 */
  monthIncome: string;
  /** 本月成功支付订单数。 */
  monthOrderCount: number;
  /** 光荣榜人数（累计实付大于 0 的赞助者）。 */
  supporterCount: number;
  supporters: SponsorHonorEntry[];
  /** 汇总生成时间（毫秒）。 */
  generatedAt: number;
}

export interface AfdianSignedRequest {
  user_id: string;
  params: string;
  ts: number;
  sign: string;
}

interface AfdianListData {
  total_count?: number;
  total_page?: number;
  list?: unknown[];
}

interface RawSponsorUser {
  user_id?: unknown;
  name?: unknown;
  avatar?: unknown;
}

interface RawSponsor {
  all_sum_amount?: unknown;
  last_pay_time?: unknown;
  user?: RawSponsorUser;
}

interface RawOrder {
  status?: unknown;
  total_amount?: unknown;
  create_time?: unknown;
  pay_time?: unknown;
}

/**
 * 按官方规则构造签名请求体。
 * 注意参数 key 顺序固定，除 token 外直接拼接 key+value，无任何连接符。
 */
export function buildAfdianSignedRequest(
  userId: string,
  token: string,
  params: Record<string, unknown>,
  ts: number = Math.floor(Date.now() / 1000),
): AfdianSignedRequest {
  const paramsJson = JSON.stringify(params);
  const sign = createHash('md5')
    .update(`${token}params${paramsJson}ts${ts}user_id${userId}`)
    .digest('hex');
  return { user_id: userId, params: paramsJson, ts, sign };
}

/** 当前北京时间自然月窗口：[月初秒, 下月初秒)。 */
export function currentMonthWindow(nowMs: number = Date.now()): {
  key: string;
  label: string;
  startSec: number;
  endSec: number;
} {
  const beijingNow = new Date(nowMs + BEIJING_OFFSET_MS);
  const year = beijingNow.getUTCFullYear();
  const monthIndex = beijingNow.getUTCMonth();
  const startMs = Date.UTC(year, monthIndex, 1) - BEIJING_OFFSET_MS;
  const endMs = Date.UTC(year, monthIndex + 1, 1) - BEIJING_OFFSET_MS;
  const monthNumber = monthIndex + 1;
  return {
    key: `${year}-${String(monthNumber).padStart(2, '0')}`,
    label: `${year} 年 ${monthNumber} 月`,
    startSec: Math.floor(startMs / 1000),
    endSec: Math.floor(endMs / 1000),
  };
}

/**
 * 解析爱发电时间字段为秒级时间戳。
 * 订单 create_time 实测为北京时间字符串 "YYYY-MM-DD HH:mm:ss"，
 * 这里同时兼容纯数字（秒/毫秒）与缺失场景，返回 null 表示无法判定月份。
 */
export function parseAfdianTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/u.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return null;
      return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(trimmed);
    if (match) {
      const [, year, month, day, hour, minute, second] = match;
      const utcMs = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      );
      return Math.floor((utcMs - BEIJING_OFFSET_MS) / 1000);
    }
  }
  return null;
}

/** 元转分（整数），规避浮点累加误差。 */
function yuanToCents(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric * 100);
}

function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

async function postAfdianList(
  service: 'query-sponsor' | 'query-order',
  userId: string,
  token: string,
  params: Record<string, unknown>,
): Promise<AfdianListData> {
  const body = buildAfdianSignedRequest(userId, token, params);
  const response = await fetch(`${AFDIAN_API_BASE}/${service}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`afdian ${service} upstream status ${response.status}`);
  }
  const envelope = (await response.json()) as { ec?: number; em?: string; data?: AfdianListData };
  if (envelope.ec !== 200 || !envelope.data) {
    throw new Error(`afdian ${service} rejected: ec=${String(envelope.ec)} em=${envelope.em ?? ''}`);
  }
  return envelope.data;
}

/**
 * 翻页拉全一个列表接口。爱发电返回 total_page；首页之外的页数按顺序拉取。
 * 调用方通过 maxPages 限定预算。
 */
async function fetchAllPages(
  service: 'query-sponsor' | 'query-order',
  userId: string,
  token: string,
  extraParams: Record<string, unknown>,
  maxPages: number,
): Promise<{ list: unknown[]; totalCount: number }> {
  const collected: unknown[] = [];
  let page = 1;
  let totalPages = 1;
  let totalCount = 0;
  do {
    const data = await postAfdianList(service, userId, token, { page, ...extraParams });
    const pageItems = Array.isArray(data.list) ? data.list : [];
    collected.push(...pageItems);
    totalCount = Number(data.total_count ?? collected.length);
    totalPages = Number(data.total_page ?? 1);
    if (!Number.isFinite(totalPages) || totalPages < 1) break;
    page += 1;
  } while (page <= totalPages && page <= maxPages);
  return { list: collected, totalCount };
}

/**
 * 拉取并汇总赛博化缘页需要的全部数据：
 * - query-order：合计当前北京时间自然月的成功支付金额与订单数；
 * - query-sponsor：构建累计赞助光荣榜。
 */
export async function fetchSponsorSummary(options: {
  userId: string;
  token: string;
  nowMs?: number;
}): Promise<SponsorSummary> {
  const { userId, token } = options;
  const nowMs = options.nowMs ?? Date.now();
  const window = currentMonthWindow(nowMs);

  const [ordersResult, sponsorsResult] = await Promise.all([
    fetchAllPages('query-order', userId, token, { per_page: ORDER_PAGE_SIZE }, MAX_ORDER_PAGES),
    fetchAllPages('query-sponsor', userId, token, {}, MAX_SPONSOR_PAGES),
  ]);

  let monthCents = 0;
  let monthOrderCount = 0;
  for (const raw of ordersResult.list as RawOrder[]) {
    if (Number(raw.status) !== PAID_ORDER_STATUS) continue;
    const paidAt = parseAfdianTime(raw.create_time ?? raw.pay_time);
    // 无法判定时间的订单保守地不计入本月；不影响光荣榜（以赞助者接口为准）。
    if (paidAt === null || paidAt < window.startSec || paidAt >= window.endSec) continue;
    monthCents += yuanToCents(raw.total_amount);
    monthOrderCount += 1;
  }

  const supporters = (sponsorsResult.list as RawSponsor[])
    .map((raw): SponsorHonorEntry | null => {
      const user = raw.user;
      const id = typeof user?.user_id === 'string' ? user.user_id : '';
      if (!id) return null;
      const cents = yuanToCents(raw.all_sum_amount);
      if (cents <= 0) return null;
      const rawName = typeof user?.name === 'string' ? user.name.trim() : '';
      // 未设置昵称时爱发电返回「爱发电用户_xxx」，与官方展示惯例一致，截取 ID 前 5 位。
      const name = rawName === '' || rawName.startsWith('爱发电用户_') ? id.slice(0, 5) : rawName;
      return {
        id,
        name,
        avatar: typeof user?.avatar === 'string' ? user.avatar : '',
        url: `https://afdian.com/u/${id}`,
        amount: centsToYuan(cents),
        lastPayAt: parseAfdianTime(raw.last_pay_time),
      };
    })
    .filter((entry): entry is SponsorHonorEntry => entry !== null)
    .sort((a, b) => {
      const amountDiff = Number.parseFloat(b.amount) - Number.parseFloat(a.amount);
      if (amountDiff !== 0) return amountDiff;
      return (b.lastPayAt ?? 0) - (a.lastPayAt ?? 0);
    });

  return {
    month: window.key,
    monthLabel: window.label,
    monthIncome: centsToYuan(monthCents),
    monthOrderCount,
    supporterCount: supporters.length,
    supporters,
    generatedAt: nowMs,
  };
}
