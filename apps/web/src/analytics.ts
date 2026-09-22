/// <reference types="vite/client" />

// 51.la V6 站点统计。
// 仅在生产构建中异步加载 SDK，避免本地开发与测试环境污染统计数据。

const LA_SDK_URL = 'https://sdk.51.la/js-sdk-pro.min.js';
const LA_SITE_ID = '3RHkJ5YdSFYSeVHk';

interface LaCollector {
  init: (config: Record<string, unknown>) => void;
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
      hashMode: true,
      screenRecord: true,
    });
  });
  document.head.appendChild(script);
}
