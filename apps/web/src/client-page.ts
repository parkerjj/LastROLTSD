import { AnalyticsEvent, track } from "./analytics";
import { siteNavMarkup, mountSiteNav } from "./nav";
import { injectLegalLinksIntoFooters } from "./footer-links";

/**
 * LRO 进阶客户端说明页（/client）。
 * 正式页面：主导航「进阶客户端」入口即指向这里。
 */

const NATIVE_VERSION = "1.1035.261121";
const NATIVE_LATEST_URL = "/api/v1/native/latest";
const NATIVE_LINUX_URL = "/api/v1/native/linux";

interface NativeAsset {
  url: string;
  size?: number;
}

interface NativeManifest {
  version?: string;
  installers?: Record<string, NativeAsset>;
  platforms?: Record<string, NativeAsset>;
}

const NATIVE_CAPABILITIES = [
  {
    title: "独立原生窗口",
    body: "下载、安装、启动即可进入游戏，不需要浏览器、开发者开关或命令行。每个窗口都能独立登录账号。",
  },
  {
    title: "三服与两种连接模式",
    body: "三转、二转与 App 服使用同一个客户端。App 服支持 Direct TCP 直连，二转和三转使用官方传统连接。",
  },
  {
    title: "本地账号与资源缓存",
    body: "常用账号保存在本机，可按服务器 profile 管理；游戏资源缓存可在不同原生窗口之间复用。",
  },
  {
    title: "签名自动更新",
    body: "启动时自动检查新版本，运行期间每六小时再检查。更新包通过签名校验后，由你确认安装并重启。",
  },
] as const;

const COMPARE_ROWS = [
  {
    feature: "底层引擎",
    oldClient: "RO 官方客户端",
    newClient: "RoBrowser 最新版本",
  },
  {
    feature: "整体架构",
    oldClient: "十年前的祖传代码",
    newClient: "Tauri 原生桌面架构，独立窗口运行，无需浏览器安装环境",
    isNew: true,
  },
  {
    feature: "数据传输",
    oldClient: "固定使用官方传统连接",
    newClient: "App 服支持 Direct TCP 直连；二转、三转保留官方传统连接",
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

function nativeCapabilitiesMarkup(): string {
  return NATIVE_CAPABILITIES.map(
    (capability, index) => `
      <article class="native-capability">
        <span class="native-capability-index" aria-hidden="true">0${index + 1}</span>
        <div><h3>${capability.title}</h3><p>${capability.body}</p></div>
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

export function mountClientPage(root: HTMLElement): void {
  document.title = "LRO 进阶客户端 · 露天商店.Ro";
  root.innerHTML = `
    <header class="site-header">
      <div class="topbar page-width">
        <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
        ${siteNavMarkup("client")}
      </div>
    </header>
    <main class="client-main page-width">
      <section class="client-hero" aria-labelledby="client-page-title">
        <div class="client-hero-copy">
          <p class="eyebrow">LRO 进阶客户端 / NATIVE DESKTOP</p>
          <h1 id="client-page-title">进阶<span>客户端</span></h1>
          <p class="client-hero-subtitle">LRO 进阶客户端原生桌面版。下载并安装后即可直接登录三转、二转和 App 服，支持多窗口、本地账号管理、资源缓存与签名自动更新，无需浏览器或开发者设置。</p>
          <div class="client-hero-meta">
            <span class="meta-chip"><i class="ph ph-windows-logo" aria-hidden="true"></i>Windows</span>
            <span class="meta-chip"><i class="ph ph-apple-logo" aria-hidden="true"></i>macOS</span>
            <span class="meta-chip"><i class="ph ph-linux-logo" aria-hidden="true"></i>Linux</span>
            <span class="meta-chip"><i class="ph ph-git-fork" aria-hidden="true"></i>完全开源</span>
          </div>
        </div>
        <aside class="client-download-card" aria-label="Native 客户端下载">
          <div class="client-app-identity"><img src="/brand/LRO-Native.png" alt="LRO 进阶客户端图标" width="58" height="58" /><span>LRO 进阶客户端<small>原生桌面版</small></span></div>
          <span class="download-kicker">当前 NATIVE 版本</span>
          <div class="download-version"><strong data-native-version>v${NATIVE_VERSION}</strong><span class="beta-tag">NATIVE</span></div>
          <p class="download-desc">独立安装包，启动后自动检查更新。Windows 使用当前用户 NSIS 安装，不需要管理员级手动配置。</p>
          <a class="download-button" href="https://client.ltsd.ro/native/${NATIVE_VERSION}/LRO-Client-${NATIVE_VERSION}-windows-x64-setup.exe" data-native-asset="windows-x86_64"><i class="ph ph-download-simple" aria-hidden="true"></i>下载 Windows 版</a>
          <div class="download-file-info"><span>Windows x64 · NSIS</span><span data-native-size="windows-x86_64">27.9 MB</span></div>
          <div class="download-alternatives"><a href="#download">macOS / Linux 下载</a><span>签名自动更新</span></div>
        </aside>
      </section>

      <section class="site-notice client-requirements" aria-label="环境要求">
        <span class="notice-badge">运行环境</span>
        <div class="notice-body"><p>支持 <strong>Windows x64</strong>、<strong>macOS Universal</strong> 与 <strong>Linux x86_64 / aarch64</strong>。Windows 需要 WebView2；macOS 同时支持 Apple 芯片和 Intel Mac；Linux 提供 DEB 与 RPM 安装包。</p></div>
      </section>

      <section class="client-section native-download-section" id="download" aria-labelledby="download-title">
        <div class="section-heading">
          <div><p class="eyebrow">DOWNLOAD</p><h2 id="download-title">下载 Native 客户端</h2></div>
          <p>选择对应系统的安装包。下载地址与版本号会自动同步官方 Native 发布清单。</p>
        </div>
        <div class="native-download-grid">
          <article class="native-platform-card">
            <header class="native-platform-header"><i class="ph ph-windows-logo" aria-hidden="true"></i><div><h3>Windows</h3><p>x64 · NSIS 当前用户安装</p></div></header>
            <p class="native-platform-description">适用于 Windows 电脑，运行需要 WebView2。下载后打开安装程序，按提示完成安装即可。</p>
            <a class="download-button" href="https://client.ltsd.ro/native/${NATIVE_VERSION}/LRO-Client-${NATIVE_VERSION}-windows-x64-setup.exe" data-native-asset="windows-x86_64"><i class="ph ph-download-simple" aria-hidden="true"></i>下载 Windows 版</a>
            <div class="native-platform-foot"><span>EXE 安装包</span><span data-native-size="windows-x86_64">27.9 MB</span></div>
          </article>
          <article class="native-platform-card">
            <header class="native-platform-header"><i class="ph ph-apple-logo" aria-hidden="true"></i><div><h3>macOS</h3><p>Universal · Apple 芯片与 Intel</p></div></header>
            <p class="native-platform-description">同一个 DMG 支持两类 Mac。打开 DMG，将 LRO 进阶客户端拖入「应用程序」后启动。</p>
            <a class="native-download-link native-download-primary" href="https://client.ltsd.ro/native/${NATIVE_VERSION}/LRO-Client-${NATIVE_VERSION}-macos-universal.dmg" data-native-asset="darwin-universal"><span><i class="ph ph-download-simple" aria-hidden="true"></i>下载 macOS 版</span><small data-native-size="darwin-universal">64.6 MB</small></a>
            <div class="native-platform-foot"><span>DMG 安装镜像</span><span>签名并公证</span></div>
          </article>
          <article class="native-platform-card">
            <header class="native-platform-header"><i class="ph ph-linux-logo" aria-hidden="true"></i><div><h3>Linux</h3><p>x86_64 与 aarch64</p></div></header>
            <p class="native-platform-description">按系统架构和发行版选择 DEB 或 RPM。安装与更新由系统软件包机制完成授权。</p>
            <div class="native-download-actions">
              <a class="native-download-link" href="https://client.ltsd.ro/native/${NATIVE_VERSION}/LRO-Client-${NATIVE_VERSION}-linux-amd64.deb" data-native-asset="linux-x86_64-deb"><span>x86_64 · DEB</span><small data-native-size="linux-x86_64-deb">31.6 MB</small></a>
              <a class="native-download-link" href="https://client.ltsd.ro/native/${NATIVE_VERSION}/LRO-Client-${NATIVE_VERSION}-linux-x86_64.rpm" data-native-asset="linux-x86_64-rpm"><span>x86_64 · RPM</span><small data-native-size="linux-x86_64-rpm">31.6 MB</small></a>
              <a class="native-download-link" href="https://client.ltsd.ro/native/${NATIVE_VERSION}/LRO-Client-${NATIVE_VERSION}-linux-arm64.deb" data-native-asset="linux-aarch64-deb"><span>ARM64 · DEB</span><small data-native-size="linux-aarch64-deb">31.7 MB</small></a>
              <a class="native-download-link" href="https://client.ltsd.ro/native/${NATIVE_VERSION}/LRO-Client-${NATIVE_VERSION}-linux-aarch64.rpm" data-native-asset="linux-aarch64-rpm"><span>ARM64 · RPM</span><small data-native-size="linux-aarch64-rpm">31.7 MB</small></a>
            </div>
          </article>
        </div>
        <p class="native-download-note"><i class="ph ph-shield-check" aria-hidden="true"></i><span>页面版本：<strong data-native-version>v${NATIVE_VERSION}</strong>。安装包来自 <code>client.ltsd.ro/native/</code>，客户端更新会验证 Tauri 签名与版本。</span></p>
      </section>

      <section class="client-section" aria-labelledby="native-title">
        <div class="section-heading">
          <div><p class="eyebrow">NATIVE BY DESIGN</p><h2 id="native-title">打开客户端，剩下的交给它</h2></div>
          <p>保留进阶客户端的玩法与体验，把安装、运行和更新收回到一个独立桌面程序中。</p>
        </div>
        <div class="native-capabilities">${nativeCapabilitiesMarkup()}</div>
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

      <section class="client-feedback" aria-label="问题反馈">
        <span class="feedback-badge">问题反馈</span>
        <p>使用中遇到问题？加入 QQ 交流群 <button type="button" class="qq-copy" data-copy="725955796" aria-label="复制QQ群号 725955796"><span>725955796</span><span class="copy-hint" aria-hidden="true">复制</span></button> 或前往<a class="feedback-link" href="/guestbook">玩家登记簿（露天商店留言簿）</a>留言反馈。</p>
      </section>
    </main>
    <footer class="site-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46" /></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/accounts">KE 监控台</a><a href="/guestbook">玩家登记簿</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>
  `;

  mountSiteNav(root);
  injectLegalLinksIntoFooters(root);

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

  refreshNativeReleases(root);
}

function isNativeAsset(value: unknown): value is NativeAsset {
  if (!value || typeof value !== "object") return false;
  const asset = value as Partial<NativeAsset>;
  return typeof asset.url === "string" && asset.url.startsWith("https://client.ltsd.ro/native/");
}

function nativeSize(size: unknown): string | null {
  return typeof size === "number" && Number.isFinite(size) && size > 0
    ? `${(size / 1_000_000).toFixed(1)} MB`
    : null;
}

/** 同步官方 Native 清单；网络不可用时保留已核实的下载快照。 */
function refreshNativeReleases(root: HTMLElement): void {
  void (async () => {
    try {
      const [latestResponse, linuxResponse] = await Promise.all([
        fetch(NATIVE_LATEST_URL, { headers: { accept: "application/json" } }),
        fetch(NATIVE_LINUX_URL, { headers: { accept: "application/json" } }),
      ]);
      if (!latestResponse.ok || !linuxResponse.ok) return;
      const [latest, linux] = (await Promise.all([
        latestResponse.json(),
        linuxResponse.json(),
      ])) as [NativeManifest, NativeManifest];
      if (!latest.version || latest.version !== linux.version) return;

      const assets: Record<string, NativeAsset | undefined> = {
        ...latest.installers,
        ...linux.platforms,
      };
      root.querySelectorAll<HTMLAnchorElement>("[data-native-asset]").forEach((link) => {
        const asset = assets[link.dataset.nativeAsset ?? ""];
        if (isNativeAsset(asset)) link.href = asset.url;
      });
      root.querySelectorAll<HTMLElement>("[data-native-size]").forEach((element) => {
        const asset = assets[element.dataset.nativeSize ?? ""];
        const size = isNativeAsset(asset) ? nativeSize(asset.size) : null;
        if (size) element.textContent = size;
      });
      root.querySelectorAll<HTMLElement>("[data-native-version]").forEach((element) => {
        element.textContent = `v${latest.version}`;
      });
    } catch {
      // 清单不可用时不阻断下载，继续显示当前快照。
    }
  })();
}
