/// <reference types="vite/client" />

// 51.la V6 站点统计。
// 仅在生产构建中异步加载 SDK，避免本地开发与测试环境污染统计数据。

const LA_SDK_URL = 'https://sdk.51.la/js-sdk-pro.min.js';
const LA_SITE_ID = '3RHkJ5YdSFYSeVHk';

// 自定义事件标识。上报前需先在 51.la 控制台「事件管理」中创建同名事件。
// 注意保持精简：51.la 对事件数/参数数/上报量有额度限制，参数只保留有分析价值的字段。
export const AnalyticsEvent = {
  /** 提交搜索表单（结果返回后上报一次，含是否有结果） */
  Search: 'search',
  /** 打开物品价格历史 */
  ItemHistory: 'item_history',
  /** 打开地图定位浮层 */
  MapOpen: 'map_open',
  /** 复制 GPT 带路指令 */
  CopyCommand: 'copy_command',
  /** 复制 QQ 群号 */
  QqGroupCopy: 'qq_group_copy',
  /** 从搜索联想中选择物品（仅计数，不带参数） */
  AutocompleteSelect: 'autocomplete_select',
  /** 菜农监控台使用情况（仅上报监控账号数量，绝不上报账号/密码等任何信息） */
  AccountsUsage: 'accounts_usage',
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];
export type AnalyticsParams = Record<string, string | number | boolean | null | undefined>;

// 51.la 事件子 SDK（js-sdk-event）对参数的硬限制：
// key 长度不超过 25，value 转字符串后长度不超过 64，超限字段会被直接丢弃。
const MAX_KEY_LENGTH = 25;
const MAX_VALUE_LENGTH = 64;

type LaTrack = (eventId: string, params?: Record<string, unknown>) => void;

interface LaCollector {
  init: (config: Record<string, unknown>) => void;
  // 网站版 SDK 的自定义事件方法是 LA.track（不是 LA.event），
  // 由 autoTrack 自动加载的 js-sdk-event.min.js 在加载完成后挂载。
  track?: LaTrack;
}

declare global {
  interface Window {
    LA?: LaCollector;
  }
}

// 事件子 SDK 比主 SDK 晚加载；在它就绪前先把事件排队，就绪后补发。
let pendingEvents: Array<{ eventId: AnalyticsEventName; params?: Record<string, unknown> }> = [];
let flushStarted = false;

export function initAnalytics(): void {
  if (!import.meta.env.PROD) return;
  if (document.getElementById('LA_COLLECT')) return;

  const script = document.createElement('script');
  script.id = 'LA_COLLECT';
  script.async = true;
  script.charset = 'UTF-8';
  script.src = LA_SDK_URL;
  script.addEventListener('load', () => {
    window.LA?.init({
      id: LA_SITE_ID,
      ck: LA_SITE_ID,
      autoTrack: true,
      hashMode: false,
      // 关闭会话回放：监控台页面含密码输入框，且回放数据量大，容易触额。
      screenRecord: false,
    });
    scheduleFlush();
  });
  document.head.appendChild(script);
}

/**
 * 上报自定义事件：LA.track(事件名, 扁平参数对象)。
 * - 非生产环境直接跳过；
 * - 事件子 SDK 未就绪时排队等待，就绪后自动补发。
 */
export function track(eventId: AnalyticsEventName, params?: AnalyticsParams): void {
  if (!import.meta.env.PROD) return;

  const cleaned = cleanParams(params);
  if (isTrackReady()) {
    window.LA!.track!(eventId, cleaned);
    return;
  }
  pendingEvents.push(cleaned ? { eventId, params: cleaned } : { eventId });
  scheduleFlush();
}

function isTrackReady(): boolean {
  return typeof window.LA?.track === 'function';
}

function scheduleFlush(): void {
  if (flushStarted) return;
  flushStarted = true;
  const startedAt = Date.now();
  const timer = window.setInterval(() => {
    if (!isTrackReady()) {
      // 最多等待 30 秒，超时放弃，避免异常情况下常驻定时器。
      if (Date.now() - startedAt > 30_000) {
        window.clearInterval(timer);
        flushStarted = false;
        pendingEvents = [];
      }
      return;
    }
    window.clearInterval(timer);
    flushStarted = false;
    const queued = pendingEvents;
    pendingEvents = [];
    for (const item of queued) {
      window.LA!.track!(item.eventId, item.params);
    }
  }, 500);
}

function cleanParams(params: AnalyticsParams | undefined): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) continue;
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string') {
      // 超长字符串截断后再上报（如很长的搜索词），保证关键词前缀仍可统计。
      result[key] = value.slice(0, MAX_VALUE_LENGTH);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      if (String(value).length <= MAX_VALUE_LENGTH) result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
