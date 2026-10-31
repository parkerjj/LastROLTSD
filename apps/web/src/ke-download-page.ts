// KoreEngine 脱机版下载页（/ke/download）。
// 版面与文案对齐已审核的 ke-download-design-preview.html；
// 版本号、大小与文件名来自 /api/v1/ke/downloads，
// 缺失平台显示「暂未发布」，不展示示意数据。

import { injectLegalLinksIntoFooters } from "./footer-links";
import { mountSiteNav, siteNavMarkup } from "./nav";
import "./ke-download.css";

type PlatformKey = "windows" | "android";

interface DownloadEntry {
  version: string;
  url: string;
  fileName: string;
  versionCode?: number;
  sha256?: string;
  size?: number;
  minOs?: string;
  abi?: string;
  notes?: string;
  publishedAt?: string;
}

interface DownloadsPayload {
  schemaVersion: 1;
  channel?: string;
  generatedAt?: string;
  platforms: Partial<Record<PlatformKey, DownloadEntry>>;
}

type SyncState =
  | { phase: "loading" }
  | { phase: "ready"; payload: DownloadsPayload }
  | { phase: "error" };

const PLATFORM_META: Record<
  PlatformKey,
  { board: string; boardSub: string; card: string; code: string; title: string; tag: string; ext: string }
> = {
  windows: {
    board: "Windows",
    boardSub: "桌面版 · Windows 10/11",
    card: "Windows 桌面版",
    code: "WINDOWS",
    title: "Windows 桌面版",
    tag: "EXE",
    ext: ".exe",
  },
  android: {
    board: "Android",
    boardSub: "手机版 · Android 8+",
    card: "Android 手机版",
    code: "ANDROID",
    title: "Android 手机版",
    tag: "APK",
    ext: ".apk",
  },
};

function esc(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function formatSize(size: number | undefined): string {
  if (!size || size <= 0) return "—";
  const mb = size / 1_048_576;
  return `${mb.toFixed(1)} MB`;
}

function fileExt(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
}

function platformHref(platform: PlatformKey): string {
  return `/ke/download?platform=${platform}`;
}

function entryOf(payload: DownloadsPayload | undefined, platform: PlatformKey): DownloadEntry | undefined {
  return payload?.platforms[platform];
}

function statusMarkup(phase: SyncState["phase"], available: boolean): string {
  if (phase === "loading") {
    return '<span class="status status--loading"><i aria-hidden="true"></i>正在获取</span>';
  }
  if (phase === "error") {
    return '<span class="status status--off"><i aria-hidden="true"></i>暂时不可用</span>';
  }
  if (!available) {
    return '<span class="status status--off"><i aria-hidden="true"></i>暂未发布</span>';
  }
  return '<span class="status"><i aria-hidden="true"></i>可下载</span>';
}

function versionText(entry: DownloadEntry | undefined, phase: SyncState["phase"]): string {
  if (phase === "loading") return "…";
  return entry?.version ?? "—";
}

function specRows(platform: PlatformKey, entry: DownloadEntry | undefined, phase: SyncState["phase"]): string {
  const dash = phase === "loading" ? "…" : "—";
  if (platform === "windows") {
    return `
      <div><dt>支持系统</dt><dd>${entry ? `Windows ${esc(entry.minOs ?? "10 / 11")}` : dash}</dd></div>
      <div><dt>安装包</dt><dd class="filename">${entry ? esc(entry.fileName) : dash}</dd></div>
      <div><dt>大小</dt><dd>${entry ? formatSize(entry.size) : dash}</dd></div>
    `;
  }
  return `
    <div><dt>支持系统</dt><dd>${entry ? `Android ${esc(entry.minOs ?? "8.0")} 及以上` : dash}</dd></div>
    <div><dt>安装包</dt><dd class="filename">${entry ? esc(entry.fileName) : dash}</dd></div>
    <div><dt>大小</dt><dd>${entry ? formatSize(entry.size) : dash}</dd></div>
  `;
}

function cardMarkup(platform: PlatformKey, entry: DownloadEntry | undefined, phase: SyncState["phase"]): string {
  const meta = PLATFORM_META[platform];
  const available = !!entry;
  const version = versionText(entry, phase);
  const button =
    phase === "loading"
      ? '<span class="dl-button is-disabled" aria-disabled="true"><span>正在获取…</span></span>'
      : phase === "error"
        ? '<span class="dl-button is-disabled" aria-disabled="true"><span>暂时无法下载</span></span>'
        : available
          ? `<a class="dl-button" href="${platformHref(platform)}"><span>下载${platform === "windows" ? "安装包" : " APK"} <span class="file-tag">.${meta.tag}</span></span><span class="icon" aria-hidden="true">↓</span></a>`
          : `<span class="dl-button is-disabled" aria-disabled="true"><span>暂未发布 <span class="file-tag">.${meta.tag}</span></span></span>`;
  const stubVersion = available && entry ? entry.version : "—";
  return `
    <article class="dl-card dl-card--${platform} ${platform === "android" ? "kd-reveal kd-reveal-d1" : "kd-reveal"}">
      <span class="dl-ghost" aria-hidden="true">${platform === "windows" ? "WIN" : "APK"}</span>
      <div class="dl-head">
        <span class="dl-icon"><img src="/brand/koreengine-app.jpg" alt="" width="52" height="52" /></span>
        <span class="dl-head-copy"><span class="dl-code">${meta.code}</span><h3>${meta.title}</h3></span>
        ${statusMarkup(phase, available)}
      </div>
      <div class="dl-version"><span class="dl-kicker">当前稳定版</span><strong>${esc(version)}</strong></div>
      <dl class="dl-specs">
        ${specRows(platform, entry, phase)}
      </dl>
      ${button}
      <p class="dl-note">${platform === "windows" ? "直接覆盖安装就行：原有账号、配置和已下载的模块都会保留，不需要先卸载旧版本。" : "可以直接覆盖安装，账号和配置都会保留，不用先卸载。"}</p>
      <div class="dl-stub"><span class="barcode" aria-hidden="true"></span><span class="stub-code">DL / ${platform === "windows" ? "WIN" : "AND"} / ${esc(stubVersion)}<br>官方下载 · 自动更新</span></div>
    </article>`;
}

function cardsMarkup(state: SyncState): string {
  if (state.phase === "loading") {
    return cardMarkup("windows", undefined, "loading") + cardMarkup("android", undefined, "loading");
  }
  if (state.phase === "error") {
    return cardMarkup("windows", undefined, "error") + cardMarkup("android", undefined, "error");
  }
  return cardMarkup("windows", entryOf(state.payload, "windows"), "ready") + cardMarkup("android", entryOf(state.payload, "android"), "ready");
}

function boardRowsMarkup(state: SyncState): string {
  const rows = (["windows", "android"] as const).map((platform) => {
    const meta = PLATFORM_META[platform];
    const entry = state.phase === "ready" ? entryOf(state.payload, platform) : undefined;
    if (state.phase === "loading") {
      return `
        <div class="board-row is-loading">
          <span class="lamp" aria-hidden="true"></span>
          <span class="board-platform"><b>${meta.board}</b><small>${meta.boardSub}</small></span>
          <span class="board-version">…</span>
          <span class="board-file">正在获取</span>
          <span class="board-action">…</span>
        </div>`;
    }
    if (!entry) {
      return `
        <div class="board-row is-dev">
          <span class="lamp" aria-hidden="true"></span>
          <span class="board-platform"><b>${meta.board}</b><small>${meta.boardSub}</small></span>
          <span class="board-version">—</span>
          <span class="board-file">暂未发布</span>
          <span class="board-action">待发布</span>
        </div>`;
    }
    return `
      <a class="board-row is-ready" href="${platformHref(platform)}">
        <span class="lamp" aria-hidden="true"></span>
        <span class="board-platform"><b>${meta.board}</b><small>${meta.boardSub}</small></span>
        <span class="board-version">v${esc(entry.version)}</span>
        <span class="board-file">${esc(fileExt(entry.fileName) || meta.ext)} · ${formatSize(entry.size)}</span>
        <span class="board-action">下载 <span class="icon" aria-hidden="true">↓</span></span>
      </a>`;
  });
  return `${rows.join("")}
    <div class="board-row is-dev">
      <span class="lamp" aria-hidden="true"></span>
      <span class="board-platform"><b>macOS</b><small>桌面 · Apple</small></span>
      <span class="board-version">—</span>
      <span class="board-file">开发中</span>
      <span class="board-action">待发布</span>
    </div>
    <div class="board-row is-review">
      <span class="lamp" aria-hidden="true"></span>
      <span class="board-platform"><b>iOS</b><small>移动 · iPhone</small></span>
      <span class="board-version">—</span>
      <span class="board-file">受限评估</span>
      <span class="board-action">待定</span>
    </div>`;
}

function actionMarkup(platform: PlatformKey, entry: DownloadEntry | undefined, phase: SyncState["phase"], style: string): string {
  const meta = PLATFORM_META[platform];
  if (phase === "loading") {
    return `<span class="kd-btn ${style} is-disabled" aria-disabled="true"><span class="icon" aria-hidden="true">↓</span>正在获取…</span>`;
  }
  if (phase === "error") {
    return `<span class="kd-btn ${style} is-disabled" aria-disabled="true"><span class="icon" aria-hidden="true">↓</span>暂时无法下载</span>`;
  }
  if (!entry) {
    return `<span class="kd-btn ${style} is-disabled" aria-disabled="true"><span class="icon" aria-hidden="true">↓</span>${meta.board} 暂未发布</span>`;
  }
  return `<a class="kd-btn ${style}" href="${platformHref(platform)}"><span class="icon" aria-hidden="true">↓</span>下载 ${meta.board} 版</a>`;
}

function heroActionsMarkup(state: SyncState): string {
  const windows = state.phase === "ready" ? entryOf(state.payload, "windows") : undefined;
  const android = state.phase === "ready" ? entryOf(state.payload, "android") : undefined;
  return actionMarkup("windows", windows, state.phase, "kd-btn--red") + actionMarkup("android", android, state.phase, "kd-btn--light");
}

function startActionsMarkup(state: SyncState): string {
  const windows = state.phase === "ready" ? entryOf(state.payload, "windows") : undefined;
  const android = state.phase === "ready" ? entryOf(state.payload, "android") : undefined;
  return `${actionMarkup("windows", windows, state.phase, "kd-btn--red")}${actionMarkup("android", android, state.phase, "kd-btn--dark")}<a class="text-link" href="/ke/guide">第一次用 KE？读一遍指南 <span class="icon" aria-hidden="true">→</span></a>`;
}

function ctaActionsMarkup(state: SyncState): string {
  const windows = state.phase === "ready" ? entryOf(state.payload, "windows") : undefined;
  const android = state.phase === "ready" ? entryOf(state.payload, "android") : undefined;
  return `${actionMarkup("windows", windows, state.phase, "kd-btn--red")}${actionMarkup("android", android, state.phase, "kd-btn--cream")}<p class="kd-cta-note">遇到问题？<a href="/guestbook">去留言板</a> · <a href="/ke/guide">读 KE 指南</a></p>`;
}

function manifestStateMarkup(state: SyncState): string {
  if (state.phase === "loading") return '<p class="kd-manifest-state" role="status" aria-live="polite">正在获取最新版本…</p>';
  if (state.phase === "error") return '<p class="kd-manifest-state is-error" role="alert">版本信息暂时获取失败，下载按钮已先禁用</p>';
  const count = Object.keys(state.payload.platforms).length;
  return `<p class="kd-manifest-state" role="status" aria-live="polite">当前稳定版 · 已发布 ${count} 个平台</p>`;
}

function pageMarkup(): string {
  return `
  <header class="site-header kd-header">
    <div class="topbar page-width">
      <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
      ${siteNavMarkup("download")}
    </div>
  </header>
  <main class="kd-main kd-page">
    <section class="kd-hero">
      <div class="kd-hero-watermark" aria-hidden="true">STANDALONE</div>
      <div class="kd-hero-grid page-width">
        <div class="kd-hero-copy">
          <p class="eyebrow"><span class="eyebrow-rule" aria-hidden="true"></span>KoreEngine / Standalone</p>
          <h1><span><span class="line-in">脱机版，</span></span><span><span class="line-in">把 <em>KE</em> 装进口袋。</span></span></h1>
          <p class="kd-hero-lead">不用一直开着浏览器。Windows 和 Android 都有独立客户端：装在自己的电脑或手机上，账号和配置还是 LTSD 那一套，角色照常跑。</p>
          <div class="kd-hero-actions" data-hero-actions></div>
          <div class="kd-hero-meta">
            <span><i aria-hidden="true"></i>Windows 10 / 11</span>
            <span><i aria-hidden="true"></i>Android 8.0 及以上</span>
            <span><i aria-hidden="true"></i>官方直链 · 自动更新</span>
          </div>
          <p class="kd-hero-foot">macOS 与 iOS 仍在开发中 · 进展见下方平台列表</p>
        </div>
        <div class="kd-hero-stage">
          <div class="board">
            <div class="board-head">
              <div class="board-title"><b>发行站台</b><span>RELEASE BOARD</span></div>
              <span class="channel"><i aria-hidden="true"></i>稳定版</span>
            </div>
            <div data-board-rows></div>
            <div class="board-foot"><span>官方下载</span><span>安装包已校验</span></div>
          </div>
          <div class="stamp" aria-hidden="true">STANDALONE<br>OFFICIAL RELEASE<br>官方发布</div>
        </div>
      </div>
    </section>

    <div class="page-width"><div class="kd-alert" data-alert hidden><i class="ph ph-warning-circle" aria-hidden="true"></i><span data-alert-text></span></div></div>

    <section class="kd-section page-width" id="download">
      <div class="kd-section-head kd-reveal">
        <div>
          <div class="kd-section-index"><span class="no">01</span><span class="bar" aria-hidden="true"></span><span>平台列表</span></div>
          <h2>两个平台已经发车，<br>两个还在路上。</h2>
        </div>
        <p>点按钮就能下载当前稳定版，装好后用 LTSD 账号登录即可，不用装浏览器插件，也不用经过网盘。</p>
      </div>
      <div data-manifest-state></div>
      <div class="download-grid" data-platform-cards></div>

      <div class="dev-ledger kd-reveal">
        <div class="ledger-head"><b>还没做完的平台</b><span>不写预计日期 · 能发布才发布</span></div>
        <div class="ledger-grid">
          <div class="ledger-item">
            <div class="ledger-title"><h3>macOS 桌面版</h3><span class="stamp-sm">开发中</span></div>
            <p class="ledger-target">目标 · macOS 13 及以上</p>
            <p>正在做适配，完成后会先小范围试用，确认稳定再开放下载。</p>
          </div>
          <div class="ledger-item">
            <div class="ledger-title"><h3>iOS 移动版</h3><span class="stamp-sm stamp-sm--red">受限评估</span></div>
            <p class="ledger-target">目标 · iOS 16 及以上</p>
            <p>App Store 对这类本地运行的 App 限制严格，不保证能上架。我们会尽最大努力给出一个能用的方案，有结果才更新本页。</p>
          </div>
        </div>
        <p class="ledger-note"><i aria-hidden="true"></i>为什么不写日期？因为能不能上架，不由我们决定。</p>
      </div>
    </section>

    <section class="kd-section page-width">
      <div class="kd-section-head kd-reveal">
        <div>
          <div class="kd-section-index"><span class="no">02</span><span class="bar" aria-hidden="true"></span><span>界面与能力</span></div>
          <h2>不用一直开着浏览器，<br>关掉网页也能继续挂。</h2>
        </div>
        <p>Windows 和 Android 都是完整的客户端：界面和角色状态都在你的电脑或手机上；关掉窗口，角色还会按你的配置继续跑。</p>
      </div>
      <div class="cap-split">
        <div class="cap-copy kd-reveal">
          <p>桌面和手机看到的是同一份状态：账号、配置和进度都存在 LTSD 里，换设备登录也不会丢。</p>
          <p class="cap-quote">“挂机不再依赖浏览器会话。”</p>
        </div>
        <div class="app-stage kd-reveal kd-reveal-d1">
          <div class="app-window" role="group" aria-label="KoreEngine 客户端界面示意">
            <div class="app-bar">
              <img src="/brand/koreengine-app.jpg" alt="" width="22" height="22" />
              <b>KoreEngine</b>
              <div class="app-tabs"><span class="on">实例</span><span>账号</span><span>设置</span></div>
              <span class="app-stop">全部停止</span>
            </div>
            <div class="app-body">
              <div class="app-summary"><span><b>3 个角色</b> · 2 运行中</span><span>LTSD 已连接</span></div>
              <div class="app-row"><span class="avatar">智</span><span class="app-name"><strong>智者</strong><small>Lv 99/70 · prontera</small></span><span class="app-state"><i aria-hidden="true"></i>运行中</span><span class="hp"><span class="track"><span class="fill" style="width:80%"></span></span>80%</span><span class="app-time">02:41:18</span></div>
              <div class="app-row"><span class="avatar">猎</span><span class="app-name"><strong>猎人</strong><small>Lv 99/70 · pay_fild04</small></span><span class="app-state warn"><i aria-hidden="true"></i>重连中 · 第 3 次</span><span class="hp"><span class="track"><span class="fill warn" style="width:64%"></span></span>64%</span><span class="app-time">5 秒后重试</span></div>
              <div class="app-row"><span class="avatar">商</span><span class="app-name"><strong>商人</strong><small>未启动 · 待命</small></span><span class="app-state idle"><i aria-hidden="true"></i>待命</span><span class="hp"><span class="track"><span class="fill" style="width:0%"></span></span>—</span><span class="app-time">—</span></div>
              <div class="app-log">
                <p><span>[12:00:03]</span> 自动 · 喝药阈值 40% · prontera</p>
                <p><span>[12:00:02]</span> 攻击 波利 120 伤害</p>
                <p class="good"><span>[12:00:01]</span> 断线重连成功，恢复 AI 自动</p>
                <p class="warn"><span>[11:59:56]</span> 地图服 30 秒无数据，重新登录</p>
              </div>
            </div>
          </div>
          <p class="app-caption">UI PREVIEW · 实例页</p>
        </div>
      </div>
      <div class="feature-grid">
        ${featureMarkup("01 / 多开", "多角色并行", "一个窗口管理多个账号与角色，独立启动、停止，互不打断。", "多账号 · 多角色", "")}
        ${featureMarkup("02 / 掉线", "断线自动重连", "掉线后自动重试，回到地图后继续按原来的设置挂机。", "掉线自动恢复", "kd-reveal-d1")}
        ${featureMarkup("03 / 后台", "后台继续挂机", "Android 切到后台或锁屏也能继续跑；Windows 关掉窗口后会留在托盘。", "托盘 · 后台运行", "kd-reveal-d2")}
        ${featureMarkup("04 / 配置", "配置在网页里改", "在配置工作台保存方案，客户端启动时会自动读取最新配置。", "网页改 · 客户端跑", "")}
        ${featureMarkup("05 / 状态", "看得见的状态", "日志、背包和经验统计都能在客户端里看到，不用切回网页。", "日志 · 背包 · 统计", "kd-reveal-d1")}
        ${featureMarkup("06 / 更新", "自动更新", "有新版本时客户端会提示并完成更新，不用手动重新下载。", "自动更新", "kd-reveal-d2")}
      </div>
    </section>

    <section class="kd-start">
      <div class="page-width">
        <div class="kd-section-head kd-reveal">
          <div>
            <div class="kd-section-index"><span class="no">03</span><span class="bar" aria-hidden="true"></span><span>开始使用</span></div>
            <h2>三步开始，<br>第一次也能跑起来。</h2>
          </div>
          <p>不用折腾环境，也不用装浏览器插件。装好之后，用 LTSD 账号登录就能用。</p>
        </div>
        <div class="steps kd-steps">
          ${stepMarkup("01", "下载对应安装包", "Windows 选 .exe，Android 选 .apk。点按钮就会下载当前稳定版。", "STEP 01 / INSTALL", "")}
          ${stepMarkup("02", "用 LTSD 账号登录", "打开 App，按提示在网页里确认设备授权；客户端不会保存你的游戏密码。", "STEP 02 / AUTH", "kd-reveal-d1")}
          ${stepMarkup("03", "保存配置，回客户端启动", "先在网页配置工作台保存当前角色的方案，再添加游戏账号、读取角色并启动实例。", "STEP 03 / RUN", "kd-reveal-d2")}
        </div>
        <div class="kd-start-actions kd-reveal" data-start-actions></div>
      </div>
    </section>

    <section class="kd-section page-width">
      <div class="kd-faq-grid">
        <div class="kd-faq-side kd-reveal">
          <div class="kd-section-index"><span class="no">04</span><span class="bar" aria-hidden="true"></span><span>常见问题</span></div>
          <h2>装之前，<br>先把疑问放下。</h2>
          <p>只回答脱机版相关的问题；配置写法与挂机规则见 KE 指南。</p>
          <div class="side-note">
            <strong>记住三条边界</strong>
            <ul>
              <li>不做爬塔、镜像、PVP、无限塔、自动副本。</li>
              <li>不做自动交易、插件和冷门 KE 功能。</li>
              <li>与网页版共用同一套实例额度。</li>
            </ul>
          </div>
          <p class="kd-faq-foot-note">没找到答案？<a href="/guestbook">去留言板提问 →</a></p>
        </div>
        <div class="kd-faq-list kd-reveal kd-reveal-d1">
          ${faqMarkup("脱机版和网页里的 KE 有什么区别？", "网页版在浏览器里的进阶客户端中运行；脱机版是一个独立的 App，界面和挂机都在你自己的电脑或手机上。两者用的是同一个 LTSD 账号和同一套配置，实例额度也共用。", true)}
          ${faqMarkup("真的可以关掉浏览器吗？", "可以。脱机版不依赖浏览器。Windows 关掉窗口后留在系统托盘，Android 切后台或锁屏也能继续；电脑关机、手机被系统清理或手动停止后，角色才会停。")}
          ${faqMarkup("更新会丢账号或配置吗？", "不会。直接覆盖安装就行，账号、配置和已下载的模块都会保留，不需要先卸载。更新时客户端会先停掉正在运行的角色，停不下来就不会开始安装。")}
          ${faqMarkup("我的旧手机能装吗？", "目前只提供 64 位安卓安装包，近几年主流机型都能用；32 位老手机和模拟器暂时装不了。")}
          ${faqMarkup("脱机版会多送实例额度吗？", "不会。额度和网页版共用：注册并验证邮箱后默认有 1 个全自动实例；半自动模式不占额度。")}
          ${faqMarkup("macOS 和 iOS 现在能用吗？", "还不能。macOS 在开发中；iOS 受 Apple 分发政策限制，不保证上架，但会尽最大努力提供一个能用的方案。确定后会在本页和更新说明里公布。")}
          ${faqMarkup("下载会不会有病毒？", "安装包只从我们自己的服务器下载，页面上的按钮不会跳到网盘或第三方站点。如果杀毒软件提示风险，先别安装，到留言板告诉我们。")}
        </div>
      </div>
    </section>

    <section class="kd-cta page-width">
      <div class="kd-cta-box kd-reveal">
        <div class="kd-cta-copy">
          <p class="kd-cta-kicker">STATION OPEN / 现在可以发车</p>
          <h2>选一个平台，<br>先把角色跑起来。</h2>
          <p>Windows 和 Android 都已开放下载；macOS 与 iOS 有进展时，会在这里更新。</p>
        </div>
        <div class="kd-cta-actions" data-cta-actions></div>
        <span class="kd-cta-app" aria-hidden="true"><img src="/brand/koreengine-app.jpg" alt="" width="120" height="120" /></span>
      </div>
    </section>
  </main>
  <footer class="site-footer kd-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/ke/guide">KE指南</a><a href="/ke/download">脱机版下载</a><a href="/ke/my">配置工作台</a><a href="/ke/hall">配置大厅</a><a href="/client">进阶客户端</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考 · KOREENGINE STANDALONE</small></div></footer>`;
}

function featureMarkup(no: string, title: string, body: string, tag: string, extra: string): string {
  return `<div class="feature-item kd-reveal ${extra}"><div class="feature-no">${no}</div><h3>${title}</h3><p>${body}</p><span class="feature-tag">${tag}</span></div>`;
}

function stepMarkup(no: string, title: string, body: string, meta: string, extra: string): string {
  return `<div class="kd-step kd-reveal ${extra}"><div class="kd-step-no">${no}</div><h3>${title}</h3><p>${body}</p><div class="kd-step-meta">${meta}</div></div>`;
}

function faqMarkup(question: string, answer: string, open = false): string {
  return `<details name="ke-offline-faq"${open ? " open" : ""}><summary>${question}</summary><p>${answer}</p></details>`;
}

function renderSection(container: Element | null, html: string): void {
  if (container) container.innerHTML = html;
}

function syncPage(root: HTMLElement, state: SyncState): void {
  renderSection(root.querySelector("[data-hero-actions]"), heroActionsMarkup(state));
  renderSection(root.querySelector("[data-board-rows]"), boardRowsMarkup(state));
  renderSection(root.querySelector("[data-platform-cards]"), cardsMarkup(state));
  renderSection(root.querySelector("[data-manifest-state]"), manifestStateMarkup(state));
  renderSection(root.querySelector("[data-start-actions]"), startActionsMarkup(state));
  renderSection(root.querySelector("[data-cta-actions]"), ctaActionsMarkup(state));
}

function showStatusAlert(root: HTMLElement): void {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  if (!status) return;
  const platform = params.get("platform");
  const label = platform === "windows" ? "Windows" : platform === "android" ? "Android" : "该平台";
  const messages: Record<string, string> = {
    invalid: `不支持的平台参数${platform ? `（${esc(platform)}）` : ""}，请从下方选择 Windows 或 Android。`,
    unavailable: `${label} 的安装包暂未发布，可以先查看下方平台列表。`,
    error: "版本信息暂时获取失败，下载按钮已先禁用，请稍后刷新重试。",
  };
  const message = messages[status];
  if (!message) return;
  const alert = root.querySelector<HTMLElement>("[data-alert]");
  const text = root.querySelector<HTMLElement>("[data-alert-text]");
  if (!alert || !text) return;
  text.textContent = message;
  alert.hidden = false;
  alert.setAttribute("role", "alert");
}

async function loadDownloads(): Promise<DownloadsPayload> {
  const response = await fetch("/api/v1/ke/downloads", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`downloads api ${response.status}`);
  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (payload as { platforms?: unknown }).platforms !== "object" ||
    (payload as { platforms?: unknown }).platforms === null
  ) {
    throw new Error("downloads api payload invalid");
  }
  return payload as DownloadsPayload;
}

const observed = new WeakSet<Element>();

function setupReveal(root: HTMLElement): void {
  const elements = Array.from(root.querySelectorAll<HTMLElement>(".kd-reveal"));
  if (typeof window === "undefined" || typeof IntersectionObserver !== "function") {
    elements.forEach((element) => element.classList.add("is-in"));
    return;
  }
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  if (reduced) {
    elements.forEach((element) => element.classList.add("is-in"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  elements.forEach((element) => {
    if (observed.has(element)) return;
    observed.add(element);
    observer.observe(element);
  });
}

export async function mountKeDownloadPage(root: HTMLElement): Promise<void> {
  root.innerHTML = pageMarkup();
  mountSiteNav(root);
  showStatusAlert(root);
  syncPage(root, { phase: "loading" });
  setupReveal(root);

  try {
    const payload = await loadDownloads();
    syncPage(root, { phase: "ready", payload });
  } catch {
    syncPage(root, { phase: "error" });
  }
  setupReveal(root);
  injectLegalLinksIntoFooters(root);
}
