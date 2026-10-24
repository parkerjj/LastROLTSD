import { createWorkerDatabase } from '../db/mysql-connection';
import { mysqlErrorContext } from '../db/mysql-error-context';
import type { AppEnv } from '../env';
import { logError } from '../observability';
import { resolveAuthConfig } from './config';
import { createMailDispatcher } from './mail';
import { createAuthRepository } from './repository';
import type { AuthRuntime } from './types';

/**
 * The outbox stays the source of truth. A wake message only tells a consumer to look
 * at it now instead of waiting for the two-minute Cron tick, so it carries no mail data.
 */
export interface MailWakeMessage { kind: 'auth_mail_wake' }
export const MAIL_WAKE_MESSAGE: MailWakeMessage = { kind: 'auth_mail_wake' };

/** One wake sends a short burst at most; a larger backlog is left to further wakes and Cron. */
export const MAIL_WAKE_MAX_SENDS = 5;
const MAIL_WAKE_RETRY_DELAY_SECONDS = 30;

export interface MailWakeQueue { send(message: MailWakeMessage): Promise<void> }

export interface MailWakeQueueMessage { body: unknown; ack(): void; retry(options?: { delaySeconds?: number }): void }

type MailSendOutcome = 'sent' | 'idle' | 'retry' | 'paused' | 'failed';

export function isMailWakeMessage(value: unknown): value is MailWakeMessage {
  return value !== null && typeof value === 'object' && (value as Record<string, unknown>).kind === MAIL_WAKE_MESSAGE.kind;
}

/**
 * Builds the fire-and-forget callback services invoke after the outbox transaction commits.
 * It never throws and never delays the response: a lost wake only means Cron sends the mail.
 */
export function createMailWake(
  queue: MailWakeQueue | undefined,
  waitUntil?: (promise: Promise<unknown>) => void,
): (() => void) | undefined {
  if (!queue) return undefined;
  return () => {
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(queue.send(MAIL_WAKE_MESSAGE));
    } catch (error) {
      logError('lastroweb.auth_mail_wake_enqueue_failed', error);
      return;
    }
    const settled = pending.catch((error: unknown) => {
      logError('lastroweb.auth_mail_wake_enqueue_failed', error);
    });
    waitUntil?.(settled);
  };
}

/** Sends ready mail until the outbox is idle, a send does not complete, or the burst cap is reached. */
export async function drainMail(
  sendOne: (now: number) => Promise<MailSendOutcome>,
  now: () => number,
  maxSends = MAIL_WAKE_MAX_SENDS,
): Promise<MailSendOutcome[]> {
  const outcomes: MailSendOutcome[] = [];
  while (outcomes.length < maxSends) {
    const outcome = await sendOne(now());
    outcomes.push(outcome);
    if (outcome !== 'sent') break;
  }
  return outcomes;
}

export async function consumeMailWakeBatch(
  messages: readonly MailWakeQueueMessage[],
  env: AppEnv,
  runtime: AuthRuntime = { now: () => Date.now(), fetch: globalThis.fetch },
): Promise<void> {
  const ackAll = () => { for (const message of messages) message.ack(); };

  let config;
  try {
    config = resolveAuthConfig(env);
  } catch (error) {
    logError('lastroweb.auth_mail_wake_config_unavailable', error);
    ackAll();
    return;
  }
  // Without delivery credentials the Cron tick reports the misconfiguration; nothing to do here.
  if (!config.enabled || !config.mailDelivery?.apiKey) {
    ackAll();
    return;
  }

  const database = createWorkerDatabase(env);
  if (!database) {
    ackAll();
    return;
  }
  try {
    const repository = createAuthRepository(database, {
      mailDailyLimit: config.mailDailyLimit,
      mailMonthlyLimit: config.mailMonthlyLimit,
    });
    const dispatcher = createMailDispatcher(repository, config, runtime);
    const outcomes = await drainMail((now) => dispatcher.sendOne(now), () => runtime.now());
    const last = outcomes[outcomes.length - 1];
    if (last === 'paused' || last === 'failed') {
      logError('lastroweb.auth_mail_wake_stopped', new Error(`mail wake stopped: ${last}`), {
        result: last,
        sent: outcomes.filter((outcome) => outcome === 'sent').length,
      });
    }
    ackAll();
  } catch (error) {
    logError('lastroweb.auth_mail_wake_failed', error, mysqlErrorContext(error));
    for (const message of messages) message.retry({ delaySeconds: MAIL_WAKE_RETRY_DELAY_SECONDS });
  } finally {
    await database.close();
  }
}
