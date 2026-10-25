import type { Hono } from 'hono';
import { jsonError, requestId } from '../middleware/errors';
import { logError } from '../observability';

const UPSTREAM_ORIGIN = 'https://game.lastro.cn';
const MAX_BODY_BYTES = 4 * 1024;
const MAX_CREDENTIAL_LENGTH = 64;
const UPSTREAM_TIMEOUT_MS = 10_000;

// 官方监控接口按服务器 nid 区分，登录表单字段前缀需与官网一致：
// 三转（V6-Online）→ Login_cn2，进阶二转（V6-Eden）→ Login_debug，App 服（V6-APP）沿用 Login_debug。
const SERVER_FORM_PREFIX = {
  3: 'Login_cn2',
  5: 'Login_debug',
  6: 'Login_debug',
} as const;
type ServerNid = keyof typeof SERVER_FORM_PREFIX;
const DEFAULT_SERVER_NID: ServerNid = 5;

export function registerLastroAccountRoute(app: Hono<any>): void {
  app.post('/api/v1/lastro/account-status', async (c) => {
    const id = requestId(c.req.raw);
    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return jsonError('payload_too_large', 'Request body exceeds 4 KiB', 413, id);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return jsonError('bad_request', 'Request body must be valid JSON', 400, id);
    }
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const userid = typeof record?.userid === 'string' ? record.userid.trim() : '';
    const userPass = typeof record?.user_pass === 'string' ? record.user_pass : '';
    if (!userid || userid.length > MAX_CREDENTIAL_LENGTH || !userPass || userPass.length > MAX_CREDENTIAL_LENGTH) {
      return jsonError('bad_request', '账号或密码格式不正确', 400, id);
    }

    const rawNid = record?.nid;
    const nidValue =
      rawNid === undefined || rawNid === null || (typeof rawNid === 'string' && rawNid.trim() === '')
        ? DEFAULT_SERVER_NID
        : typeof rawNid === 'string'
          ? Number(rawNid.trim())
          : rawNid;
    if (typeof nidValue !== 'number' || !Number.isInteger(nidValue) || !(nidValue in SERVER_FORM_PREFIX)) {
      return jsonError('bad_request', '不支持的游戏服务器', 400, id);
    }
    const nid = nidValue as ServerNid;

    const form = new URLSearchParams();
    form.set(`${SERVER_FORM_PREFIX[nid]}[userid]`, userid);
    form.set(`${SERVER_FORM_PREFIX[nid]}[user_pass]`, userPass);

    let upstreamText: string;
    try {
      const upstream = await fetch(`${UPSTREAM_ORIGIN}/?r=mn/search&nid=${nid}`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!upstream.ok) {
        logError('lastroweb.lastro_account_upstream_status', new Error(`upstream status ${upstream.status}`), { request_id: id });
        return jsonError('upstream_unavailable', 'LastRO 官方接口暂时不可用，请稍后再试', 502, id, { retryable: true });
      }
      upstreamText = await upstream.text();
    } catch (error) {
      logError('lastroweb.lastro_account_upstream_error', error, { request_id: id });
      return jsonError('upstream_unavailable', '无法连接 LastRO 官方服务器，请稍后再试', 502, id, { retryable: true });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(upstreamText);
    } catch {
      return jsonError('upstream_unavailable', 'LastRO 官方接口返回异常，请稍后再试', 502, id, { retryable: true });
    }

    if (payload === 1) return c.json({ state: 'auth_failed' }, 200, { 'cache-control': 'no-store' });
    if (payload === 2) return c.json({ state: 'offline' }, 200, { 'cache-control': 'no-store' });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonError('upstream_unavailable', 'LastRO 官方接口返回异常，请稍后再试', 502, id, { retryable: true });
    }
    return c.json({ state: 'online', data: payload }, 200, { 'cache-control': 'no-store' });
  });
}
