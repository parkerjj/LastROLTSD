import type { CommerceCatalog, CommerceProductKey, CommerceDiscountPercent } from "@lastroweb/commerce";
import type { AuthApiClient } from "./auth/api";
import type { AuthSessionResponse } from "./auth/types";

export type CommerceQuoteSelection =
  | { type: "slot_add"; quantity: number; termDays: 30 | 90 | 180 | 360 }
  | { type: "slot_renew"; unitIds: string[]; termDays: 30 | 90 | 180 | 360 }
  | { type: "standalone"; termDays: 30 | 90 | 180 | 360 }
  | { type: "align_all_paid"; termDays: 30 | 90 | 180 | 360 };

export interface CommerceBootstrapUnit {
  unitId: string;
  entitlementId: string | null;
  resource: string;
  kind: "commerce" | "legacy";
  quantity: number;
  startsAt: string;
  expiresAt: string;
  source: string | null;
  sourceRef: string | null;
  isGift: boolean;
}

export interface CommerceBootstrapEntitlement {
  id: string;
  unitId: string | null;
  resource: string;
  quantity: number;
  startsAt: string;
  expiresAt: string;
  source: string;
  sourceRef: string | null;
  isGift: boolean;
}

export interface CommerceBootstrap {
  version: 1;
  catalog: CommerceCatalog;
  session: AuthSessionResponse | null;
  account: {
    units: CommerceBootstrapUnit[];
    entitlements: CommerceBootstrapEntitlement[];
    effective: { slots: number; modules: string[] };
  };
}

export interface CommercePreviewEntitlement {
  entitlementId: string | null;
  unitId: string | null;
  resource: string;
  quantity: number;
  startsAt: string;
  expiresAt: string;
  productKey: CommerceProductKey | null;
  isGift: boolean;
  isNew?: boolean;
}

export interface CommerceQuoteItem {
  ordinal: number;
  productKey: CommerceProductKey;
  operation: "ADD" | "RENEW";
  targetUnitId: string | null;
  targetEntitlementId: string | null;
  durationMs: string;
  expectedStartsAt: string;
  expectedExpiresAt: string;
  discountPercent: CommerceDiscountPercent;
  rawCents: string;
  tierCents: string;
  paidCents: string;
}

export interface CommerceQuote {
  quoteId: string;
  pricingVersion: string;
  currency: "CNY";
  createdAt: string;
  expiresAt: string;
  items: CommerceQuoteItem[];
  accountPreview: {
    before: { entitlements: CommercePreviewEntitlement[]; effective: { slots: number; modules: string[] } };
    after: { entitlements: CommercePreviewEntitlement[]; effective: { slots: number; modules: string[] } };
  };
  rawTotalCents: string;
  tierTotalCents: string;
  promoTotalCents: string | null;
  selectedTotalCents: string;
  discountStrategy: "term" | "promotion_code";
  promotion: null | { subtotalCents: number; totalCents: number; discountCents: number; currency: "cny"; applied: boolean };
}

export interface CommerceOrderResponse {
  orderId: string;
  checkoutUrl: string | null;
  expiresAt: string;
  paymentStatus: string;
}

export interface CommerceOrderSummary {
  orderId: string;
  createdAt: string;
  currency: "CNY";
  paidTotalCents: string;
  paymentState: "unpaid" | "processing" | "paid";
  fulfillmentState: "pending" | "fulfilled" | "settled";
  refundState: "none" | "partial" | "full";
  refundedTotalCents: string;
  itemCount: number;
}

export interface CommerceOrderPage {
  items: CommerceOrderSummary[];
  nextCursor: string | null;
}

export interface CommerceOrderRefund {
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  amountCents: string;
  createdAt: string;
  cumulativeSuccessfulCents: string;
  cumulativeRatioBasisPoints: number;
}

export interface CommerceOrderRefundAdjustment {
  revision: number;
  cumulativeRefundCents: string;
  retainedDurationMs: string;
  deductedDurationMs: string;
  occurredAt: string;
  afterExpiresAt: string | null;
}

export interface CommerceOrderHistoryItem extends Omit<CommerceQuoteItem, "operation"> {
  operation: "ADD" | "RENEW" | "ALIGN";
  deliveryState: "pending" | "delivered" | "settled_no_entitlement";
  deliveredAt: string | null;
  fulfillmentBefore: { startsAt: string | null; expiresAt: string | null } | null;
  fulfillmentAfter: { startsAt: string | null; expiresAt: string | null } | null;
  refundAdjustments: CommerceOrderRefundAdjustment[];
}

export interface CommerceOrderView {
  orderId: string;
  createdAt: string;
  currency: "CNY";
  pricingVersion: string;
  rawTotalCents: string;
  tierTotalCents: string;
  promoTotalCents: string | null;
  paidTotalCents: string;
  discountStrategy: "term" | "promotion_code";
  accountPreview: CommerceQuote["accountPreview"];
  checkoutState: "creating" | "ready" | "failed" | "expired";
  checkoutExpiresAt: string | null;
  paymentState: "unpaid" | "processing" | "paid";
  fulfillmentState: "pending" | "fulfilled" | "settled";
  refundState: "none" | "partial" | "full";
  paidAt: string | null;
  fulfilledAt: string | null;
  refundedTotalCents: string;
  checkoutUrl: string | null;
  items: CommerceOrderHistoryItem[];
  refunds: CommerceOrderRefund[];
}

export interface CommerceApi {
  quoteCommerceSelection(selection: readonly CommerceQuoteSelection[], promotionCode?: string): Promise<CommerceQuote>;
  createOrder(quoteId: string, idempotencyKey: string): Promise<CommerceOrderResponse>;
  listOrders(cursor?: string): Promise<CommerceOrderPage>;
  getOrder(orderId: string, options?: { statusOnly?: boolean }): Promise<CommerceOrderView>;
  navigateToCheckout(url: string): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value);
}

function entitlement(value: unknown): value is CommercePreviewEntitlement {
  return record(value)
    && (value.entitlementId === null || decimal(value.entitlementId))
    && (value.unitId === null || decimal(value.unitId))
    && typeof value.resource === "string"
    && Number.isSafeInteger(value.quantity)
    && decimal(value.startsAt)
    && decimal(value.expiresAt)
    && (value.productKey === null || value.productKey === "slots" || value.productKey === "module:standalone")
    && typeof value.isGift === "boolean"
    && (value.isNew === undefined || typeof value.isNew === "boolean");
}

function quoteResponse(value: unknown): value is CommerceQuote {
  if (!record(value) || !record(value.accountPreview)) return false;
  const sides = [value.accountPreview.before, value.accountPreview.after];
  return decimal(value.quoteId)
    && typeof value.pricingVersion === "string"
    && value.currency === "CNY"
    && decimal(value.createdAt)
    && decimal(value.expiresAt)
    && Array.isArray(value.items)
    && value.items.every((item) => record(item)
      && Number.isSafeInteger(item.ordinal)
      && (item.productKey === "slots" || item.productKey === "module:standalone")
      && (item.operation === "ADD" || item.operation === "RENEW")
      && (item.targetUnitId === null || decimal(item.targetUnitId))
      && (item.targetEntitlementId === null || decimal(item.targetEntitlementId))
      && decimal(item.durationMs) && decimal(item.expectedStartsAt) && decimal(item.expectedExpiresAt)
      && (item.discountPercent === 100 || item.discountPercent === 80 || item.discountPercent === 70)
      && decimal(item.rawCents) && decimal(item.tierCents) && decimal(item.paidCents))
    && sides.every((side) => record(side) && Array.isArray(side.entitlements)
      && side.entitlements.every(entitlement) && record(side.effective)
      && Number.isSafeInteger(side.effective.slots) && Array.isArray(side.effective.modules)
      && side.effective.modules.every((module) => typeof module === "string"))
    && decimal(value.rawTotalCents)
    && decimal(value.tierTotalCents)
    && (value.promoTotalCents === null || decimal(value.promoTotalCents))
    && decimal(value.selectedTotalCents)
    && (value.discountStrategy === "term" || value.discountStrategy === "promotion_code")
    && (value.promotion === null || (record(value.promotion)
      && Number.isSafeInteger(value.promotion.subtotalCents)
      && Number.isSafeInteger(value.promotion.totalCents)
      && Number.isSafeInteger(value.promotion.discountCents)
      && value.promotion.currency === "cny"
      && typeof value.promotion.applied === "boolean"));
}

function validAccountPreview(value: unknown): value is CommerceQuote["accountPreview"] {
  if (!record(value)) return false;
  const sides = [value.before, value.after];
  return sides.every((side) => record(side) && Array.isArray(side.entitlements)
    && side.entitlements.every(entitlement) && record(side.effective)
    && Number.isSafeInteger(side.effective.slots) && Array.isArray(side.effective.modules)
    && side.effective.modules.every((module) => typeof module === "string"));
}

function safeCheckoutUrl(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:" && parsed.hostname === "checkout.stripe.com" && !parsed.username && !parsed.password) {
      return parsed.href;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function orderSummary(value: unknown): value is CommerceOrderSummary {
  return record(value) && decimal(value.orderId) && decimal(value.createdAt) && value.currency === "CNY"
    && decimal(value.paidTotalCents) && ["unpaid", "processing", "paid"].includes(String(value.paymentState))
    && ["pending", "fulfilled", "settled"].includes(String(value.fulfillmentState))
    && ["none", "partial", "full"].includes(String(value.refundState))
    && decimal(value.refundedTotalCents) && Number.isSafeInteger(value.itemCount) && Number(value.itemCount) >= 0;
}

function orderPage(value: unknown): value is CommerceOrderPage {
  return record(value) && Array.isArray(value.items) && value.items.every(orderSummary)
    && (value.nextCursor === null || (typeof value.nextCursor === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.nextCursor)));
}

function fulfillmentWindow(value: unknown): boolean {
  return value === null || (record(value)
    && (value.startsAt === null || decimal(value.startsAt))
    && (value.expiresAt === null || decimal(value.expiresAt)));
}

function orderView(value: unknown): value is CommerceOrderView {
  if (!record(value) || !decimal(value.orderId) || !decimal(value.createdAt) || value.currency !== "CNY"
    || typeof value.pricingVersion !== "string" || !decimal(value.rawTotalCents) || !decimal(value.tierTotalCents)
    || (value.promoTotalCents !== null && !decimal(value.promoTotalCents)) || !decimal(value.paidTotalCents)
    || (value.discountStrategy !== "term" && value.discountStrategy !== "promotion_code")
    || !validAccountPreview(value.accountPreview)
    || !["creating", "ready", "failed", "expired"].includes(String(value.checkoutState))
    || (value.checkoutExpiresAt !== null && !decimal(value.checkoutExpiresAt))
    || !["unpaid", "processing", "paid"].includes(String(value.paymentState))
    || !["pending", "fulfilled", "settled"].includes(String(value.fulfillmentState))
    || !["none", "partial", "full"].includes(String(value.refundState))
    || (value.paidAt !== null && !decimal(value.paidAt))
    || (value.fulfilledAt !== null && !decimal(value.fulfilledAt))
    || !decimal(value.refundedTotalCents)
    || safeCheckoutUrl(value.checkoutUrl) === undefined
    || !Array.isArray(value.items) || !Array.isArray(value.refunds)) return false;

  const validItems = value.items.every((item) => record(item)
    && Number.isSafeInteger(item.ordinal)
    && (item.productKey === "slots" || item.productKey === "module:standalone")
    && ["ADD", "RENEW", "ALIGN"].includes(String(item.operation))
    && (item.targetUnitId === null || decimal(item.targetUnitId))
    && (item.targetEntitlementId === null || decimal(item.targetEntitlementId))
    && decimal(item.durationMs) && decimal(item.expectedStartsAt) && decimal(item.expectedExpiresAt)
    && (item.discountPercent === 70 || item.discountPercent === 80 || item.discountPercent === 100)
    && decimal(item.rawCents) && decimal(item.tierCents) && decimal(item.paidCents)
    && ["pending", "delivered", "settled_no_entitlement"].includes(String(item.deliveryState))
    && (item.deliveredAt === null || decimal(item.deliveredAt))
    && fulfillmentWindow(item.fulfillmentBefore) && fulfillmentWindow(item.fulfillmentAfter)
    && Array.isArray(item.refundAdjustments) && item.refundAdjustments.every((adjustment) => record(adjustment)
      && Number.isSafeInteger(adjustment.revision) && Number(adjustment.revision) > 0
      && decimal(adjustment.cumulativeRefundCents) && decimal(adjustment.retainedDurationMs)
      && decimal(adjustment.deductedDurationMs) && decimal(adjustment.occurredAt)
      && (adjustment.afterExpiresAt === null || decimal(adjustment.afterExpiresAt))));
  const validRefunds = value.refunds.every((refund) => record(refund)
    && ["pending", "requires_action", "succeeded", "failed", "canceled"].includes(String(refund.status))
    && decimal(refund.amountCents) && decimal(refund.createdAt) && decimal(refund.cumulativeSuccessfulCents)
    && Number.isSafeInteger(refund.cumulativeRatioBasisPoints)
    && Number(refund.cumulativeRatioBasisPoints) >= 0 && Number(refund.cumulativeRatioBasisPoints) <= 10_000);
  return validItems && validRefunds;
}

function toWireSelection(selection: CommerceQuoteSelection): Record<string, unknown> {
  switch (selection.type) {
    case "slot_add": return { type: selection.type, quantity: selection.quantity, term_days: selection.termDays };
    case "slot_renew": return { type: selection.type, unit_ids: [...selection.unitIds], term_days: selection.termDays };
    case "standalone":
    case "align_all_paid": return { type: selection.type, term_days: selection.termDays };
  }
}

function safeOrderResponse(value: unknown): CommerceOrderResponse {
  if (!record(value) || !decimal(value.orderId) || !decimal(value.expiresAt) || typeof value.paymentStatus !== "string") {
    throw new Error("订单服务返回无效响应，请稍后重试");
  }
  let checkoutUrl: string | null = null;
  if (value.checkoutUrl !== null) {
    if (typeof value.checkoutUrl !== "string") throw new Error("付款链接无效，请稍后重试");
    let parsed: URL;
    try {
      parsed = new URL(value.checkoutUrl);
    } catch {
      throw new Error("付款链接无效，请稍后重试");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "checkout.stripe.com" || parsed.username || parsed.password) {
      throw new Error("付款链接无效，请稍后重试");
    }
    checkoutUrl = parsed.href;
  }
  return { orderId: value.orderId, checkoutUrl, expiresAt: value.expiresAt, paymentStatus: value.paymentStatus };
}

export function createCommerceApi(authApi: Pick<AuthApiClient, "sessionRequest" | "sessionRead">): CommerceApi {
  return {
    async quoteCommerceSelection(selection, promotionCode) {
      const body = {
        selection: selection.map(toWireSelection),
        ...(promotionCode?.trim() ? { promotion_code: promotionCode.trim() } : {}),
      };
      const result = await authApi.sessionRequest<unknown>("/api/v1/commerce/quotes", "POST", body);
      if (!quoteResponse(result)) throw new Error("报价服务返回无效响应，请刷新页面后重试");
      return result;
    },
    async createOrder(quoteId, idempotencyKey) {
      if (!decimal(quoteId) || !idempotencyKey || idempotencyKey.length > 255 || !/^[\x21-\x7e]+$/u.test(idempotencyKey)) {
        throw new Error("订单确认信息无效，请重新获取报价");
      }
      const result = await authApi.sessionRequest<unknown>(
        "/api/v1/commerce/orders",
        "POST",
        { quote_id: quoteId },
        { "Idempotency-Key": idempotencyKey },
      );
      return safeOrderResponse(result);
    },
    async listOrders(cursor) {
      if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(cursor)) throw new Error("购买记录游标无效，请刷新页面");
      const path = cursor === undefined ? "/api/v1/commerce/orders" : `/api/v1/commerce/orders?cursor=${encodeURIComponent(cursor)}`;
      const result = await authApi.sessionRead<unknown>(path);
      if (!orderPage(result)) throw new Error("购买记录服务返回无效响应，请刷新页面后重试");
      return result;
    },
    async getOrder(orderId, options) {
      if (!decimal(orderId)) throw new Error("订单编号无效，请刷新页面后重试");
      const path = `/api/v1/commerce/orders/${encodeURIComponent(orderId)}${options?.statusOnly ? "?status_only=1" : ""}`;
      const result = await authApi.sessionRead<unknown>(path);
      if (!orderView(result)) throw new Error("订单服务返回无效响应，请刷新页面后重试");
      return result;
    },
    navigateToCheckout(url) {
      const safe = safeOrderResponse({ orderId: "1", expiresAt: "0", paymentStatus: "unpaid", checkoutUrl: url });
      if (!safe.checkoutUrl) throw new Error("付款链接无效，请稍后重试");
      window.location.assign(safe.checkoutUrl);
    },
  };
}
