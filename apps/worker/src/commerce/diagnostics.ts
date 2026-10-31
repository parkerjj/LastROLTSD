import { requestId } from '../middleware/errors';
import { logError } from '../observability';
import { StripeRequestError } from './stripe-client';

export interface CommerceSetupDiagnostic {
  reason: 'database_unavailable' | 'commerce_config_invalid' | 'auth_config_unavailable' | 'auth_disabled' | 'commerce_not_configured';
  invalidFields?: readonly string[];
}

function errorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error === 'string' ? 'StringError' : 'UnknownError';
  return /^[A-Za-z][A-Za-z0-9_.]{0,63}$/u.test(name) ? name : 'UnknownError';
}

function safeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : null;
}

export function logCommerceSetupUnavailable(
  request: Request,
  route: string,
  diagnostic?: CommerceSetupDiagnostic,
): void {
  logError('commerce.setup_unavailable', new Error('Commerce route setup unavailable'), {
    request_id: requestId(request),
    route,
    reason: diagnostic?.reason ?? 'commerce_not_configured',
    ...(diagnostic?.invalidFields?.length ? { invalid_fields: diagnostic.invalidFields } : {}),
  });
}

export function logCommerceRequestFailure(request: Request, route: string, stage: string, error: unknown): void {
  const safeCode = error instanceof StripeRequestError ? null : safeErrorCode(error);
  logError('commerce.request_failure', new Error('Commerce request failed'), {
    request_id: requestId(request),
    route,
    failure_stage: stage,
    error_class: errorClass(error),
    ...(error instanceof StripeRequestError ? {
      stripe_status: error.status,
      ...(error.providerCode ? { stripe_error_code: error.providerCode } : {}),
    } : {}),
    ...(safeCode ? { error_code: safeCode } : {}),
  });
}
