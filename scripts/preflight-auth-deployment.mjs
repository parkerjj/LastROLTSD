import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const KEY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/u;
const MAILBOX_PATTERN = /^(?:[^<>\r\n]{1,120}\s+)?<[^<>\s@]+@[^<>\s@]+>$|^[^<>\s@]+@[^<>\s@]+$/u;

/** @typedef {Record<string, string | undefined>} AuthDeploymentPreflightInput */

/**
 * Returns only a deployment decision and redacted reason codes. Secret values and
 * address/site values are never copied to the result or logged.
 *
 * @param {AuthDeploymentPreflightInput} input
 * @returns {{enabled: boolean; reasonCodes: string[]}}
 */
export function resolveAuthDeploymentPreflight(input) {
  if (input.requestedEnabled !== 'true') return { enabled: false, reasonCodes: [] };

  const reasonCodes = [];
  const addReason = (reason) => {
    if (!reasonCodes.includes(reason)) reasonCodes.push(reason);
  };

  const requiredSecrets = [
    input.passwordSecret,
    input.csrfSecret,
    input.rateSecret,
    input.mailPayloadSecret,
    input.resendApiKey,
  ];
  if (requiredSecrets.some((value) => !hasValue(value))) addReason('MISSING_REQUIRED_SECRET');
  if (requiredSecrets.slice(0, 4).some((value) => !isCanonicalSecret(value))) addReason('INVALID_CORE_SECRET');
  if (hasValue(input.resendApiKey)
    && (input.resendApiKey.length > 512 || /\s/u.test(input.resendApiKey))) addReason('INVALID_RESEND_API_KEY');

  const passwordVersion = input.passwordKeyVersion || '1';
  const mailPayloadVersion = input.mailPayloadKeyVersion || '1';
  if (!isKeyVersion(passwordVersion)) addReason('INVALID_PASSWORD_KEY_VERSION');
  if (!isKeyVersion(mailPayloadVersion)) addReason('INVALID_MAIL_PAYLOAD_KEY_VERSION');

  const keyMaterial = [...requiredSecrets.slice(0, 4)];
  validatePreviousKeyPair(
    'PASSWORD', passwordVersion, input.passwordPreviousKeyVersion, input.passwordPreviousSecret, keyMaterial, addReason,
  );
  validatePreviousKeyPair(
    'MAIL_PAYLOAD', mailPayloadVersion, input.mailPayloadPreviousKeyVersion, input.mailPayloadPreviousSecret, keyMaterial, addReason,
  );
  const validKeyMaterial = keyMaterial.filter(isCanonicalSecret);
  if (new Set(validKeyMaterial).size !== validKeyMaterial.length) addReason('DUPLICATE_SECRET_MATERIAL');

  if (!isTrustedHttpsOrigin(input.authSiteUrl)) addReason('INVALID_AUTH_SITE_URL');
  if (!isPublicMailbox(input.mailFrom)) addReason('INVALID_MAIL_FROM');
  if (hasValue(input.mailReplyTo) && !isPublicMailbox(input.mailReplyTo)) addReason('INVALID_MAIL_REPLY_TO');
  if (!isMailLimit(input.mailDailyLimit, 100) || !isMailLimit(input.mailMonthlyLimit, 3_000)) {
    addReason('INVALID_MAIL_LIMIT');
  }

  return { enabled: reasonCodes.length === 0, reasonCodes };
}

function hasValue(value) {
  return typeof value === 'string' && value.length > 0;
}

function isCanonicalSecret(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.byteLength === 32 && bytes.toString('base64') === value;
  } catch {
    return false;
  }
}

function isKeyVersion(value) {
  return typeof value === 'string' && KEY_VERSION_PATTERN.test(value);
}

function validatePreviousKeyPair(label, currentVersion, previousVersion, previousSecret, keyMaterial, addReason) {
  const hasVersion = hasValue(previousVersion);
  const hasSecret = hasValue(previousSecret);
  if (hasVersion !== hasSecret) {
    addReason(`INCOMPLETE_${label}_PREVIOUS_KEY_PAIR`);
    return;
  }
  if (!hasVersion) return;
  if (!isKeyVersion(previousVersion)) addReason(`INVALID_${label}_PREVIOUS_KEY_VERSION`);
  if (previousVersion === currentVersion) addReason(`SAME_${label}_PREVIOUS_KEY_VERSION`);
  if (!isCanonicalSecret(previousSecret)) addReason(`INVALID_${label}_PREVIOUS_SECRET`);
  else keyMaterial.push(previousSecret);
}

function isTrustedHttpsOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && url.pathname === '/'
      && !url.search
      && !url.hash
      && isPublicDomain(url.hostname);
  } catch {
    return false;
  }
}

function isPublicMailbox(value) {
  if (typeof value !== 'string' || value.length > 320 || !MAILBOX_PATTERN.test(value)) return false;
  const bracketed = /<([^<>]+)>$/u.exec(value);
  const address = bracketed?.[1] ?? value;
  const at = address.lastIndexOf('@');
  return at > 0 && isPublicDomain(address.slice(at + 1));
}

function isPublicDomain(value) {
  const host = value.toLowerCase().replace(/\.$/u, '');
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost')
    || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.length > 253) return false;
  if (host === 'invalid' || host.endsWith('.invalid') || host === 'test' || host.endsWith('.test')
    || host === 'example' || host.endsWith('.example')) return false;
  if (['example.com', 'example.net', 'example.org'].some((domain) => host === domain || host.endsWith(`.${domain}`))) return false;
  return host.split('.').every((label) => label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label));
}

function isMailLimit(value, maximum) {
  if (value === undefined || value === '') return true;
  if (!/^[1-9]\d*$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum;
}

function environmentInput(env) {
  return {
    requestedEnabled: env.AUTH_ENABLED_REQUEST,
    authSiteUrl: env.AUTH_SITE_URL,
    mailFrom: env.MAIL_FROM,
    mailReplyTo: env.MAIL_REPLY_TO,
    passwordSecret: env.AUTH_PASSWORD_SECRET,
    csrfSecret: env.AUTH_CSRF_SECRET,
    rateSecret: env.AUTH_RATE_SECRET,
    mailPayloadSecret: env.AUTH_MAIL_PAYLOAD_SECRET,
    resendApiKey: env.RESEND_API_KEY,
    passwordKeyVersion: env.AUTH_PASSWORD_KEY_VERSION,
    mailPayloadKeyVersion: env.AUTH_MAIL_PAYLOAD_KEY_VERSION,
    passwordPreviousKeyVersion: env.AUTH_PASSWORD_PREVIOUS_KEY_VERSION,
    passwordPreviousSecret: env.AUTH_PASSWORD_PREVIOUS_SECRET,
    mailPayloadPreviousKeyVersion: env.AUTH_MAIL_PAYLOAD_PREVIOUS_KEY_VERSION,
    mailPayloadPreviousSecret: env.AUTH_MAIL_PAYLOAD_PREVIOUS_SECRET,
    mailDailyLimit: env.AUTH_MAIL_DAILY_LIMIT,
    mailMonthlyLimit: env.AUTH_MAIL_MONTHLY_LIMIT,
  };
}

function runCli() {
  const input = environmentInput(process.env);
  const result = resolveAuthDeploymentPreflight(input);
  const reasonCodes = result.reasonCodes.join(',');
  const output = `enabled=${String(result.enabled)}\nreason_codes=${reasonCodes}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
  if (input.requestedEnabled === 'true' && !result.enabled) {
    process.stdout.write(`::warning::Production account auth remains disabled by preflight (${reasonCodes})\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) runCli();
