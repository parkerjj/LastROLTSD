import type { Hono } from 'hono';
import { requestId } from '../middleware/errors';
import { logError } from '../observability';

// Server-side presence proxy for *. Browsers cannot carry the
// Yii2 `_csrf` cookie for game.lastro.cn, so the Worker fetches the login page,
// keeps the cookie jar in memory for the duration of this request only, and
// posts the official mg/check|mg/checkin form on the browser's behalf.
const ROUTE_PATH = '/lastro/presence';
const ALLOWED_ORIGIN = '*';
const UPSTREAM_ORIGIN = 'https://game.lastro.cn';
const UPSTREAM_REFERER = 'https://game.lastro.cn/ro/api.html?71.86';
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 4 * 1024;
const MAX_CREDENTIAL_LENGTH = 128;

const CORS_HEADERS = {
  'access-control-allow-origin': ALLOWED_ORIGIN,
  vary: 'Origin',
} as const;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS_HEADERS } as const;

const FORM_NAMES = { 3: 'Login_cn2', 4: 'Login_ts', 5: 'Login_debug' } as const;
type PresenceNid = keyof typeof FORM_NAMES;
type PresenceAction = 'check' | 'checkin';

// Non-critical fingerprint headers are randomized per request; the upstream URL,
// nid, Login_* fields, _csrf, Cookie and Content-Type are never randomized.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
] as const;
const ACCEPT_LANGUAGES = [
  'zh-CN,zh;q=0.9',
  'zh-CN,zh;q=0.9,en;q=0.8',
  'zh-TW,zh;q=0.9,en;q=0.8',
  'en-US,en;q=0.9,zh-CN;q=0.8',
] as const;
const SEC_CH_UA = [
  '"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="99"',
  '"Chromium";v="139", "Google Chrome";v="139", "Not=A?Brand";v="99"',
] as const;

function pick<T>(values: readonly T[]): T {
  const roll = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return values[roll % values.length]!;
}

function isTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError';
}

function collectSetCookies(headers: Headers, jar: Map<string, string>): void {
  const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  const entries = typeof getSetCookie === 'function' ? getSetCookie.call(headers) : [headers.get('set-cookie')].filter((value): value is string => Boolean(value));
  for (const entry of entries) {
    const pair = entry.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
}

function extractCsrfToken(html: string): string | null {
  const input =
    /<input\b[^>]*\bname=["']_csrf["'][^>]*\bvalue=["']([^"']+)["']/i.exec(html) ??
    /<input\b[^>]*\bvalue=["']([^"']+)["'][^>]*\bname=["']_csrf["']/i.exec(html);
  if (input?.[1]) return input[1];
  const meta =
    /<meta\b[^>]*\bname=["']csrf-token["'][^>]*\bcontent=["']([^"']+)["']/i.exec(html) ??
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']csrf-token["']/i.exec(html);
  return meta?.[1] ?? null;
}

interface CsrfSession {
  token: string;
  cookieHeader: string;
}

// The cookie jar lives only for this call: page response cookies and the hidden
// `_csrf` input always come from the same page fetch, keeping the pair matched.
async function fetchCsrfSession(nid: PresenceNid): Promise<CsrfSession | null> {
  const jar = new Map<string, string>();
  const userAgent = pick(USER_AGENTS);
  let url = `${UPSTREAM_ORIGIN}/?r=pc/index&nid=${nid}`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers: Record<string, string> = {
      'user-agent': userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8',
      'accept-language': pick(ACCEPT_LANGUAGES),
      'sec-ch-ua': pick(SEC_CH_UA),
    };
    if (jar.size > 0) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cf: { cacheTtl: 0 },
    });
    collectSetCookies(response.headers, jar);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      url = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) return null;
    const token = extractCsrfToken(await response.text());
    if (!token) return null;
    return { token, cookieHeader: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') };
  }
  return null;
}

function fail(code: string, status: number, id: string): Response {
  return new Response(JSON.stringify({ ok: false, error: code, request_id: id }), { status, headers: JSON_HEADERS });
}

export function registerPresenceRoute(app: Hono<any>): void {
  app.options(ROUTE_PATH, () => new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'access-control-max-age': '86400',
    },
  }));

  app.post(ROUTE_PATH, async (c) => {
    const id = requestId(c.req.raw);
    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return fail('invalid_request', 413, id);
    }
    // Content-Length can be absent (chunked/test clients); enforce on the actual body too.
    const bodyText = await c.req.text().catch(() => null);
    if (bodyText === null) return fail('invalid_request', 400, id);
    if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
      return fail('invalid_request', 413, id);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      return fail('invalid_request', 400, id);
    }
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!record) return fail('invalid_request', 400, id);

    const action = record.action;
    if (action !== 'check' && action !== 'checkin') return fail('unsupported_action', 400, id);

    const nidValue = typeof record.nid === 'string' && record.nid.trim() !== '' ? Number(record.nid) : record.nid;
    if (typeof nidValue !== 'number' || !Number.isInteger(nidValue) || !(nidValue in FORM_NAMES)) return fail('unsupported_nid', 400, id);
    const nid = nidValue as PresenceNid;

    const userid = typeof record.userid === 'string' ? record.userid.trim() : '';
    const userPass = typeof record.user_pass === 'string' ? record.user_pass : '';
    if (!userid || userid.length > MAX_CREDENTIAL_LENGTH || !userPass || userPass.length > MAX_CREDENTIAL_LENGTH) {
      return fail('invalid_request', 400, id);
    }

    // Never log userid/user_pass/csrf/cookie — error context carries ids only.
    let session: CsrfSession | null;
    try {
      session = await fetchCsrfSession(nid);
    } catch (error) {
      logError('lastroweb.presence_csrf_error', error, { request_id: id, nid, action });
      return fail(isTimeout(error) ? 'upstream_timeout' : 'csrf_fetch_failed', isTimeout(error) ? 504 : 502, id);
    }
    if (!session) {
      logError('lastroweb.presence_csrf_missing', new Error('csrf token not found in upstream page'), { request_id: id, nid, action });
      return fail('csrf_fetch_failed', 502, id);
    }

    const formName = FORM_NAMES[nid];
    const form = new URLSearchParams();
    form.set('_csrf', session.token);
    form.set(`${formName}[userid]`, userid);
    form.set(`${formName}[user_pass]`, userPass);

    let upstream: Response;
    try {
      upstream = await fetch(`${UPSTREAM_ORIGIN}/?r=mg/${action}&nid=${nid}`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          'accept-language': pick(ACCEPT_LANGUAGES),
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          cookie: session.cookieHeader,
          origin: UPSTREAM_ORIGIN,
          referer: UPSTREAM_REFERER,
          'sec-ch-ua': pick(SEC_CH_UA),
          'user-agent': pick(USER_AGENTS),
          'x-requested-with': 'XMLHttpRequest',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        cf: { cacheTtl: 0 },
      });
    } catch (error) {
      logError('lastroweb.presence_upstream_error', error, { request_id: id, nid, action });
      return fail(isTimeout(error) ? 'upstream_timeout' : 'upstream_request_failed', isTimeout(error) ? 504 : 502, id);
    }

    if (!upstream.ok) {
      logError('lastroweb.presence_upstream_status', new Error(`upstream status ${upstream.status}`), { request_id: id, nid, action, upstream_status: upstream.status });
      await upstream.body?.cancel();
      return fail('upstream_request_failed', 502, id);
    }
    await upstream.body?.cancel();
    return new Response(JSON.stringify({ ok: true, action, nid }), { status: 200, headers: JSON_HEADERS });
  });
}
