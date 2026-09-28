import { AnalyticsEvent, track } from "./analytics";
import { siteNavMarkup, mountSiteNav } from "./nav";

/**
 * LRO 进阶客户端说明页（/client）。
 * 半开放测试页：不进入主导航与页脚链接，仅通过直接访问 URL 到达。
 */

/**
 * IWA Update Manifest 的固定 URL——Chrome 会自动从中拉取最新 .swbn 并安装。
 * 发布新 client 时无需回来改这里——Chrome 直接读 updates.json 获取最新版本。
 */
const IWA_UPDATE_MANIFEST_URL = "https://client.ltsd.ro/updates.json";
/** 版本号加载前的占位显示；实际版本由 /api/v1/iwa/info 动态填入。 */
const CLIENT_VERSION = "v0.1.0";
/** 获取最新 Release 信息的端点，返回 { version, src }。 */
const IWA_INFO_URL = "/api/v1/iwa/info";

const INSTALL_STEPS = [
  {
    title: "开启 IWA 开发者模式",
    body: `在地址栏依次打开 ${copyChipMarkup("chrome://flags/#enable-isolated-web-apps")}、${copyChipMarkup("chrome://flags/#enable-isolated-web-app-dev-mode")} 和 ${copyChipMarkup("chrome://flags/#enable-isolated-web-app-unmanaged-install")}，将这三个开关都设为 <strong>Enabled</strong>，然后点击 <strong>Relaunch</strong> 重启 Chrome。只需设置一次。若找不到开关，或无法打开下方的安装设置页，请先通过 <strong>⋮ → 帮助 → 关于 Google Chrome</strong> 检查更新；也可前往 <a href="https://www.google.cn/chrome/" target="_blank" rel="noopener noreferrer">Chrome 中国官网</a>下载并安装最新版（Chrome 154 或更新版本），重启浏览器后再试。`,
  },
  {
    title: "在 chrome://web-app-internals 中安装",
    body: `地址栏打开 ${copyChipMarkup("chrome://web-app-internals")}，找到 <strong>Install IWA from Update Manifest</strong>，粘贴更新地址 ${copyChipMarkup(IWA_UPDATE_MANIFEST_URL)} 后点击安装。Chrome 会自动拉取最新安装包，无需手动下载。若其他教程提到的 chrome://iwa-dev 显示 ERR_INVALID_URL，请使用此入口。`,
  },
  {
    title: "确认并启动",
    body: "在安装向导中确认应用名称与版本后点击安装。完成后从开始菜单或应用列表打开「LRO 进阶客户端」，像原生程序一样独立窗口运行。",
  },
] as const;

/** chrome:// 地址无法作为超链接打开（浏览器安全策略），渲染为点击即复制的芯片按钮。 */
function copyChipMarkup(text: string): string {
  return `<button type="button" class="copy-chip" data-copy="${text}" aria-label="复制 ${text}"><code>${text}</code><span class="copy-hint" aria-hidden="true">复制</span></button>`;
}

const COMPARE_ROWS = [
  {
    feature: "底层引擎",
    oldClient: "RO 官方客户端",
    newClient: "RoBrowser 最新版本",
  },
  {
    feature: "整体架构",
    oldClient: "十年前的祖传代码",
    newClient: "复兴后现代客户端架构（基于Chrome IWA重新构建）",
    isNew: true,
  },
  {
    feature: "数据传输",
    oldClient: "需经过WSS to TCP中转，延迟增加且不稳定",
    newClient: "服务器直连，不经中转",
    isNew: true,
  },
  {
    feature: "三服同端",
    oldClient: "无语",
    newClient: "三转、二转、App服同时支持，游戏内直接切换，无须重开网页。",
    isNew: true,
  },
  {
    feature: "账号管理",
    oldClient: "无",
    newClient:
      "支持常用账号储存与管理，实现一键登录。 账号密码数据均只存于你的设备，不会同步给任何人。",
    isNew: true,
  },
  {
    feature: "源代码",
    oldClient: "LRO使用第三方开源项目进行魔改后闭源",
    newClient: "完全开源，可审计、可共建",
  },
  {
    feature: "画面帧率",
    oldClient: "锁定 30 帧",
    newClient: "无限帧率，不再锁定 30 帧",
    isNew: true,
  },
  {
    feature: "装备鉴定",
    oldClient: "使用放大镜后才能看到装备信息",
    newClient:
      "免鉴定即可预览装备（因词条会在使用放大镜时生成，鉴定后才有词条）",
  },
  {
    feature: "多开限制",
    oldClient: "登录角色数量有限制",
    newClient: "去除登录数量限制",
    isNew: true,
  },
  {
    feature: "离线挂机",
    oldClient: "支持",
    newClient: "支持离线挂机与设定",
  },
  {
    feature: "快捷功能",
    oldClient: "右下角快捷传送",
    newClient:
      "在已有的基础上增加更多快捷传送点，例如各大洞穴直接传送到门口而不是洞穴内部（省卷轴），每日任务NPC坐标快捷传送等。",
    isNew: true,
  },
  {
    feature: "功能体验",
    oldClient: "原版体验",
    newClient: "多项功能优化与改良",
  },
  {
    feature: "手柄支持",
    oldClient: "无",
    newClient: "支持手柄操作RO，用手柄玩过FF14吗？",
  },
  {
    feature: "「十全大补」补丁",
    oldClient: "无",
    newClient: "补丁功能部分已加入（例如装备免鉴定），剩余将陆续内置到客户端中",
  },
  {
    feature: "后续路线",
    oldClient: "停止演进",
    newClient: "更多「真·黑科技」持续加入（这个新版框架，是一切未来之基石）",
  },
] as const;

const KNOWN_ISSUES = [
  {
    title: "NPC 对话选择空条目会掉线",
    body: "与 NPC 对话时，如果未选中任何条目点击确定，会导致与服务器断开连接。请避免点击空白选项。",
    status: "待修复",
  },
  {
    title: "活动公告未实现快速传送",
    body: "服务器公告发送的活动信息目前以原文形式显示，暂未实现「点我快速传送」功能。但你可以在右下角的快捷传送栏中选择自定义传送，然后手动输入地图名和坐标， 坐标0,0表示传送该地图随机一点。 输入具体数据则传到具体位置（包括可以把你卡在墙里的位置）",
    status: "待实现",
  },
  {
    title: "NPC 商店输入数字时容易失焦",
    body: "与 NPC 交易购买输入数量时，输入框容易失去焦点，需要重新点击输入框。",
    status: "待修复",
  },
  {
    title: "铁匠精炼界面闪烁",
    body: "铁匠精炼时 UI 会出现闪烁现象，但不影响精炼功能的正常使用。",
    status: "不影响使用",
  },
  {
    title: "文字乱码",
    body: "一些不重要的地方文字可能会出现乱码，但都不影响使用。",
    status: "不影响使用",
  },
] as const;

function installStepsMarkup(): string {
  return INSTALL_STEPS.map(
    (step, index) => `
      <article class="install-step">
        <span class="step-number" aria-hidden="true">0${index + 1}</span>
        <h3>${step.title}</h3>
        <p>${step.body}</p>
      </article>`,
  ).join("");
}

function compareRowsMarkup(): string {
  return COMPARE_ROWS.map(
    (row) => `
          <tr>
            <td class="col-feature">${row.feature}</td>
            <td class="col-old">${row.oldClient}</td>
            <td class="col-new">${row.newClient}${"isNew" in row && row.isNew ? '<span class="feature-new-tag">新增</span>' : ""}</td>
          </tr>`,
  ).join("");
}

function knownIssuesMarkup(): string {
  return KNOWN_ISSUES.map(
    (issue, index) => `
      <li class="issue-item">
        <span class="issue-index" aria-hidden="true">${index + 1}</span>
        <div><h3>${issue.title}</h3><p>${issue.body}</p></div>
        <span class="issue-status">${issue.status}</span>
      </li>`,
  ).join("");
}

export function mountClientPage(root: HTMLElement): void {
  document.title = "LRO 进阶客户端 · 露天商店.Ro";
  root.innerHTML = `
    <header class="site-header">
      <div class="topbar page-width">
        <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
        ${siteNavMarkup("client")}
      </div>
    </header>
    <main class="client-main page-width">
      <section class="client-hero" aria-labelledby="client-page-title">
        <div class="client-hero-copy">
          <p class="eyebrow">LRO 进阶客户端 / ISOLATED WEB APP</p>
          <h1 id="client-page-title">进阶<span>客户端</span></h1>
          <p class="client-hero-subtitle">基于 Chrome IWA（Isolated Web App）技术打造的下一代 LastRO 客户端。以网页形态分发安装，以接近原生应用的体验运行——无限帧率、离线挂机、装备免鉴定，一切从这套全新的开源架构开始。</p>
          <div class="client-hero-meta">
            <span class="meta-chip"><i class="ph ph-desktop" aria-hidden="true"></i>仅限电脑端</span>
            <span class="meta-chip"><i class="ph ph-google-chrome-logo" aria-hidden="true"></i>Chrome 浏览器</span>
            <span class="meta-chip"><i class="ph ph-browser" aria-hidden="true"></i>兼容 Edge</span>
            <span class="meta-chip"><i class="ph ph-git-fork" aria-hidden="true"></i>完全开源</span>
          </div>
        </div>
        <aside class="client-download-card" aria-label="客户端版本信息">
          <span class="download-kicker">当前版本</span>
          <div class="download-version"><strong data-latest-version>${CLIENT_VERSION}</strong><span class="beta-tag">测试版</span></div>
          <p class="download-desc">签名 Release（Chrome IWA）。当前为测试版框架，也是后续一切「黑科技」的基础。安装无需手动下载——Chrome 会自动拉取最新安装包。</p>
          <div class="download-file-info"><span>签名 Release 版</span><span>Chrome IWA（.swbn）</span></div>
        </aside>
      </section>

      <section class="site-notice client-requirements" aria-label="环境要求">
        <span class="notice-badge">环境要求</span>
        <div class="notice-body"><p>本客户端<strong>仅支持电脑端</strong>：请使用桌面版 <strong>Google Chrome</strong> 浏览器安装（Microsoft Edge 也许可用，但我不用Windows，所以未完成Edge验证），暂不支持手机与平板（未来会加入，十一假期以后）。</p></div>
      </section>

      <section class="client-section" aria-labelledby="install-title">
        <div class="section-heading">
          <div><p class="eyebrow">INSTALL GUIDE</p><h2 id="install-title">三步完成安装</h2></div>
          <p>按步骤操作即可，全程无需下载文件、无需命令行。Chrome 会通过更新地址自动拉取最新安装包。</p>
        </div>
        <div class="install-steps">${installStepsMarkup()}</div>
        <p class="install-note"><i class="ph ph-info" aria-hidden="true"></i><span>为什么需要开发者模式？Chrome 目前仅允许进入官方应用列表的 IWA 免开关直接安装；未入列的签名 Release 包（如本客户端）必须开启 Developer Mode 后才能安装。该开关为浏览器级设置，开启一次即可，不影响浏览器其他功能。</span></p>
      </section>

      <section class="client-section" aria-labelledby="compare-title">
        <div class="section-heading">
          <div><p class="eyebrow">COMPARE</p><h2 id="compare-title">与旧客户端有什么不同</h2></div>
          <p>进阶客户端不是旧客户端的补丁，而是一套重写的新架构。以下为主要差异一览。</p>
        </div>
        <div class="compare-wrap">
          <table class="compare-table">
            <thead>
              <tr><th scope="col">特性</th><th scope="col">旧客户端</th><th scope="col" class="col-new"><i class="ph ph-rocket-launch" aria-hidden="true"></i>LRO·LTSD 进阶客户端</th></tr>
            </thead>
            <tbody>${compareRowsMarkup()}
            </tbody>
          </table>
        </div>
        <p class="compare-footnote">注：装备免鉴定指「使用放大镜前即可查看这是什么装备」；随机词条的生成时机仍然是使用放大镜时，因此仍需鉴定后才能装备该物品。</p>
      </section>

      <section class="client-section" aria-labelledby="issues-title">
        <div class="section-heading">
          <div><p class="eyebrow">KNOWN ISSUES</p><h2 id="issues-title">已知问题</h2></div>
          <p>当前为测试版框架，以下问题已确认存在，将在后续版本中修复。</p>
        </div>
        <ol class="issue-list">${knownIssuesMarkup()}
        </ol>
      </section>

      <section class="client-feedback" aria-label="问题反馈">
        <span class="feedback-badge">问题反馈</span>
        <p>遇到未列出的问题？加入 QQ 交流群 <button type="button" class="qq-copy" data-copy="725955796" aria-label="复制QQ群号 725955796"><span>725955796</span><span class="copy-hint" aria-hidden="true">复制</span></button> 或前往<a class="feedback-link" href="/guestbook">玩家登记簿（露天商店留言簿）</a>留言反馈。</p>
      </section>
    </main>
    <footer class="site-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/accounts">菜农监控台</a><a href="/guestbook">玩家登记簿</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>
  `;

  mountSiteNav(root);

  const copyButtons = root.querySelectorAll<HTMLButtonElement>("[data-copy]");
  copyButtons.forEach((copyButton) => {
    let copyHintTimer = 0;
    copyButton.addEventListener("click", async () => {
      const copyText = copyButton.dataset.copy ?? "";
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(copyText);
          copied = true;
        }
      } catch {
        // Clipboard API 不可用（权限或非安全上下文）时使用降级方案。
      }
      if (!copied) {
        try {
          const fallback = document.createElement("input");
          fallback.value = copyText;
          fallback.style.position = "fixed";
          fallback.style.opacity = "0";
          document.body.appendChild(fallback);
          fallback.select();
          document.execCommand("copy");
          fallback.remove();
          copied = true;
        } catch {
          copied = false;
        }
      }
      const hint = copyButton.querySelector(".copy-hint");
      if (copied && hint) {
        if (copyButton.classList.contains("qq-copy")) {
          track(AnalyticsEvent.QqGroupCopy);
        }
        hint.textContent = "已复制";
        window.clearTimeout(copyHintTimer);
        copyHintTimer = window.setTimeout(() => {
          hint.textContent = "复制";
        }, 1800);
      } else if (!copied) {
        copyButton.setAttribute("aria-label", `${copyText}，请手动复制`);
      }
    });
  });

  refreshLatestRelease(root);
}

/** 拉取最新 Release 版本号，更新页面上的版本显示。 */
function refreshLatestRelease(root: HTMLElement): void {
  const versionEl = root.querySelector<HTMLElement>("[data-latest-version]");
  if (!versionEl) return;
  void (async () => {
    try {
      const response = await fetch(IWA_INFO_URL, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { version?: string };
      if (typeof payload.version === "string" && payload.version.length > 0) {
        versionEl.textContent = `v${payload.version}`;
      }
    } catch {
      // 拉取失败时保留占位版本号。
    }
  })();
}
