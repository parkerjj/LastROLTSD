import { AuthFailure } from './types';

const LOCAL_PART_CHARACTER = /^[A-Za-z0-9!#$%&'*+/=?^_\x60{|}~-]+$/u;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

function invalid(code: string, publicMessage: string): AuthFailure {
  return new AuthFailure(code, 400, publicMessage);
}

function containsEmailControlOrLineSeparator(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029) return true;
  }
  return false;
}

export function normalizeEmail(value: string): { delivery: string; normalized: string } {
  if (typeof value !== 'string' || containsEmailControlOrLineSeparator(value)) {
    throw invalid('INVALID_EMAIL', '请输入有效的 Email 地址');
  }

  const trimmed = value.trim();
  const separator = trimmed.indexOf('@');
  if (separator <= 0 || separator !== trimmed.lastIndexOf('@')) {
    throw invalid('INVALID_EMAIL', '请输入有效的 Email 地址');
  }

  const localPart = trimmed.slice(0, separator);
  const rawDomain = trimmed.slice(separator + 1);
  const localSegments = localPart.split('.');
  if (localPart.length > 64 || localSegments.some((segment) => !LOCAL_PART_CHARACTER.test(segment))) {
    throw invalid('INVALID_EMAIL', '请输入有效的 Email 地址');
  }
  if (!rawDomain || /[\s@:?#\\]/u.test(rawDomain) || rawDomain.includes('/') || rawDomain.includes('[') || rawDomain.includes(']') || rawDomain.includes('%')) {
    throw invalid('INVALID_EMAIL', '请输入有效的 Email 地址');
  }

  let asciiDomain: string;
  try {
    asciiDomain = new URL(`http://${rawDomain}`).hostname.toLowerCase();
  } catch {
    throw invalid('INVALID_EMAIL', '请输入有效的 Email 地址');
  }

  const labels = asciiDomain.split('.');
  if (asciiDomain.length > 253 || labels.length < 2 || labels.some((label) => label.length > 63 || !DOMAIN_LABEL.test(label))
    || /^\d+(?:\.\d+){3}$/u.test(asciiDomain)) {
    throw invalid('INVALID_EMAIL', '请输入有效的 Email 地址');
  }

  const delivery = `${localPart}@${asciiDomain}`;
  if (delivery.length > 254) throw invalid('INVALID_EMAIL', '请输入有效的 Email 地址');
  return { delivery, normalized: `${localPart.toLowerCase()}@${asciiDomain}` };
}

export function parseDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw invalid('INVALID_DISPLAY_NAME', '昵称长度需为 1 到 32 个字符');
  const displayName = value.trim();
  const codePoints = [...displayName].length;
  if (codePoints < 1 || codePoints > 32) throw invalid('INVALID_DISPLAY_NAME', '昵称长度需为 1 到 32 个字符');
  return displayName;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== 'string') throw invalid('INVALID_PASSWORD', '密码长度需为 5 到 256 个字符');
  let codePoints = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw invalid('INVALID_PASSWORD', '密码格式无效');
    codePoints += 1;
  }
  if (codePoints < 5 || codePoints > 256) throw invalid('INVALID_PASSWORD', '密码长度需为 5 到 256 个字符');
  return value;
}

export function validatePasswordConfirmation(passwordValue: unknown, confirmationValue: unknown): string {
  const password = validatePassword(passwordValue);
  if (typeof confirmationValue !== 'string' || password !== confirmationValue) {
    throw invalid('PASSWORD_CONFIRMATION_MISMATCH', '密码确认不一致');
  }
  return password;
}
