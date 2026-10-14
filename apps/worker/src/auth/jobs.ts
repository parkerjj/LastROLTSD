import { createMailDispatcher, MAIL_LEASE_MILLISECONDS } from './mail';
import type { AuthRepository } from './repository';
import type { AuthConfig, AuthRuntime } from './types';

export type AuthJobTickResult =
  | { kind: 'mail'; result: 'sent' | 'retry' | 'paused' | 'failed' }
  | { kind: 'cleanup'; result: string }
  | { kind: 'idle'; result: string };

export async function runAuthJobTick(
  repository: AuthRepository,
  config: AuthConfig,
  runtime: AuthRuntime,
): Promise<AuthJobTickResult> {
  if (!config.enabled) return { kind: 'idle', result: 'auth_disabled' };

  const now = runtime.now();
  if (config.mailDelivery?.apiKey) {
    const claim = await repository.claimOneMailForTick(now, MAIL_LEASE_MILLISECONDS);
    if (claim.kind === 'claimed') {
      const result = await createMailDispatcher(repository, config, runtime).sendClaimed(claim.job);
      return { kind: 'mail', result };
    }
    if (claim.kind === 'cleaned') return { kind: 'cleanup', result: 'expired_mail' };
  }

  const affected = await repository.cleanupAuthBatch(now, 50);
  return affected > 0
    ? { kind: 'cleanup', result: 'auth_batch' }
    : { kind: 'idle', result: config.mailDelivery?.apiKey ? 'no_work' : 'mail_unconfigured' };
}
