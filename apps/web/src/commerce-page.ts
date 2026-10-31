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
  CommerceOrderPage,
  CommerceOrderSummary,
  CommerceOrderView,
  CommercePreviewEntitlement,
  CommerceQuote,
  CommerceQuoteSelection,
} from "./commerce-api";
import "./commerce-page.css";

const TERM_DAYS = [30, 90, 180, 360] as const;
const MAX_SELECTION_ITEMS = 1000;
const SLOTS_NAME = "KE 挂机额度";
const FEATURE_NAME = "全平台脱机 KoreEngine";

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

function formatShortCents(cents: bigint | string): string {
  const value = typeof cents === "bigint" ? cents : BigInt(cents);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const fraction = absolute % 100n;
  return fraction === 0n
    ? `${sign}¥${absolute / 100n}`
    : `${sign}¥${absolute / 100n}.${String(fraction).padStart(2, "0")}`;
}

function formatDate(value: string | number): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8_640_000_000_000_000) return "日期不可用";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function formatDay(value: string | number): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8_640_000_000_000_000) return "日期不可用";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(timestamp);
}

function formatClock(value: string | number): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return "--:--";
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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

function remainingDays(value: string | number, now: number): number {
  const diff = Number(value) - now;
  return Math.max(0, Math.ceil(diff / Number(COMMERCE_DAY_MS)));
}

function termLabel(days: number): string {
  return `${days / 30} 个月`;
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
  if (!account.effective.modules.includes("standalone")) return [];
  return account.entitlements.filter((row) => row.resource === "module:standalone" && row.quantity > 0 && !row.isGift
    && Number(row.startsAt) <= now && Number(row.expiresAt) > now);
}

function hasActiveStandaloneGift(account: CommerceBootstrap["account"], now: number): boolean {
  return account.effective.modules.includes("standalone") && account.entitlements.some((row) => row.resource === "module:standalone"
    && row.quantity > 0 && row.isGift && Number(row.startsAt) <= now && Number(row.expiresAt) > now);
}

function alignmentExpiries(account: CommerceBootstrap["account"], now: number): Array<{ key: "slots" | "module:standalone"; expiresAt: number }> {
  const rows: Array<{ key: "slots" | "module:standalone"; expiresAt: number }> = activePaidSlots(account, now)
    .map((unit) => ({ key: "slots", expiresAt: Number(unit.expiresAt) }));
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

function rawLineCents(catalog: CommerceCatalog, key: "slots" | "module:standalone", days: number): bigint {
  const item = product(catalog, key);
  return priceLineCents(BigInt(item.monthlyUnitPriceCents), BigInt(days) * COMMERCE_DAY_MS, 100);
}

function formatTerm(term: CommerceTerm, catalog: CommerceCatalog, key: "slots" | "module:standalone", group: string): string {
  const days = term.days;
  const discount = term.discountPercent === 100 ? "原价" : `${term.discountPercent / 10} 折`;
  const saveBadge = term.discountPercent === 100
    ? ""
    : `<span class="commerce-term-save">${discount} · 省 ${formatShortCents(rawLineCents(catalog, key, days) - lineCents(catalog, key, BigInt(days) * COMMERCE_DAY_MS))}</span>`;
  if (group === "alignment") {
    return `<button type="button" class="commerce-term" data-focus-key="term-${group}-${days}" data-term-days="${days}" aria-pressed="false"><span class="commerce-term-month">${termLabel(days)}</span><span class="commerce-term-days">目标再延 ${days} 天</span></button>`;
  }
  const price = term.discountPercent === 100
    ? `<span class="commerce-term-price">${formatShortCents(lineCents(catalog, key, BigInt(days) * COMMERCE_DAY_MS))}</span>`
    : `<span class="commerce-term-price"><s>${formatShortCents(rawLineCents(catalog, key, days))}</s>${formatShortCents(lineCents(catalog, key, BigInt(days) * COMMERCE_DAY_MS))}</span>`;
  return `<button type="button" class="commerce-term" data-focus-key="term-${group}-${days}" data-term-days="${days}" aria-pressed="false"><span class="commerce-term-month">${termLabel(days)}</span><span class="commerce-term-days">${days} 天</span>${price}${saveBadge}</button>`;
}

function entitlementName(row: CommercePreviewEntitlement): string {
  if (row.resource === "slots") return row.isGift ? "赠送挂机额度" : SLOTS_NAME;
  if (row.resource === "module:standalone") return FEATURE_NAME;
  if (row.resource === "module:core") return row.isGift ? "核心功能（赠送）" : "核心功能";
  return `额度调整 · ${row.resource}`;
}

function renderAccountPreview(
  preview: { before: { entitlements: CommercePreviewEntitlement[] }; after: { entitlements: CommercePreviewEntitlement[] } },
  options: { collapseUnchanged?: boolean } = {},
): { html: string; changed: number; unchanged: number } {
  const before = preview.before.entitlements;
  const after = preview.after.entitlements;
  const beforeByKey = new Map<string, CommercePreviewEntitlement>();
  before.forEach((row, index) => beforeByKey.set(row.entitlementId ? `id:${row.entitlementId}` : `row:${index}`, row));
  const used = new Set<string>();
  let changedCount = 0;
  const changedRows: string[] = [];
  const unchangedRows: Array<{ html: string; keepOpen: boolean }> = [];
  after.forEach((row, index) => {
    const key = row.entitlementId ? `id:${row.entitlementId}` : `new:${index}`;
    used.add(key);
    const old = beforeByKey.get(row.entitlementId ? `id:${row.entitlementId}` : `row:${index}`);
    const label = entitlementName(row);
    const changed = old ? old.expiresAt !== row.expiresAt : row.isNew === true;
    const quantity = row.quantity < 0 ? `调整 ${row.quantity}` : `${row.quantity}`;
    const rowHtml = `<tr data-preview-row="${escapeHtml(key)}"${changed ? ' class="is-changed"' : ""}><th scope="row"><span class="commerce-preview-name">${escapeHtml(label)}</span>${row.isGift ? '<span class="commerce-gift-tag">赠送</span>' : ""}</th><td>${quantity}</td><td>${old ? formatDate(old.expiresAt) : row.isNew ? "新购" : "—"}</td><td>${formatDate(row.expiresAt)}</td></tr>`;
    if (changed) {
      changedCount += 1;
      changedRows.push(rowHtml);
    } else {
      unchangedRows.push({ html: rowHtml, keepOpen: row.isGift });
    }
  });
  before.forEach((row, index) => {
    const key = row.entitlementId ? `id:${row.entitlementId}` : `row:${index}`;
    if (used.has(key)) return;
    unchangedRows.push({
      html: `<tr data-preview-row="${escapeHtml(key)}"><th scope="row"><span class="commerce-preview-name">${escapeHtml(entitlementName(row))}</span></th><td>${row.quantity}</td><td>${formatDate(row.expiresAt)}</td><td>本次不变</td></tr>`,
      keepOpen: row.isGift,
    });
  });
  const collapse = options.collapseUnchanged === true;
  const collapsible = unchangedRows.filter((row) => !row.keepOpen);
  const body = changedRows.join("") + unchangedRows.map((row) => collapse && !row.keepOpen
    ? row.html.replace("<tr ", '<tr data-preview-unchanged class="is-collapsed-row" ')
    : row.html).join("");
  return {
    html: `<div class="commerce-preview-wrap"><table class="commerce-preview-table"><thead><tr><th scope="col">账号权益</th><th scope="col">数量</th><th scope="col">购买前到期</th><th scope="col">购买后到期</th></tr></thead><tbody>${body}</tbody></table></div>`,
    changed: changedCount,
    unchanged: unchangedRows.length,
    collapsible: collapsible.length,
  };
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
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > MAX_SELECTION_ITEMS) return [];
    if (quantity > 0) selection.push({ type: "slot_add", quantity, termDays: slotTermDays as 30 | 90 | 180 | 360 });
  } else {
    const unitIds = activePaidSlots(account, Date.now()).filter((unit) => selectedUnitIds.has(unit.unitId)).map((unit) => unit.unitId);
    if (unitIds.length) selection.push({ type: "slot_renew", unitIds, termDays: slotTermDays as 30 | 90 | 180 | 360 });
  }
  if (featureSelected) selection.push({ type: "standalone", termDays: featureTermDays as 30 | 90 | 180 | 360 });
  return selection;
}

function selectionItemCount(selection: readonly CommerceQuoteSelection[]): number {
  return selection.reduce((total, item) => total + (item.type === "slot_add" ? item.quantity
    : item.type === "slot_renew" ? item.unitIds.length : item.type === "standalone" ? 1 : 0), 0);
}

function selectionLimitMessage(): string {
  return `单笔最多 ${MAX_SELECTION_ITEMS} 个权益项；额度与脱机功能合计超限，请减少额度数量或取消部分续期。`;
}

function alignmentLimitMessage(itemCount: number): string {
  return `统一到期会产生 ${itemCount} 个付费项目，超过单笔 ${MAX_SELECTION_ITEMS} 项上限；请关闭窗口后分批选择额度续期。`;
}

function selectionPrice(selection: readonly CommerceQuoteSelection[], catalog: CommerceCatalog): bigint {
  return selection.reduce((total, item) => {
    const key = item.type === "standalone" ? "module:standalone" : "slots";
    const amount = lineCents(catalog, key, BigInt(item.termDays) * COMMERCE_DAY_MS);
    const quantity = item.type === "slot_add" ? item.quantity : item.type === "slot_renew" ? item.unitIds.length : 1;
    return total + amount * BigInt(quantity);
  }, 0n);
}

function selectionRawPrice(selection: readonly CommerceQuoteSelection[], catalog: CommerceCatalog): bigint {
  return selection.reduce((total, item) => {
    const key = item.type === "standalone" ? "module:standalone" : "slots";
    const amount = rawLineCents(catalog, key, item.termDays);
    const quantity = item.type === "slot_add" ? item.quantity : item.type === "slot_renew" ? item.unitIds.length : 1;
    return total + amount * BigInt(quantity);
  }, 0n);
}

interface GroupedQuoteItem {
  productKey: "slots" | "module:standalone";
  operation: "ADD" | "RENEW";
  durationMs: bigint;
  expectedStartsAt: number;
  expectedExpiresAt: number;
  count: number;
  paidCents: bigint;
}

function groupQuoteItems(items: readonly CommerceQuote["items"][number][]): GroupedQuoteItem[] {
  const grouped = new Map<string, GroupedQuoteItem>();
  for (const item of items) {
    const key = `${item.productKey}|${item.operation}|${item.durationMs}|${item.expectedStartsAt}|${item.expectedExpiresAt}`;
    const current = grouped.get(key);
    if (current) {
      current.count += 1;
      current.paidCents += BigInt(item.paidCents);
    } else {
      grouped.set(key, {
        productKey: item.productKey,
        operation: item.operation,
        durationMs: BigInt(item.durationMs),
        expectedStartsAt: Number(item.expectedStartsAt),
        expectedExpiresAt: Number(item.expectedExpiresAt),
        count: 1,
        paidCents: BigInt(item.paidCents),
      });
    }
  }
  return [...grouped.values()];
}

function quoteItemName(key: "slots" | "module:standalone"): string {
  return key === "slots" ? SLOTS_NAME : FEATURE_NAME;
}

function quoteOperationLabel(key: "slots" | "module:standalone", operation: "ADD" | "RENEW"): string {
  if (key === "module:standalone") return operation === "ADD" ? "开通" : "续期";
  return operation === "ADD" ? "新买" : "续期";
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
  let quoteRevision = 0;
  let orderBusy = false;
  let errorMessage = "";
  let alignmentNotice = false;
  let orderMessage = "";
  let idempotencyKey: string | null = null;
  let view: "buy" | "orders" = "buy";
  let alignOpen = false;
  let promoOpen = false;
  let previewExpanded = false;
  let historyLoading = false;
  let historyLoaded = false;
  let historyError = "";
  let historyPage: CommerceOrderPage = { items: [], nextCursor: null };
  let orderDetailLoading = false;
  let orderDetailError = "";
  let selectedOrderId: string | null = null;
  let selectedOrder: CommerceOrderView | null = null;
  let returnMessage = "";
  let returnOrderId: string | null = null;
  let returnPollAttempts = 0;
  let returnPollTimer: number | null = null;
  let returnPollExhausted = false;
  const location = root.ownerDocument.defaultView?.location;
  const checkoutResult = location ? new URL(location.href).searchParams.get("checkout") : null;
  const checkoutOrderId = location ? new URL(location.href).searchParams.get("order_id") : null;
  const isSuccessReturn = checkoutResult === "success";
  const isCancelledReturn = checkoutResult === "cancelled";
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";
  const canPurchase = bootstrap.session?.user.status === "ACTIVE" && bootstrap.session.user.permission_level >= 1;
  const slotsProduct = product(bootstrap.catalog, "slots");
  const featureProduct = product(bootstrap.catalog, "module:standalone");

  function renderTerms(group: string, key: "slots" | "module:standalone", days: number): string {
    const ariaLabel = group === "alignment" ? "统一到期额外时长" : key === "slots" ? "挂机额度期限" : "脱机功能期限";
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

  function alignmentTarget(now: number): number | null {
    const rows = alignmentExpiries(bootstrap.account, now);
    if (!rows.length) return null;
    return Math.max(...rows.map((row) => row.expiresAt)) + alignTermDays * Number(COMMERCE_DAY_MS);
  }

  function alignmentDetails(now: number): Array<{ label: string; addedMs: bigint; cents: bigint }> {
    const target = alignmentTarget(now);
    if (target === null) return [];
    const rows: Array<{ label: string; addedMs: bigint; cents: bigint }> = activePaidSlots(bootstrap.account, now)
      .map((unit, index) => ({
        label: `额度 #${index + 1}（剩 ${remainingDays(unit.expiresAt, now)} 天）`,
        addedMs: BigInt(target - Number(unit.expiresAt)),
        cents: lineCents(bootstrap.catalog, "slots", BigInt(target - Number(unit.expiresAt))),
      }));
    const features = activeStandalone(bootstrap.account, now);
    if (features.length) {
      const expiresAt = Math.max(...features.map((row) => Number(row.expiresAt)));
      rows.push({
        label: `脱机 KoreEngine（剩 ${remainingDays(expiresAt, now)} 天）`,
        addedMs: BigInt(target - expiresAt),
        cents: lineCents(bootstrap.catalog, "module:standalone", BigInt(target - expiresAt)),
      });
    }
    return rows;
  }

  function renderSlots(now: number): string {
    const units = bootstrap.account.units;
    if (!units.length) return '<p class="commerce-empty">目前没有挂机额度。</p>';
    const activeUnitIds = new Set(activePaidSlots(bootstrap.account, now).map((unit) => unit.unitId));
    return `<div class="commerce-renew-list">${units.map((unit, index) => {
      const selectable = activeUnitIds.has(unit.unitId);
      const selected = selectedUnitIds.has(unit.unitId);
      const expiry = Number(unit.expiresAt);
      const after = selectable ? formatDay(expiry + slotTermDays * Number(COMMERCE_DAY_MS)) : "";
      const meta = unit.isGift ? `赠送 · ${formatDay(expiry)}到期 · 不可续费` : selectable ? `剩 ${remainingDays(expiry, now)} 天 · 到期 ${formatDay(expiry)}` : "已到期";
      return `<label class="commerce-renew-row${selected ? " is-selected" : ""}${!selectable ? " is-disabled" : ""}"><input data-focus-key="unit-${escapeHtml(unit.unitId)}" data-slot-unit="${escapeHtml(unit.unitId)}" type="checkbox" ${selected ? "checked" : ""} ${!selectable ? "disabled" : ""} aria-label="选择续期额度 ${index + 1}"><span class="commerce-renew-main"><span class="commerce-renew-name">额度 #${index + 1}${unit.isGift ? '<span class="commerce-gift-tag">赠送</span>' : ""}</span><span class="commerce-renew-meta">${meta}</span></span>${selectable ? `<span class="commerce-renew-after">续 ${slotTermDays} 天后<b>${after}</b></span>` : ""}</label>`;
    }).join("")}</div>`;
  }

  function renderQuantityRow(): string {
    return `<div class="commerce-quantity-row">
      <span class="commerce-quantity-label">数量</span>
      <div class="commerce-stepper">
        <button type="button" data-action="qty-step" data-step="-1" aria-label="减少数量" ${!canPurchase ? "disabled" : ""}>−</button>
        <input data-focus-key="slot-quantity" name="slot-quantity" type="number" min="0" max="${MAX_SELECTION_ITEMS}" step="1" inputmode="numeric" value="${escapeHtml(slotQuantity)}" ${!canPurchase ? "disabled" : ""}>
        <button type="button" data-action="qty-step" data-step="1" aria-label="增加数量" ${!canPurchase ? "disabled" : ""}>＋</button>
        <span class="commerce-stepper-unit">个</span>
      </div>
      <span class="commerce-quantity-hint">单笔上限 10 个 · 设为 0 可只买脱机功能</span>
    </div>`;
  }

  function renderSlotsCard(now: number): string {
    const active = activePaidSlots(bootstrap.account, now);
    return `<article class="commerce-card" data-product="slots">
      <div class="commerce-card-head">
        <div><h2>${SLOTS_NAME}</h2><p>买 1 个额度 = 多开 1 个实例，每个额度各自到期、各自续费。</p></div>
        <div class="commerce-card-price"><b>${formatShortCents(slotsProduct.monthlyUnitPriceCents)}</b><span>/ 个 · 30 天</span></div>
      </div>
      <div class="commerce-seg" role="group" aria-label="挂机额度操作">
        <button type="button" data-focus-key="slot-mode-add" data-mode="add" aria-pressed="${slotMode === "add"}">新买额度</button>
        <button type="button" data-focus-key="slot-mode-renew" data-mode="renew" aria-pressed="${slotMode === "renew"}" ${active.length === 0 ? "disabled" : ""}>续费已有额度</button>
      </div>
      ${slotMode === "add" ? renderQuantityRow() : `<div class="commerce-renew-block"><div class="commerce-renew-head"><h3>选择要续期的额度</h3><span>已选 ${selectedUnitIds.size} 个</span></div>${renderSlots(now)}<p class="commerce-renew-note">赠送额度不能续期；同一天到期的额度也各自独立，不会合并。</p></div>`}
      <div class="commerce-terms-block">
        <div class="commerce-terms-head"><h3>选择时长</h3><p>折扣按本次新增时长逐项计算，不合并额度数量。</p></div>
        ${renderTerms("slots", "slots", slotTermDays)}
      </div>
    </article>`;
  }

  function renderFeatureCard(now: number): string {
    const active = activeStandalone(bootstrap.account, now);
    const giftActive = hasActiveStandaloneGift(bootstrap.account, now);
    const latest = active.length ? Math.max(...active.map((row) => Number(row.expiresAt))) : null;
    const state = latest === null
      ? giftActive ? "当前通过赠送开通，本次购买将新增独立的付费期限。" : "当前未开通，本次购买将开通。"
      : `当前已开通，最晚到期 ${formatDay(latest)}，再次购买直接顺延。`;
    const action = active.length ? "续期" : giftActive ? "购买付费期" : "开通";
    return `<article class="commerce-card" data-product="feature">
      <div class="commerce-card-head">
        <div><h2>${FEATURE_NAME}</h2><p>账号级功能，开通后账号下所有实例都能用，不按实例数量另收费。</p></div>
        <div class="commerce-card-price"><b>${formatShortCents(featureProduct.monthlyUnitPriceCents)}</b><span>/ 账号 · 30 天</span></div>
      </div>
      <div class="commerce-switch-row">
        <div class="commerce-switch-info"><b>本次${action}脱机功能</b><span>${state}</span></div>
        <label class="commerce-switch"><input data-focus-key="feature-selected" name="feature-selected" type="checkbox" ${featureSelected ? "checked" : ""} ${!canPurchase ? "disabled" : ""} aria-label="将脱机功能加入本次订单"><span class="commerce-switch-track" aria-hidden="true"></span></label>
      </div>
      <div class="commerce-terms-block">
        <div class="commerce-terms-head"><h3>选择时长</h3><p>功能按账号计费，不按实例数量重复收费。</p></div>
        ${renderTerms("feature", "module:standalone", featureTermDays)}
      </div>
    </article>`;
  }

  function renderAlignLine(now: number, amount: bigint | null): string {
    const rows = alignmentExpiries(bootstrap.account, now);
    return `<div class="commerce-align-line">
      <span class="commerce-align-icon" aria-hidden="true">◷</span>
      <div class="commerce-align-copy"><b>把所有到期日统一到同一天</b><span>${amount === null ? "当前没有可统一的付费项目" : `共 ${rows.length} 个付费项 · 当前需补 ${formatCents(amount)}`}</span></div>
      <button type="button" class="commerce-align-button" data-focus-key="align-open" data-action="open-align" ${!canPurchase || amount === null ? "disabled" : ""}>调整</button>
    </div>`;
  }

  function renderAlignDialog(now: number, amount: bigint | null): string {
    const itemCount = alignmentExpiries(bootstrap.account, now).length;
    const alignmentOverLimit = itemCount > MAX_SELECTION_ITEMS;
    const details = alignmentOverLimit ? [] : alignmentDetails(now);
    return `<dialog class="commerce-dialog commerce-align-dialog" data-align-dialog aria-labelledby="commerce-align-title">
      <div class="commerce-dialog-head"><h2 id="commerce-align-title" data-focus-key="commerce-align-title">统一所有付费项目的到期日</h2><p>以「最晚到期的一项 + 所选时长」为目标，落后的项目自动补足差额。赠送额度与核心功能不参与。</p></div>
      <div class="commerce-dialog-body">
        ${details.length ? `<div class="commerce-align-details">${details.map((row) => `<div class="commerce-align-detail"><span>${escapeHtml(row.label)}</span><b>+${formatDuration(row.addedMs)} · ${formatCents(row.cents)}</b></div>`).join("")}</div>` : alignmentOverLimit ? "" : '<p class="commerce-empty">当前没有可统一的付费项目。</p>'}
        ${alignmentOverLimit ? `<p class="commerce-selection-limit-error" data-alignment-limit-error role="alert">${alignmentLimitMessage(itemCount)}</p>` : ""}
        ${renderTerms("alignment", "slots", alignTermDays)}
        <div class="commerce-dialog-total"><span>本次需补</span><b>${amount === null ? "—" : formatCents(amount)}</b></div>
        <p class="commerce-dialog-note">若收费项目到期相差不到 24 小时，会提示「无需统一」，不产生报价或订单。</p>
      </div>
      <div class="commerce-dialog-foot"><button type="button" class="commerce-button commerce-button--secondary" data-action="close-align">取消</button><button type="button" class="commerce-button commerce-button--primary" data-action="align" ${!canPurchase || amount === null || alignmentOverLimit || quoteBusy || orderBusy ? "disabled" : ""}>统一到期并去确认</button></div>
    </dialog>`;
  }

  function renderPromotionControl(placement: "desktop" | "mobile"): string {
    const mobileAttribute = placement === "mobile" ? " data-mobile-promo" : "";
    return `<div class="commerce-promo commerce-promo--${placement}"${mobileAttribute}>
      <button type="button" class="commerce-promo-toggle" data-focus-key="promotion-toggle-${placement}" data-action="toggle-promo" aria-expanded="${promoOpen}"><i aria-hidden="true">＋</i> ${promoOpen ? "收起优惠码" : "有优惠码？"}</button>
      <div class="commerce-promo-body${promoOpen ? "" : " is-hidden"}">
        <input data-focus-key="promotion-code-${placement}" name="promotion-code" type="text" maxlength="100" autocomplete="off" value="${escapeHtml(promotionCode)}" placeholder="输入 Stripe 优惠码" ${!canPurchase ? "disabled" : ""}>
        <p>与时长优惠整单比较，只取更低的一种，不重复叠加。</p>
      </div>
    </div>`;
  }

  function renderSummary(selection: readonly CommerceQuoteSelection[], estimate: bigint, selectionOverLimit: boolean): string {
    const lines: Array<{ title: string; note: string; cents: bigint }> = [];
    for (const item of selection) {
      const key = item.type === "standalone" ? "module:standalone" : "slots";
      const amount = lineCents(bootstrap.catalog, key, BigInt(item.termDays) * COMMERCE_DAY_MS);
      const count = item.type === "slot_add" ? item.quantity : item.type === "slot_renew" ? item.unitIds.length : 1;
      const title = item.type === "standalone" ? "脱机 KoreEngine" : `${SLOTS_NAME} × ${count}`;
      const action = item.type === "standalone"
        ? `${activeStandalone(bootstrap.account, Date.now()).length ? "续费" : "开通"} · ${termLabel(item.termDays)}（${item.termDays} 天）`
        : `${item.type === "slot_add" ? "新买" : "续费"} · ${termLabel(item.termDays)}（${item.termDays} 天）`;
      lines.push({ title, note: action, cents: amount * BigInt(count) });
    }
    const saved = selectionRawPrice(selection, bootstrap.catalog) - estimate;
    return `<aside class="commerce-summary" aria-label="本次订单摘要">
      <div class="commerce-summary-head"><h3>本次订单</h3><span>${lines.length} 项</span></div>
      <div class="commerce-summary-lines">${lines.length ? lines.map((line) => `<div class="commerce-summary-line"><div><b>${escapeHtml(line.title)}</b><span>${escapeHtml(line.note)}</span></div><em>${formatCents(line.cents)}</em></div>`).join("") : '<p class="commerce-summary-empty">还没有选择项目。<br>在上方选择额度或脱机功能。</p>'}</div>
      ${renderPromotionControl("desktop")}
      <div class="commerce-summary-total"><div class="commerce-summary-total-label">合计<span>${saved > 0n ? `已含时长优惠 −${formatCents(saved)}` : "最终金额以服务器报价为准"}</span></div><div class="commerce-summary-amount">${formatCents(estimate)}</div></div>
      <button type="button" class="commerce-summary-cta" data-focus-key="commerce-review" data-action="review" ${!canPurchase || selection.length === 0 || selectionOverLimit || quoteBusy || orderBusy ? "disabled" : ""}>${quoteBusy ? "正在获取报价…" : "去确认订单"}</button>
      <p class="commerce-summary-foot">确认后商品、时长与金额固定不可改<br>付款限时 30 分钟</p>
    </aside>`;
  }

  function renderQuote(): string {
    if (!currentQuote) return "";
    const quote = currentQuote;
    const selected = formatCents(quote.selectedTotalCents);
    const raw = formatCents(quote.rawTotalCents);
    const discount = BigInt(quote.rawTotalCents) - BigInt(quote.selectedTotalCents);
    const strategy = quote.discountStrategy === "promotion_code" ? "整单优惠码 · 不重复叠加" : "期限优惠 · 不重复叠加";
    const grouped = groupQuoteItems(quote.items);
    const itemRows = grouped.map((item) => {
      const name = quoteItemName(item.productKey);
      const operation = quoteOperationLabel(item.productKey, item.operation);
      const expiry = item.operation === "ADD"
        ? `<span class="commerce-item-new">新购</span> → ${formatDate(item.expectedExpiresAt)}`
        : `<span class="commerce-item-old">现 ${formatDay(item.expectedStartsAt)}</span> → ${formatDate(item.expectedExpiresAt)}`;
      return `<tr><td class="commerce-item-name" data-label="项目"><b>${name}${item.count > 1 ? ` × ${item.count}` : ""}</b><span>${operation}</span></td><td class="commerce-item-duration" data-label="时长">${formatDuration(item.durationMs)}</td><td class="commerce-item-expiry" data-label="到期">${expiry}</td><td class="commerce-item-money" data-label="金额">${formatCents(item.paidCents)}</td></tr>`;
    }).join("");
    const preview = renderAccountPreview(quote.accountPreview, { collapseUnchanged: !previewExpanded });
    return `<section class="commerce-confirm" data-review-result aria-labelledby="commerce-review-title">
      <div class="commerce-confirm-bar">
        <button type="button" class="commerce-confirm-back" data-action="close-review">← 返回修改</button>
        <div class="commerce-confirm-title"><h2 id="commerce-review-title" data-focus-key="commerce-review-title">确认订单</h2><p>共 ${grouped.length} 项 · 实际支付 ${selected}</p></div>
        <div class="commerce-confirm-timer"><span>报价有效至</span><b>${formatClock(quote.expiresAt)}</b></div>
      </div>
      <div class="commerce-panel">
        <div class="commerce-panel-head"><h3>购买内容</h3><span>下单后固定不可修改</span></div>
        <div class="commerce-item-table-wrap"><table class="commerce-item-table"><thead><tr><th scope="col">项目</th><th scope="col">时长</th><th scope="col">到期</th><th scope="col">金额</th></tr></thead><tbody>${itemRows}</tbody></table></div>
        <div class="commerce-calc-bar">
          <span>原价 <b>${raw}</b></span>
          ${discount > 0n ? `<span class="is-discount">优惠 <b>−${formatCents(discount)}</b></span>` : ""}
          <span class="commerce-calc-strategy">${strategy}</span>
          <span class="commerce-calc-final">实际支付 <b>${selected}</b></span>
        </div>
      </div>
      <div class="commerce-panel">
        <div class="commerce-panel-head"><div><h3>账号权益变化</h3><p class="commerce-confirm-timezone" data-confirm-timezone>日期按浏览器本地时区显示：<strong>${escapeHtml(timezone)}</strong></p></div><span>${preview.changed} 项变化${preview.unchanged ? ` · ${preview.unchanged} 项不变` : ""}</span></div>
        <div data-account-preview>${preview.html}</div>
        ${preview.collapsible ? `<div class="commerce-preview-toggle-row"><button type="button" data-focus-key="commerce-preview-toggle" data-action="toggle-preview">${previewExpanded ? "收起未变化项" : `展开其余 ${preview.collapsible} 项`}</button></div>` : ""}
      </div>
      <div class="commerce-pay-strip">
        <div class="commerce-pay-info"><b>付款限时 30 分钟</b><p>确认后订单内容固定不可修改；权益由服务器在收款后自动发放，无需联系客服。</p></div>
        <button type="button" class="commerce-pay-button" data-focus-key="commerce-pay" data-action="pay" ${orderBusy || quoteBusy ? "disabled" : ""}>${orderBusy ? "正在创建订单…" : `去付款 · ${selected}`}</button>
      </div>
      ${errorMessage ? `<p class="commerce-error" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
      ${orderMessage ? `<p class="commerce-success" role="status">${escapeHtml(orderMessage)}</p>` : ""}
    </section>`;
  }

  function operationLabel(operation: CommerceOrderView["items"][number]["operation"]): string {
    if (operation === "ADD") return "加购";
    if (operation === "ALIGN") return "统一续期";
    return "续期";
  }

  function orderStatus(order: CommerceOrderView): string {
    if (order.paymentState === "failed") return "付款失败，请返回购买页重新下单。";
    if (order.paymentState === "processing") return "付款正在确认";
    if (order.paymentState === "unpaid") return order.checkoutState === "expired" ? "付款期限已结束" : "等待付款";
    if (order.fulfillmentState === "pending") return "付款已确认，权益正在同步";
    if (order.fulfillmentState === "settled") return "已付款；未交付项目已结算";
    return "购买已完成";
  }

  function orderBadge(order: CommerceOrderView): string {
    if (order.paymentState === "failed") return '<span class="commerce-pill is-bad">付款失败</span>';
    if (order.paymentState === "processing") return '<span class="commerce-pill is-wait">付款确认中</span>';
    if (order.paymentState === "unpaid") {
      return order.checkoutState === "expired"
        ? '<span class="commerce-pill is-gray">已超时</span>'
        : '<span class="commerce-pill is-wait">待付款</span>';
    }
    if (order.fulfillmentState === "pending") return '<span class="commerce-pill is-wait">权益同步中</span>';
    if (order.fulfillmentState === "settled") return '<span class="commerce-pill is-ok">已结算</span>';
    return '<span class="commerce-pill is-ok">已完成</span>';
  }

  function refundBadge(order: CommerceOrderView): string {
    if (order.refundState === "partial") return '<span class="commerce-pill is-bad">部分退款</span>';
    if (order.refundState === "full") return '<span class="commerce-pill is-gray">全额退款</span>';
    return "";
  }

  function summaryBadge(order: CommerceOrderSummary): string {
    const refund = order.refundState === "partial"
      ? '<span class="commerce-pill is-bad">部分退款</span>'
      : order.refundState === "full"
        ? '<span class="commerce-pill is-gray">全额退款</span>'
        : "";
    if (order.paymentState === "failed") return `<span class="commerce-pill is-bad">付款失败</span>${refund}`;
    if (order.paymentState === "processing") return `<span class="commerce-pill is-wait">付款确认中</span>${refund}`;
    if (order.paymentState === "unpaid") return `<span class="commerce-pill is-wait">待付款</span>${refund}`;
    if (order.fulfillmentState === "pending") return `<span class="commerce-pill is-wait">权益同步中</span>${refund}`;
    if (order.fulfillmentState === "settled") return `<span class="commerce-pill is-ok">已结算</span>${refund}`;
    return `<span class="commerce-pill is-ok">已完成</span>${refund}`;
  }

  function renderOrderDetail(): string {
    if (!selectedOrderId) {
      return '<aside class="commerce-order-detail is-empty"><p>选择左侧订单，查看付款状态、交付结果与退款记录。</p></aside>';
    }
    if (orderDetailLoading) return '<aside class="commerce-order-detail"><p class="commerce-order-message" role="status">正在读取订单…</p></aside>';
    if (orderDetailError) return `<aside class="commerce-order-detail"><p class="commerce-error" role="alert">${escapeHtml(orderDetailError)}</p></aside>`;
    const order = selectedOrder;
    if (!order) return "";
    const itemRows = order.items.map((item) => {
      const name = item.productKey === "slots" ? SLOTS_NAME : FEATURE_NAME;
      const actualBefore = item.fulfillmentBefore?.expiresAt ? formatDate(item.fulfillmentBefore.expiresAt) : "无既有付费期限";
      const actualAfter = item.fulfillmentAfter?.expiresAt ? formatDate(item.fulfillmentAfter.expiresAt) : "尚未交付";
      const adjustments = item.refundAdjustments.map((adjustment) => `<p class="commerce-refund-adjustment">退款重算 ${formatDate(adjustment.occurredAt)}：扣减 ${formatDuration(adjustment.deductedDurationMs)}，调整后到期 ${adjustment.afterExpiresAt ? formatDate(adjustment.afterExpiresAt) : "无有效期限"}</p>`).join("");
      return `<article class="commerce-order-item"><div class="commerce-order-item-head"><b>${name}</b><span class="commerce-op">${operationLabel(item.operation)}</span><span class="commerce-order-item-paid">${formatCents(item.paidCents)}</span></div><dl class="commerce-order-facts"><div><dt>购买时长</dt><dd>${formatDuration(item.durationMs)}</dd></div><div><dt>订单预计到期</dt><dd>${formatDate(item.expectedExpiresAt)}</dd></div><div><dt>交付状态</dt><dd>${item.deliveryState === "delivered" ? "已交付" : item.deliveryState === "settled_no_entitlement" ? "已结算" : "等待交付"}</dd></div><div><dt>购买前期限</dt><dd>${actualBefore}</dd></div><div><dt>交付后到期</dt><dd>${actualAfter}</dd></div></dl>${adjustments}</article>`;
    }).join("");
    const refunds = order.refunds.length ? `<div class="commerce-order-refunds"><h4>退款记录</h4>${order.refunds.map((refund) => `<p>${formatDate(refund.createdAt)} · ${refund.status === "succeeded" ? "已退款" : refund.status === "pending" || refund.status === "requires_action" ? "退款处理中" : "退款未完成"} ${formatCents(refund.amountCents)} · 累计退款 ${Number(refund.cumulativeRatioBasisPoints / 100).toFixed(2)}%</p>`).join("")}</div>` : "";
    const resume = order.checkoutUrl
      ? '<button class="commerce-button commerce-button--primary" type="button" data-action="resume-checkout">继续付款</button>'
      : order.paymentState === "failed"
        ? '<a class="commerce-button commerce-button--primary" href="/ke/buy">返回购买页重新下单</a>'
        : "";
    return `<aside class="commerce-order-detail" aria-labelledby="commerce-order-detail-title">
      <div class="commerce-order-detail-head">
        <div class="commerce-order-detail-title"><p class="commerce-kicker">订单详情</p><h3 id="commerce-order-detail-title">订单 ${escapeHtml(order.orderId)}</h3><span>创建于 ${formatDate(order.createdAt)} · ${escapeHtml(timezone)}</span><div class="commerce-order-pills">${orderBadge(order)}${refundBadge(order)}</div></div>
        <div class="commerce-order-detail-amount"><b>${formatCents(order.paidTotalCents)}</b><span>已退款 ${formatCents(order.refundedTotalCents)}</span></div>
      </div>
      <div class="commerce-order-status"><strong>${orderStatus(order)}</strong>${resume}</div>
      <div class="commerce-order-items">${itemRows}</div>
      ${refunds}
      <div class="commerce-order-snapshot"><div class="commerce-panel-head"><h4>购买前后的账号权益</h4><span>下单时快照</span></div>${renderAccountPreview(order.accountPreview).html}</div>
      <div class="commerce-order-detail-foot"><button class="commerce-button commerce-button--secondary" type="button" data-action="close-order">返回购买记录</button></div>
    </aside>`;
  }

  function renderOrdersPage(): string {
    const rows = historyPage.items.map((order: CommerceOrderSummary) => `<button type="button" class="commerce-order-row${selectedOrderId === order.orderId ? " is-selected" : ""}" data-action="open-order" data-order-id="${escapeHtml(order.orderId)}"><span class="commerce-order-id"><b>订单 ${escapeHtml(order.orderId)}</b><span>${formatDate(order.createdAt)} · ${order.itemCount} 项</span></span><span class="commerce-order-row-status">${summaryBadge(order)}</span><span class="commerce-order-amount">${formatCents(order.paidTotalCents)}</span><span class="commerce-order-arrow" aria-hidden="true">›</span></button>`).join("");
    return `<div class="commerce-top-row"><div class="commerce-page-title"><h1>我的订单</h1><p>查看付款状态、交付结果与退款记录。</p></div>${renderTabs()}</div>
      ${renderBanner()}
      ${errorMessage ? `<p class="commerce-error" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
      <div class="commerce-orders-grid">
        <section class="commerce-orders-panel" aria-labelledby="commerce-history-title">
          <div class="commerce-panel-head"><h2 id="commerce-history-title" data-focus-key="commerce-history-title">购买记录</h2><span>${historyPage.items.length ? `已加载 ${historyPage.items.length} 笔` : ""}</span></div>
          ${historyLoading ? '<p class="commerce-order-message" role="status">正在读取购买记录…</p>' : ""}
          ${historyError ? `<p class="commerce-error" role="alert">${escapeHtml(historyError)}</p>` : ""}
          ${rows ? `<div class="commerce-order-list">${rows}</div>` : ""}
          ${!rows && !historyLoading && !historyError && historyLoaded ? '<p class="commerce-order-empty">暂无购买记录</p>' : ""}
          ${historyPage.nextCursor ? `<button class="commerce-load-more" type="button" data-action="more-orders"${historyLoading ? " disabled" : ""}>加载更早的订单</button>` : ""}
        </section>
        ${renderOrderDetail()}
      </div>
      ${renderFoot()}`;
  }

  function renderTabs(): string {
    return `<div class="commerce-tabs" role="group" aria-label="页面切换"><button type="button" data-action="view-buy" aria-pressed="${view === "buy"}">购买</button><button type="button" data-action="purchase-history" aria-pressed="${view === "orders"}">我的订单</button></div>`;
  }

  function renderBuyTop(): string {
    return `<div class="commerce-top-row"><div class="commerce-page-title"><h1>购买与续费</h1><p>额度按「个数 × 时长」购买；脱机功能按账号开通，所有实例通用。</p></div>${renderTabs()}</div>`;
  }

  function renderBanner(): string {
    if (!returnMessage) return "";
    const tone = /失败|无法|未完成|仍在确认/u.test(returnMessage) ? " is-warn" : " is-ok";
    const icon = tone === " is-warn" ? "!" : "✓";
    return `<div class="commerce-banner${tone}" role="status"><span class="commerce-banner-icon" aria-hidden="true">${icon}</span><span class="commerce-banner-text">${escapeHtml(returnMessage)}</span>${isSuccessReturn && returnPollExhausted ? '<button type="button" class="commerce-banner-action" data-action="refresh-order-status">刷新订单状态</button>' : ""}</div>`;
  }

  function renderFoot(): string {
    return `<div class="commerce-foot"><a href="/refunds">退款规则</a><span>期限折扣与优惠码整单比较，只取更低的一种</span><div class="commerce-foot-tz">所有日期按浏览器本地时区显示<br><b>${escapeHtml(timezone)}</b></div></div>`;
  }

  async function loadHistory(cursor?: string): Promise<void> {
    if (historyLoading) return;
    historyLoading = true;
    historyError = "";
    view = "orders";
    render("commerce-history-title");
    try {
      const page = await api.listOrders(cursor);
      historyPage = cursor === undefined ? page : {
        items: [...historyPage.items, ...page.items], nextCursor: page.nextCursor,
      };
      historyLoaded = true;
      if (!selectedOrderId && historyPage.items.length) void openOrder(historyPage.items[0]!.orderId);
    } catch (error) {
      historyError = quoteMessage(error);
    } finally {
      historyLoading = false;
      render("commerce-history-title");
    }
  }

  async function openOrder(orderId: string, statusOnly = false): Promise<void> {
    view = "orders";
    selectedOrderId = orderId;
    selectedOrder = null;
    orderDetailError = "";
    orderDetailLoading = true;
    render("commerce-history-title");
    try {
      selectedOrder = await api.getOrder(orderId, statusOnly ? { statusOnly: true } : undefined);
    } catch (error) {
      orderDetailError = quoteMessage(error);
    } finally {
      orderDetailLoading = false;
      render("commerce-history-title");
    }
  }

  async function pollReturnedOrder(): Promise<void> {
    if (!returnOrderId) return;
    returnPollAttempts += 1;
    await openOrder(returnOrderId, true);
    if (!selectedOrder) {
      returnMessage = "暂时无法读取订单状态，请稍后重试。";
    } else {
      returnMessage = orderStatus(selectedOrder);
    }
    const terminal = selectedOrder && ((selectedOrder.paymentState === "paid"
      && (selectedOrder.fulfillmentState === "fulfilled" || selectedOrder.fulfillmentState === "settled"))
      || selectedOrder.paymentState === "failed"
      || (selectedOrder.paymentState === "unpaid" && selectedOrder.checkoutState === "expired"));
    if (!terminal && returnPollAttempts < 40) {
      returnPollTimer = root.ownerDocument.defaultView!.setTimeout(() => { void pollReturnedOrder(); }, 1500);
    } else if (!terminal && returnPollAttempts >= 40) {
      returnPollExhausted = true;
      returnMessage = "状态仍在确认中，可手动刷新订单状态。";
    }
    render("commerce-history-title");
  }

  function startCheckoutReturn(): void {
    if (!isSuccessReturn && !isCancelledReturn) return;
    if (!checkoutOrderId || !decimal(checkoutOrderId)) {
      view = "orders";
      returnMessage = "无法识别付款订单，请从购买记录中查看订单状态。";
      render();
      return;
    }
    returnOrderId = checkoutOrderId;
    if (isSuccessReturn) {
      returnMessage = "正在确认付款";
      void pollReturnedOrder();
    } else {
      returnMessage = "付款未完成，原订单仍保留。可在付款期限内继续付款。";
      void openOrder(returnOrderId);
    }
  }

  function render(focusKey?: string, caret?: number | null): void {
    const active = root.ownerDocument.activeElement as HTMLElement | null;
    const restoreKey = focusKey ?? active?.dataset.focusKey;
    const InputConstructor = root.ownerDocument.defaultView?.HTMLInputElement;
    const restoreCaret = caret === undefined && InputConstructor && active instanceof InputConstructor ? active.selectionStart : caret;
    const now = Date.now();
    const alignAmount = alignmentPrice(now);
    const selection = buildNormalSelection(slotMode, slotQuantity, slotTermDays, selectedUnitIds, featureSelected, featureTermDays, bootstrap.account);
    const selectionOverLimit = selectionItemCount(selection) > MAX_SELECTION_ITEMS;
    const estimate = selectionPrice(selection, bootstrap.catalog);
    const loginNotice = bootstrap.session === null
      ? '<p class="commerce-banner is-warn" role="status"><span class="commerce-banner-icon" aria-hidden="true">!</span><span class="commerce-banner-text">登录并完成邮箱验证后即可购买。请使用顶部账号入口登录。</span></p>'
      : bootstrap.session.user.status !== "ACTIVE" || bootstrap.session.user.permission_level < 1
        ? '<p class="commerce-banner is-warn" role="status"><span class="commerce-banner-icon" aria-hidden="true">!</span><span class="commerce-banner-text">该账号尚未完成购买资格验证，请先完成邮箱验证。</span></p>'
        : "";
    const buyShell = `<div class="commerce-buy-shell${currentQuote ? " is-hidden" : ""}">
      ${renderBuyTop()}
      ${loginNotice}
      ${renderBanner()}
      <div class="commerce-grid">
        <div class="commerce-main-column">${renderSlotsCard(now)}${renderFeatureCard(now)}${renderAlignLine(now, alignAmount)}</div>
        ${renderSummary(selection, estimate, selectionOverLimit)}
      </div>
      ${selectionOverLimit ? `<p class="commerce-selection-limit-error" data-selection-limit-error role="alert">${selectionLimitMessage()}</p>` : ""}
      <div class="commerce-mobile-bar">${renderPromotionControl("mobile")}<div><b>${formatCents(estimate)}</b><span>${selection.length} 项${selectionRawPrice(selection, bootstrap.catalog) - estimate > 0n ? ` · 已省 ${formatCents(selectionRawPrice(selection, bootstrap.catalog) - estimate)}` : ""}</span></div><button type="button" data-action="review" ${!canPurchase || selection.length === 0 || selectionOverLimit || quoteBusy || orderBusy ? "disabled" : ""}>去确认</button></div>
      ${!currentQuote && errorMessage ? `<p class="commerce-error" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
      ${renderFoot()}
      ${renderAlignDialog(now, alignAmount)}
    </div>
    ${currentQuote ? renderQuote() : ""}`;

    root.innerHTML = `
      <header class="site-header"><div class="topbar page-width"><a class="brand" href="/"><span class="brand-mark brand-mark--logo"><img src="/brand/LTSD_128.png" alt="" width="46" height="46"></span><span><strong>露天商店.Ro</strong><small>玩家交易资料站</small></span></a>${siteNavMarkup(null)}</div></header>
      <main class="page-width commerce-page">
        ${view === "orders" ? renderOrdersPage() : buyShell}
        <dialog class="commerce-dialog commerce-notice-dialog" data-alignment-notice><h2>到期时间已基本一致</h2><p>收费项目之间不到 24 小时，无需统一到期。请使用普通续期，不会生成报价或订单。</p><div class="commerce-dialog-foot"><button class="commerce-button commerce-button--secondary" type="button" data-focus-key="alignment-notice-close" data-action="close-alignment-notice">知道了</button></div></dialog>
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
    if (alignOpen) {
      const dialog = root.querySelector<HTMLDialogElement>("[data-align-dialog]");
      try { dialog?.showModal(); } catch { dialog?.setAttribute("open", ""); }
    }
  }

  function invalidateQuote(): void {
    quoteRevision += 1;
    currentQuote = null;
    quoteBusy = false;
    idempotencyKey = null;
    orderMessage = "";
    previewExpanded = false;
  }

  async function requestQuote(selection: CommerceQuoteSelection[]): Promise<void> {
    if (!canPurchase || quoteBusy || orderBusy || selection.length === 0) return;
    if (selectionItemCount(selection) > MAX_SELECTION_ITEMS) {
      errorMessage = selectionLimitMessage();
      render();
      return;
    }
    const requestRevision = ++quoteRevision;
    alignmentNotice = false;
    errorMessage = "";
    orderMessage = "";
    currentQuote = null;
    quoteBusy = true;
    render();
    try {
      const quote = await api.quoteCommerceSelection(selection, promotionCode.trim() || undefined);
      if (requestRevision === quoteRevision) currentQuote = quote;
    } catch (error) {
      if (requestRevision === quoteRevision) errorMessage = quoteMessage(error);
    } finally {
      if (requestRevision === quoteRevision) {
        quoteBusy = false;
        render("commerce-review-title");
      }
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
    const action = target.dataset.action;
    if (action === "view-buy") {
      view = "buy";
      render();
      return;
    }
    if (action === "close-review") {
      invalidateQuote();
      errorMessage = "";
      render("commerce-review");
      return;
    }
    if (action === "open-align") {
      if (!canPurchase) return;
      alignOpen = true;
      render("commerce-align-title");
      return;
    }
    if (action === "close-align") {
      alignOpen = false;
      render("align-open");
      return;
    }
    if (action === "toggle-promo") {
      promoOpen = !promoOpen;
      const placement = target.dataset.focusKey?.endsWith("-mobile") ? "mobile" : "desktop";
      render(promoOpen ? `promotion-code-${placement}` : `promotion-toggle-${placement}`);
      return;
    }
    if (action === "toggle-preview") {
      previewExpanded = !previewExpanded;
      render("commerce-preview-toggle");
      return;
    }
    if (action === "qty-step") {
      const step = Number(target.dataset.step);
      const base = Number.parseInt(slotQuantity, 10);
      const quantity = Math.min(MAX_SELECTION_ITEMS, Math.max(0, (Number.isSafeInteger(base) ? base : 0) + (Number.isFinite(step) ? step : 0)));
      slotQuantity = String(quantity);
      invalidateQuote();
      errorMessage = "";
      render("slot-quantity");
      return;
    }
    if (action === "close-alignment-notice") {
      alignmentNotice = false;
      render("align-open");
      return;
    }
    if (action === "align") {
      if (!canPurchase || quoteBusy || orderBusy) return;
      const rows = alignmentExpiries(bootstrap.account, Date.now());
      if (!rows.length) {
        alignOpen = false;
        errorMessage = "当前没有可统一到期的付费项目。";
        render();
        return;
      }
      if (rows.length > MAX_SELECTION_ITEMS) {
        render();
        return;
      }
      alignOpen = false;
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
    if (action === "review") {
      invalidateQuote();
      void requestQuote(selectedNormalItems());
      return;
    }
    if (action === "pay") {
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
    if (action === "purchase-history") {
      view = "orders";
      if (!historyLoaded) void loadHistory();
      else render("commerce-history-title");
      return;
    }
    if (action === "open-order" && target.dataset.orderId) {
      void openOrder(target.dataset.orderId);
      return;
    }
    if (action === "close-order") {
      selectedOrderId = null;
      selectedOrder = null;
      orderDetailError = "";
      render("commerce-history-title");
      return;
    }
    if (action === "more-orders" && historyPage.nextCursor) {
      void loadHistory(historyPage.nextCursor);
      return;
    }
    if (action === "resume-checkout" && selectedOrder?.checkoutUrl) {
      api.navigateToCheckout(selectedOrder.checkoutUrl);
      return;
    }
    if (action === "refresh-order-status" && returnOrderId) {
      if (returnPollTimer !== null) root.ownerDocument.defaultView!.clearTimeout(returnPollTimer);
      returnPollTimer = null;
      returnPollAttempts = 0;
      returnPollExhausted = false;
      returnMessage = "正在确认付款";
      void pollReturnedOrder();
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
  startCheckoutReturn();
}
