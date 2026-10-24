import { hasMailProvider } from './config';
import { createMailDispatcher, MAIL_LEASE_MILLISECONDS } from './mail';
import type { AuthRepository } from './repository';
import type { AuthConfig, AuthRuntime } from './types';

const AUTH_TICK_MAX_MAIL = 5;

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
  if (hasMailProvider(config)) {
    const dispatcher = createMailDispatcher(repository, config, runtime);
    let result: 'sent' | 'retry' | 'paused' | 'failed' | null = null;
    // 每次 tick 最多处理几封；额度或配置导致暂停时立即停下，其余结果继续处理下一封以便消化积压。
    for (let handled = 0; handled < AUTH_TICK_MAX_MAIL && result !== 'paused'; handled += 1) {
      const claim = await repository.claimOneMailForTick(runtime.now(), MAIL_LEASE_MILLISECONDS);
      if (claim.kind !== 'claimed') {
        if (result === null && claim.kind === 'cleaned') return { kind: 'cleanup', result: 'expired_mail' };
        break;
      }
      result = await dispatcher.sendClaimed(claim.job);
    }
    if (result !== null) return { kind: 'mail', result };
  }

  const affected = await repository.cleanupAuthBatch(now, 50);
  return affected > 0
    ? { kind: 'cleanup', result: 'auth_batch' }
    : { kind: 'idle', result: hasMailProvider(config) ? 'no_work' : 'mail_unconfigured' };
}
