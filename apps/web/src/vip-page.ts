import { authStore, type AuthStore, type AuthStoreState } from "./auth/store";
import { mountSiteNav, siteNavMarkup } from "./nav";

/**
 * 会员定价页（/vip/price）。
 *
 * 刻意不加入主导航、页脚或任何其它页面的链接：只能通过 URL 直接访问。
 *
 * 所有「购买」按钮都指向同一个 Stripe 收款链接（Payment Link）；该链接的收款方式
 * 已开启支付宝，因此支付宝入口与 Stripe 入口共用同一链接（页面上仍保留两个入口
 * 以便国内用户直接识别）。站点不接触任何卡号与支付信息。
 */

const STRIPE_CHECKOUT_URL = "https://buy.stripe.com/28E5kFdkNbeo6nyejM1RC01";

/** 收款通道的对外展示名，两个入口共用同一链接。 */
const PAY_ALIPAY_LABEL = "支付宝支付";
const PAY_STRIPE_LABEL = "Stripe 支付";

interface VipBenefit {
  readonly icon: string;
  readonly title: string;
  readonly desc: string;
  readonly tag: string;
}

const BENEFITS: readonly VipBenefit[] = [
  {
    icon: "ph-chart-line-up",
    title: "市场深度数据",
    desc: "查看道具近 90 天成交曲线、最低价与成交量记录，并导出 CSV 自行做行情分析。",
    tag: "数据",
  },
  {
    icon: "ph-monitor",
    title: "监控台账号扩容",
    desc: "菜农监控台的账号位从 3 个提升到 20 个，多开挂机的角色都能放进来一起看。",
    tag: "监控",
  },
  {
    icon: "ph-bell-ringing",
    title: "掉线与死亡提醒",
    desc: "角色掉线、HP 归零或负重爆满时，通过邮件推送提醒，不用一直盯着屏幕。",
    tag: "提醒",
  },
  {
    icon: "ph-crown",
    title: "会员身份标识",
    desc: "监控台卡片、玩家登记簿与账号头像旁展示金色会员徽章与专属昵称配色。",
    tag: "身份",
  },
  {
    icon: "ph-rocket-launch",
    title: "新功能抢先体验",
    desc: "进阶客户端 Beta 与新实验性功能优先开放，随时反馈随时改。",
    tag: "尝鲜",
  },
  {
    icon: "ph-headset",
    title: "优先支持",
    desc: "反馈与问题排查进入优先队列，站长优先处理会员提交的 bug 与需求。",
    tag: "服务",
  },
];

interface VipPlan {
  readonly name: string;
  readonly audience: string;
  readonly price: string;
  readonly unit: string;
  /** 划线原价；永久档没有原价，留空。 */
  readonly wasPrice: string;
  readonly saving: string;
  readonly features: readonly string[];
  readonly excluded: readonly string[];
  readonly footnote: string;
  readonly badge?: string;
}

const PLANS: readonly VipPlan[] = [
  {
    name: "月卡",
    audience: "先试一个月",
    price: "30",
    unit: "/ 月",
    wasPrice: "¥30",
    saving: "",
    features: ["全部 6 项会员服务", "监控台 20 个账号位"],
    excluded: ["不含次年续费折扣"],
    footnote: "到期自动降级为普通玩家，不自动扣费",
  },
  {
    name: "季卡",
    audience: "稳定玩一个赛季",
    price: "78",
    unit: "/ 季",
    wasPrice: "¥90",
    saving: "省 ¥12 · 约 ¥26/月",
    features: ["全部 6 项会员服务", "监控台 20 个账号位", "有效期 90 天"],
    excluded: [],
    footnote: "折合每月比月卡便宜 ¥4",
  },
  {
    name: "年卡",
    audience: "长期挂机的首选",
    price: "268",
    unit: "/ 年",
    wasPrice: "¥360",
    saving: "省 ¥92 · 约 ¥22.3/月",
    features: ["全部 6 项会员服务", "监控台 20 个账号位", "有效期 365 天"],
    excluded: [],
    footnote: "每 7 位开通年卡，就够站点跑一个月",
    badge: "最受欢迎",
  },
  {
    name: "永久",
    audience: "一次买断，长期有效",
    price: "588",
    unit: "/ 买断",
    wasPrice: "",
    saving: "不限时长",
    features: [
      "全部 6 项会员服务",
      "监控台 20 个账号位",
      "永久有效 · 后续新权益同样解锁",
    ],
    excluded: [],
    footnote: "适合长期不换号的老玩家",
  },
];

interface CompareRow {
  readonly label: string;
  /** 四档取值，true = 支持（打勾），false = 不支持（打叉）。 */
  readonly values: readonly (string | boolean)[];
}

const COMPARE_ROWS: readonly CompareRow[] = [
  { label: "市场深度数据（90 天曲线 · 导出）", values: [true, true, true, true] },
  { label: "监控台账号位", values: ["20 个", "20 个", "20 个", "20 个"] },
  { label: "掉线 / 死亡 / 负重提醒（邮件）", values: [true, true, true, true] },
  { label: "会员徽章与专属昵称配色", values: [true, true, true, true] },
  { label: "新功能抢先体验", values: [true, true, true, true] },
  { label: "优先支持", values: [true, true, true, true] },
  { label: "有效期", values: ["30 天", "90 天", "365 天", "永久"] },
  {
    label: "是否自动续费",
    values: ["不自动扣费", "不自动扣费", "不自动扣费", "无需续费"],
  },
];

const PLAN_HEADERS = ["月卡", "季卡", "年卡", "永久"] as const;
const PLAN_FOOTER_PRICE = ["¥30 / 月", "¥78 / 季", "¥268 / 年", "¥588 买断"] as const;
const PLAN_FOOTER_MONTHLY = ["¥30.0", "≈ ¥26.0", "≈ ¥22.3", "—"] as const;

const FAQS: readonly { readonly question: string; readonly answer: string }[] = [
  {
    question: "可以用支付宝付款吗？",
    answer:
      "可以。两个「支付宝支付」入口都会打开同一个 Stripe 收单页面，用手机扫码即可，人民币结算，不强制绑定银行卡。",
  },
  {
    question: "两个按钮有什么区别？",
    answer:
      "没有区别，指向的是同一个收款链接。支付宝入口是给习惯扫码的用户看的，Stripe 入口适合用国际信用卡或 Apple Pay 的玩家。",
  },
  {
    question: "开通后多久生效？",
    answer:
      "付款成功后由 Stripe 回调写入会员到期时间，通常几秒内即时生效；续费会在当前到期时间上叠加，不用等旧的用完再买。",
  },
  {
    question: "换账号后会员还在吗？",
    answer:
      "会员绑定本站 LTSD 账号，不绑定游戏角色。请注意账号 ID 与游戏账号是两套体系，付款前请确认使用的是要开通的账号。",
  },
  {
    question: "不开会员会影响现有功能吗？",
    answer: "不会。搜索市场、菜农监控台与玩家登记簿对所有玩家保持免费，会员仅增加额外权益。",
  },
  {
    question: "可以退款吗？",
    answer:
      "数字服务一经开通原则上不支持退款；若 24 小时内发现权益无法使用且问题未解决，可申请原路退回。",
  },
];

export function mountVipPage(
  root: HTMLElement,
  store: AuthStore = authStore,
): void {
  document.title = "购买会员 · 露天商店.Ro";
  root.innerHTML = `
    <header class="site-header">
      <div class="topbar page-width">
        <a class="brand" href="/" aria-label="露天商店.Ro首页"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>
        ${siteNavMarkup(null)}
      </div>
    </header>
    <main class="vip-main page-width">
      <section class="vip-hero" aria-labelledby="vip-page-title">
        <div class="vip-hero-copy">
          <p class="eyebrow">会员 / VIP MEMBERSHIP</p>
          <h1 id="vip-page-title">购买<span>会员</span></h1>
          <p class="vip-hero-subtitle">为交易资料站补一笔「运营燃料」，换取更深的市场数据和更省心的挂机监控。开通后即时解锁，支付宝与 Stripe 走同一个收款链接，四个档位可选。</p>
          <div class="vip-hero-meta">
            <span class="meta-chip"><i class="ph ph-credit-card" aria-hidden="true"></i>支付宝 / Stripe</span>
            <span class="meta-chip"><i class="ph ph-shield-check" aria-hidden="true"></i>不接触卡号信息</span>
            <span class="meta-chip"><i class="ph ph-user-circle-check" aria-hidden="true"></i>绑定 LTSD 账号</span>
            <span class="meta-chip"><i class="ph ph-infinity" aria-hidden="true"></i>基础功能永久免费</span>
          </div>
        </div>
        <aside class="vip-status-card" aria-label="当前会员状态" data-vip-status>
          <span class="status-kicker"><i class="ph ph-hourglass" aria-hidden="true"></i>正在读取账号状态…</span>
        </aside>
      </section>

      <section class="vip-section" aria-labelledby="vip-benefit-title">
        <div class="section-heading">
          <div><p class="eyebrow">MEMBER SERVICES</p><h2 id="vip-benefit-title">会员包含哪些服务</h2></div>
          <p>六项增值服务，开通后在账号有效期内全部解锁；站点的搜索、监控台与登记簿等基础功能不因是否付费而改变。</p>
        </div>
        <div class="vip-benefit-grid">
          ${BENEFITS.map(
            (benefit) => `
          <article class="vip-benefit-card">
            <span class="vip-benefit-icon" aria-hidden="true"><i class="ph ${benefit.icon}"></i></span>
            <h3>${benefit.title}</h3>
            <p>${benefit.desc}</p>
            <span class="vip-benefit-tag">${benefit.tag}</span>
          </article>`,
          ).join("")}
        </div>
      </section>

      <section class="vip-section" id="plans" aria-labelledby="vip-plan-title">
        <div class="section-heading">
          <div><p class="eyebrow">PLANS &amp; PRICING</p><h2 id="vip-plan-title">选择套餐</h2></div>
          <p>四个档位权益相同、时长不同；长期档位折算月单价更低。所有价格单位为人民币（¥），一次性付款，不自动续费。</p>
        </div>
        <div class="vip-plan-grid">
          ${PLANS.map((plan) => planCardMarkup(plan)).join("")}
        </div>
      </section>

      <section class="vip-section" aria-labelledby="vip-pay-title">
        <div class="section-heading">
          <div><p class="eyebrow">PAYMENT METHODS</p><h2 id="vip-pay-title">支持的付款方式</h2></div>
          <p>付款统一由 Stripe 收单，页面不接触你的卡号；国内用户直接扫码即可完成支付。</p>
        </div>
        <div class="vip-pay-methods">
          <article class="vip-pay-method vip-pay-method--alipay">
            <span class="vip-pay-mark vip-pay-mark--alipay" aria-hidden="true"><i class="ph ph-qr-code"></i></span>
            <div>
              <h3>支付宝<span class="vip-pay-tag">ALIPAY</span></h3>
              <p>扫码即付，无需绑定银行卡，人民币直接结算。由 Stripe 收单页面提供支付宝通道。</p>
              <ul><li>扫码支付</li><li>无需银行卡</li><li>人民币结算</li><li>Stripe 收单</li></ul>
            </div>
          </article>
          <article class="vip-pay-method vip-pay-method--stripe">
            <span class="vip-pay-mark vip-pay-mark--stripe" aria-hidden="true"><i class="ph ph-credit-card"></i></span>
            <div>
              <h3>Stripe<span class="vip-pay-tag">STRIPE</span></h3>
              <p>面向海外或习惯用卡的玩家，支持主流国际信用卡与钱包，全程加密不落地。</p>
              <ul><li>Visa</li><li>Mastercard</li><li>JCB</li><li>Apple Pay / Google Pay</li></ul>
            </div>
          </article>
        </div>
      </section>

      <section class="vip-section" aria-labelledby="vip-compare-title">
        <div class="section-heading">
          <div><p class="eyebrow">DETAIL COMPARISON</p><h2 id="vip-compare-title">四档权益对比</h2></div>
          <p>权益完全相同，差别只在时长与折算价格；新权益上线后所有档位同步解锁。</p>
        </div>
        <div class="compare-wrap vip-compare-wrap">
          <table class="compare-table vip-compare">
            <caption class="vip-compare-caption">四档会员的产品、服务与价格明细</caption>
            <thead>
              <tr>
                <th scope="col">权益 / 服务</th>
                ${PLAN_HEADERS.map(
                  (plan, index) =>
                    `<th scope="col"${index === 2 ? ' class="col-new"' : ""}>${plan}</th>`,
                ).join("")}
              </tr>
            </thead>
            <tbody>
              ${COMPARE_ROWS.map(
                (row) => `
              <tr>
                <th scope="row" class="col-feature">${row.label}</th>
                ${row.values
                  .map(
                    (value, index) =>
                      `<td${index === 2 ? ' class="col-new"' : ""}>${compareCell(value)}</td>`,
                  )
                  .join("")}
              </tr>`,
              ).join("")}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">价格（人民币）</th>
                ${PLAN_FOOTER_PRICE.map(
                  (price, index) => `<td${index === 2 ? ' class="col-new"' : ""}>${price}</td>`,
                ).join("")}
              </tr>
              <tr>
                <th scope="row">折算月单价</th>
                ${PLAN_FOOTER_MONTHLY.map(
                  (price, index) => `<td${index === 2 ? ' class="col-new"' : ""}>${price}</td>`,
                ).join("")}
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section class="site-notice vip-notice" aria-label="购买须知">
        <span class="notice-badge">购买须知</span>
        <div class="notice-body">
          <p><strong>会员是增值服务，不是收费墙。</strong>搜索市场、菜农监控台、玩家登记簿等现有功能对所有玩家免费开放；会员只额外解锁上表中的深度数据与提醒等增值项。</p>
          <p><strong>付款与生效：</strong>付款由 Stripe 收单，本站不保存卡号。付款成功后会按账号自动写入会员到期时间，当前档位剩余时长自动叠加；如需开具凭证或对订单有疑问，可通过 <a href="/guestbook">玩家登记簿</a> 或 QQ 群（725955796）联系站长。</p>
          <p><strong>退款说明：</strong>数字服务一经开通原则上不支持退款；若 24 小时内发现权益无法使用且问题未解决，可申请原路退回。</p>
        </div>
      </section>

      <section class="vip-section" aria-labelledby="vip-faq-title">
        <div class="section-heading">
          <div><p class="eyebrow">FAQ</p><h2 id="vip-faq-title">常见问题</h2></div>
          <p>关于付款、开通与账号绑定的常见疑问。</p>
        </div>
        <div class="vip-faq-grid">
          ${FAQS.map(
            (faq) => `
          <article class="vip-faq-item">
            <h3>${faq.question}</h3>
            <p>${faq.answer}</p>
          </article>`,
          ).join("")}
        </div>
      </section>
    </main>
    <footer class="site-footer vip-footer"><div class="page-width footer-inner"><div><a class="brand footer-brand" href="/"><span class="brand-mark">RO</span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a><p>让每一次摆摊，都更容易被找到。</p></div><div class="footer-links"><a href="/#search">搜索市场</a><a href="/accounts">菜农监控台</a><a href="/guestbook">玩家登记簿</a><a href="/updates">更新说明</a><a href="https://game.lastro.cn/?r=pc/news&nid=5" target="_blank" rel="noreferrer">LastRO 官网</a></div><small>支付由 Stripe 收单 · 账号与付款信息仅用于会员开通，不做他用</small></div></footer>
  `;

  mountSiteNav(root, store);

  const statusCard = root.querySelector<HTMLElement>("[data-vip-status]");
  if (statusCard) {
    const render = (): void => renderStatusCard(statusCard, store.getState());
    store.subscribe(render);
    render();
  }
}

function planCardMarkup(plan: VipPlan): string {
  const badge = plan.badge
    ? `<span class="vip-plan-badge">${plan.badge}</span>`
    : "";
  const compare = [
    plan.wasPrice ? `<span class="vip-plan-was">${plan.wasPrice}</span>` : "",
    plan.saving ? `<span class="vip-plan-save">${plan.saving}</span>` : "",
  ]
    .filter(Boolean)
    .join("");
  const features = plan.features
    .map(
      (feature) =>
        `<li><i class="ph ph-check-circle" aria-hidden="true"></i>${feature}</li>`,
    )
    .join("");
  const excluded = plan.excluded
    .map(
      (feature) =>
        `<li class="is-off"><i class="ph ph-minus-circle" aria-hidden="true"></i>${feature}</li>`,
    )
    .join("");
  const label = `${plan.name} ${plan.price} 元`;

  return `
          <article class="vip-plan-card${plan.badge ? " vip-plan-card--featured" : ""}">
            ${badge}
            <span class="vip-plan-name">${plan.name}</span>
            <span class="vip-plan-for">${plan.audience}</span>
            <div class="vip-plan-price"><span class="vip-plan-currency">¥</span><strong>${plan.price}</strong><span class="vip-plan-per">${plan.unit}</span></div>
            <div class="vip-plan-compare">${compare}</div>
            <ul class="vip-plan-features">${features}${excluded}</ul>
            <div class="vip-plan-actions">
              ${checkoutLink("vip-pay-alipay", "ph-qr-code", PAY_ALIPAY_LABEL, label)}
              ${checkoutLink("vip-pay-stripe", "ph-credit-card", PAY_STRIPE_LABEL, label)}
            </div>
            <p class="vip-plan-foot">${plan.footnote}</p>
          </article>`;
}

/** 购买入口统一指向同一个 Stripe 收款链接，新标签打开以免丢失当前页面。 */
function checkoutLink(
  className: string,
  icon: string,
  text: string,
  planLabel: string,
): string {
  return `<a class="${className}" href="${STRIPE_CHECKOUT_URL}" target="_blank" rel="noopener noreferrer" aria-label="${planLabel}：使用${text}，在新页面完成 Stripe 付款"><i class="ph ${icon}" aria-hidden="true"></i>${text}</a>`;
}

function compareCell(value: string | boolean): string {
  if (value === true)
    return '<i class="ph ph-check-circle vip-compare-yes" aria-hidden="true"></i><span class="vip-visually-hidden">支持</span>';
  if (value === false)
    return '<i class="ph ph-x-circle vip-compare-no" aria-hidden="true"></i><span class="vip-visually-hidden">不支持</span>';
  return value;
}

function renderStatusCard(card: HTMLElement, state: Readonly<AuthStoreState>): void {
  if (state.status === "loading") {
    card.innerHTML = `
      <span class="status-kicker"><i class="ph ph-hourglass" aria-hidden="true"></i>当前会员状态</span>
      <p class="vip-status-note">正在读取账号状态…</p>`;
    return;
  }

  if (state.status === "error" || state.status === "disabled") {
    card.innerHTML = `
      <span class="status-kicker"><i class="ph ph-crown" aria-hidden="true"></i>当前会员状态</span>
      <p class="vip-status-note">账号服务暂不可用，无法读取登录状态。请稍后刷新重试，会员开通不受影响。</p>
      <a class="vip-status-cta" href="#plans"><i class="ph ph-crown-simple" aria-hidden="true"></i>选择套餐开通</a>`;
    return;
  }

  const signedIn =
    state.status === "pending" || state.status === "active"
      ? state.user
      : undefined;

  const identity = signedIn
    ? `
      <div class="status-account">
        <span class="status-avatar" aria-hidden="true">${escapeHtml(
          signedIn.display_name.slice(0, 1),
        )}</span>
        <div><strong>${escapeHtml(signedIn.display_name)}</strong><small>${escapeHtml(
          signedIn.email,
        )}</small></div>
      </div>`
    : `
      <div class="status-account">
        <span class="status-avatar status-avatar--guest" aria-hidden="true"><i class="ph ph-user"></i></span>
        <div><strong>尚未登录</strong><small>登录后会员才绑定到你的账号</small></div>
      </div>`;

  const cta = signedIn
    ? `<a class="vip-status-cta" href="#plans"><i class="ph ph-crown-simple" aria-hidden="true"></i>选择套餐开通</a>`
    : `<button class="vip-status-cta" type="button" data-open-login>登录 LTSD 账号</button>`;

  const note = signedIn
    ? "付款成功后会员会自动绑定到该账号并即时生效，续费将在当前到期时间上叠加。"
    : "登录后即可开通会员，付款成功后会员会自动绑定到你的账号。";

  card.innerHTML = `
      <span class="status-kicker"><i class="ph ph-crown" aria-hidden="true"></i>当前会员状态</span>
      ${identity}
      <span class="status-badge"><i class="ph ph-minus-circle" aria-hidden="true"></i>尚未开通会员</span>
      <div class="status-level"><dt>会员档位</dt><dd>普通玩家</dd></div>
      <div class="status-level"><dt>到期时间</dt><dd>—</dd></div>
      ${cta}
      <p class="vip-status-note">${note}</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}
