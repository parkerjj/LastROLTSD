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

const QUOTE_JSON_LIMIT = 32 * 1024;
const QUOTE_RATE_LIMIT = { scope: 'commerce_quote_session', limit: 10, windowMs: 60_000 } as const;

export interface CommerceQuoteRouteContext {
  authConfig: EnabledAuthConfig;
  authRepository: AuthRepository;
  quoteDependencies: QuoteDependencies;
  runtime: AuthRuntime;
}

export interface CommerceQuoteRouteOptions {
  setup(): CommerceQuoteRouteContext | null;
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

function fixedError(request: Request, code: string, message: string, status: 400 | 401 | 403 | 404 | 413 | 415 | 429 | 503): Response {
  const response = jsonError(code, message, status, requestId(request));
  response.headers.set('cache-control', 'private, no-store');
  return response;
}

function rateLimited(request: Request, retryAfter: number): Response {
  const response = fixedError(request, 'COMMERCE_RATE_LIMITED', '报价请求过于频繁，请稍后重试', 429);
  response.headers.set('retry-after', String(Math.max(1, Math.ceil(retryAfter))));
  return response;
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

function quoteFailure(request: Request, error: unknown): Response {
  if (error instanceof AuthFailure) return fixedError(request, error.code, error.publicMessage, error.status);
  if (error instanceof QuoteInputError) return fixedError(request, 'COMMERCE_BAD_REQUEST', error.message, 400);
  if (error instanceof CommerceQuoteError) {
    const publicError = QUOTE_ERRORS[error.code];
    return fixedError(request, error.code, publicError.message, publicError.status);
  }
  return fixedError(request, 'COMMERCE_UNAVAILABLE', '购买报价暂不可用，请稍后重试', 503);
}

export function registerCommerceQuoteRoute(app: Hono<any>, options: CommerceQuoteRouteOptions): void {
  app.post('/api/v1/commerce/quotes', async (c) => {
    try {
      const context = options.setup();
      if (!context) return fixedError(c.req.raw, 'COMMERCE_UNAVAILABLE', '购买报价暂不可用，请稍后重试', 503);
      const sessions = createSessionService(context.authRepository, context.authConfig, context.runtime);
      const identity = await sessions.authenticate(c.req.raw);
      await assertCsrf(c.req.raw, context.authConfig, 'session', identity, context.runtime.now);
      const session = await sessions.me(identity);
      if (session.user.status !== 'ACTIVE' || session.user.permission_level < 1) {
        return fixedError(c.req.raw, 'COMMERCE_ACCOUNT_REQUIRED', '请使用已验证邮箱的正式账号购买', 403);
      }

      const keyDigest = await authRateLimitKey(context.authConfig.rateSecret, 'session', identity.sessionToken);
      const rate = await consumeAuthRateLimit(context.authRepository, [{
        kind: 'window', scope: QUOTE_RATE_LIMIT.scope, keyDigest,
        limit: QUOTE_RATE_LIMIT.limit, windowMs: QUOTE_RATE_LIMIT.windowMs,
      }], context.runtime.now);
      if (!rate.allowed) return rateLimited(c.req.raw, rate.retryAfter);

      const parsed = parseQuoteInput(await readAuthJson(c.req.raw, QUOTE_JSON_LIMIT));
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
      return quoteFailure(c.req.raw, error);
    }
  });
}
