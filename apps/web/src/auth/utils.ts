import { AuthApiError } from './api';
import type { AuthAcceptedResponse, MailAvailability } from './types';

export function parseDisplayName(value: string): string | null {
  const name = value.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= 32 ? name : null;
}

export function validatePassword(value: string): string | null {
  const length = Array.from(value).length;
  if (length < 5 || length > 256) return '密码长度需为 5–256 个字符。';
  return null;
}

export function authErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AuthApiError && error.status === 401) return '登录状态已失效，请重新登录。';
  if (error instanceof AuthApiError && error.status === 503) return '账号服务暂不可用，请重试。';
  return error instanceof Error ? error.message : fallback;
}

export function acceptedMessage(response: AuthAcceptedResponse, purpose: 'register' | 'verify' | 'reset'): string {
  const base = purpose === 'register'
    ? '申请已受理，正在等待发送。请检查邮箱；已有账号可以登录或申请密码重置。'
    : purpose === 'reset'
      ? '如果该邮箱对应可恢复的账号，申请已受理，正在等待发送。'
      : '已受理，正在等待发送。';
  const availability = formatMailAvailability(response.mail_availability, purpose);
  return availability ? `${base} ${availability}` : base;
}

export function formatMailAvailability(availability: MailAvailability, purpose: 'register' | 'verify' | 'reset'): string {
  if (availability.code === 'MAIL_DAILY_QUOTA') {
    const restoreTime = availability.retry_at === null ? '' : `预计当地恢复时间：${formatTimestamp(availability.retry_at)}。`;
    if (purpose === 'register') return `今天邮件发送数量已达到上限，请明天重新申请。${restoreTime}服务商日额度按 UTC 恢复。`;
    return purpose === 'verify'
      ? `今天发送邮件的数量已达到上限，请明天重新登录账号，再进行 Email 身份验证。${restoreTime}服务商日额度按 UTC 恢复。已收到的有效验证链接仍可使用。`
      : `今天发送邮件的数量已达到上限，请明天重新申请密码重置。${restoreTime}服务商日额度按 UTC 恢复。`;
  }
  if (availability.code === 'MAIL_MONTHLY_QUOTA') {
    return purpose === 'verify'
      ? '本月邮件发送额度已用完，请待额度恢复后重试。'
      : '本月邮件发送额度已用完，请待额度恢复后重试；额度恢复后重新申请密码重置。';
  }
  return '';
}

export function setText(root: ParentNode, selector: string, text: string): void {
  const element = root.querySelector<HTMLElement>(selector);
  if (element) element.textContent = text;
}

export function value(root: ParentNode, selector: string): string {
  return root.querySelector<HTMLInputElement>(selector)?.value ?? '';
}

export function clearPasswordFields(root: ParentNode): void {
  root.querySelectorAll<HTMLInputElement>('[data-password-input]').forEach((input) => {
    input.value = '';
    input.type = 'password';
    const toggle = input.parentElement?.querySelector<HTMLButtonElement>('[data-password-toggle]');
    if (toggle) {
      toggle.setAttribute('aria-pressed', 'false');
      toggle.setAttribute('aria-label', `显示${toggle.dataset.passwordLabel ?? '密码'}`);
      toggle.textContent = '显示';
    }
  });
}

export function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间暂不可用' : date.toLocaleString();
}

export function initials(displayName: string): string {
  return Array.from(displayName.trim())[0] ?? '用';
}
