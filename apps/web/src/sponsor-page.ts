import { MarketApi } from "./api";
import { mountSiteNav, siteNavMarkup } from "./nav";
import type { SponsorHonorEntry, SponsorSummary } from "./types";

/**
 * 赛博化缘页（/sponsor）。
 *
 * 非营利说明页：本月真实打赏收入 + 累计赞助光荣榜。
 * 数据由 Worker 用 secret 中的爱发电 token + Stripe Secret Key 服务端拉取
 * （见 routes/sponsors.ts），浏览器只访问自家 /api/v1/sponsors，永远接触不到机密。
 *
 * 当前状态：捐款通道暂时关闭。所有打赏入口（Stripe / 爱发电）均渲染为不可点击的
 * 禁用态，并在页面顶部给出暂停公告，向此前积极捐款的同学致谢。光荣榜继续保留展示。
 */

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
          <p class="eyebrow">赛博化缘 / SUPPORT THE STATION</p>
          <h1 id="sponsor-page-title">赛博<span>化缘</span></h1>
          <p class="sponsor-hero-subtitle">露天商店.Ro 一直挂在白嫖来的免费服务器上，由站长个人维护，纯靠打赏。免费服务器偶尔抽风，所以开了这个化缘页：如果你觉得这个站点确实帮到了你，可以自愿赏口饭吃，凑点钱把服务器升级成稳定的付费版。</p>
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
          <div class="sponsor-cta-button sponsor-cta-button--disabled" role="link" aria-disabled="true" data-sponsor-closed>
            <i class="ph ph-prohibit" aria-hidden="true"></i>
            <span>捐款通道暂时关闭</span>
          </div>
          <p class="sponsor-benefit-note">因技术型故障，暂时不接收新捐款。</p>
          <p class="fund-footnote" data-sponsor-updated>数据来自爱发电 + Stripe，每分钟自动更新</p>
        </aside>
      </section>

      <section class="sponsor-closed-banner" aria-label="捐款通道状态">
        <span class="sponsor-closed-icon" aria-hidden="true"><i class="ph ph-hand-heart"></i></span>
        <div class="sponsor-closed-copy">
          <p class="sponsor-closed-title"><i class="ph ph-prohibit" aria-hidden="true"></i>捐款通道暂时关闭</p>
          <p class="sponsor-closed-desc">衷心感谢每一位曾经为本站积极捐款的同学——正是你们一次次慷慨的支持，露天商店.Ro 才能安安稳稳地运转到今天。目前化缘通道已暂时关闭，恢复时间待定；已经收到的每一份心意，都会永远记在下面的光荣簿上。</p>
        </div>
      </section>

      <section class="site-notice sponsor-notice" aria-label="化缘说明">
        <span class="notice-badge">关于化缘</span>
        <div class="notice-body">
          <p><strong>钱会花在哪：</strong>付费服务器与域名等站点基础开销，让露天商店.Ro 少宕机、少抽风。</p>
          <p><strong>关于回报：</strong>打赏属于自愿支持，没有付费专属功能，也不构成任何交易；爱发电与 Stripe 上的支付、退款等规则以平台为准。</p>
        </div>
      </section>

      <section class="sponsor-section" aria-labelledby="sponsor-honor-title">
        <div class="section-heading">
          <div><p class="eyebrow">HONOR ROLL</p><h2 id="sponsor-honor-title">光荣榜</h2></div>
          <p>感谢每一位为爱发电的玩家。榜单按累计支持金额排序，数据来自爱发电与 Stripe。</p>
        </div>
        <div class="sponsor-honor" data-sponsor-honor>
          <p class="sponsor-honor-loading"><i class="ph ph-hourglass" aria-hidden="true"></i>正在搬来功德箱…</p>
        </div>
      </section>

      <section class="sponsor-bottom-cta" aria-label="捐款通道状态">
        <div class="sponsor-bottom-copy">
          <h2>谢谢曾经慷慨解囊的你</h2>
          <p>捐款通道暂时关闭，但每一份支持都已被记在心上。再次感谢之前为本站积极捐款的同学。</p>
        </div>
        <div class="sponsor-bottom-actions">
          <div class="sponsor-cta-button sponsor-cta-button--large sponsor-cta-button--disabled" role="link" aria-disabled="true" data-sponsor-closed>
            <i class="ph ph-prohibit" aria-hidden="true"></i>
            <span>捐款通道暂时关闭</span>
          </div>
        </div>
      </section>
    </main>
    <footer class="site-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/accounts">菜农监控台</a><a href="/guestbook">玩家登记簿</a><a href="/updates">更新说明</a><a href="/sponsor">赛博化缘</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>资料来源于公开市场记录 · 仅供游戏内交易参考</small></div></footer>
  `;

  mountSiteNav(root);

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
    updatedEl.textContent = "数据来自爱发电 + Stripe，每分钟自动更新";
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
  updatedEl.textContent = minutesAgo <= 1 ? "数据刚刚更新 · 来源爱发电 + Stripe" : `数据更新于 ${minutesAgo} 分钟前 · 来源爱发电 + Stripe`;
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

    const source = document.createElement("span");
    const sourceKind = supporter.source === "stripe" ? "stripe" : "afdian";
    source.className = `sponsor-source-badge sponsor-source-badge--${sourceKind}`;
    source.textContent = sourceKind === "stripe" ? "Stripe" : "爱发电";

    const amount = document.createElement("span");
    amount.className = "honor-amount";
    amount.textContent = `¥${supporter.amount}`;

    card.append(rank, avatar, name, source, amount);
    container.appendChild(card);
  }
}

function rankTone(index: number): "gold" | "silver" | "bronze" | "plain" {
  if (index === 0) return "gold";
  if (index === 1) return "silver";
  if (index === 2) return "bronze";
  return "plain";
}
