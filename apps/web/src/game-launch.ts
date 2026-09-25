// LastRO 网页客户端（roBrowser）启动参数与握手。
//
// 背景：https://game.lastro.cn/ro/api.html 打开后只显示「正在初始化程序」，
// 必须由宿主页面通过 postMessage 下发初始化配置后才会加载 Online.js。
// 官方 pc/index 页用弹窗（POPUP）做宿主，但实测当 opener 在跨域窗口打开后
// 立即变为后台标签时，Chrome 跨进程窗口交接会丢失关键的握手消息；Ctrl+点击
// 让新标签在后台打开、opener 保持前台时反而正常。因此本站默认用同源 /play 页
// 内嵌 iframe（官方 FRAME 模式）做宿主：iframe.contentWindow 是绑在 DOM 上的
// 稳定引用，发送方始终是前台标签，不依赖 window.opener，也不受后台定时器节流
// 影响。勾选「以全屏新窗口打开」时才退回官方 POPUP 模式（带窗口特性的弹窗会与
// opener 同进程同窗口组，握手可靠）。

export const GAME_ORIGIN = "https://game.lastro.cn";
export const GAME_CLIENT_VERSION = 70.84;
export const GAME_CLIENT_URL = `${GAME_ORIGIN}/ro/api.html?${GAME_CLIENT_VERSION}`;

// 与官方 pc-api.js 的 WaitForInitialization 逐项一致（application 经
// start() 由枚举 ROBrowser.APP.ONLINE(=1) 转成字符串 "Online"）。
export const GAME_INIT_CONFIG = {
  application: "Online",
  servers: "data/clientinfo.xml",
  grfList: null,
  remoteClient: "/ro/client_re/",
  packetver: "auto",
  development: false,
  api: false,
  socketProxy: null,
  packetKeys: false,
  saveFiles: true,
  skipServerList: true,
  skipIntro: true,
  autoLogin: [],
  version: GAME_CLIENT_VERSION,
  clientHash: null,
  plugins: { IntroMessagePc: {}, LoadingDonate: {} },
  charBlockSize: 0,
  BGMFileExtension: ["mp3"],
  ClientVer: 5,
} as const;

export interface GameHandshake {
  /** 主动停止握手（收到 ready 后内部也会自动停止）。 */
  stop(): void;
}

interface HandshakeOptions {
  /** 每次发送前调用，返回 true 时停止握手（用于检测 popup 已关闭）。 */
  isClosed?: () => boolean;
  /** 收到 api.html 回发的 "ready" 时回调。 */
  onReady?: (() => void) | undefined;
}

/**
 * 向游戏窗口持续 postMessage 初始化配置，直到 api.html 回发 "ready"。
 * api.html 的监听器注册得很早且只接收第一条消息，因此这里立即先发一次，
 * 再按 100ms 间隔补发，覆盖对方文档加载的任意时序。
 */
function startHandshake(
  targetWindow: Window,
  options: HandshakeOptions = {},
): GameHandshake {
  let stopped = false;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    window.clearInterval(timer);
    window.removeEventListener("message", handleMessage);
  }

  function postConfig(): void {
    if (stopped) return;
    if (options.isClosed?.()) {
      stop();
      return;
    }
    // 目标窗口正在跨文档导航的瞬间，postMessage 偶尔会抛错；下一个 tick 补发即可。
    try {
      targetWindow.postMessage(GAME_INIT_CONFIG, "*");
    } catch {
      // ignored: retried on the next interval
    }
  }

  function handleMessage(event: MessageEvent): void {
    if (
      event.source === targetWindow &&
      event.origin === GAME_ORIGIN &&
      event.data === "ready"
    ) {
      stop();
      options.onReady?.();
    }
  }

  const timer = window.setInterval(postConfig, 100);
  postConfig();
  window.addEventListener("message", handleMessage);
  return { stop };
}

/** iframe（FRAME）宿主握手：iframe 生命周期跟随父页，无需检测关闭。 */
export function startFrameHandshake(
  frameWindow: Window,
  options: { onReady?: () => void } = {},
): GameHandshake {
  return startHandshake(frameWindow, { onReady: options.onReady });
}

/** 弹窗（POPUP）宿主握手：popup 被用户关掉时自动停止，避免定时器泄漏。 */
export function startPopupHandshake(
  popupWindow: Window,
  options: { onReady?: () => void } = {},
): GameHandshake {
  return startHandshake(popupWindow, {
    isClosed: () => popupWindow.closed,
    onReady: options.onReady,
  });
}

/**
 * 以「全屏新窗口」方式打开游戏客户端。必须传入窗口尺寸等特性参数——只有带
 * 特性的 window.open 才会作为独立弹窗（与 opener 同窗口组）打开；不传特性则
 * 是普通新标签，跨站时握手不可靠。返回 null 表示被浏览器弹窗拦截器拦截。
 */
export function openGamePopup(): Window | null {
  if (typeof window === "undefined") return null;
  const screenWidth = window.screen?.availWidth || 800;
  const screenHeight = window.screen?.availHeight || 600;
  const features = [
    "directories=yes",
    "fullscreen=no",
    "top=0",
    "left=0",
    `height=${screenHeight}`,
    `width=${screenWidth}`,
    "location=yes",
    "menubar=yes",
    "resizable=yes",
    "scrollbars=no",
    "status=no",
    "toolbar=yes",
  ].join(",");
  return window.open(GAME_CLIENT_URL, "_blank", features);
}
