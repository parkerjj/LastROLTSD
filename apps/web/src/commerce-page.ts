import {
  COMMERCE_DAY_MS,
  getCommerceCatalog,
  priceLineCents,
  tierForDuration,
  type CommerceCatalog,
  type CommerceProduct,
  type CommerceTerm,
} from "@lastroweb/commerce";
import { siteNavMarkup, mountSiteNav } from "./nav";
import { authApi } from "./auth/api";
import { authStore } from "./auth/store";
import type {
  CommerceApi,
  CommerceBootstrap,
  CommerceBootstrapEntitlement,
  CommerceBootstrapUnit,
  CommercePreviewEntitlement,
  CommerceQuote,
  CommerceQuoteSelection,
} from "./commerce-api";
import "./commerce-page.css";

const TERM_DAYS = [30, 90, 180, 360] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value);
}

function validCatalog(value: unknown): value is CommerceCatalog {
  if (!record(value) || typeof value.pricingVersion !== "string" || !value.pricingVersion.trim()
    || value.currency !== "CNY" || value.billingMonthDays !== 30
    || !Array.isArray(value.products) || !Array.isArray(value.terms)) return false;
  const products = value.products;
  const hasProduct = (key: string, mode: string) => products.some((product) => record(product)
    && product.key === key && product.purchaseMode === mode
    && typeof product.name === "string" && typeof product.description === "string"
    && typeof product.unitLabel === "string" && decimal(product.monthlyUnitPriceCents));
  return products.length === 2
    && hasProduct("slots", "quantity-and-duration")
    && hasProduct("module:standalone", "duration")
    && value.terms.length === 4
    && value.terms.every((term, index) => record(term)
      && term.days === TERM_DAYS[index]
      && term.discountPercent === (index < 2 ? 100 : index === 2 ? 80 : 70));
}

function validSession(value: unknown): boolean {
  if (!record(value) || !record(value.user)) return false;
  const user = value.user;
  return typeof user.id === "string" && decimal(user.id)
    && typeof user.email === "string" && typeof user.display_name === "string"
    && ["ACTIVE", "PENDING_EMAIL", "DISABLED"].includes(String(user.status))
    && Number.isSafeInteger(user.permission_level)
    && (user.email_verified_at === null || Number.isSafeInteger(user.email_verified_at))
    && Number.isSafeInteger(user.created_at)
    && typeof user.has_avatar === "boolean"
    && Number.isSafeInteger(user.avatar_version)
    && typeof user.avatar_url === "string"
    && Number.isSafeInteger(value.expires_at)
    && typeof value.csrf_token === "string" && value.csrf_token.length > 0
    && (value.mail_availability === null || record(value.mail_availability));
}

function validUnit(value: unknown): value is CommerceBootstrapUnit {
  return record(value)
    && decimal(value.unitId)
    && (value.entitlementId === null || decimal(value.entitlementId))
    && value.resource === "slots"
    && (value.kind === "commerce" || value.kind === "legacy")
    && Number.isSafeInteger(value.quantity) && Number(value.quantity) > 0
    && decimal(value.startsAt) && decimal(value.expiresAt)
    && (value.source === null || typeof value.source === "string")
    && (value.sourceRef === null || typeof value.sourceRef === "string")
    && typeof value.isGift === "boolean";
}

function validEntitlement(value: unknown): value is CommerceBootstrapEntitlement {
  return record(value)
    && decimal(value.id)
    && (value.unitId === null || decimal(value.unitId))
    && typeof value.resource === "string"
    && Number.isSafeInteger(value.quantity)
    && decimal(value.startsAt) && decimal(value.expiresAt)
    && typeof value.source === "string"
    && (value.sourceRef === null || typeof value.sourceRef === "string")
    && typeof value.isGift === "boolean";
}

export function readCommerceBootstrap(doc: Document): CommerceBootstrap {
  const element = doc.getElementById("commerce-bootstrap");
  if (!element || element.tagName !== "SCRIPT" || element.getAttribute("type") !== "application/json") {
    throw new Error("购买页面数据暂不可用，请刷新页面");
  }

  let value: unknown;
  try {
    value = JSON.parse(element.textContent ?? "");
  } catch {
    throw new Error("购买页面数据暂不可用，请刷新页面");
  }
  if (!record(value) || value.version !== 1 || !validCatalog(value.catalog)
    || !(value.session === null || validSession(value.session))
    || !record(value.account) || !Array.isArray(value.account.units) || !value.account.units.every(validUnit)
    || !Array.isArray(value.account.entitlements) || !value.account.entitlements.every(validEntitlement)
    || !record(value.account.effective) || !Number.isSafeInteger(value.account.effective.slots)
    || !Array.isArray(value.account.effective.modules)
    || !value.account.effective.modules.every((module) => typeof module === "string")) {
    throw new Error("购买页面数据暂不可用，请刷新页面");
  }
  return value as unknown as CommerceBootstrap;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function formatCents(cents: bigint | string): string {
  const value = typeof cents === "bigint" ? cents : BigInt(cents);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}¥${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function formatDate(value: string): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8_640_000_000_000_000) return "日期不可用";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function formatDuration(value: string | bigint): string {
  let remaining = typeof value === "bigint" ? value : BigInt(value);
  const day = COMMERCE_DAY_MS;
  const hour = 60n * 60n * 1000n;
  const minute = 60n * 1000n;
  const days = remaining / day;
  remaining %= day;
  const hours = remaining / hour;
  remaining %= hour;
  const minutes = remaining / minute;
  return [days ? `${days} 天` : "", hours ? `${hours} 小时` : "", minutes ? `${minutes} 分钟` : ""]
    .filter(Boolean).join(" ") || "不足一分钟";
}

function product(catalog: CommerceCatalog, key: "slots" | "module:standalone"): CommerceProduct {
  const value = catalog.products.find((entry) => entry.key === key);
  if (!value) throw new Error("购买目录缺少商品");
  return value;
}

function activePaidSlots(account: CommerceBootstrap["account"], now: number): CommerceBootstrapUnit[] {
  return account.units.filter((unit) => !unit.isGift && unit.quantity > 0
    && Number(unit.startsAt) <= now && Number(unit.expiresAt) > now);
}

function activeStandalone(account: CommerceBootstrap["account"], now: number): CommerceBootstrapEntitlement[] {
  return account.entitlements.filter((row) => row.resource === "module:standalone" && row.quantity > 0 && !row.isGift
    && Number(row.startsAt) <= now && Number(row.expiresAt) > now);
}

function alignmentExpiries(account: CommerceBootstrap["account"], now: number): Array<{ key: "slots" | "module:standalone"; expiresAt: number }> {
  const rows = activePaidSlots(account, now).map((unit) => ({ key: "slots" as const, expiresAt: Number(unit.expiresAt) }));
  const features = activeStandalone(account, now);
  if (features.length) {
    rows.push({ key: "module:standalone", expiresAt: Math.max(...features.map((row) => Number(row.expiresAt))) });
  }
  return rows;
}

function tierForDays(days: number) {
  return tierForDuration(BigInt(days) * COMMERCE_DAY_MS);
}

function lineCents(catalog: CommerceCatalog, key: "slots" | "module:standalone", durationMs: bigint): bigint {
  const item = product(catalog, key);
  const tier = tierForDuration(durationMs);
  return priceLineCents(BigInt(item.monthlyUnitPriceCents), durationMs, tier);
}

function formatTerm(term: CommerceTerm, catalog: CommerceCatalog, key: "slots" | "module:standalone", group: string): string {
  const note = group === "alignment"
    ? `统一目标后再增加 ${term.days} 天`
    : `${formatCents(lineCents(catalog, key, BigInt(term.days) * COMMERCE_DAY_MS))} / 项`;
  const discount = term.discountPercent === 100 ? "原价" : `${term.discountPercent / 10} 折`;
  return `<button type="button" class="commerce-term" data-focus-key="term-${group}-${term.days}" data-term-days="${term.days}" aria-pressed="false"><strong>${term.days} 天</strong><span>${discount}</span><small>${note}</small></button>`;
}

function entitlementName(row: CommercePreviewEntitlement): string {
  if (row.resource === "slots") return row.isGift ? "赠送实例额度" : "KE 实例额度";
  if (row.resource === "module:standalone") return "全平台离线 KoreEngine";
  if (row.resource === "module:core") return row.isGift ? "核心功能（赠送）" : "核心功能";
  return `额度调整 · ${row.resource}`;
}

function renderAccountPreview(quote: CommerceQuote): string {
  const before = quote.accountPreview.before.entitlements;
  const after = quote.accountPreview.after.entitlements;
  const beforeByKey = new Map<string, CommercePreviewEntitlement>();
  before.forEach((row, index) => beforeByKey.set(row.entitlementId ? `id:${row.entitlementId}` : `row:${index}`, row));
  const used = new Set<string>();
  const rows = after.map((row, index) => {
    const key = row.entitlementId ? `id:${row.entitlementId}` : `new:${index}`;
    used.add(key);
    const old = beforeByKey.get(row.entitlementId ? `id:${row.entitlementId}` : `row:${index}`);
    const label = entitlementName(row);
    const changed = old ? old.expiresAt !== row.expiresAt : row.isNew === true;
    const quantity = row.quantity < 0 ? `调整 ${row.quantity}` : `${row.quantity}`;
    return `<tr data-preview-row="${escapeHtml(key)}"${changed ? ' class="is-changed"' : ""}><th scope="row">${escapeHtml(label)}${row.isGift ? '<span class="commerce-gift-tag">赠送</span>' : ""}</th><td>${quantity}</td><td>${old ? formatDate(old.expiresAt) : "新购"}</td><td>${formatDate(row.expiresAt)}</td></tr>`;
  });
  before.forEach((row, index) => {
    const key = row.entitlementId ? `id:${row.entitlementId}` : `row:${index}`;
    if (used.has(key)) return;
    rows.push(`<tr data-preview-row="${escapeHtml(key)}"><th scope="row">${escapeHtml(entitlementName(row))}</th><td>${row.quantity}</td><td>${formatDate(row.expiresAt)}</td><td>本次不变</td></tr>`);
  });
  return `<div class="commerce-preview-table-wrap"><table class="commerce-preview-table"><thead><tr><th scope="col">账号权益</th><th scope="col">数量</th><th scope="col">购买前到期</th><th scope="col">购买后到期</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function quoteMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "购买服务暂时不可用，请稍后重试";
}

function buildNormalSelection(
  slotMode: "add" | "renew",
  slotQuantity: string,
  slotTermDays: number,
  selectedUnitIds: ReadonlySet<string>,
  featureSelected: boolean,
  featureTermDays: number,
  account: CommerceBootstrap["account"],
): CommerceQuoteSelection[] {
  const selection: CommerceQuoteSelection[] = [];
  if (slotMode === "add") {
    const quantity = Number(slotQuantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) return [];
    selection.push({ type: "slot_add", quantity, termDays: slotTermDays as 30 | 90 | 180 | 360 });
  } else {
    const unitIds = activePaidSlots(account, Date.now()).filter((unit) => selectedUnitIds.has(unit.unitId)).map((unit) => unit.unitId);
    if (unitIds.length) selection.push({ type: "slot_renew", unitIds, termDays: slotTermDays as 30 | 90 | 180 | 360 });
  }
  if (featureSelected) selection.push({ type: "standalone", termDays: featureTermDays as 30 | 90 | 180 | 360 });
  return selection;
}

function selectionPrice(selection: readonly CommerceQuoteSelection[], catalog: CommerceCatalog): bigint {
  return selection.reduce((total, item) => {
    const key = item.type === "standalone" ? "module:standalone" : "slots";
    const amount = lineCents(catalog, key, BigInt(item.termDays) * COMMERCE_DAY_MS);
    const quantity = item.type === "slot_add" ? item.quantity : item.type === "slot_renew" ? item.unitIds.length : 1;
    return total + amount * BigInt(quantity);
  }, 0n);
}

export function mountCommercePage(root: HTMLElement, bootstrap: CommerceBootstrap, api: CommerceApi): void {
  let slotMode: "add" | "renew" = "add";
  let slotTermDays = 30;
  let featureTermDays = 30;
  let alignTermDays = 30;
  let slotQuantity = "1";
  let featureSelected = false;
  const selectedUnitIds = new Set<string>();
  let promotionCode = "";
  let currentQuote: CommerceQuote | null = null;
  let quoteBusy = false;
  let orderBusy = false;
  let errorMessage = "";
  let alignmentNotice = false;
  let orderMessage = "";
  let idempotencyKey: string | null = null;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";
  const canPurchase = bootstrap.session?.user.status === "ACTIVE" && bootstrap.session.user.permission_level >= 1;
  const slotsProduct = product(bootstrap.catalog, "slots");
  const featureProduct = product(bootstrap.catalog, "module:standalone");

  function renderTerms(group: string, key: "slots" | "module:standalone", days: number): string {
    const ariaLabel = group === "alignment" ? "统一到期额外时长" : key === "slots" ? "实例额度期限" : "离线功能期限";
    return `<div class="commerce-terms" data-term-group="${group}" role="group" aria-label="${ariaLabel}">${bootstrap.catalog.terms.map((term) => formatTerm(term, bootstrap.catalog, key, group).replace('aria-pressed="false"', `aria-pressed="${term.days === days}"`)).join("")}</div>`;
  }

  function normalPrice(): bigint {
    return selectionPrice(buildNormalSelection(slotMode, slotQuantity, slotTermDays, selectedUnitIds, featureSelected, featureTermDays, bootstrap.account), bootstrap.catalog);
  }

  function alignmentPrice(now: number): bigint | null {
    const rows = alignmentExpiries(bootstrap.account, now);
    if (!rows.length) return null;
    const latest = Math.max(...rows.map((row) => row.expiresAt));
    const target = latest + alignTermDays * Number(COMMERCE_DAY_MS);
    return rows.reduce((total, row) => total + lineCents(bootstrap.catalog, row.key, BigInt(target - row.expiresAt)), 0n);
  }

  function renderSlots(): string {
    const units = bootstrap.account.units;
    if (!units.length) return '<p class="commerce-empty">目前没有生效中的实例额度。</p>';
    const activeUnitIds = new Set(activePaidSlots(bootstrap.account, Date.now()).map((unit) => unit.unitId));
    return `<div class="commerce-unit-list">${units.map((unit, index) => {
      const selectable = activeUnitIds.has(unit.unitId);
      const selected = selectedUnitIds.has(unit.unitId);
      return `<div class="commerce-unit-row"><div class="commerce-unit-main"><span class="commerce-unit-number">额度 ${index + 1}</span><span class="commerce-unit-kind">${unit.isGift ? '<span class="commerce-gift-tag">永久赠送</span>' : unit.kind === "legacy" ? "既有额度" : "付费额度"}</span><span class="commerce-unit-expiry">到期 ${formatDate(unit.expiresAt)}</span></div>${slotMode === "renew" ? `<label class="commerce-check"><input data-focus-key="unit-${escapeHtml(unit.unitId)}" data-slot-unit="${escapeHtml(unit.unitId)}" type="checkbox" ${selected ? "checked" : ""} ${!selectable ? "disabled" : ""} aria-label="选择续期额度 ${index + 1}"><span>续期</span></label>` : ""}</div>`;
    }).join("")}</div>`;
  }

  function renderQuote(): string {
    if (!currentQuote) return "";
    const quote = currentQuote;
    const tierTotal = formatCents(quote.tierTotalCents);
    const promoTotal = quote.promoTotalCents === null ? null : formatCents(quote.promoTotalCents);
    const strategy = quote.discountStrategy === "promotion_code" ? "整单优惠码胜出" : "期限优惠胜出";
    const itemRows = quote.items.map((item) => {
      const name = item.productKey === "slots" ? "KE 实例额度" : "全平台离线 KoreEngine";
      const operation = item.operation === "ADD" ? "新增" : "续期";
      return `<tr><th scope="row">${name} · ${operation}</th><td>${formatDuration(item.durationMs)}</td><td>${formatDate(item.expectedExpiresAt)}</td><td>${formatCents(item.paidCents)}</td></tr>`;
    }).join("");
    return `<section class="commerce-review" data-review-result aria-labelledby="commerce-review-title"><div class="commerce-section-heading"><div><p class="commerce-kicker">最终确认</p><h2 id="commerce-review-title" data-focus-key="commerce-review-title">本次订单</h2></div><p>报价有效至 ${formatDate(quote.expiresAt)}</p></div><div class="commerce-review-summary"><div><span>期限优惠合计</span><strong>${tierTotal}</strong></div>${promoTotal ? `<div><span>优惠码整单价</span><strong>${promoTotal}</strong></div>` : ""}<div class="commerce-review-total"><span>${strategy} · 不重复叠加</span><strong>${formatCents(quote.selectedTotalCents)}</strong></div></div><div class="commerce-preview-table-wrap"><table class="commerce-preview-table"><thead><tr><th scope="col">购买项目</th><th scope="col">新增时长</th><th scope="col">预计到期</th><th scope="col">金额</th></tr></thead><tbody>${itemRows}</tbody></table></div><div class="commerce-section-heading commerce-account-heading"><div><p class="commerce-kicker">完整账号预览</p><h3>购买前后所有权益</h3></div><p>赠送、未选择和只读调整项目也会保留显示</p></div><div data-account-preview>${renderAccountPreview(quote)}</div><div class="commerce-pay-row"><button class="commerce-button commerce-button--primary" type="button" data-focus-key="commerce-pay" data-action="pay" ${orderBusy ? "disabled" : ""}>${orderBusy ? "正在创建订单…" : `确认订单并前往付款 ${formatCents(quote.selectedTotalCents)}`}</button><span>确认后订单内容固定，付款时间为 30 分钟。</span></div>${orderMessage ? `<p class="commerce-success" role="status">${escapeHtml(orderMessage)}</p>` : ""}</section>`;
  }

  function render(focusKey?: string, caret?: number | null): void {
    const active = root.ownerDocument.activeElement as HTMLElement | null;
    const restoreKey = focusKey ?? active?.dataset.focusKey;
    const InputConstructor = root.ownerDocument.defaultView?.HTMLInputElement;
    const restoreCaret = caret === undefined && InputConstructor && active instanceof InputConstructor ? active.selectionStart : caret;
    const now = Date.now();
    const freeUnits = activePaidSlots(bootstrap.account, now).length;
    const alignAmount = alignmentPrice(now);
    const selection = buildNormalSelection(slotMode, slotQuantity, slotTermDays, selectedUnitIds, featureSelected, featureTermDays, bootstrap.account);
    const estimate = selectionPrice(selection, bootstrap.catalog);
    const loginNotice = bootstrap.session === null
      ? '<p class="commerce-access-note" role="status">登录并完成邮箱验证后即可购买。请使用顶部账号入口登录。</p>'
      : bootstrap.session.user.status !== "ACTIVE" || bootstrap.session.user.permission_level < 1
        ? '<p class="commerce-access-note" role="status">该账号尚未完成购买资格验证，请先完成邮箱验证。</p>'
        : "";

    root.innerHTML = `
      <header class="site-header"><div class="topbar page-width"><a class="brand" href="/"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46"></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>${siteNavMarkup(null)}</div></header>
      <main class="page-width commerce-page">
        <section class="commerce-heading"><div><p class="commerce-kicker">KE 额度与功能</p><h1>购买与续期</h1><p>实例额度按个数和时长计价；离线 KoreEngine 是账号级功能，开通后该账号所有实例都可使用。</p></div><p class="commerce-timezone">日期按浏览器本地时区显示：<strong>${escapeHtml(timezone)}</strong></p></section>
        ${loginNotice}
        <section class="commerce-products" aria-label="购买项目">
          <article class="commerce-product commerce-product--slots" data-product="slots"><div class="commerce-product-head"><div><p class="commerce-kicker">按额度 × 时长</p><h2>${escapeHtml(slotsProduct.name)}</h2><p>${escapeHtml(slotsProduct.description)} 每个额度每 30 天 ¥50。</p></div><div class="commerce-product-price">¥50<span> / 个 / 30 天</span></div></div>
            <div class="commerce-mode" role="group" aria-label="实例额度操作"><button type="button" data-focus-key="slot-mode-add" data-mode="add" aria-pressed="${slotMode === "add"}">加购额度</button><button type="button" data-focus-key="slot-mode-renew" data-mode="renew" aria-pressed="${slotMode === "renew"}" ${freeUnits === 0 ? "disabled" : ""}>续期额度</button></div>
            <div class="commerce-subsection"><div class="commerce-section-heading"><div><h3>当前生效额度</h3><p>逐个显示；续期时可单独勾选付费额度。</p></div><strong>${bootstrap.account.units.length} 个</strong></div>${renderSlots()}</div>
            ${slotMode === "add" ? `<label class="commerce-quantity">本次加购数量<input data-focus-key="slot-quantity" name="slot-quantity" type="number" min="1" max="1000" step="1" inputmode="numeric" value="${escapeHtml(slotQuantity)}" ${!canPurchase ? "disabled" : ""}></label>` : `<p class="commerce-selection-note">已选 ${selectedUnitIds.size} 个付费额度；赠送额度不能续期。只有赠送额度时不能提交额度续期。</p>`}
            <div class="commerce-subsection"><div class="commerce-section-heading"><div><h3>本次增加时长</h3><p>每个额度单独判断折扣，不合并额度数量。</p></div></div>${renderTerms("slots", "slots", slotTermDays)}</div>
          </article>
          <article class="commerce-product commerce-product--feature" data-product="feature"><div class="commerce-product-head"><div><p class="commerce-kicker">账号级功能</p><h2>${escapeHtml(featureProduct.name)}</h2><p>${escapeHtml(featureProduct.description)} 不受实例额度数量影响。</p></div><div class="commerce-product-price commerce-product-price--feature">¥30<span> / 账号 / 30 天</span></div></div>
            <div class="commerce-feature-state">${activeStandalone(bootstrap.account, now).length ? `当前已开通，最晚到期 ${formatDate(String(Math.max(...activeStandalone(bootstrap.account, now).map((row) => Number(row.expiresAt)))))}。` : "当前未开通。"}</div>
            <label class="commerce-feature-toggle"><input data-focus-key="feature-selected" name="feature-selected" type="checkbox" ${featureSelected ? "checked" : ""} ${!canPurchase ? "disabled" : ""}><span>${activeStandalone(bootstrap.account, now).length ? "本次续期离线功能" : "本次开通离线功能"}</span></label>
            <div class="commerce-subsection"><div class="commerce-section-heading"><div><h3>本次增加时长</h3><p>功能按账号计费，不按实例数量重复收费。</p></div></div>${renderTerms("feature", "module:standalone", featureTermDays)}</div>
          </article>
        </section>
        <section class="commerce-alignment" aria-labelledby="commerce-align-title"><div class="commerce-section-heading"><div><p class="commerce-kicker">可选操作</p><h2 id="commerce-align-title">统一付费项目到期时间</h2><p>把所有当前生效的付费额度与离线功能延长至同一天；赠送额度、核心功能和调整记录不计入目标。</p></div><div class="commerce-align-estimate">${alignAmount === null ? "没有可统一的付费项目" : `当前预估 <strong>${formatCents(alignAmount)}</strong>`}</div></div><div class="commerce-alignment-controls"><div>${renderTerms("alignment", "slots", alignTermDays)}</div><button type="button" class="commerce-button commerce-button--secondary" data-focus-key="align-action" data-action="align" ${!canPurchase || !alignAmount || quoteBusy || orderBusy ? "disabled" : ""}>一键统一到期并购买所选时长</button></div><p class="commerce-fine-print">至少补足 30 天；若所有收费项目的到期时差不足 24 小时，会提示改用普通续期并且不会创建报价。</p></section>
        <section class="commerce-order-controls" aria-label="报价设置"><div class="commerce-section-heading"><div><p class="commerce-kicker">订单优惠</p><h2>整笔订单择优</h2></div><p>期限折扣与 Stripe 优惠码比较整单金额，只采用更低的一种，不重复叠加。</p></div><label class="commerce-promo-field">Stripe 优惠码（可选）<input data-focus-key="promotion-code" name="promotion-code" type="text" maxlength="100" autocomplete="off" value="${escapeHtml(promotionCode)}" placeholder="输入优惠码" ${!canPurchase ? "disabled" : ""}></label><div class="commerce-review-trigger"><div><strong>当前选择预估 ${formatCents(estimate)}</strong><span>最终金额以服务器报价为准。</span></div><button class="commerce-button commerce-button--primary" type="button" data-action="review" ${!canPurchase || selection.length === 0 || quoteBusy || orderBusy ? "disabled" : ""}>${quoteBusy ? "正在获取报价…" : "查看全部权益变化与金额"}</button></div></section>
        ${errorMessage ? `<p class="commerce-error" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
        ${currentQuote ? renderQuote() : ""}
        <dialog class="commerce-dialog" data-alignment-notice ${alignmentNotice ? "open" : ""}><h2>到期时间已基本一致</h2><p>收费项目之间不到 24 小时，无需统一到期。请使用普通续期，不会生成报价或订单。</p><button class="commerce-button commerce-button--secondary" type="button" data-focus-key="alignment-notice-close" data-action="close-alignment-notice">知道了</button></dialog>
      </main>`;
    mountSiteNav(root, authStore, authApi);
    if (restoreKey) {
      const next = [...root.querySelectorAll<HTMLElement>("[data-focus-key]")].find((element) => element.dataset.focusKey === restoreKey);
      next?.focus({ preventScroll: true });
      if (InputConstructor && next instanceof InputConstructor && restoreCaret !== null && restoreCaret !== undefined && next.type === "text") {
        next.setSelectionRange(restoreCaret, restoreCaret);
      }
    }
    if (alignmentNotice) {
      const dialog = root.querySelector<HTMLDialogElement>("[data-alignment-notice]");
      try { dialog?.showModal(); } catch { dialog?.setAttribute("open", ""); }
    }
  }

  function invalidateQuote(): void {
    currentQuote = null;
    idempotencyKey = null;
    orderMessage = "";
  }

  async function requestQuote(selection: CommerceQuoteSelection[]): Promise<void> {
    if (!canPurchase || quoteBusy || orderBusy || selection.length === 0) return;
    alignmentNotice = false;
    errorMessage = "";
    orderMessage = "";
    currentQuote = null;
    quoteBusy = true;
    render();
    try {
      currentQuote = await api.quoteCommerceSelection(selection, promotionCode.trim() || undefined);
    } catch (error) {
      errorMessage = quoteMessage(error);
    } finally {
      quoteBusy = false;
      render("commerce-review-title");
    }
  }

  function selectedNormalItems(): CommerceQuoteSelection[] {
    return buildNormalSelection(slotMode, slotQuantity, slotTermDays, selectedUnitIds, featureSelected, featureTermDays, bootstrap.account);
  }

  root.addEventListener("click", (event) => {
    const ElementConstructor = root.ownerDocument.defaultView?.Element;
    const target = ElementConstructor && event.target instanceof ElementConstructor
      ? event.target.closest<HTMLElement>("button")
      : null;
    if (!target) return;
    if (target.dataset.mode === "add" || target.dataset.mode === "renew") {
      slotMode = target.dataset.mode;
      invalidateQuote();
      errorMessage = "";
      render(target.dataset.focusKey);
      return;
    }
    const termDays = Number(target.dataset.termDays);
    const termGroup = target.closest<HTMLElement>("[data-term-group]")?.dataset.termGroup;
    if (termGroup && TERM_DAYS.includes(termDays as typeof TERM_DAYS[number])) {
      if (termGroup === "slots") slotTermDays = termDays;
      else if (termGroup === "feature") featureTermDays = termDays;
      else alignTermDays = termDays;
      invalidateQuote();
      errorMessage = "";
      render();
      return;
    }
    if (target.dataset.action === "close-alignment-notice") {
      alignmentNotice = false;
      render();
      return;
    }
    if (target.dataset.action === "align") {
      if (!canPurchase || quoteBusy || orderBusy) return;
      const rows = alignmentExpiries(bootstrap.account, Date.now());
      if (!rows.length) {
        errorMessage = "当前没有可统一到期的付费项目。";
        render();
        return;
      }
      const expiries = rows.map((row) => row.expiresAt);
      if (Math.max(...expiries) - Math.min(...expiries) < Number(COMMERCE_DAY_MS)) {
        alignmentNotice = true;
        errorMessage = "";
        render();
        return;
      }
      invalidateQuote();
      void requestQuote([{ type: "align_all_paid", termDays: alignTermDays as 30 | 90 | 180 | 360 }]);
      return;
    }
    if (target.dataset.action === "review") {
      invalidateQuote();
      void requestQuote(selectedNormalItems());
      return;
    }
    if (target.dataset.action === "pay") {
      if (!currentQuote || orderBusy || quoteBusy || Date.now() >= Number(currentQuote.expiresAt)) {
        if (currentQuote && Date.now() >= Number(currentQuote.expiresAt)) {
          invalidateQuote();
          errorMessage = "报价已过期，请重新获取报价。";
          render();
        }
        return;
      }
      if (!idempotencyKey) idempotencyKey = globalThis.crypto.randomUUID();
      const fixedQuote = currentQuote;
      orderBusy = true;
      errorMessage = "";
      render();
      void api.createOrder(fixedQuote.quoteId, idempotencyKey).then((order) => {
        if (order.checkoutUrl) {
          api.navigateToCheckout(order.checkoutUrl);
        } else {
          orderMessage = `订单 ${order.orderId} 已创建，支付状态：${order.paymentStatus}。权益发放会由服务器自动处理。`;
        }
      }).catch((error: unknown) => {
        errorMessage = quoteMessage(error);
      }).finally(() => {
        orderBusy = false;
        render("commerce-review-title");
      });
    }
  });

  root.addEventListener("input", (event) => {
    const InputConstructor = root.ownerDocument.defaultView?.HTMLInputElement;
    const target = event.target;
    if (!InputConstructor || !(target instanceof InputConstructor)) return;
    if (target.name === "slot-quantity") slotQuantity = target.value;
    else if (target.name === "promotion-code") promotionCode = target.value;
    else return;
    invalidateQuote();
    errorMessage = "";
    render(target.dataset.focusKey, target.selectionStart);
  });

  root.addEventListener("change", (event) => {
    const InputConstructor = root.ownerDocument.defaultView?.HTMLInputElement;
    const target = event.target;
    if (!InputConstructor || !(target instanceof InputConstructor)) return;
    if (target.name === "feature-selected") featureSelected = target.checked;
    else if (target.dataset.slotUnit) {
      if (target.checked) selectedUnitIds.add(target.dataset.slotUnit);
      else selectedUnitIds.delete(target.dataset.slotUnit);
    } else return;
    invalidateQuote();
    errorMessage = "";
    render(target.dataset.focusKey);
  });

  render();
}
