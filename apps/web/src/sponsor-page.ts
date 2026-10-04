import { AnalyticsEvent, track } from "./analytics";
import { MarketApi } from "./api";
import { mountSiteNav, siteNavMarkup } from "./nav";
import type { SponsorHonorEntry, SponsorSummary } from "./types";

/**
 * 赛博化缘页（/sponsor）。
 *
 * 纯为爱发电的非营利说明页：本月真实打赏收入 + 累计赞助光荣榜，
 * 数据由 Worker 用 secret 中的爱发电 token 服务端拉取（见 routes/sponsors.ts），
 * 浏览器只会访问自家 /api/v1/sponsors，永远接触不到 token。
 */

const AFDIAN_PAGE_URL = "https://afdian.com/a/LTSD_RO";

export function mountSponsorPage(root: HTMLElement): void {
  document.title = "赛博化缘 · 露天商店.Ro";
  root.innerHTML = `
    <header class="site-header">
      <div class="topbar page-width">
        <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
        ${siteNavMarkup("sponsors")}
      </div>
    </header>
    <main class="sponsor-main page-width">
      <section class="sponsor-hero" aria-labelledby="sponsor-page-title">
        <div class="sponsor-hero-copy">
          <p class="eyebrow">赛博化缘 / SUPPORT ON AFDian</p>
          <h1 id="sponsor-page-title">赛博<span>化缘</span></h1>
          <p class="sponsor-hero-subtitle">露天商店.Ro 一直挂在白嫖来的免费服务器上，由站长个人维护，纯靠爱发电。免费服务器偶尔抽风，所以开了这个化缘页：如果你觉得这个站点确实帮到了你，可以自愿赏口饭吃，凑点钱把服务器升级成稳定的付费版。</p>
          <div class="sponsor-hero-meta">
            <span class="meta-chip"><i class="ph ph-hand-heart" aria-hidden="true"></i>完全自愿</span>
            <span class="meta-chip"><i class="ph ph-bell-slash" aria-hidden="true"></i>随时可停</span>
            <span class="meta-chip"><i class="ph ph-gift" aria-hidden="true"></i>无回报义务</span>
            <span class="meta-chip"><i class="ph ph-hard-drives" aria-hidden="true"></i>仅用于站点开销</span>
          </div>
          <p class="sponsor-hero-note"><i class="ph ph-info" aria-hidden="true"></i>打赏不影响站点任何现有功能，无论打赏与否，所有功能都一如既往免费开放。</p>
        </div>
        <aside class="sponsor-fund-card" aria-label="本月打赏收入">
          <span class="fund-kicker"><i class="ph ph-coffee" aria-hidden="true"></i>本月化缘收入</span>
          <div class="fund-month" data-sponsor-month>本月（北京时间）</div>
          <div class="fund-amount"><span class="fund-currency">¥</span><strong data-sponsor-income>—</strong></div>
          <p class="fund-sub" data-sponsor-status>正在清点香火钱…</p>
          <a class="sponsor-cta-button" href="${AFDIAN_PAGE_URL}" target="_blank" rel="noopener noreferrer" data-sponsor-cta>
            <i class="ph ph-heart" aria-hidden="true"></i>
            <span>前往爱发电打赏</span>
            <i class="ph ph-arrow-square-out" aria-hidden="true"></i>
          </a>
          <p class="fund-footnote" data-sponsor-updated>数据来自爱发电，每分钟自动更新</p>
        </aside>
      </section>

      <section class="site-notice sponsor-notice" aria-label="化缘说明">
        <span class="notice-badge">关于化缘</span>
        <div class="notice-body">
          <p><strong>钱会花在哪：</strong>付费服务器与域名等站点基础开销，让露天商店.Ro 少宕机、少抽风。</p>
          <p><strong>关于回报：</strong>打赏属于自愿支持，没有付费专属功能，也不构成任何交易；爱发电上的支付、退款等规则以平台为准。</p>
        </div>
      </section>

      <section class="sponsor-section" aria-labelledby="sponsor-honor-title">
        <div class="section-heading">
          <div><p class="eyebrow">HONOR ROLL</p><h2 id="sponsor-honor-title">光荣榜</h2></div>
          <p>感谢每一位为爱发电的玩家。榜单按累计支持金额排序，数据来自爱发电。</p>
        </div>
        <div class="sponsor-honor" data-sponsor-honor>
          <p class="sponsor-honor-loading"><i class="ph ph-hourglass" aria-hidden="true"></i>正在搬来功德箱…</p>
        </div>
      </section>

      <section class="sponsor-bottom-cta" aria-label="打赏入口">
        <div>
          <h2>随缘打赏，丰俭由人</h2>
          <p>一元也是爱，一分也是情。功德无量，喵。</p>
        </div>
        <a class="sponsor-cta-button sponsor-cta-button--large" href="${AFDIAN_PAGE_URL}" target="_blank" rel="noopener noreferrer" data-sponsor-cta>
          <i class="ph ph-heart" aria-hidden="true"></i>
          <span>去爱发电支持一下</span>
        </a>
      </section>
    </main>
    <footer class="site-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/accounts">菜农监控台</a><a href="/guestbook">玩家登记簿</a><a href="/updates">更新说明</a><a href="/sponsor">赛博化缘</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>
  `;

  mountSiteNav(root);

  root.querySelectorAll<HTMLAnchorElement>("[data-sponsor-cta]").forEach((link) => {
    link.addEventListener("click", () => {
      track(AnalyticsEvent.SponsorOutbound);
    });
  });

  void refreshSponsorSummary(root);
}

async function refreshSponsorSummary(root: HTMLElement): Promise<void> {
  const incomeEl = root.querySelector<HTMLElement>("[data-sponsor-income]");
  const monthEl = root.querySelector<HTMLElement>("[data-sponsor-month]");
  const statusEl = root.querySelector<HTMLElement>("[data-sponsor-status]");
  const updatedEl = root.querySelector<HTMLElement>("[data-sponsor-updated]");
  const honorEl = root.querySelector<HTMLElement>("[data-sponsor-honor]");
  if (!incomeEl || !monthEl || !statusEl || !updatedEl || !honorEl) return;

  try {
    const summary = await new MarketApi().getSponsorSummary();
    renderFundCard(summary, incomeEl, monthEl, statusEl, updatedEl);
    renderHonorRoll(honorEl, summary.supporters);
  } catch {
    incomeEl.textContent = "—";
    statusEl.textContent = "暂时无法获取收入数据，请稍后再试";
    updatedEl.textContent = "数据来自爱发电，每分钟自动更新";
    honorEl.innerHTML = "";
    const error = document.createElement("p");
    error.className = "sponsor-honor-error";
    error.innerHTML = '<i class="ph ph-cloud-warning" aria-hidden="true"></i>光荣榜数据暂时无法获取，稍后再来看榜吧。';
    honorEl.appendChild(error);
  }
}

function renderFundCard(
  summary: SponsorSummary,
  incomeEl: HTMLElement,
  monthEl: HTMLElement,
  statusEl: HTMLElement,
  updatedEl: HTMLElement,
): void {
  monthEl.textContent = `${summary.monthLabel}（北京时间）`;
  incomeEl.textContent = summary.monthIncome;
  statusEl.textContent = `本月共 ${summary.monthOrderCount} 笔支持 · 累计 ${summary.supporterCount} 位列榜`;
  const minutesAgo = Math.max(0, Math.round((Date.now() - summary.generatedAt) / 60_000));
  updatedEl.textContent = minutesAgo <= 1 ? "数据刚刚更新 · 来源爱发电" : `数据更新于 ${minutesAgo} 分钟前 · 来源爱发电`;
}

function renderHonorRoll(container: HTMLElement, supporters: SponsorHonorEntry[]): void {
  container.innerHTML = "";
  if (supporters.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sponsor-honor-empty";
    empty.innerHTML = `
      <i class="ph ph-heart" aria-hidden="true"></i>
      <p>目前还没有打赏记录。</p>
      <p>光荣榜虚位以待，等你来当榜首。</p>`;
    container.appendChild(empty);
    return;
  }

  for (const [index, supporter] of supporters.entries()) {
    const card = document.createElement(supporter.url ? "a" : "div");
    card.className = "sponsor-honor-card";
    if (supporter.url) {
      card.setAttribute("href", supporter.url);
      card.setAttribute("target", "_blank");
      card.setAttribute("rel", "noopener noreferrer");
    }
    card.setAttribute("aria-label", `${supporter.name}，累计支持 ¥${supporter.amount}`);

    const rank = document.createElement("span");
    rank.className = `honor-rank honor-rank--${rankTone(index)}`;
    rank.setAttribute("aria-hidden", "true");
    rank.innerHTML = index < 3 ? "" : String(index + 1);
    if (index === 0) rank.innerHTML = '<i class="ph ph-crown"></i>';
    else if (index === 1) rank.innerHTML = '<i class="ph ph-medal"></i>';
    else if (index === 2) rank.innerHTML = '<i class="ph ph-trophy"></i>';

    const avatar = document.createElement("span");
    avatar.className = "honor-avatar";
    if (supporter.avatar) {
      const image = document.createElement("img");
      image.src = supporter.avatar;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => {
        image.remove();
        avatar.textContent = supporter.name.slice(0, 1);
        avatar.classList.add("honor-avatar--fallback");
      });
      avatar.appendChild(image);
    } else {
      avatar.textContent = supporter.name.slice(0, 1);
      avatar.classList.add("honor-avatar--fallback");
    }

    const name = document.createElement("span");
    name.className = "honor-name";
    name.textContent = supporter.name;

    const amount = document.createElement("span");
    amount.className = "honor-amount";
    amount.textContent = `¥${supporter.amount}`;

    card.append(rank, avatar, name, amount);
    container.appendChild(card);
  }
}

function rankTone(index: number): "gold" | "silver" | "bronze" | "plain" {
  if (index === 0) return "gold";
  if (index === 1) return "silver";
  if (index === 2) return "bronze";
  return "plain";
}
