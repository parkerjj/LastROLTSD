import { GAME_CLIENT_URL, startFrameHandshake } from "./game-launch";

/**
 * /play 同源游戏启动页：整页一个全屏 iframe 承载 LastRO 官方 api.html，
 * 本页（始终是前台标签）对 iframe.contentWindow 做 postMessage 握手。
 * 这样既满足「在新标签页打开」，又避开了跨域新标签 opener 失活导致的丢消息问题。
 */
export function mountPlayPage(root: HTMLElement): void {
  document.title = "LastRO 游戏中 · 露天商店.Ro";
  root.innerHTML = `
    <div class="play-page">
      <iframe class="game-frame" src="${GAME_CLIENT_URL}" title="LastRO 游戏客户端" allowfullscreen></iframe>
      <a class="play-back" href="/accounts"><i class="ph ph-caret-left" aria-hidden="true"></i>返回账号监控台</a>
    </div>`;

  const frame = root.querySelector<HTMLIFrameElement>(".game-frame")!;
  // contentWindow 在 iframe 进入 DOM 后立即可用；即使对方文档还在导航，
  // 握手会以 100ms 间隔持续补发配置直到收到 ready。
  if (frame.contentWindow) startFrameHandshake(frame.contentWindow);
}
