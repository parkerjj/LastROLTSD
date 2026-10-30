const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const STRIPE_TIMEOUT_MS = 10_000;
export const STRIPE_PUBLIC_ERROR = '支付服务暂时不可用，请稍后重试';

export type StripeFormValue = string | number | boolean | null | undefined | StripeFormValue[] | { [key: string]: StripeFormValue };
export type StripeForm = Record<string, StripeFormValue>;

export interface StripeClient {
  get<T>(path: string, params?: StripeForm): Promise<T>;
  post<T>(path: string, params?: StripeForm, options?: { idempotencyKey?: string }): Promise<T>;
}

export class StripeRequestError extends Error {
  constructor(public readonly status: number | null = null, public readonly providerCode: string | null = null) {
    super(STRIPE_PUBLIC_ERROR);
    this.name = 'StripeRequestError';
  }
}

function appendFormValue(form: URLSearchParams, key: string, value: StripeFormValue): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const childKey = item !== null && typeof item === 'object' ? `${key}[${index}]` : `${key}[]`;
      appendFormValue(form, childKey, item);
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) appendFormValue(form, `${key}[${childKey}]`, childValue);
    return;
  }
  form.append(key, String(value));
}

function encodeStripeForm(params: StripeForm): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) appendFormValue(form, key, value);
  return form;
}

function readProviderCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[a-z0-9_]{1,80}$/iu.test(code) ? code : null;
}

export function createStripeClient(options: {
  secretKey: string;
  apiVersion: string;
  fetch: typeof globalThis.fetch;
}): StripeClient {
  if (!options.secretKey.trim() || !options.apiVersion.trim()) throw new TypeError('Stripe client configuration is incomplete');

  async function request<T>(method: 'GET' | 'POST', path: string, params: StripeForm, idempotencyKey?: string): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new TypeError('invalid Stripe API path');
    const encoded = encodeStripeForm(params);
    const url = new URL(`${STRIPE_API_BASE}${path}`);
    const headers = new Headers({
      Authorization: `Bearer ${options.secretKey}`,
      'Stripe-Version': options.apiVersion,
    });
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    };
    if (method === 'GET') {
      url.search = encoded.toString();
    } else {
      headers.set('Content-Type', 'application/x-www-form-urlencoded');
      if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
      init.body = encoded.toString();
    }

    let response: Response;
    try {
      response = await options.fetch.call(globalThis, url, init);
    } catch {
      throw new StripeRequestError();
    }

    if (!response.ok) {
      let providerCode: string | null = null;
      try {
        providerCode = readProviderCode(await response.json());
      } catch {
        // Stripe's public error body is deliberately not returned to callers.
      }
      throw new StripeRequestError(response.status, providerCode);
    }

    try {
      return await response.json() as T;
    } catch {
      throw new StripeRequestError(response.status);
    }
  }

  return {
    get: <T>(path: string, params: StripeForm = {}) => request<T>('GET', path, params),
    post: <T>(path: string, params: StripeForm = {}, requestOptions: { idempotencyKey?: string } = {}) =>
      request<T>('POST', path, params, requestOptions.idempotencyKey),
  };
}
