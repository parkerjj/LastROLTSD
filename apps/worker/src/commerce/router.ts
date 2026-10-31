import type { Hono } from 'hono';
import { requestId, jsonError } from '../middleware/errors';
import { assertCsrf } from '../auth/csrf';
import { readAuthJson } from '../auth/body';
import { createSessionService } from '../auth/session-service';
import { authRateLimitKey, consumeAuthRateLimit } from '../auth/rate-limit';
import { AuthFailure, type AuthRepository, type AuthRuntime, type EnabledAuthConfig } from '../auth/types';
import type { QuoteDependencies, CommerceQuote, CommerceQuoteErrorCode } from './quotes';
import { CommerceQuoteError, createQuote } from './quotes';
import { parseQuoteInput, QuoteInputError } from './quote-input';
import type { OrderDependencies, CommerceOrderErrorCode } from './orders';
import { CommerceOrderError, createOrderAndCheckout, getCommerceOrder, listCommerceOrders } from './orders';
import type { WebhookDependencies } from './webhook';
import { receiveStripeEvent } from './webhook';
import { logCommerceRequestFailure, logCommerceSetupUnavailable, type CommerceSetupDiagnostic } from './diagnostics';

const QUOTE_JSON_LIMIT = 32 * 1024;
const QUOTE_RATE_LIMIT = { scope: 'commerce_quote_session', limit: 10, windowMs: 60_000 } as const;
const ORDER_JSON_LIMIT = 4 * 1024;
const ORDER_RATE_LIMIT = { scope: 'commerce_order_session', limit: 5, windowMs: 60_000 } as const;
const ORDER_READ_RATE_LIMIT = { scope: 'commerce_order_read_session', limit: 90, windowMs: 60_000 } as const;

export interface CommerceQuoteRouteContext {
  authConfig: EnabledAuthConfig;
  authRepository: AuthRepository;
  quoteDependencies: QuoteDependencies;
  runtime: AuthRuntime;
  salesEnabled?: boolean;
}

export interface CommerceQuoteRouteOptions {
  setup(): CommerceQuoteRouteContext | null;
  setupUnavailable?: CommerceSetupDiagnostic;
}

export interface CommerceOrderRouteContext {
  authConfig: EnabledAuthConfig;
  authRepository: AuthRepository;
  orderDependencies: OrderDependencies;
  runtime: AuthRuntime;
  salesEnabled?: boolean;
}

export interface CommerceOrderRouteOptions {
  setup(): CommerceOrderRouteContext | null;
  setupUnavailable?: CommerceSetupDiagnostic;
}

export interface CommerceWebhookRouteOptions {
  setup(): WebhookDependencies | null;
}

const QUOTE_ERRORS: Record<CommerceQuoteErrorCode, { status: 400 | 404 | 503; message: string }> = {
  COMMERCE_SELECTION_INVALID: { status: 400, message: '购买选择无效' },
  COMMERCE_NO_RENEWABLE_SLOTS: { status: 400, message: '没有可续期的付费实例额度' },
  COMMERCE_TARGET_UNAVAILABLE: { status: 404, message: '所选付费项目已不可用，请刷新页面' },
  COMMERCE_NO_CHARGEABLE_ITEMS: { status: 400, message: '没有可统一到期的付费项目' },
  COMMERCE_ALIGN_NOT_NEEDED: { status: 400, message: '当前付费项目到期时间已基本一致，请使用普通续期' },
  COMMERCE_ITEM_LIMIT: { status: 400, message: '单次购买项目数量超出限制' },
  COMMERCE_PROMOTION_INVALID: { status: 400, message: '优惠码无效或不适用于此订单' },
  COMMERCE_PROMOTION_UNAVAILABLE: { status: 503, message: '优惠码暂时无法验证，请稍后重试' },
};

function fixedError(request: Request, code: string, message: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503): Response {
  const response = jsonError(code, message, status, requestId(request));
  response.headers.set('cache-control', 'private, no-store');
  return response;
}

function rateLimited(request: Request, retryAfter: number): Response {
  const response = fixedError(request, 'COMMERCE_RATE_LIMITED', '报价请求过于频繁，请稍后重试', 429);
  response.headers.set('retry-after', String(Math.max(1, Math.ceil(retryAfter))));
  return response;
}

const ORDER_ERRORS: Record<CommerceOrderErrorCode, { status: 400 | 404 | 409 | 503; message: string }> = {
  COMMERCE_QUOTE_UNAVAILABLE: { status: 404, message: '报价不存在或不可用' },
  COMMERCE_QUOTE_EXPIRED: { status: 409, message: '报价已过期，请重新获取' },
  COMMERCE_PRICING_CHANGED: { status: 409, message: '价格已更新，请重新获取报价' },
  COMMERCE_IDEMPOTENCY_CONFLICT: { status: 409, message: '该确认请求已用于不同订单' },
  COMMERCE_ORDER_EXPIRED: { status: 409, message: '订单付款时间已过，请重新获取报价' },
  COMMERCE_ORDER_NOT_FOUND: { status: 404, message: '订单不存在或不可用' },
  COMMERCE_CURSOR_INVALID: { status: 400, message: '购买记录游标无效，请刷新页面' },
  COMMERCE_ORDER_UNAVAILABLE: { status: 503, message: '订单暂不可用，请稍后重试' },
};

function parseOrderBody(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || typeof input.quote_id !== 'string' || !/^[1-9]\d{0,19}$/u.test(input.quote_id)) return null;
  return input.quote_id;
}

function publicQuote(quote: CommerceQuote): Omit<CommerceQuote, 'requestHash' | 'promotion'> & {
  promotion: null | { subtotalCents: number; totalCents: number; discountCents: number; currency: 'cny'; applied: boolean };
} {
  const { requestHash: _requestHash, promotion, ...publicFields } = quote;
  return {
    ...publicFields,
    promotion: promotion ? {
      subtotalCents: promotion.subtotalCents,
      totalCents: promotion.totalCents,
      discountCents: promotion.discountCents,
      currency: promotion.currency,
      applied: quote.discountStrategy === 'promotion_code',
    } : null,
  };
}

function quoteFailure(request: Request, error: unknown, stage: string): Response {
  if (error instanceof AuthFailure) {
    if (error.status >= 500) logCommerceRequestFailure(request, '/api/v1/commerce/quotes', stage, error);
    return fixedError(request, error.code, error.publicMessage, error.status);
  }
  if (error instanceof QuoteInputError) return fixedError(request, 'COMMERCE_BAD_REQUEST', error.message, 400);
  if (error instanceof CommerceQuoteError) {
    const publicError = QUOTE_ERRORS[error.code];
    if (publicError.status >= 500) logCommerceRequestFailure(request, '/api/v1/commerce/quotes', stage, error);
    return fixedError(request, error.code, publicError.message, publicError.status);
  }
  logCommerceRequestFailure(request, '/api/v1/commerce/quotes', stage, error);
  return fixedError(request, 'COMMERCE_UNAVAILABLE', '购买报价暂不可用，请稍后重试', 503);
}

export function registerCommerceQuoteRoute(app: Hono<any>, options: CommerceQuoteRouteOptions): void {
  app.post('/api/v1/commerce/quotes', async (c) => {
    let failureStage = 'setup';
    try {
      const context = options.setup();
      if (!context) {
        logCommerceSetupUnavailable(c.req.raw, '/api/v1/commerce/quotes', options.setupUnavailable);
        return fixedError(c.req.raw, 'COMMERCE_UNAVAILABLE', '购买报价暂不可用，请稍后重试', 503);
      }
      if (context.salesEnabled === false) return fixedError(c.req.raw, 'COMMERCE_UNAVAILABLE', '购买服务暂不可用，请稍后重试', 503);
      const sessions = createSessionService(context.authRepository, context.authConfig, context.runtime);
      failureStage = 'authentication';
      const identity = await sessions.authenticate(c.req.raw);
      failureStage = 'csrf_validation';
      await assertCsrf(c.req.raw, context.authConfig, 'session', identity, context.runtime.now);
      failureStage = 'account_profile';
      const session = await sessions.me(identity);
      if (session.user.status !== 'ACTIVE' || session.user.permission_level < 1) {
        return fixedError(c.req.raw, 'COMMERCE_ACCOUNT_REQUIRED', '请使用已验证邮箱的正式账号购买', 403);
      }

      failureStage = 'rate_limit';
      const keyDigest = await authRateLimitKey(context.authConfig.rateSecret, 'session', identity.sessionToken);
      const rate = await consumeAuthRateLimit(context.authRepository, [{
        kind: 'window', scope: QUOTE_RATE_LIMIT.scope, keyDigest,
        limit: QUOTE_RATE_LIMIT.limit, windowMs: QUOTE_RATE_LIMIT.windowMs,
      }], context.runtime.now);
      if (!rate.allowed) return rateLimited(c.req.raw, rate.retryAfter);

      failureStage = 'request_parse';
      const parsed = parseQuoteInput(await readAuthJson(c.req.raw, QUOTE_JSON_LIMIT));
      failureStage = 'quote_creation';
      const quote = await createQuote({
        userId: session.user.id,
        selection: parsed.selection,
        ...(parsed.promotionCode ? { promotionCode: parsed.promotionCode } : {}),
      }, context.quoteDependencies);
      return new Response(JSON.stringify(publicQuote(quote)), {
        status: 201,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
      });
    } catch (error) {
      return quoteFailure(c.req.raw, error, failureStage);
    }
  });
}

export function registerCommerceOrderRoute(app: Hono<any>, options: CommerceOrderRouteOptions): void {
  app.get('/api/v1/commerce/orders', async (c) => {
    let failureStage = 'setup';
    try {
      const context = options.setup();
      if (!context) {
        logCommerceSetupUnavailable(c.req.raw, '/api/v1/commerce/orders', options.setupUnavailable);
        return fixedError(c.req.raw, 'COMMERCE_UNAVAILABLE', '购买记录暂不可用，请稍后重试', 503);
      }
      const sessions = createSessionService(context.authRepository, context.authConfig, context.runtime);
      failureStage = 'authentication';
      const identity = await sessions.authenticate(c.req.raw);
      failureStage = 'account_profile';
      const session = await sessions.me(identity);
      if (session.user.status !== 'ACTIVE' || session.user.permission_level < 1) {
        return fixedError(c.req.raw, 'COMMERCE_ACCOUNT_REQUIRED', '请使用已验证邮箱的正式账号查看购买记录', 403);
      }
      failureStage = 'rate_limit';
      const keyDigest = await authRateLimitKey(context.authConfig.rateSecret, 'session', identity.sessionToken);
      const rate = await consumeAuthRateLimit(context.authRepository, [{
        kind: 'window', scope: ORDER_READ_RATE_LIMIT.scope, keyDigest,
        limit: ORDER_READ_RATE_LIMIT.limit, windowMs: ORDER_READ_RATE_LIMIT.windowMs,
      }], context.runtime.now);
      if (!rate.allowed) {
        const response = fixedError(c.req.raw, 'COMMERCE_RATE_LIMITED', '购买记录请求过于频繁，请稍后重试', 429);
        response.headers.set('retry-after', String(Math.max(1, Math.ceil(rate.retryAfter))));
        return response;
      }
      failureStage = 'order_history_query';
      const page = await listCommerceOrders(session.user.id, c.req.query('cursor'), context.orderDependencies);
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
      });
    } catch (error) {
      if (error instanceof AuthFailure) {
        if (error.status >= 500) logCommerceRequestFailure(c.req.raw, '/api/v1/commerce/orders', failureStage, error);
        return fixedError(c.req.raw, error.code, error.publicMessage, error.status);
      }
      if (error instanceof CommerceOrderError) {
        const publicError = ORDER_ERRORS[error.code];
        if (publicError.status >= 500) logCommerceRequestFailure(c.req.raw, '/api/v1/commerce/orders', failureStage, error);
        return fixedError(c.req.raw, error.code, publicError.message, publicError.status);
      }
      logCommerceRequestFailure(c.req.raw, '/api/v1/commerce/orders', failureStage, error);
      return fixedError(c.req.raw, 'COMMERCE_UNAVAILABLE', '购买记录暂不可用，请稍后重试', 503);
    }
  });

  app.get('/api/v1/commerce/orders/:orderId', async (c) => {
    try {
      const context = options.setup();
      if (!context) {
        logCommerceSetupUnavailable(c.req.raw, '/api/v1/commerce/orders/:orderId', options.setupUnavailable);
        return fixedError(c.req.raw, 'COMMERCE_UNAVAILABLE', '订单状态暂不可用，请稍后重试', 503);
      }
      const sessions = createSessionService(context.authRepository, context.authConfig, context.runtime);
      const identity = await sessions.authenticate(c.req.raw);
      const session = await sessions.me(identity);
      if (session.user.status !== 'ACTIVE' || session.user.permission_level < 1) {
        return fixedError(c.req.raw, 'COMMERCE_ACCOUNT_REQUIRED', '请使用已验证邮箱的正式账号查看订单', 403);
      }
      const keyDigest = await authRateLimitKey(context.authConfig.rateSecret, 'session', identity.sessionToken);
      const rate = await consumeAuthRateLimit(context.authRepository, [{
        kind: 'window', scope: ORDER_READ_RATE_LIMIT.scope, keyDigest,
        limit: ORDER_READ_RATE_LIMIT.limit, windowMs: ORDER_READ_RATE_LIMIT.windowMs,
      }], context.runtime.now);
      if (!rate.allowed) {
        const response = fixedError(c.req.raw, 'COMMERCE_RATE_LIMITED', '订单状态请求过于频繁，请稍后重试', 429);
        response.headers.set('retry-after', String(Math.max(1, Math.ceil(rate.retryAfter))));
        return response;
      }
      const statusOnly = c.req.query('status_only');
      if (statusOnly !== undefined && statusOnly !== '1') {
        return fixedError(c.req.raw, 'COMMERCE_BAD_REQUEST', '订单状态请求无效', 400);
      }
      const order = await getCommerceOrder(session.user.id, c.req.param('orderId'), context.orderDependencies, {
        includeCheckoutUrl: statusOnly !== '1',
      });
      return new Response(JSON.stringify(order), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
      });
    } catch (error) {
      if (error instanceof AuthFailure) {
        if (error.status >= 500) logCommerceRequestFailure(c.req.raw, '/api/v1/commerce/orders/:orderId', 'order_status', error);
        return fixedError(c.req.raw, error.code, error.publicMessage, error.status);
      }
      if (error instanceof CommerceOrderError) {
        const publicError = ORDER_ERRORS[error.code];
        if (publicError.status >= 500) logCommerceRequestFailure(c.req.raw, '/api/v1/commerce/orders/:orderId', 'order_status', error);
        return fixedError(c.req.raw, error.code, publicError.message, publicError.status);
      }
      logCommerceRequestFailure(c.req.raw, '/api/v1/commerce/orders/:orderId', 'order_status', error);
      return fixedError(c.req.raw, 'COMMERCE_UNAVAILABLE', '订单状态暂不可用，请稍后重试', 503);
    }
  });

  app.post('/api/v1/commerce/orders', async (c) => {
    try {
      const context = options.setup();
      if (!context) {
        logCommerceSetupUnavailable(c.req.raw, '/api/v1/commerce/orders', options.setupUnavailable);
        return fixedError(c.req.raw, 'COMMERCE_UNAVAILABLE', '购买服务暂不可用，请稍后重试', 503);
      }
      if (context.salesEnabled === false) return fixedError(c.req.raw, 'COMMERCE_UNAVAILABLE', '购买服务暂不可用，请稍后重试', 503);
      const sessions = createSessionService(context.authRepository, context.authConfig, context.runtime);
      const identity = await sessions.authenticate(c.req.raw);
      await assertCsrf(c.req.raw, context.authConfig, 'session', identity, context.runtime.now);
      const session = await sessions.me(identity);
      if (session.user.status !== 'ACTIVE' || session.user.permission_level < 1) {
        return fixedError(c.req.raw, 'COMMERCE_ACCOUNT_REQUIRED', '请使用已验证邮箱的正式账号购买', 403);
      }

      const keyDigest = await authRateLimitKey(context.authConfig.rateSecret, 'session', identity.sessionToken);
      const rate = await consumeAuthRateLimit(context.authRepository, [{
        kind: 'window', scope: ORDER_RATE_LIMIT.scope, keyDigest,
        limit: ORDER_RATE_LIMIT.limit, windowMs: ORDER_RATE_LIMIT.windowMs,
      }], context.runtime.now);
      if (!rate.allowed) return rateLimited(c.req.raw, rate.retryAfter);

      const quoteId = parseOrderBody(await readAuthJson(c.req.raw, ORDER_JSON_LIMIT));
      const idempotencyKey = c.req.raw.headers.get('idempotency-key');
      if (!quoteId || !idempotencyKey || idempotencyKey.length > 255 || !/^[\x21-\x7e]+$/u.test(idempotencyKey)) {
        return fixedError(c.req.raw, 'COMMERCE_BAD_REQUEST', '订单确认请求无效', 400);
      }
      const result = await createOrderAndCheckout({ userId: session.user.id, quoteId, idempotencyKey }, context.orderDependencies);
      return new Response(JSON.stringify({
        orderId: result.orderId,
        checkoutUrl: result.checkoutUrl,
        expiresAt: String(result.expiresAt),
        paymentStatus: result.paymentStatus,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
      });
    } catch (error) {
      if (error instanceof AuthFailure) {
        if (error.status >= 500) logCommerceRequestFailure(c.req.raw, '/api/v1/commerce/orders', 'order_creation', error);
        return fixedError(c.req.raw, error.code, error.publicMessage, error.status);
      }
      if (error instanceof CommerceOrderError) {
        const publicError = ORDER_ERRORS[error.code];
        if (publicError.status >= 500) logCommerceRequestFailure(c.req.raw, '/api/v1/commerce/orders', 'order_creation', error);
        return fixedError(c.req.raw, error.code, publicError.message, publicError.status);
      }
      logCommerceRequestFailure(c.req.raw, '/api/v1/commerce/orders', 'order_creation', error);
      return fixedError(c.req.raw, 'COMMERCE_UNAVAILABLE', '订单暂不可用，请稍后重试', 503);
    }
  });
}

export function registerCommerceWebhookRoute(app: Hono<any>, options: CommerceWebhookRouteOptions): void {
  app.post('/api/v1/commerce/stripe/webhook', async (c) => {
    let dependencies: WebhookDependencies | null;
    try {
      dependencies = options.setup();
    } catch {
      return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    if (!dependencies) return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
    return receiveStripeEvent(c.req.raw, dependencies);
  });
}
