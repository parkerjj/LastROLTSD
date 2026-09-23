/// <reference types="vite/client" />

// 51.la V6 站点统计。
// 仅在生产构建中异步加载 SDK，避免本地开发与测试环境污染统计数据。

const LA_SDK_URL = 'https://sdk.51.la/js-sdk-pro.min.js';
const LA_SITE_ID = '3RHkJ5YdSFYSeVHk';

// 自定义事件标识。上报前需先在 51.la 控制台「事件管理」中创建同名事件，
// 否则事件会被丢弃（控制台可开启自动创建，视后台设置而定）。
export const AnalyticsEvent = {
  /** 提交搜索表单 */
  Search: 'search',
  /** 搜索结果返回 */
  SearchResult: 'search_result',
  /** 打开物品价格历史 */
  ItemHistory: 'item_history',
  /** 打开地图定位浮层 */
  MapOpen: 'map_open',
  /** 复制 GPT 带路指令 */
  CopyCommand: 'copy_command',
  /** 复制 QQ 群号 */
  QqGroupCopy: 'qq_group_copy',
  /** 从搜索联想中选择物品 */
  AutocompleteSelect: 'autocomplete_select',
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];
export type AnalyticsParams = Record<string, string | number | boolean | null | undefined>;

interface LaEventOptions {
  callback?: () => void;
  params?: Record<string, unknown>;
}

interface LaCollector {
  init: (config: Record<string, unknown>) => void;
  event?: (eventId: string, options?: LaEventOptions) => void;
}

declare global {
  interface Window {
    LA?: LaCollector;
  }
}

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
      screenRecord: true,
    });
  });
  document.head.appendChild(script);
}

/**
 * 上报自定义事件。
 * - 非生产环境直接跳过；
 * - SDK 尚未加载完成时也直接跳过（事件不缓存，避免离线积压）。
 */
export function track(eventId: AnalyticsEventName, params?: AnalyticsParams): void {
  if (!import.meta.env.PROD) return;
  const la = window.LA;
  if (typeof la?.event !== 'function') return;

  const cleaned = cleanParams(params);
  la.event(eventId, cleaned ? { params: cleaned } : undefined);
}

function cleanParams(params: AnalyticsParams | undefined): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
