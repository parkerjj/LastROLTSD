import { openMailPayload, sealMailPayload } from './crypto';
import { requireAuthConfig } from './config';
import type { MailFinishResult, MailRepository } from './repository';
import type {
  ActionPurpose,
  AuthConfig,
  AuthFailure,
  AuthRuntime,
  ClaimedMailJob,
  MailAttemptContext,
  MailPurpose,
  NewMailJob,
  SealedMailPayload,
  UserId,
} from './types';

const MAIL_LEASE_MILLISECONDS = 30_000;
const MAIL_HTTP_TIMEOUT_MILLISECONDS = 5_000;
const MAIL_MAX_BODY_BYTES = 8_192;
const MAIL_MAX_ATTEMPTS = 4;
const MAIL_IDEMPOTENCY_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAIL_RETRY_DELAYS = [60_000, 5 * 60_000, 15 * 60_000] as const;
const MAIL_PAUSE_RECHECK_MILLISECONDS = 5 * 60_000;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface ActionMailInput {
  mailId: string;
  actionDigest: Uint8Array;
  userId: UserId | null;
  email: string;
  displayName: string;
  token: string;
  purpose: ActionPurpose;
  createdAt: number;
  expiresAt: number;
}

export interface PasswordChangedMailInput {
  mailId: string;
  userId: UserId;
  email: string;
  displayName: string;
  createdAt: number;
}

interface MailIntent {
  kind: 'intent';
  to: string[];
  subject: string;
  html: string;
  text: string;
}

interface ResendEmailBody {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
}

type DecryptedMailPayload = { kind: 'intent'; value: MailIntent } | { kind: 'body'; value: ResendEmailBody; json: string };

function unavailableMailInput(): Error {
  return new Error('invalid account mail input');
}

function validMailId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function validMailRecipient(value: string): boolean {
  return value.length <= 320 && !/[\r\n]/u.test(value) && /^[^<>\s@]+@[^<>\s@]+$/u.test(value);
}

function validUserId(value: string): boolean {
  return /^\d{1,20}$/u.test(value);
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function createActionLink(config: AuthConfig, purpose: ActionPurpose, token: string): string {
  requireAuthConfig(config);
  const path = purpose === 'VERIFY_EMAIL' ? '/verify-email' : '/reset-password';
  const url = new URL(path, config.authSiteUrl);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

function actionIntent(input: ActionMailInput, config: AuthConfig): MailIntent {
  const nickname = escapeHtml(input.displayName);
  const link = createActionLink(config, input.purpose, input.token);
  const verify = input.purpose === 'VERIFY_EMAIL';
  const purposeText = verify ? '验证 LTSD 账号邮箱' : '重置 LTSD 账号密码';
  const lifetime = verify ? '24 小时' : '30 分钟';
  const subject = verify ? 'LTSD 邮箱验证' : 'LTSD 密码重置';
  const buttonText = verify ? '验证邮箱' : '重置密码';
  const html = `<!doctype html><html lang="zh-CN"><body><main><p>你好，${nickname}</p>`
    + `<p>请使用下面的链接${purposeText}。</p><p><a href="${escapeHtml(link)}">${buttonText}</a></p>`
    + `<p>此链接有效期为 ${lifetime}，只能使用一次。</p><p>如果按钮无法打开，请复制此地址：${escapeHtml(link)}</p>`
    + '<p>如果不是你发起的请求，请忽略这封邮件。</p><p>LTSD 账号系统</p></main></body></html>';
  const text = `你好，${input.displayName}\n\n请使用下面的链接${purposeText}：\n${link}\n\n`
    + `此链接有效期为 ${lifetime}，只能使用一次。\n如果不是你发起的请求，请忽略这封邮件。\nLTSD 账号系统`;
  return { kind: 'intent', to: [input.email], subject, html, text };
}

function passwordChangedIntent(input: PasswordChangedMailInput): MailIntent {
  const nickname = escapeHtml(input.displayName);
  const subject = 'LTSD 密码已修改通知';
  const html = `<!doctype html><html lang="zh-CN"><body><main><p>你好，${nickname}</p>`
    + '<p>你的 LTSD 账号密码已修改。</p><p>如果不是你本人操作，请尽快通过 LTSD 官方渠道联系支持。</p>'
    + '<p>这是一封安全通知，不包含授权登录或重置密码的链接。</p><p>LTSD 账号系统</p></main></body></html>';
  const text = `你好，${input.displayName}\n\n你的 LTSD 账号密码已修改。\n`
    + '如果不是你本人操作，请尽快通过 LTSD 官方渠道联系支持。\n'
    + '这是一封安全通知，不包含授权登录或重置密码的链接。\nLTSD 账号系统';
  return { kind: 'intent', to: [input.email], subject, html, text };
}

async function sealIntent(mailId: string, purpose: MailPurpose, intent: MailIntent, config: AuthConfig): Promise<SealedMailPayload> {
  return sealMailPayload(JSON.stringify(intent), { mailId, purpose }, config);
}

export async function prepareActionMail(input: ActionMailInput, config: AuthConfig): Promise<NewMailJob> {
  requireAuthConfig(config);
  if (!validMailId(input.mailId) || (input.userId !== null && !validUserId(input.userId))
    || !(input.actionDigest instanceof Uint8Array) || input.actionDigest.byteLength !== 32
    || !validMailRecipient(input.email) || typeof input.displayName !== 'string'
    || input.displayName.length > 256 || !/^[A-Za-z0-9_-]{43}$/u.test(input.token)
    || (input.purpose !== 'VERIFY_EMAIL' && input.purpose !== 'RESET_PASSWORD')
    || !validTime(input.createdAt) || !validTime(input.expiresAt) || input.expiresAt <= input.createdAt) {
    throw unavailableMailInput();
  }
  const sealed = await sealIntent(input.mailId, input.purpose, actionIntent(input, config), config);
  return {
    ...sealed,
    id: input.mailId,
    actionDigest: new Uint8Array(input.actionDigest),
    userId: input.userId,
    purpose: input.purpose,
    priority: 1,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
}

export async function preparePasswordChangedMail(input: PasswordChangedMailInput, config: AuthConfig): Promise<NewMailJob> {
  requireAuthConfig(config);
  if (!validMailId(input.mailId) || !validUserId(input.userId) || !validMailRecipient(input.email)
    || typeof input.displayName !== 'string' || input.displayName.length > 256 || !validTime(input.createdAt)) {
    throw unavailableMailInput();
  }
  const expiresAt = input.createdAt + MAIL_IDEMPOTENCY_WINDOW_MILLISECONDS;
  if (!validTime(expiresAt)) throw unavailableMailInput();
  const sealed = await sealIntent(input.mailId, 'PASSWORD_CHANGED', passwordChangedIntent(input), config);
  return {
    ...sealed,
    id: input.mailId,
    actionDigest: null,
    userId: input.userId,
    purpose: 'PASSWORD_CHANGED',
    priority: 0,
    createdAt: input.createdAt,
    expiresAt,
  };
}

function currentTime(value: number): number {
  if (!validTime(value)) throw new Error('invalid auth mail timestamp');
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMailIntent(value: unknown): value is MailIntent {
  return isObject(value) && value.kind === 'intent'
    && Array.isArray(value.to) && value.to.length === 1 && typeof value.to[0] === 'string'
    && typeof value.subject === 'string' && typeof value.html === 'string' && typeof value.text === 'string';
}

function isResendEmailBody(value: unknown): value is ResendEmailBody {
  return isObject(value) && typeof value.from === 'string'
    && Array.isArray(value.to) && value.to.length === 1 && typeof value.to[0] === 'string'
    && typeof value.subject === 'string' && typeof value.html === 'string' && typeof value.text === 'string'
    && (value.reply_to === undefined || typeof value.reply_to === 'string');
}

function decryptPayload(plaintext: string): DecryptedMailPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(plaintext) as unknown;
  } catch {
    return null;
  }
  if (isMailIntent(value)) return { kind: 'intent', value };
  if (isResendEmailBody(value)) return { kind: 'body', value, json: plaintext };
  return null;
}

function authFailureCode(error: unknown): string | null {
  return error !== null && typeof error === 'object' && typeof (error as AuthFailure).code === 'string'
    ? (error as AuthFailure).code
    : null;
}

function isMailKeyUnavailable(error: unknown): boolean {
  return authFailureCode(error) === 'MAIL_PAYLOAD_KEY_UNAVAILABLE';
}

function buildResendBody(intent: MailIntent, from: string, replyTo: string | null): ResendEmailBody {
  return {
    from,
    to: [...intent.to],
    subject: intent.subject,
    html: intent.html,
    text: intent.text,
    ...(replyTo ? { reply_to: replyTo } : {}),
  };
}

function delayForRetry(attemptNumber: number, retryAfter: string | null, now: number): number {
  const defaultDelay = MAIL_RETRY_DELAYS[Math.min(attemptNumber - 1, MAIL_RETRY_DELAYS.length - 1)]!;
  if (retryAfter === null) return defaultDelay;
  const seconds = Number(retryAfter);
  const requestedDelay = Number.isFinite(seconds) && seconds > 0
    ? seconds * 1_000
    : Date.parse(retryAfter) - now;
  if (!Number.isFinite(requestedDelay) || requestedDelay <= 0) return defaultDelay;
  return Math.min(MAIL_RETRY_DELAYS[MAIL_RETRY_DELAYS.length - 1]!, Math.max(defaultDelay, requestedDelay));
}

function resendErrorName(body: string | null): string | null {
  if (body === null) return null;
  try {
    const value: unknown = JSON.parse(body);
    if (!isObject(value)) return null;
    if (typeof value.name === 'string') return value.name;
    if (isObject(value.error) && typeof value.error.name === 'string') return value.error.name;
    return null;
  } catch {
    return null;
  }
}

async function readBoundedResponseBody(response: Response): Promise<string | null> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAIL_MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    totalBytes += part.value.byteLength;
    if (totalBytes > MAIL_MAX_BODY_BYTES) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function postResend(
  fetcher: typeof globalThis.fetch,
  apiKey: string,
  mailId: string,
  body: string,
): Promise<{ response: Response; text: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAIL_HTTP_TIMEOUT_MILLISECONDS);
  try {
    const response = await fetcher(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `ltsd-auth/${mailId}`,
      },
      body,
      signal: controller.signal,
    });
    return { response, text: await readBoundedResponseBody(response) };
  } finally {
    clearTimeout(timeout);
  }
}

function retryResult(errorCode: string, attemptNumber: number, retryAfter: string | null, now: number): MailFinishResult {
  return {
    status: 'retry',
    errorCode,
    nextAttemptAt: now + delayForRetry(attemptNumber, retryAfter, now),
    observedAt: now,
  };
}

async function applyFinish(
  repository: MailRepository,
  job: ClaimedMailJob,
  result: MailFinishResult,
): Promise<boolean> {
  return repository.finishMail(job.id, job.leaseId, result);
}

export function createMailDispatcher(repository: MailRepository, config: AuthConfig, runtime: AuthRuntime) {
  return {
    async sendOne(now: number): Promise<'sent' | 'idle' | 'retry' | 'paused' | 'failed'> {
      if (!config.enabled) return 'paused';
      const apiKey = config.mailDelivery?.apiKey;
      if (!apiKey) return 'paused';
      const requestedAt = currentTime(now);
      const availability = await repository.readMailAvailability(requestedAt);
      if (availability.code !== 'AVAILABLE') return 'paused';

      const job = await repository.claimOneMail(requestedAt, MAIL_LEASE_MILLISECONDS);
      if (!job) {
        const latestAvailability = await repository.readMailAvailability(currentTime(runtime.now()));
        return latestAvailability.code === 'AVAILABLE' ? 'idle' : 'paused';
      }

      const context = { mailId: job.id, purpose: job.purpose };
      let plaintext: string;
      try {
        plaintext = await openMailPayload(job, context, config);
      } catch (error) {
        const observedAt = currentTime(runtime.now());
        if (isMailKeyUnavailable(error)) {
          const finished = await applyFinish(repository, job, {
            status: 'paused', errorCode: 'MAIL_PAYLOAD_KEY_UNAVAILABLE',
            nextAttemptAt: Math.min(job.expiresAt, observedAt + MAIL_PAUSE_RECHECK_MILLISECONDS), observedAt,
          });
          return finished ? 'paused' : 'retry';
        }
        const finished = await applyFinish(repository, job, { status: 'failed', errorCode: 'MAIL_PAYLOAD_UNREADABLE', observedAt });
        return finished ? 'failed' : 'retry';
      }

      const decrypted = decryptPayload(plaintext);
      if (!decrypted) {
        const observedAt = currentTime(runtime.now());
        const finished = await applyFinish(repository, job, { status: 'failed', errorCode: 'MAIL_PAYLOAD_UNREADABLE', observedAt });
        return finished ? 'failed' : 'retry';
      }

      let body: string;
      if (decrypted.kind === 'body') {
        body = decrypted.json;
      } else {
        const from = config.mailDelivery?.from;
        if (!from) {
          const observedAt = currentTime(runtime.now());
          const finished = await applyFinish(repository, job, {
            status: 'paused', errorCode: 'MAIL_SENDER_UNCONFIGURED',
            nextAttemptAt: Math.min(job.expiresAt, observedAt + MAIL_PAUSE_RECHECK_MILLISECONDS), observedAt,
          });
          return finished ? 'paused' : 'retry';
        }
        body = JSON.stringify(buildResendBody(decrypted.value, from, config.mailDelivery?.replyTo ?? null));
        if (new TextEncoder().encode(body).byteLength > MAIL_MAX_BODY_BYTES) {
          const observedAt = currentTime(runtime.now());
          const finished = await applyFinish(repository, job, { status: 'failed', errorCode: 'MAIL_BODY_TOO_LARGE', observedAt });
          return finished ? 'failed' : 'retry';
        }
        let frozen: SealedMailPayload;
        try {
          frozen = await sealMailPayload(body, context, config);
        } catch {
          const observedAt = currentTime(runtime.now());
          const finished = await applyFinish(repository, job, {
            status: 'paused', errorCode: 'MAIL_PAYLOAD_SEAL_FAILED',
            nextAttemptAt: Math.min(job.expiresAt, observedAt + MAIL_PAUSE_RECHECK_MILLISECONDS), observedAt,
          });
          return finished ? 'paused' : 'retry';
        }
        const frozenAt = currentTime(runtime.now());
        if (!await repository.freezeMailPayload(job.id, job.leaseId, job, frozen, frozenAt)) return 'retry';
      }

      if (new TextEncoder().encode(body).byteLength > MAIL_MAX_BODY_BYTES) {
        const observedAt = currentTime(runtime.now());
        const finished = await applyFinish(repository, job, { status: 'failed', errorCode: 'MAIL_BODY_TOO_LARGE', observedAt });
        return finished ? 'failed' : 'retry';
      }

      const reservation = await repository.reserveMailAttempt(job.id, job.leaseId, () => runtime.now());
      if (reservation.status === 'quota') return 'paused';
      if (reservation.status === 'exhausted') return 'failed';
      if (reservation.status === 'stale') {
        const observedAt = currentTime(runtime.now());
        await applyFinish(repository, job, { status: 'release', observedAt });
        return 'retry';
      }
      if (reservation.status !== 'reserved') return 'paused';

      const attemptNumber = job.attemptCount + 1;
      let response: Response;
      let responseText: string | null;
      try {
        ({ response, text: responseText } = await postResend(runtime.fetch, apiKey, job.id, body));
      } catch (error) {
        const observedAt = currentTime(runtime.now());
        const code = error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
          ? 'MAIL_TIMEOUT'
          : 'MAIL_NETWORK_ERROR';
        const result = retryResult(code, attemptNumber, null, observedAt);
        const finished = await applyFinish(repository, job, result);
        return finished && attemptNumber >= MAIL_MAX_ATTEMPTS ? 'failed' : 'retry';
      }

      const observedAt = currentTime(runtime.now());
      if (response.status >= 200 && response.status < 300) {
        let providerMessageId: string | null = null;
        if (responseText !== null) {
          try {
            const result: unknown = JSON.parse(responseText);
            if (isObject(result) && typeof result.id === 'string'
              && result.id.length > 0 && result.id.length <= 191 && !/[\r\n]/u.test(result.id)) providerMessageId = result.id;
          } catch {
            providerMessageId = null;
          }
        }
        if (!providerMessageId) {
          const finished = await applyFinish(repository, job, retryResult('MAIL_PROVIDER_RESPONSE_UNKNOWN', attemptNumber, null, observedAt));
          return finished && attemptNumber >= MAIL_MAX_ATTEMPTS ? 'failed' : 'retry';
        }
        const finished = await applyFinish(repository, job, { status: 'sent', providerMessageId, observedAt });
        return finished ? 'sent' : 'retry';
      }

      const errorName = resendErrorName(responseText);
      if (response.status === 429 && errorName === 'daily_quota_exceeded') {
        await repository.recordProviderQuota(job.id, job.leaseId, 'daily', reservation.attempt, observedAt);
        return 'paused';
      }
      if (response.status === 429 && errorName === 'monthly_quota_exceeded') {
        await repository.recordProviderQuota(job.id, job.leaseId, 'monthly', reservation.attempt, observedAt);
        return 'paused';
      }
      if (response.status === 429 && errorName === 'rate_limit_exceeded') {
        const result = retryResult('MAIL_RATE_LIMIT', attemptNumber, response.headers.get('retry-after'), observedAt);
        const finished = await applyFinish(repository, job, result);
        return finished && attemptNumber >= MAIL_MAX_ATTEMPTS ? 'failed' : 'retry';
      }
      if (response.status === 409 && errorName === 'concurrent_idempotent_requests') {
        const finished = await applyFinish(repository, job, retryResult('MAIL_IDEMPOTENCY_CONCURRENT', attemptNumber, null, observedAt));
        return finished && attemptNumber >= MAIL_MAX_ATTEMPTS ? 'failed' : 'retry';
      }
      if (response.status === 409 && errorName === 'invalid_idempotent_request') {
        const finished = await applyFinish(repository, job, { status: 'failed', errorCode: 'MAIL_IDEMPOTENCY_INVALID', observedAt });
        return finished ? 'failed' : 'retry';
      }
      if (response.status === 401 || response.status === 403) {
        const finished = await applyFinish(repository, job, {
          status: 'paused', errorCode: 'MAIL_PROVIDER_AUTH', nextAttemptAt: job.expiresAt, observedAt,
        });
        return finished ? 'paused' : 'retry';
      }
      if (response.status >= 500 && response.status <= 599) {
        const finished = await applyFinish(repository, job, retryResult('MAIL_PROVIDER_SERVER_ERROR', attemptNumber, null, observedAt));
        return finished && attemptNumber >= MAIL_MAX_ATTEMPTS ? 'failed' : 'retry';
      }

      const finished = await applyFinish(repository, job, {
        status: 'failed', errorCode: response.status === 429 ? 'MAIL_PROVIDER_429_UNKNOWN' : 'MAIL_PROVIDER_REJECTED', observedAt,
      });
      return finished ? 'failed' : 'retry';
    },
  };
}
